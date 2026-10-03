#!/usr/bin/env python3
"""Staged sweep over arms A, B and D on cached culico features.

Selection is on val macro-F1 throughout. Test is scored for every configuration so that the
val-oracle gap can be reported as a leakage audit, but no choice is ever made on test; the
oracle column is quoted so a reader can see that val selection is not quietly losing anything.

Run:  taskset -c 0-6 OMP_NUM_THREADS=4 .venv/bin/python run_cached.py
"""
from __future__ import annotations

import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C
import arms_cached as A

OUT = os.path.dirname(os.path.abspath(__file__))
SEED = 0
PS = [0.0, 0.5, 1.0]          # class-weight / resampling exponent: natural, sqrt-balanced, uniform
ALPHAS = [0.0, 0.3, 0.5, 0.7, 0.9, 1.0]
TEMPS = [1.0, 2.0, 4.0]
LAMS = [0.0, 0.1, 0.3, 1.0, 3.0]


def dump():
    with open(f"{OUT}/cached_results.json", "w") as f:
        json.dump(STATE, f, indent=1)
    print("wrote cached_results.json", flush=True)


def rec(arm, task, cfg, vsc, tsc, k, rows, tr, va, te):
    return {"arm": arm, "task": task, "cfg": cfg,
            "val_macro_f1": vsc["macro_f1"], "val_acc": vsc["acc"], "val_bal": vsc["bal_acc"],
            "test_macro_f1": tsc["macro_f1"], "test_acc": tsc["acc"], "test_bal": tsc["bal_acc"],
            "test_per_class": tsc["per_class"], "k": k}


def main():
    rows = C.load_rows()
    tr, va, te = C.uuid_split(rows)
    leak = C.leak_check(rows, tr, va, te)
    assert leak["straddling_rows"] == 0 and leak["straddling_uuids"] == 0, leak
    X = C.culico_features()
    Xt = C.h14_features()
    T = C.tasks(rows)
    global STATE
    res, models = [], {}
    STATE = {"leak": None, "test_tier_mix": None, "test_species_rank_tier_mix": None, "results": res}
    tmix_gen = C.tier_mix(rows, te)
    tmix_sp = C.species_tier_mix(rows, te)
    STATE["leak"] = leak
    STATE["test_tier_mix"] = tmix_gen
    STATE["test_species_rank_tier_mix"] = tmix_sp
    print("leak", json.dumps(leak), flush=True)
    print("test tier mix", json.dumps(tmix_gen), flush=True)
    print("test species-rank tier mix", json.dumps(tmix_sp), flush=True)

    for tname in ["genus4", "species9", "aedes4"]:
        t = T[tname]
        k = len(t["classes"])
        y = t["y"]
        mask = t["mask"]
        y = np.where(mask, y, -1)
        sub = np.where(mask)[0]
        remap = -np.ones(len(rows), int)
        remap[sub] = np.arange(len(sub))
        ys = remap[y]
        tr_s, va_s, te_s = remap[tr], remap[va], remap[te]
        keep = lambda ix: ix[ys[ix] >= 0]
        tr_s, va_s, te_s = keep(tr_s), keep(va_s), keep(te_s)
        ktr = keep(tr)
        t0 = time.time()

        # ---- teacher: MLP probe on the H/14 embeddings, same protocol, natural weighting.
        tsc, tpred = A.fit_teacher(Xt, ktr, ys[ktr], va_s, ys[va_s], k, seed_=SEED)
        tl = tpred(Xt)
        print(f"[{tname}] teacher H/14 probe  val acc {tsc['acc']:.4f} "
              f"macroF1 {tsc['macro_f1']:.4f}  ({time.time()-t0:.0f}s)", flush=True)
        tt = C.score(ys[te_s], tl[te_s], list(range(k)))
        res.append(rec("teacher_h14_mlp", tname, {}, tsc, tt, k, rows, tr_s, va_s, te_s))
        models[(tname, "teacher")] = tl

        Tl = tl

        # ---- stage 1: readout shape x class weighting (arm D)
        # stage 1a: linear readout, the class-weighting arm D on the probe itself
        best_lin = (-1, None)
        for p in PS:
            cfg = {"kind": "linear", "p": p, "resample": False, "alpha": 0.0, "lam": 0.0, "T": 1.0}
            vsc, m, _ = A.train_head(X, ys, tr_s, va_s, k, kind="linear", p=p, Xt=Xt, seed_=SEED)
            tsc2 = C.score(ys[te_s], A.predict(m, X[te_s]), list(range(k)))
            res.append(rec("baseline" if p == 0.0 else "D_weighting", tname, cfg, vsc, tsc2,
                           k, rows, tr_s, va_s, te_s))
            print(f"  [{tname}] linear p={p}  valF1 {vsc['macro_f1']:.4f} "
                  f"testF1 {tsc2['macro_f1']:.4f}", flush=True)
            if vsc["macro_f1"] > best_lin[0]:
                best_lin = (vsc["macro_f1"], p)

        # stage 1b: MLP readout -- capacity x class weighting x resampling (arm D)
        best_mlp = (-1, None)
        for hid, drop in [(256, 0.1), (512, 0.2), (1024, 0.3)]:
            for p in PS:
                for resamp in [False, True]:
                    cfg = {"kind": "mlp", "hid": hid, "p_drop": drop, "p": p,
                           "resample": resamp, "alpha": 0.0, "lam": 0.0, "T": 1.0}
                    vsc, m, _ = A.train_head(X, ys, tr_s, va_s, k, kind="mlp", p=p, resample=resamp,
                                            Xt=Xt, seed_=SEED, hid=hid, p_drop=drop)
                    tsc2 = C.score(ys[te_s], A.predict(m, X[te_s]), list(range(k)))
                    res.append(rec("D_sampling" if resamp else "D_weighting", tname, cfg,
                                   vsc, tsc2, k, rows, tr_s, va_s, te_s)); dump()
                    print(f"  [{tname}] mlp hid={hid} drop={drop} p={p} resample={resamp}  "
                          f"valF1 {vsc['macro_f1']:.4f} testF1 {tsc2['macro_f1']:.4f}", flush=True)
                    if vsc["macro_f1"] > best_mlp[0]:
                        best_mlp = (vsc["macro_f1"], (hid, drop, p, resamp))
        bp = best_mlp[1]
        print(f"[{tname}] best linear p={best_lin[1]}; best mlp (hid,drop,p,resample)={bp}", flush=True)
        HIDD, DROPP, PP, RESS = bp

        # ---- stage 2: B-kd (alpha, T) at the chosen p; A/B-fd (lam)
        for alpha in ALPHAS:
            for Tt in (TEMPS if alpha > 0 else [1.0]):
                cfg = {"kind": "mlp", "hid": HIDD, "p_drop": DROPP, "p": PP, "resample": RESS,
                       "alpha": alpha, "T": Tt, "lam": 0.0}
                vsc, m, _ = A.train_head(X, ys, tr_s, va_s, k, kind="mlp", p=PP, resample=RESS,
                                        alpha=alpha, T=Tt, Xt=Xt, teacher_logits=Tl,
                                        seed_=SEED, hid=HIDD, p_drop=DROPP)
                tsc2 = C.score(ys[te_s], A.predict(m, X[te_s]), list(range(k)))
                res.append(rec("B_kd", tname, cfg, vsc, tsc2, k, rows, tr_s, va_s, te_s)); dump()
                print(f"  [{tname}] kd alpha={alpha} T={Tt}  valF1 {vsc['macro_f1']:.4f} "
                      f"testF1 {tsc2['macro_f1']:.4f}", flush=True)
                if alpha == 0.0:
                    models[(tname, "mlp_hard")] = m
        for lam in LAMS:
            if lam == 0.0:
                continue
            cfg = {"kind": "mlp", "hid": HIDD, "p_drop": DROPP, "p": PP, "resample": RESS,
                   "alpha": 0.0, "T": 1.0, "lam": lam}
            vsc, m, _ = A.train_head(X, ys, tr_s, va_s, k, kind="mlp", p=PP, resample=RESS, lam=lam,
                                    Xt=Xt, seed_=SEED, hid=HIDD, p_drop=DROPP)
            tsc2 = C.score(ys[te_s], A.predict(m, X[te_s]), list(range(k)))
            res.append(rec("A_fd", tname, cfg, vsc, tsc2, k, rows, tr_s, va_s, te_s)); dump()
            print(f"  [{tname}] fd lam={lam}  valF1 {vsc['macro_f1']:.4f} "
                  f"testF1 {tsc2['macro_f1']:.4f}", flush=True)
            if lam == 0.3:
                models[(tname, "fd03")] = m

    dump()

    # ---- leakage audit: how much val selection loses against an oracle
    for tname in ["genus4", "species9", "aedes4"]:
        rr = [r for r in res if r["task"] == tname and r["arm"] != "teacher_h14_mlp"]
        sel = max(rr, key=lambda r: r["val_macro_f1"])
        orc = max(rr, key=lambda r: r["test_macro_f1"])
        print(f"[{tname}] val-selected {sel['arm']} {sel['cfg']} -> test F1 "
              f"{sel['test_macro_f1']:.4f}; oracle {orc['arm']} {orc['cfg']} -> "
              f"{orc['test_macro_f1']:.4f} (gap {orc['test_macro_f1']-sel['test_macro_f1']:+.4f})",
              flush=True)


def torchify(tl, ktr, tr_s, k):
    """The teacher's logits are computed on every culico-row index; the head trains on the
    task's train sub-indices, so hand it the global array and let it index by global row."""
    import torch
    return torch.from_numpy(tl.astype(np.float32))


if __name__ == "__main__":
    main()
