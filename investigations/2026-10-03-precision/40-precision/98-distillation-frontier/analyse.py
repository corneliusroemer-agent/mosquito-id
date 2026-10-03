#!/usr/bin/env python3
"""Turn cached_results.json into the tables the report quotes."""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C

D = json.load(open(f"{HERE}/cached_results.json"))
R = D["results"]
TASKS = ["genus4", "species9", "aedes4"]


def best(r, key="val_macro_f1"):
    return max(r, key=lambda x: x[key])


def main():
    print("leak", json.dumps(D["leak"]))
    print("test tier mix", json.dumps(D["test_tier_mix"]))
    print("test species-rank tier mix", json.dumps(D["test_species_rank_tier_mix"]))
    for t in TASKS:
        rr = [r for r in R if r["task"] == t]
        if not rr:
            continue
        print(f"\n===== {t}  (k={rr[0]['k']}) =====")
        groups = {}
        for r in rr:
            groups.setdefault(r["arm"], []).append(r)
        for arm, g in groups.items():
            b = best(g)
            print(f"  {arm:16s} n_cfg={len(g):3d}  val-selected {json.dumps(b['cfg'])}")
            print(f"  {'':16s}   val macroF1 {b['val_macro_f1']:.4f} acc {b['val_acc']:.4f} | "
                  f"TEST macroF1 {b['test_macro_f1']:.4f} acc {b['test_acc']:.4f} "
                  f"bal {b['test_bal']:.4f}")
        base = [r for r in rr if r["arm"] == "baseline"]
        if base:
            b0 = base[0]
            for arm, g in groups.items():
                if arm in ("baseline", "teacher_h14_mlp"):
                    continue
                b = best(g)
                print(f"  delta {arm:14s} vs baseline (test macroF1): "
                      f"{b['test_macro_f1']-b0['test_macro_f1']:+.4f} "
                      f"(val-selected cfg {json.dumps(b['cfg'])})")
        orc = best(rr, "test_macro_f1")
        sel = best([r for r in rr if r["arm"] != "teacher_h14_mlp"])
        print(f"  ORACLE test macroF1 {orc['test_macro_f1']:.4f} {json.dumps(orc['cfg'])} "
              f"| val-selected {sel['test_macro_f1']:.4f} {json.dumps(sel['cfg'])} "
              f"| gap {orc['test_macro_f1']-sel['test_macro_f1']:+.4f}")
        pb = best([r for r in rr if r["arm"] == "baseline"])
        print("  per-class recall, val-selected arm:")
        print("   ", json.dumps({k: {"n": v["n"], "r": None if v["recall"] is None else round(v["recall"], 3)}
                                 for k, v in b["test_per_class"].items()}))
        print("   baseline:")
        print("   ", json.dumps({k: {"n": v["n"], "r": None if v["recall"] is None else round(v["recall"], 3)}
                                 for k, v in pb["test_per_class"].items()}))


if __name__ == "__main__":
    main()
