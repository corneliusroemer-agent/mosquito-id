#!/usr/bin/env python3
"""Arm B with a representation that moves: partial fine-tuning of the culico backbone.

The 95/ negative's structural argument -- the student cannot exceed a teacher that is a linear map
of the features it already reads -- does not apply once the backbone's weights move. This script
moves them: the last `frac` of the backbone's 213 parameter tensors plus a fresh head are trained
end-to-end with images, while the early layers stay frozen.

The backbone is the **TorchScript** release, not a re-implementation. Its forward reproduces the
cached ONNX features at cosine 1.00000, so this trains exactly the representation every other arm
in this directory reads. True LoRA is not available here: LoRA needs an assignable ``nn.Module``,
``register_forward_hook`` is unsupported on ScriptModules, and the release's ``attention_biases``
are pinned to a 49/196/49 token grid that no timm release config reproduces (all 213 other tensors
match ``tiny_vit_21m_224`` exactly). That reconstruction is in the future-work ledger.

Arms, pre-declared, selected on val macro-F1, test read once:
  ft_ce      CE on hard labels
  ft_ce_fd   + lambda * (1 - cosine(proj(student feature), H/14 embedding))
  ft_ce_kd   + alpha * KL(teacher posterior), teacher = MLP probe on the H/14 embeddings
"""
from __future__ import annotations

import argparse
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
import arms_cached as A

HERE = os.path.dirname(os.path.abspath(__file__))
TS = "/workspaces/claude-devcontainer/investigations/2026-10-02-mosquito-id/04-local-models/models/cls/culico-net-cls-v1-17.pt"
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


class Culico(nn.Module):
    """The released backbone, exposing the 1152-d penultimate feature the whole study probes."""

    def __init__(self):
        super().__init__()
        ts = torch.jit.load(TS, map_location="cpu")
        self.back = getattr(ts, "0")
        self.head = getattr(ts, "1")

    def feat(self, x):
        h = self.head
        return getattr(h, "2")(getattr(h, "1")(getattr(h, "0")(self.back(x))))

    def forward(self, x):
        return getattr(self.head, "8")(getattr(self.head, "7")(
            getattr(self.head, "6")(getattr(self.head, "5")(
                getattr(self.head, "4")(getattr(self.head, "3")(
                    getattr(self.head, "2")(getattr(self.head, "1")(
                        getattr(self.head, "0")(self.back(x))))))))))


class Head(nn.Module):
    """Same shape as the shipped tail: 1152 -> 512 -> k, with dropout. Kept small on purpose --
    the question is whether the *representation* moves, not whether a bigger readout helps."""

    def __init__(self, k, hid=512, p_drop=0.2):
        super().__init__()
        self.body = nn.Linear(1152, hid)
        self.drop = nn.Dropout(p_drop)
        self.head = nn.Linear(hid, k)

    def forward(self, f):
        return self.head(self.drop(torch.relu(self.body(f))))


class Batcher:
    def __init__(self, path, rows_idx, n, bs, seed=0):
        self.A = np.load(path, mmap_mode="r")
        self.idx = rows_idx
        self.bs = bs
        self.rng = np.random.default_rng(seed)

    def epoch(self):
        order = self.rng.permutation(self.idx)
        for i in range(0, len(order), self.bs):
            raw = self.A[order[i:i + self.bs]].astype(np.float32) / 255.0
            x = (raw - MEAN) / STD
            yield (torch.from_numpy(np.ascontiguousarray(x.transpose(0, 3, 1, 2))),
                   torch.from_numpy(order[i:i + self.bs]))


@torch.no_grad()
def features(model, path, idx, bs=32):
    model.eval()
    A_ = np.load(path, mmap_mode="r")
    out = np.zeros((len(idx), 1152), np.float32)
    for i in range(0, len(idx), bs):
        raw = A_[idx[i:i + bs]].astype(np.float32) / 255.0
        x = (raw - MEAN) / STD
        out[i:i + bs] = model.feat(torch.from_numpy(
            np.ascontiguousarray(x.transpose(0, 3, 1, 2)))).numpy()
    return out


def run(arm, k, rows, tr, va, te, T, y, Xt, Tt, frac, epochs, bs, lr, lam, alpha, seed_=0,
        a_tag="ft"):
    path = f"{HERE}/cache/images_224_uint8.npy"
    model = Culico()
    names = [n for n, _ in model.back.named_parameters()]
    frozen = [(n, p.detach().clone()) for n, p in model.back.named_parameters()]
    for p in model.parameters():
        p.requires_grad_(False)
    cut = int(len(names) * (1 - frac))
    trainable = []
    for i, (n, p) in enumerate(model.back.named_parameters()):
        if i >= cut:
            p.requires_grad_(True)
            trainable.append(p)
    head = Head(k)
    proj = nn.Linear(1152, 1024)
    for p in list(head.parameters()) + list(proj.parameters()):
        p.requires_grad_(True)
    params = trainable + list(head.parameters()) + list(proj.parameters())
    print(f"[{arm}] trainable backbone tensors {len(trainable)}/{len(names)} "
          f"({sum(p.numel() for p in trainable)/1e6:.2f}M) + head "
          f"({sum(p.numel() for p in head.parameters())/1e3:.0f}k)", flush=True)
    opt = torch.optim.AdamW([
        {"params": trainable, "lr": lr},
        {"params": list(head.parameters()) + list(proj.parameters()), "lr": lr * 10},
    ], weight_decay=1e-4)

    def ysub(ix):
        return torch.from_numpy(y[ix])

    hist = []
    for ep in range(epochs):
        model.train(); head.train()
        t0, tot, nb = time.time(), 0.0, 0
        for xb, gi in Batcher(path, tr, len(tr), bs, seed_ + ep).epoch():
            f = model.feat(xb)
            out = head(f)
            loss = F.cross_entropy(out, ysub(gi))
            if lam > 0:
                loss = loss + lam * (1 - F.cosine_similarity(proj(f), torch.from_numpy(
                    Xt[gi.numpy()]), dim=1)).mean()
            if alpha > 0:
                tp = F.softmax(torch.from_numpy(Tt[gi.numpy()]) / 2.0, dim=1)
                loss = loss + alpha * F.kl_div(F.log_softmax(out, dim=1), tp, reduction="batchmean")
            opt.zero_grad(); loss.backward(); opt.step()
            tot += float(loss.detach()); nb += 1
        fv = features(model, path, va)
        with torch.no_grad():
            sc = C.score(y[va], head(torch.from_numpy(fv)).numpy().astype(np.float64), list(range(k)))
        hist.append({"epoch": ep + 1, "loss": tot / nb, "val_macro_f1": sc["macro_f1"],
                     "val_acc": sc["acc"], "mins": (time.time() - t0) / 60})
        # Snapshot the head every epoch: the val-selected epoch is the only one whose test score is
        # read, and a snapshot costs 2 MB. Scoring at the end from the *final* weights instead would
        # silently report the last epoch, not the selected one.
        torch.save({"head": {k: v.detach().clone() for k, v in head.state_dict().items()},
                    "proj": {k: v.detach().clone() for k, v in proj.state_dict().items()},
                    "tail": {n: p.detach().clone() for n, p in model.back.named_parameters()
                             if p.requires_grad}}, f"{HERE}/{a_tag}_{arm}_ep{ep+1}.pt")
        print(f"[{arm}] ep{ep+1} loss {tot/nb:.4f} valF1 {sc['macro_f1']:.4f} "
              f"valAcc {sc['acc']:.4f} {(time.time()-t0)/60:.1f}min", flush=True)
    best = max(hist, key=lambda h: h["val_macro_f1"])
    ck = torch.load(f"{HERE}/{a_tag}_{arm}_ep{best['epoch']}.pt", weights_only=True)
    head.load_state_dict(ck["head"])
    with torch.no_grad():
        for n, p in model.back.named_parameters():
            if n in ck["tail"]:
                p.copy_(ck["tail"][n])
    fte, ftr = features(model, path, te), features(model, path, tr)
    with torch.no_grad():
        ts = C.score(y[te], head(torch.from_numpy(fte)).numpy().astype(np.float64), list(range(k)))
    # Control: is the *representation* better, independent of the from-scratch head? A plain least
    # squares probe on the moved feature, same rows, same labels.
    W = np.linalg.lstsq(ftr.astype(np.float64), np.eye(k)[y[tr]], rcond=None)[0]
    lp = C.score(y[te], fte.astype(np.float64) @ W, list(range(k)))
    # And how far did it drift from the release?
    drift = float(np.mean([float((p.detach() - q.detach()).norm())
                           for (_, p), (_, q) in zip(model.back.named_parameters(), frozen)]))
    return {"arm": arm, "hist": hist, "best_epoch": best["epoch"], "test": ts,
            "test_linear_probe_on_moved_feature": lp, "backbone_drift_l2": drift}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", default="genus4")
    ap.add_argument("--frac", type=float, default=0.25)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--bs", type=int, default=8)
    ap.add_argument("--lr", type=float, default=1e-5)
    ap.add_argument("--arms", default="ce,ce_fd")
    ap.add_argument("--lam", type=float, default=0.5)
    ap.add_argument("--alpha", type=float, default=0.5)
    ap.add_argument("--tag", default="ft")
    a = ap.parse_args()

    rows = C.load_rows()
    tr, va, te = C.uuid_split(rows)
    leak = C.leak_check(rows, tr, va, te)
    assert leak["straddling_rows"] == 0, leak
    Xt = C.h14_features()
    T = C.tasks(rows)
    out = {"leak": leak, "frac": a.frac, "epochs": a.epochs, "arms": a.arms, "results": []}
    for tname in a.tasks.split(","):
        t = T[tname]
        k = len(t["classes"])
        y = np.where(t["mask"], t["y"], -1)
        tr_k, va_k, te_k = tr[y[tr] >= 0], va[y[va] >= 0], te[y[te] >= 0]
        tsc, tpred = A.fit_teacher(Xt, tr_k, y[tr_k], va_k, y[va_k], k, seed_=0)
        Tt = tpred(Xt).astype(np.float32)
        print(f"[{tname}] teacher val acc {tsc['acc']:.4f} macroF1 {tsc['macro_f1']:.4f}", flush=True)
        for arm in a.arms.split(","):
            lam = a.lam if "fd" in arm else 0.0
            alpha = a.alpha if "kd" in arm else 0.0
            r = run(arm, k, rows, tr_k, va_k, te_k, t, y, Xt, Tt, a.frac, a.epochs, a.bs,
                    a.lr, lam, alpha, a_tag=a.tag)
            r["task"] = tname
            out["results"].append(r)
            print(f"[{tname}/{arm}] best_ep {r['best_epoch']} drift {r['backbone_drift_l2']:.4g} "
                  f"TEST macroF1 {r['test']['macro_f1']:.4f} "
                  f"acc {r['test']['acc']:.4f} bal {r['test']['bal_acc']:.4f} | "
                  f"linear-probe-on-moved-feature F1 "
                  f"{r['test_linear_probe_on_moved_feature']['macro_f1']:.4f}", flush=True)
            with open(f"{HERE}/{a.tag}_{tname}.json", "w") as f:
                json.dump(out, f, indent=1)
    print("done", flush=True)


if __name__ == "__main__":
    main()
