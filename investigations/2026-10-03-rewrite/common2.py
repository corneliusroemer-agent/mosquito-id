"""Shared harness for the B/16 fine-tune + culico fusion pass on the 14,072-row corpus.

Everything here is either lifted from probe-rerun/probe.py (split, probe, metrics -- so the
frozen-feature baseline is measured by *the same code* as the 82.99 / 69.33 numbers) or added
for this pass (contamination tiers, per-task masks, group bootstrap).
"""
from __future__ import annotations

import csv, collections, re
import numpy as np

# A specimen is one specimen however many feeds republish it, and `split_group` names it by feed:
# `gbif:<key>` for the gbif_sweep collection and `uuid:<key>` for base_gbif carry the same GBIF
# occurrence key, and `maapi:<uuid>` / `madump:<uuid>` carry the same Mosquito-Alert specimen
# uuid.  148 occurrences and 178 BioCLIP-cache specimens appear under both of their names, so
# they straddle the split while `leak_check` on the raw string reports zero -- and the
# maapi/madump pair is invisible to a label-contradiction check, since both rows carry the same
# label.  Canonicalise before splitting.
#
# The prefix is stripped, not matched against a list of namespaces: a whitelist misses the next
# feed to republish a specimen, which is the exact failure this replaces.  `gbif:` is kept as the
# canonical prefix so the uuid/gbif keys are byte-identical to what earlier runs produced.
_NAMESPACE_GROUP = re.compile(r'^(?:uuid|gbif):(\d+)$')   # numeric GBIF occurrence key
_ANY_NAMESPACE = re.compile(r'^[^:]+:(.+)$')               # any other `<namespace>:<suffix>`


def canon_group(s):
    m = _NAMESPACE_GROUP.match(s)
    if m:
        return 'gbif:' + m.group(1)
    m = _ANY_NAMESPACE.match(s)
    return m.group(1) if m else s

import os as _os
HERE = _os.environ.get('B16FT_HERE', '/workspaces/claude-devcontainer/scratch/2026-10-04-b16-ft/work')
POOL = '/workspaces/claude-devcontainer/scratch/2026-10-04-probe-rerun/pool.tsv'
FEAT = '/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/99-feature-cache'
SEED = 0

GENUS4 = ['aedes', 'anopheles', 'culex', 'culiseta']
BARE_GENUS = ['culex', 'culiseta', 'anopheles']   # 2,084 rows the 16-column head cannot name


def load():
    rows = list(csv.DictReader(open(POOL), delimiter='\t'))
    tier = {r['uid']: r['tier'] for r in csv.DictReader(open(f'{HERE}/cache/tiers.tsv'),
                                                        delimiter='\t')}
    for r in rows:
        r['tier2'] = tier[r['uid']]
        r['genus'] = r['label'].split()[0]
        r['group_canon'] = canon_group(r['split_group'])
    species = sorted({r['label'] for r in rows if r['label'] not in BARE_GENUS})
    return rows, species, tier


def split_groups(rows, seed=SEED, frac=(0.6, 0.2, 0.2)):
    """Identical to probe-rerun/probe.py: 60/20/20 on whole specimen groups, per class."""
    rng = np.random.default_rng(seed)
    label = np.array([r['label'] for r in rows])
    grp = np.array([r['group_canon'] for r in rows])
    by_label = collections.defaultdict(set)
    for i, l in enumerate(label):
        by_label[l].add(grp[i])
    assign = {}
    for l in sorted(by_label):
        g = sorted(by_label[l])
        order = rng.permutation(len(g))
        n_tr, n_va = round(frac[0] * len(g)), round(frac[1] * len(g))
        for j, gg in enumerate(order):
            assign[g[gg]] = 'train' if j < n_tr else 'val' if j < n_tr + n_va else 'test'
    out = {'train': [], 'val': [], 'test': []}
    for i, gg in enumerate(grp):
        out[assign[gg]].append(i)
    return tuple(np.array(sorted(out[k])) for k in ('train', 'val', 'test'))


def leak_check(rows, tr, va, te):
    grp = np.array([r['group_canon'] for r in rows])
    lab = collections.defaultdict(set)
    for i, g in enumerate(grp):
        lab[g].add(rows[i]['label'])
    sets = [set(grp[ix].tolist()) for ix in (tr, va, te)]
    strad = (sets[0] & sets[1]) | (sets[0] & sets[2]) | (sets[1] & sets[2])
    return {'n_rows': len(rows), 'n_groups': len(lab), 'straddling_groups': len(strad),
            'straddling_rows': int(np.isin(grp, list(strad)).sum()) if strad else 0,
            'multi_label_groups': sum(1 for g in lab if len(lab[g]) > 1)}


def tasks(rows, species):
    """y arrays, -1 where the row is out of the task's scope. Scope is a property of the ROW,
    never of the tier, so a contaminated row is scored exactly where a clean one is."""
    y = {}
    y['genus4'] = np.array([GENUS4.index(r['genus']) for r in rows])
    ys = np.full(len(rows), -1)
    m = np.array([r['label'] not in BARE_GENUS for r in rows])
    ys[m] = [species.index(r['label']) for r, k in zip(rows, m) if k]
    y['species16'] = ys
    return y


# ---------------------------------------------------------------- metrics

def macro_f1(y, p, k):
    """Macro-F1 over the classes PRESENT in `y`.  A class with no rows has no recall and no
    precision to average in; scoring it 0.0 silently understates every macro-F1 computed on a
    subset, which is what the clean-only slices are."""
    f1, seen = [], 0
    for c in range(k):
        n = int((y == c).sum())
        if n == 0:
            continue
        seen += 1
        tp = int(((p == c) & (y == c)).sum()); fp = int(((p == c) & (y != c)).sum())
        fn = int(((p != c) & (y == c)).sum())
        f1.append(0.0 if tp == 0 else 2 * tp / (2 * tp + fp + fn))
    return float(np.mean(f1)) if f1 else float('nan')


def score(y, pred, k, classes=None):
    p = np.asarray(pred).argmax(1) if pred.ndim == 2 else pred
    rec, seen = {}, 0
    for c in range(k):
        n = int((y == c).sum())
        seen += 1 if n else 0
        rec[classes[c] if classes else str(c)] = [n, float((p[y == c] == c).mean()) if n else None]
    return {'n': int(len(y)), 'acc': float((p == y).mean()), 'macro_f1': macro_f1(y, p, k),
            'classes_scored': seen, 'per_class': rec}


def group_boot(y, grp, fn_a, fn_b, reps=2000, seed=SEED):
    """Paired bootstrap resampling whole specimen groups. fn_a/fn_b: (y, pred) -> scalar."""
    u = sorted(set(grp.tolist()))
    pos = {g: k for k, g in enumerate(u)}
    idx = np.array([pos[g] for g in grp])
    by = [np.where(idx == k)[0] for k in range(len(u))]
    rng = np.random.default_rng(seed)
    d = np.empty(reps)
    for b in range(reps):
        pick = rng.integers(0, len(u), len(u))
        sel = np.concatenate([by[k] for k in pick])
        d[b] = fn_b(y[sel], sel) - fn_a(y[sel], sel)
    return {'delta': float(d.mean()), 'lo': float(np.percentile(d, 2.5)),
            'hi': float(np.percentile(d, 97.5))}


def slices(rows, ix, y, k, pred, classes=None):
    """clean-only / all-rows scores on one split index set."""
    tier = np.array([rows[i]['tier2'] for i in ix])
    yy, pp = y[ix], (pred[ix].argmax(1) if pred.ndim == 2 else pred[ix])
    out = {'all': score(yy, pp, k, classes)}
    m = tier == 'clean'
    out['clean'] = score(yy[m], pp[m], k, classes) if m.any() else None
    out['n_all'], out['n_clean'] = int(m.sum()), int(m.sum())
    return out


# ---------------------------------------------------------------- headline metrics

def entropy_of(logp):
    """Mean predictive entropy in nats of a log-probability matrix.  The headline number:
    it charges for a distribution spread over classes, which accuracy and macro-F1 do not."""
    p = np.exp(logp - logp.max(1, keepdims=True))
    p /= p.sum(1, keepdims=True)
    return float(-(p * np.log(p + 1e-300)).sum(1).mean())


def full_score(y, logp, classes):
    """Every figure the brief asks for, on one slice.  `logp` is (n, k) log-probabilities,
    so entropy is defined; callers holding only predictions cannot report it."""
    from scipy.special import log_softmax
    logp = np.asarray(logp, np.float64)
    logp = log_softmax(logp, axis=1) if logp.min() < -1e8 or logp.max() > 0 else logp
    p = logp.argmax(1)
    k = logp.shape[1]
    n = len(y)
    rec = np.zeros(k)
    for c in range(k):
        m = y == c
        rec[c] = (p[m] == c).mean() if m.any() else np.nan
    bal = float(np.nanmean(rec))
    order = np.argsort(-logp, axis=1)
    top5 = float(np.mean([yy in oo[:5] for yy, oo in zip(y, order)])) if k > 5 else float('nan')
    return {'n': int(n), 'n_classes_present': int(sum(1 for c in range(k) if (y == c).any())),
            'entropy_nats': round(entropy_of(logp), 4),
            'acc': round(float((p == y).mean()), 4),
            'macro_f1': round(macro_f1(y, p, k), 4),
            'balanced_acc': round(bal, 4), 'top5': round(top5, 4)}


def boot_ci(y, grp, fn, reps=2000, seed=SEED):
    """Group bootstrap over whole specimen groups.  fn(y, rows) -> scalar for one metric."""
    u = sorted(set(grp.tolist())); pos = {g: j for j, g in enumerate(u)}
    idx = np.array([pos[g] for g in grp]); by = [np.where(idx == j)[0] for j in range(len(u))]
    rng = np.random.default_rng(seed); v = np.empty(reps)
    for i in range(reps):
        s = np.concatenate([by[j] for j in rng.integers(0, len(u), len(u))])
        v[i] = fn(y[s], s)
    return {'lo': round(float(np.percentile(v, 2.5)), 4),
            'hi': round(float(np.percentile(v, 97.5)), 4)}


def paired_boot(y, grp, fn_a, fn_b, reps=2000, seed=SEED):
    """CI on fn_b - fn_a, resampling whole specimen groups -- the paired form, so the two
    arms see the same resample and the correlation between them cancels."""
    u = sorted(set(grp.tolist())); pos = {g: j for j, g in enumerate(u)}
    idx = np.array([pos[g] for g in grp]); by = [np.where(idx == j)[0] for j in range(len(u))]
    rng = np.random.default_rng(seed); d = np.empty(reps)
    for i in range(reps):
        s = np.concatenate([by[j] for j in rng.integers(0, len(u), len(u))])
        d[i] = fn_b(y[s], s) - fn_a(y[s], s)
    return {'delta': round(float(d.mean()), 4), 'lo': round(float(np.percentile(d, 2.5)), 4),
            'hi': round(float(np.percentile(d, 97.5)), 4)}
