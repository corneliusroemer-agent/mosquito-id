#!/usr/bin/env python3
"""Bootstrap CIs (best arm vs baseline), per-class recall, and the markdown table."""
import json, pathlib, sys
import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import common  # noqa: E402

R = json.load(open(HERE / "aug_results.json"))
base, arms = R["baseline"], R["arms"]


def tbl(res, t):
    s = res[t]
    return (s["test"]["macro_f1"], s["test"]["bal_acc"], s["test"]["acc"],
            s["val"]["macro_f1"], s["wd"])


def f1(k):
    return common.f1_fn(k)


def main():
    best = None
    for name, res in arms.items():
        for t in ("genus4", "species9"):
            v = res[t]["test"]["macro_f1"]
            if best is None or v > best[2]:
                best = (name, t, v)
    print("best arm by test macro-F1:", best)

    lines = []
    hdr = ("| arm | n_fit | wd | genus4 val F1 | genus4 test F1 | genus4 balAcc | genus4 acc "
           "| species9 val F1 | species9 test F1 | species9 balAcc | species9 acc |")
    lines += [hdr, "|---|---|---|---|---|---|---|---|---|---|---|"]
    for label, res in [("**baseline (clean)**", base)] + [
            (f"**+ {k}**", v) for k, v in arms.items()]:
        g, s = res["genus4"], res["species9"]
        lines.append(
            f"| {label} | {g['n_train_fit']} | {g['wd']:g} | {g['val']['macro_f1']:.4f} | "
            f"{g['test']['macro_f1']:.4f} | {g['test']['bal_acc']:.4f} | {g['test']['acc']:.4f} | "
            f"{s['val']['macro_f1']:.4f} | {s['test']['macro_f1']:.4f} | {s['test']['bal_acc']:.4f} | "
            f"{s['test']['acc']:.4f} |")

    # bootstrap: each arm vs baseline, per task
    cis = {}
    for name, res in arms.items():
        cis[name] = {}
        for t in ("genus4", "species9"):
            k = res[t]["k"]
            yb = np.array(base[t]["test_y"]); pb = np.array(base[t]["test_pred"])
            ya = np.array(res[t]["test_y"]); pa = np.array(res[t]["test_pred"])
            cis[name][t] = common.paired_boot_scalar(yb, pb, pa, f1(k), reps=2000)
    out = {"best_by_test_macro_f1": best, "paired_boot_macro_f1_arm_minus_baseline": cis,
           "table_rows": lines}
    json.dump(out, open(HERE / "aug_analysis.json", "w"), indent=1)

    # per-class recall on species9, baseline vs best arm
    bestname = best[0]
    pc = {}
    for label, res in [("baseline", base), (bestname, arms[bestname])]:
        pc[label] = res["species9"]["test"]["per_class"]
    json.dump(pc, open(HERE / "aug_per_class_species9.json", "w"), indent=1)

    print("\n".join(lines))
    print()
    for n, d in cis.items():
        print(f"{n:12s} genus4 {d['genus4'][0]:+.4f} [{d['genus4'][1]:+.4f},{d['genus4'][2]:+.4f}]  "
              f"species9 {d['species9'][0]:+.4f} [{d['species9'][1]:+.4f},{d['species9'][2]:+.4f}]")
    print("\nper-class species9 (test):")
    for c in pc["baseline"]:
        b = pc["baseline"][c]; a = pc[bestname][c]
        print(f"  {c:20s} n={b['n']:4d}  base={b['recall']:.3f}  {bestname}={a['recall']:.3f}")


if __name__ == "__main__":
    main()
