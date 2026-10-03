#!/usr/bin/env python3
"""Arms A, B and D on cached culico features. No image is touched here.

Arms, all selected on val, test read once per pre-declared configuration:

  baseline  linear head, CE on hard labels          (the probe the 95/ report measured)
  D         class-weighted CE, weight_c ~ n_c^-p, p in {0, 0.5, 1}, and resampled minibatches
  B-hard    MLP head (1152 -> 1024 -> k), CE on hard labels
  B-kd      MLP head + alpha * KL(teacher). The teacher is a *trained* MLP probe on the H/14
            embeddings, not the shipped zero-shot head. The 95/ negative's teacher had posterior
            entropy 0.10-0.24 nats against 1.386 uniform, i.e. label noise at full confidence; a
            trained teacher's posterior carries the teacher's genuine uncertainty, which is the
            information soft targets are supposed to add.
  A/B-fd    MLP head + lambda * (1 - cosine(penultimate, H/14 embedding)) -- feature distillation.
            The teacher's penultimate feature carries strictly more than its softmax, and unlike
            arm A of the 95/ report the student's representation moves here.

Everything fp32. Run pinned: taskset -c 0-6, OMP_NUM_THREADS=4.
"""
from __future__ import annotations

import json
import os
import sys
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

HID = 1024
TDIM = 1024  # H/14 embedding width
EPOCHS = 200
BS = 256
LR = 1e-3
WD = 1e-2


def seed(s):
    np.random.seed(s)
    torch.manual_seed(s)


class Lin(nn.Module):
    def __init__(self, d, k):
        super().__init__()
        self.f = nn.Linear(d, k)

    def forward(self, x):
        return self.f(x)


class MLP(nn.Module):
    """d -> HID -> k. `feat` is the hidden layer: the feature-distillation target."""

    def __init__(self, d, k, hid=HID, p_drop=0.1):
        super().__init__()
        self.body = nn.Linear(d, hid)
        self.drop = nn.Dropout(p_drop)
        self.head = nn.Linear(hid, k)

    def feat(self, x):
        return self.body(x)

    def forward(self, x):
        return self.head(self.drop(self.body(x)))


def make(kind, d, k, hid=HID, p_drop=0.1):
    return Lin(d, k) if kind == "linear" else MLP(d, k, hid=hid, p_drop=p_drop)


def class_weights(y, k, p):
    """weight_c ~ n_c^-p, normalised to mean 1. p=0 natural, p=0.5 sqrt-balanced, p=1 uniform."""
    n = np.array([max((y == c).sum(), 1) for c in range(k)], dtype=np.float64)
    w = n ** (-p)
    return torch.tensor(w / w.mean(), dtype=torch.float32)


def sample_idx(y, k, p, rng, n_draw):
    n = np.array([max((y == c).sum(), 1) for c in range(k)], dtype=np.float64)
    w = n ** (-p)
    pr = w[y].astype(np.float64)
    pr /= pr.sum()          # renormalise the drawn vector, not the class table: float error here
    return rng.choice(len(y), size=n_draw, replace=True, p=pr)  # makes choice() raise


def _predict(model, X):
    model.eval()
    with torch.no_grad():
        return model(torch.from_numpy(X)).numpy().astype(np.float64)


def fit_teacher(Xt, tr, ytr, va, yva, k, epochs=EPOCHS, seed_=0):
    """Best readout available on the teacher backbone: an MLP probe on the H/14 embeddings,
    natural class weighting, selected on val. Returns (val_score, predict_fn)."""
    seed(seed_)
    m = make("mlp", TDIM, k)
    opt = torch.optim.AdamW(m.parameters(), lr=LR, weight_decay=WD)
    sch = torch.optim.lr_scheduler.CosineAnnealingLR(opt, epochs)
    Xtr, Xva = torch.from_numpy(Xt[tr]), torch.from_numpy(Xt[va])
    ytr_t = torch.from_numpy(ytr)
    for _ in range(epochs):
        m.train()
        perm = torch.randperm(len(Xtr))
        for i in range(0, len(perm), BS):
            b = perm[i:i + BS]
            loss = F.cross_entropy(m(Xtr[b]), ytr_t[b])
            opt.zero_grad(); loss.backward(); opt.step()
        sch.step()
    return C.score(yva, _predict(m, Xt[va]), list(range(k))), (lambda Z: _predict(m, Z))


def train_head(X, y, tr, va, k, kind="linear", *, p=0.0, resample=False, alpha=0.0, T=1.0,
               lam=0.0, Xt=None, teacher_logits=None, lr=LR, wd=WD, epochs=EPOCHS, seed_=0,
               bs=BS, n_draw=None, verbose=False, hid=HID, p_drop=0.1):
    """Fit on train rows, score on val. Test is never touched in this function."""
    seed(seed_)
    d = X.shape[1]
    model = make(kind, d, k, hid=hid, p_drop=p_drop)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=wd)
    sch = torch.optim.lr_scheduler.CosineAnnealingLR(opt, epochs)
    w = None if resample else class_weights(y[tr], k, p)
    Xtr = torch.from_numpy(X[tr])
    ytr_t = torch.from_numpy(y[tr])
    Xva = torch.from_numpy(X[va])
    Xt_tr = torch.from_numpy(Xt[tr]) if Xt is not None else None
    Ttr = (torch.from_numpy(np.ascontiguousarray(teacher_logits)[tr])
           if teacher_logits is not None else None)
    rng = np.random.default_rng(seed_)
    n_draw = n_draw or len(tr)
    hist = []
    for ep in range(epochs):
        model.train()
        order = (sample_idx(y[tr], k, p, rng, n_draw) if resample
                 else torch.randperm(len(tr)).numpy())
        for i in range(0, len(order), bs):
            b = torch.from_numpy(order[i:i + bs])
            gi = tr[b]
            xb, yb = Xtr[b], ytr_t[b]
            out = model(xb)
            loss = (F.cross_entropy(out, yb) if resample
                    else F.cross_entropy(out, yb, weight=w))
            if alpha > 0:
                tp = F.softmax(Ttr[b] / T, dim=1)
                loss = loss + alpha * F.kl_div(F.log_softmax(out, dim=1), tp, reduction="batchmean")
            if lam > 0:
                fb = model.feat(xb) if hasattr(model, "feat") else xb
                loss = loss + lam * (1 - F.cosine_similarity(fb, Xt_tr[b], dim=1)).mean()
            opt.zero_grad(); loss.backward(); opt.step()
        sch.step()
        if verbose and (ep + 1) % 50 == 0:
            print(f"    ep{ep+1} loss {float(loss):.4f} val "
                  f"{float((model(Xva).argmax(1).numpy() == y[va]).mean()):.4f}", flush=True)
    model.eval()
    vsc = C.score(y[va], _predict(model, X[va]), list(range(k)))
    return vsc, model, hist


def predict(model, X):
    return _predict(model, X)


def state(model):
    return {k: v.detach().clone() for k, v in model.state_dict().items()}


def rebuild(kind, d, k, st, hid=HID, p_drop=0.1):
    m = make(kind, d, k, hid=hid, p_drop=p_drop)
    m.load_state_dict(st)
    m.eval()
    return m
