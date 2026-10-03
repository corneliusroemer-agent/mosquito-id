"""Shared harness for the distillation-frontier work on culico-net-cls-v1 (21M, browser-runnable).

Design decisions that every number in this directory depends on:

  * The split is grouped on the specimen **uuid**, never on `group_key`. `group_key` is
    `<source_dataset>:<uuid>`, so a specimen ingested by both `ma/` and `ma_api/` gets two keys and
    178 specimens (6,264 keys / 6,086 uuids) would leak. `leak_check()` prints the count and the
    number of straddling rows on every run; both must be 0.

  * Labels are `../97-relabel/92-corrected-corpus.tsv`, so a row Mosquito Alert identifies to
    genus rank is scored as that genus, not credited at species.

  * Tasks. `genus4` is the 4 genera over all 6,264 rows. `species9` is the 9 classes the corpus
    actually names, over all 6,264 rows -- three of which are genus-rank, so this is the task the
    app faces. `aedes4` is the 4 Aedes species, restricted to Aedes rows, and exists only for
    comparability with the readout table in ../95-distillation/91-distillation-pilot.md.

  * Primary metrics are **macro-F1** and balanced accuracy, never raw accuracy: 4,152 of 6,264
    rows (66.3%) are genus-rank, and a micro average hides a sacrificed class. `A. koreicus` has
    112 rows corpus-wide and ~23 in test, so nothing is claimed from its per-class recall.

  * fp32 throughout.

  * Fit on train, select on val, read test once per pre-declared configuration.
"""
from __future__ import annotations

import csv
import json
import pathlib
from collections import defaultdict

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
PREC = HERE.parent
CACHE = PREC / "50-h14-scale" / "cache"
CULICO = PREC / "95-distillation" / "culico_features.npy"
CORPUS = PREC / "97-relabel" / "92-corrected-corpus.tsv"
SEED = 0

GENUS4 = ["Aedes", "Anopheles", "Culex", "Culiseta"]
SPECIES9 = ["Aedes aegypti", "Aedes albopictus", "Aedes japonicus", "Aedes koreicus",
            "Anopheles", "Culex", "Culiseta", "Culiseta annulata", "Culiseta longiareolata"]
AEDES4 = ["Aedes aegypti", "Aedes albopictus", "Aedes japonicus", "Aedes koreicus"]


def _genus(name: str) -> str:
    return name.split()[0]


def load_rows():
    """The 6,264-row corpus, with the corrected label and the provenance tier attached."""
    rows = list(csv.DictReader(open(CORPUS), delimiter="\t"))
    for r in rows:
        r["species"] = r["corrected_species"]
        r["genus"] = _genus(r["species"])
        r["uuid"] = r["group_key"].split(":", 1)[1]
    return rows


def uuid_split(rows, seed=SEED, frac=(0.6, 0.2, 0.2)):
    """60/20/20, stratified by species, assigned per uuid. Same rule as ../95-distillation/split.py."""
    rng = np.random.default_rng(seed)
    species = np.array([r["species"] for r in rows])
    uuid = np.array([r["uuid"] for r in rows])
    by_species = defaultdict(list)
    for i, sp in enumerate(species):
        by_species[sp].append(i)
    tr, va, te = [], [], []
    for sp, ii in sorted(by_species.items()):
        ii = sorted(ii, key=lambda i: uuid[i])
        uu = sorted({uuid[i] for i in ii})
        order = rng.permutation(len(uu))
        n = len(uu)
        n_tr, n_va = round(frac[0] * n), round(frac[1] * n)
        assign = {uu[order[j]]: ("train" if j < n_tr else "val" if j < n_tr + n_va else "test")
                  for j in range(n)}
        for i in ii:
            {"train": tr, "val": va, "test": te}[assign[uuid[i]]].append(i)
    return np.array(sorted(tr)), np.array(sorted(va)), np.array(sorted(te))


def leak_check(rows, tr, va, te):
    uuid = np.array([r["uuid"] for r in rows])
    sets = {"train": set(uuid[tr].tolist()), "val": set(uuid[va].tolist()), "test": set(uuid[te].tolist())}
    strad = (sets["train"] & sets["val"]) | (sets["train"] & sets["test"]) | (sets["val"] & sets["test"])
    lab = defaultdict(set)
    for i, u in enumerate(uuid):
        lab[u].add(rows[i]["species"])
    return {"n_rows": len(rows), "n_uuids": len(lab),
            "n_group_keys": len({r["group_key"] for r in rows}),
            "straddling_uuids": len(strad),
            "straddling_rows": int(np.isin(uuid, list(strad)).sum()) if strad else 0,
            "multi_label_uuids": sum(1 for u in lab if len(lab[u]) > 1)}


def culico_features(l2=True):
    F = np.load(CULICO).astype(np.float32)
    if l2:
        F /= np.linalg.norm(F, axis=1, keepdims=True)
    return F


def h14_features(l2=True):
    F = np.load(CACHE / "embeddings.npy").astype(np.float32)
    if l2:
        F /= np.linalg.norm(F, axis=1, keepdims=True)
    return F


def tasks(rows):
    """task name -> dict(classes, mask, y) with y = -1 off-mask."""
    sp = np.array([r["species"] for r in rows])
    gen = np.array([r["genus"] for r in rows])
    out = {}
    out["genus4"] = dict(classes=GENUS4, mask=np.ones(len(rows), bool),
                         y=np.array([GENUS4.index(g) for g in gen]))
    out["species9"] = dict(classes=SPECIES9, mask=np.ones(len(rows), bool),
                           y=np.array([SPECIES9.index(s) for s in sp]))
    m = np.isin(sp, AEDES4)
    y = np.full(len(rows), -1)
    y[m] = [AEDES4.index(s) for s in sp[m]]
    out["aedes4"] = dict(classes=AEDES4, mask=m, y=y)
    return out


# ---------------------------------------------------------------- metrics


def macro_f1(y, p, k):
    f1s = []
    for c in range(k):
        tp = int(((p == c) & (y == c)).sum())
        fp = int(((p == c) & (y != c)).sum())
        fn = int(((p != c) & (y == c)).sum())
        f1s.append(0.0 if tp == 0 else 2 * tp / (2 * tp + fp + fn))
    return float(np.mean(f1s))


def balanced_acc(y, p, k):
    rec = []
    for c in range(k):
        n = int((y == c).sum())
        if n:
            rec.append(float((p[y == c] == c).mean()))
    return float(np.mean(rec)), rec


def per_class_recall(y, p, classes):
    out = {}
    for c, name in enumerate(classes):
        n = int((y == c).sum())
        out[name] = {"n": n, "recall": float((p[y == c] == c).mean()) if n else None}
    return out


def score(y, pred_logit, classes):
    """pred_logit: (n, k) scores. argmax -> all headline metrics."""
    y = np.asarray(y)
    p = pred_logit.argmax(1)
    k = len(classes)
    b, rec = balanced_acc(y, p, k)
    return {"acc": float((p == y).mean()), "macro_f1": macro_f1(y, p, k),
            "bal_acc": b, "per_class": per_class_recall(y, p, classes)}


def boot_ci(y, sa, sb, fn, reps=2000, seed=SEED):
    """Paired bootstrap over test rows for a scalar metric. sa/sb are score dicts' inputs."""
    rng = np.random.default_rng(seed)
    n = len(y)
    d = []
    for _ in range(reps):
        i = rng.integers(0, n, n)
        d.append(fn(sa[i], sb[i]) - fn(sa[i], sb[i]))  # placeholder, replaced below
    return d


def paired_boot_scalar(y, pa, pb, fn, reps=2000, seed=SEED):
    """fn(y, pred) -> scalar. Returns (mean_delta, lo, hi) of fn(B) - fn(A) over resampled rows."""
    rng = np.random.default_rng(seed)
    n = len(y)
    d = np.empty(reps)
    for b in range(reps):
        i = rng.integers(0, n, n)
        d[b] = fn(y[i], pb[i]) - fn(y[i], pa[i])
    return float(d.mean()), float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))


def f1_fn(k):
    return lambda y, p: macro_f1(y, p, k)


def acc_fn(y, p):
    return float((y == p).mean())


def tier_mix(rows, idx):
    c = defaultdict(int)
    for i in idx:
        c[rows[i]["tier"]] += 1
    return dict(sorted(c.items(), key=lambda kv: -kv[1]))


def species_tier_mix(rows, idx):
    """Tier mix restricted to species-rank rows -- the only rows a species metric is about."""
    c = defaultdict(int)
    for i in idx:
        r = rows[i]
        if r["ma_taxon_rank"] == "species":
            c[r["tier"]] += 1
    return dict(sorted(c.items(), key=lambda kv: -kv[1]))
