#!/usr/bin/env python3
"""Baseline reproduction + per-transform augmented arms.

Head: identical to ../95-distillation/distill.py train_student -- nn.Linear(1152,k), AdamW
lr=1e-2 wd in {1e-4,1e-3,1e-2}, cosine over 300 epochs, batch 256, hard labels. Regularisation
strength selected on VAL macro-F1; test read once per pre-declared arm.
"""
import json, pathlib, sys

import numpy as np
import torch
import torch.nn as nn

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import common  # noqa: E402

CACHE = HERE.parent / "cache"
SEED = 0
WDS = (1e-4, 1e-3, 1e-2)


def train_head(X, y, k, wd, epochs=300, lr=1e-2, bs=256, seed=SEED):
    torch.manual_seed(seed)
    lin = nn.Linear(X.shape[1], k)
    nn.init.zeros_(lin.bias)
    nn.init.normal_(lin.weight, std=1.0 / np.sqrt(X.shape[1]))
    opt = torch.optim.AdamW(lin.parameters(), lr=lr, weight_decay=wd)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, epochs)
    Y1 = torch.zeros(len(y), k).scatter_(1, y.view(-1, 1), 1.0)
    g = torch.Generator().manual_seed(seed)
    for _ in range(epochs):
        perm = torch.randperm(len(y), generator=g)
        for i in range(0, len(perm), bs):
            b = perm[i:i + bs]
            logp = torch.log_softmax(lin(X[b]), dim=1)
            loss = -(Y1[b] * logp).sum(1).mean()
            opt.zero_grad(); loss.backward(); opt.step()
        sched.step()
    return lin


@torch.no_grad()
def logits(lin, X):
    return lin(X).numpy()


def arm_eval(Fc, rows, tr, va, te, aug=None, aug_idx=None, verbose=True):
    """Fc: clean (n,1152) already L2-normalised. aug: augmented view matrix for rows[tr] order."""
    out = {}
    for tname, T in common.tasks(rows).items():
        k = len(T["classes"])
        m = T["mask"]
        Xtr = torch.tensor(Fc[tr][m[tr]])
        ytr = torch.tensor(T["y"][tr][m[tr]])
        if aug is not None:
            Xtr = torch.cat([Xtr, torch.tensor(aug)], 0)
            ytr = torch.cat([ytr, ytr.clone()], 0)
        Xva, Xte = torch.tensor(Fc[va][m[va]]), torch.tensor(Fc[te][m[te]])
        yva, yte = T["y"][va][m[va]], T["y"][te][m[te]]
        best = None
        for wd in WDS:
            lin = train_head(Xtr, ytr, k, wd)
            sv = common.score(yva, logits(lin, Xva), T["classes"])
            if best is None or sv["macro_f1"] > best[0]["macro_f1"]:
                best = (sv, wd, lin)
        sv, wd, lin = best
        st = common.score(yte, logits(lin, Xte), T["classes"])
        out[tname] = {"k": k, "n_train_fit": int(len(ytr)), "wd": wd,
                      "val": sv, "test": st,
                      "test_pred": logits(lin, Xte).argmax(1).tolist(),
                      "test_y": np.asarray(yte).tolist(),
                      "test_tier_mix": common.tier_mix(rows, te[m[te]]),
                      "test_species_tier_mix": common.species_tier_mix(rows, te[m[te]])}
        if verbose:
            print(f"  {tname:9s} wd={wd:g}  val macroF1={sv['macro_f1']:.4f}  "
                  f"test macroF1={st['macro_f1']:.4f} balAcc={st['bal_acc']:.4f} acc={st['acc']:.4f}",
                  flush=True)
    return out


def main():
    rows = common.load_rows()
    tr, va, te = common.uuid_split(rows)
    print("leak", json.dumps(common.leak_check(rows, tr, va, te)), flush=True)
    Fc = common.culico_features(l2=True)
    print("clean feats", Fc.shape, flush=True)

    results = {"config_set_predeclared": ["baseline"] + VIEWS, "baseline": {}, "arms": {}}

    print("== baseline (clean train only)", flush=True)
    results["baseline"] = arm_eval(Fc, rows, tr, va, te)
    json.dump(results, open(HERE / "aug_results.json", "w"), indent=1)

    for v in VIEWS:
        f = CACHE / f"aug_{v}.npy"
        if not f.exists():
            print(f"== {v}: missing {f}, skipped", flush=True)
            continue
        A = np.load(f)
        print(f"== arm {v}  (train {len(tr)} + aug {A.shape[0]})", flush=True)
        results["arms"][v] = arm_eval(Fc, rows, tr, va, te, aug=A)
        json.dump(results, open(HERE / "aug_results.json", "w"), indent=1)
    print("done", flush=True)


VIEWS = ["rot_p10", "rot_p20", "blur_r1", "blur_r2", "contrast", "brightness", "crop_rrc",
         "hflip", "downres", "identity", "union"]

if __name__ == "__main__":
    main()
