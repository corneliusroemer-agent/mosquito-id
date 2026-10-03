#!/usr/bin/env python3
"""Paired bootstrap CIs for the deltas the cached sweep reports as point estimates.

Refits the three configurations that matter on genus4 (the linear probe, the sqrt-weighted linear
probe, the val-selected MLP) and bootstraps the *difference in macro-F1* over test rows, paired.
Paired is the point: the two arms agree or disagree on the same rows, so an unpaired interval would
throw that away and be far too wide.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C
import arms_cached as A

REPS = 2000


def ci(y, pa, pb, k, reps=REPS, seed=0):
    rng = np.random.default_rng(seed)
    n = len(y)
    d = np.empty(reps)
    for b in range(reps):
        i = rng.integers(0, n, n)
        d[b] = C.macro_f1(y[i], pb[i], k) - C.macro_f1(y[i], pa[i], k)
    return float(d.mean()), float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))


def acc_ci(y, pa, pb, reps=REPS, seed=0):
    rng = np.random.default_rng(seed)
    n = len(y)
    d = np.empty(reps)
    for b in range(reps):
        i = rng.integers(0, n, n)
        d[b] = float((y[i] == pb[i]).mean()) - float((y[i] == pa[i]).mean())
    return float(d.mean()), float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))


def main():
    rows = C.load_rows()
    tr, va, te = C.uuid_split(rows)
    assert C.leak_check(rows, tr, va, te)["straddling_rows"] == 0
    X = C.culico_features()
    out = {}
    for tname in ["genus4", "species9", "aedes4"]:
        t = C.tasks(rows)[tname]
        k = len(t["classes"])
        y = t["y"]
        tr_k = tr[y[tr] >= 0]; va_k = va[y[va] >= 0]; te_k = te[y[te] >= 0]
        yte = y[te_k]
        preds = {}
        for name, kw in [("linear_p0", dict(kind="linear", p=0.0)),
                         ("linear_p0.5", dict(kind="linear", p=0.5)),
                         ("linear_p1", dict(kind="linear", p=1.0)),
                         ("mlp_best", dict(kind="mlp", p=1.0, resample=True,
                                           hid=1024, p_drop=0.3))]:
            _, m, _ = A.train_head(X, y, tr_k, va_k, k, Xt=X, seed_=0, **kw)
            preds[name] = A.predict(m, X[te_k]).argmax(1)
        base = preds["linear_p0"]
        rec = {"n_test": len(te_k),
               "test_macro_f1": {n: C.macro_f1(yte, p, k) for n, p in preds.items()},
               "test_acc": {n: float((yte == p).mean()) for n, p in preds.items()},
               "vs_baseline": {}}
        for n, p in preds.items():
            if n == "linear_p0":
                continue
            m, lo, hi = ci(yte, base, p, k)
            am, alo, ahi = acc_ci(yte, base, p)
            rec["vs_baseline"][n] = {"d_macro_f1": m, "macro_f1_ci": [lo, hi],
                                     "d_acc": am, "acc_ci": [alo, ahi],
                                     "excludes_zero": not (lo <= 0 <= hi)}
        rec["per_class_recall"] = {n: C.per_class_recall(yte, p, t["classes"])
                                   for n, p in preds.items()}
        out[tname] = rec
        print(f"===== {tname}  n_test={len(te_k)}  classes={t['classes']}")
        for n, v in rec["test_macro_f1"].items():
            print(f"  {n:12s} macroF1 {v:.4f}  acc {rec['test_acc'][n]:.4f}")
        for n, v in rec["vs_baseline"].items():
            print(f"  d({n}) macroF1 {v['d_macro_f1']:+.4f} CI [{v['macro_f1_ci'][0]:+.4f}, "
                  f"{v['macro_f1_ci'][1]:+.4f}]  {'excludes 0' if v['excludes_zero'] else 'INCLUDES 0'}")
        print("  per-class recall (baseline / linear_p0.5):")
        for c, name in enumerate(t["classes"]):
            b = rec["per_class_recall"]["linear_p0"][name]
            s = rec["per_class_recall"]["linear_p0.5"][name]
            print(f"    {name:24s} n={b['n']:4d}  {b['recall']:.3f} -> {s['recall']:.3f}")
        sys.stdout.flush()
    json.dump(out, open(f"{HERE}/ci_results.json", "w"), indent=1)
    print("wrote ci_results.json")


if __name__ == "__main__":
    main()
