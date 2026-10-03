#!/usr/bin/env python3
"""Distillation / fine-tuning on culico-net-cls-v1 -- self-contained, runs off this container.

Same experiment as ``ft_backbone.py`` but with no dependency on this investigation directory: the
corpus TSV, the released backbone, the H/14 teacher embedding cache and every hyper-parameter are
CLI arguments, and ``--device`` selects cpu / mps / cuda. On an Apple-Silicon Mac,
``--device mps`` runs the arm at GPU speed; MPS is the realistic off-box route for this model because
the release ships TorchScript and Keras, neither of which MLX loads directly. An MLX-native port
would need the original Keras source or a CoreML conversion of the ONNX -- a separate piece of work.

    # reproduce the container run
    distill_portable.py --corpus 92-corrected-corpus.tsv --out /tmp/ft

    # the same arm on a Mac's GPU
    distill_portable.py --corpus ~/mosquito-id/92-corrected-corpus.tsv --out ~/ft --device mps \\
        --frac 1.0 --epochs 3 --arms ce,ce_fd --lam 0.5

The corpus TSV must carry the columns used here: ``path`` (image), ``corrected_species`` (label),
``group_key`` (grouped on the part after the first ``:``, i.e. the specimen uuid) and ``tier``.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
GENUS4 = ["Aedes", "Anopheles", "Culex", "Culiseta"]
SPECIES9 = ["Aedes aegypti", "Aedes albopictus", "Aedes japonicus", "Aedes koreicus",
            "Anopheles", "Culex", "Culiseta", "Culiseta annulata", "Culiseta longiareolata"]


def load_corpus(path):
    rows = list(csv.DictReader(open(path), delimiter="\t"))
    for r in rows:
        r["species"] = r.get("corrected_species") or r["species"]
        r["uuid"] = r["group_key"].split(":", 1)[1]
    return rows


def uuid_split(rows, seed=0, frac=(0.6, 0.2, 0.2)):
    """Grouped on the specimen uuid, stratified by species. NOT on group_key: that string is
    `<source_dataset>:<uuid>`, so a specimen ingested by both ma/ and ma_api/ gets two keys."""
    rng = np.random.default_rng(seed)
    species = np.array([r["species"] for r in rows])
    uuid = np.array([r["uuid"] for r in rows])
    by = {}
    for i, s in enumerate(species):
        by.setdefault(s, []).append(i)
    tr, va, te = [], [], []
    for s, ii in sorted(by.items()):
        uu = sorted({uuid[i] for i in ii})
        o = rng.permutation(len(uu))
        n_tr, n_va = round(frac[0] * len(uu)), round(frac[1] * len(uu))
        a = {uu[o[j]]: ("train" if j < n_tr else "val" if j < n_tr + n_va else "test")
             for j in range(len(uu))}
        for i in ii:
            {"train": tr, "val": va, "test": te}[a[uuid[i]]].append(i)
    return np.array(sorted(tr)), np.array(sorted(va)), np.array(sorted(te))


def leak_check(rows, tr, va, te):
    u = np.array([r["uuid"] for r in rows])
    s = [set(u[tr].tolist()), set(u[va].tolist()), set(u[te].tolist())]
    strad = (s[0] & s[1]) | (s[0] & s[2]) | (s[1] & s[2])
    return {"n_rows": len(rows), "n_uuids": len(set(u.tolist())),
            "straddling_uuids": len(strad),
            "straddling_rows": int(np.isin(u, list(strad)).sum()) if strad else 0}


def macro_f1(y, p, k):
    f = []
    for c in range(k):
        tp = int(((p == c) & (y == c)).sum()); fp = int(((p == c) & (y != c)).sum())
        fn = int(((p != c) & (y == c)).sum())
        f.append(0.0 if tp == 0 else 2 * tp / (2 * tp + fp + fn))
    return float(np.mean(f))


def preprocess(p):
    im = Image.open(p).convert("RGB")
    w, h = im.size
    s = 256 / min(w, h)
    im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.BICUBIC)
    w, h = im.size
    l, t = (w - 224) // 2, (h - 224) // 2
    a = np.asarray(im.crop((l, t, l + 224, t + 224)), np.float32) / 255.0
    return torch.from_numpy(((a - MEAN) / STD).transpose(2, 0, 1))


class Culico(nn.Module):
    """The released TorchScript backbone, exposing the 1152-d penultimate feature. Its forward
    reproduces the ONNX feature cache at cosine 1.000000, so this trains the same representation."""

    def __init__(self, path):
        super().__init__()
        ts = torch.jit.load(path, map_location="cpu")
        self.back = getattr(ts, "0")
        self.head = getattr(ts, "1")

    def feat(self, x):
        h = self.head
        return getattr(h, "2")(getattr(h, "1")(getattr(h, "0")(self.back(x))))


class Head(nn.Module):
    def __init__(self, k, hid=512, p_drop=0.2):
        super().__init__()
        self.body = nn.Linear(1152, hid)
        self.drop = nn.Dropout(p_drop)
        self.head = nn.Linear(hid, k)

    def forward(self, f):
        return self.head(self.drop(torch.relu(self.body(f))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--backbone", required=True, help="culico-net-cls-v1-17.pt (TorchScript)")
    ap.add_argument("--teacher-embeddings", default="", help=".npy of H/14 embeddings, row-aligned")
    ap.add_argument("--out", required=True)
    ap.add_argument("--device", default="cpu", choices=["cpu", "mps", "cuda"])
    ap.add_argument("--task", default="genus4", choices=["genus4", "species9"])
    ap.add_argument("--frac", type=float, default=0.25, help="fraction of backbone tensors trainable")
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--bs", type=int, default=16)
    ap.add_argument("--lr", type=float, default=1e-5)
    ap.add_argument("--lam", type=float, default=0.5, help="feature-distillation weight")
    ap.add_argument("--alpha", type=float, default=0.0, help="output-distillation weight")
    ap.add_argument("--arms", default="ce,ce_fd")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    dev = torch.device(a.device)
    os.makedirs(a.out, exist_ok=True)

    rows = load_corpus(a.corpus)
    tr, va, te = uuid_split(rows, a.seed)
    leak = leak_check(rows, tr, va, te)
    assert leak["straddling_rows"] == 0, leak
    print("leak", json.dumps(leak), flush=True)

    classes = GENUS4 if a.task == "genus4" else SPECIES9
    k = len(classes)
    sp = np.array([r["species"] for r in rows])
    y = np.array([classes.index(s if s in classes else s.split()[0]) for s in sp])

    model = Culico(a.backbone).to(dev)
    names = [n for n, _ in model.back.named_parameters()]
    cut = int(len(names) * (1 - a.frac))
    for p in model.parameters():
        p.requires_grad_(False)
    trn = []
    for i, (n, p) in enumerate(model.back.named_parameters()):
        if i >= cut:
            p.requires_grad_(True); trn.append(p)
    head, proj = Head(k).to(dev), nn.Linear(1152, 1024).to(dev)
    Xt = None
    if a.teacher_embeddings:
        Xt = torch.from_numpy(np.load(a.teacher_embeddings).astype(np.float32)).to(dev)
        Xt = Xt / Xt.norm(dim=1, keepdim=True)
    opt = torch.optim.AdamW([{"params": trn, "lr": a.lr},
                             {"params": list(head.parameters()) + list(proj.parameters()),
                              "lr": a.lr * 10}], weight_decay=1e-4)
    print(f"trainable backbone tensors {len(trn)}/{len(names)} "
          f"({sum(p.numel() for p in trn)/1e6:.2f}M)", flush=True)

    @torch.no_grad()
    def feats(idx, bs=32):
        model.eval()
        out = np.zeros((len(idx), 1152), np.float32)
        for i in range(0, len(idx), bs):
            x = torch.stack([preprocess(rows[j]["path"]) for j in idx[i:i + bs]]).to(dev)
            out[i:i + bs] = model.feat(x).cpu().numpy()
        return out

    out = {"leak": leak, "cfg": vars(a), "results": []}
    for arm in a.arms.split(","):
        lam = a.lam if "fd" in arm else 0.0
        alpha = a.alpha if "kd" in arm else 0.0
        torch.manual_seed(a.seed)
        head.reset_parameters(); proj.reset_parameters()
        hist = []
        for ep in range(a.epochs):
            model.train(); head.train()
            rng = np.random.default_rng(a.seed + ep)
            order = rng.permutation(tr)
            t0, tot, nb = time.time(), 0.0, 0
            for i in range(0, len(order), a.bs):
                b = order[i:i + a.bs]
                x = torch.stack([preprocess(rows[j]["path"]) for j in b]).to(dev)
                gi = torch.from_numpy(b).to(dev)
                f = model.feat(x)
                o = head(f)
                loss = F.cross_entropy(o, torch.from_numpy(y[b]).to(dev))
                if lam > 0 and Xt is not None:
                    loss = loss + lam * (1 - F.cosine_similarity(proj(f), Xt[gi], dim=1)).mean()
                if alpha > 0 and Xt is not None:
                    loss = loss + alpha * F.kl_div(F.log_softmax(o, 1), F.softmax(Xt[gi], 1),
                                                   reduction="batchmean")
                opt.zero_grad(); loss.backward(); opt.step()
                tot += float(loss.detach()); nb += 1
            fv = feats(va)
            with torch.no_grad():
                pv = head(torch.from_numpy(fv).to(dev)).argmax(1).cpu().numpy()
            hist.append({"epoch": ep + 1, "loss": tot / nb, "val_macro_f1": macro_f1(y[va], pv, k),
                         "mins": (time.time() - t0) / 60})
            print(f"[{arm}] ep{ep+1} loss {tot/nb:.4f} valF1 {hist[-1]['val_macro_f1']:.4f} "
                  f"{hist[-1]['mins']:.1f}min", flush=True)
        ft = feats(te)
        with torch.no_grad():
            pt = head(torch.from_numpy(ft).to(dev)).cpu().numpy()
        # control: a linear probe on the feature the fine-tuning produced
        W = np.linalg.lstsq(feats(tr), np.eye(k)[y[tr]], rcond=None)[0]
        pl = (ft @ W).argmax(1)
        r = {"arm": arm, "hist": hist, "best_epoch": max(hist, key=lambda h: h["val_macro_f1"])["epoch"],
             "test_macro_f1_head": macro_f1(y[te], pt, k),
             "test_macro_f1_linear_probe_on_moved_feature": macro_f1(y[te], pl, k)}
        out["results"].append(r)
        print(f"[{arm}] TEST head macroF1 {r['test_macro_f1_head']:.4f} | "
              f"linear probe on moved feature "
              f"{r['test_macro_f1_linear_probe_on_moved_feature']:.4f}", flush=True)
        json.dump(out, open(f"{a.out}/results.json", "w"), indent=1)
    print("done", flush=True)


if __name__ == "__main__":
    main()
