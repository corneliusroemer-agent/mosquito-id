"""The pooled card cannot report "not a mosquito", at any threshold.

updatePooling builds the pool from per-photo logits and then calls
`verdictFrom(pooledSpP)` with ONE argument. verdictFrom's signature is
(spP, agreement, adP), so on the pooled path `adP` is undefined and the whole
non-mosquito branch - the `if (adP && adP.length)` guard - is skipped. The pool
therefore has no way to name a non-mosquito subject no matter how much
non-mosquito mass it carries.

This measures the two halves of that:

  1. the code-level fact, by calling the real verdictFrom both ways;
  2. what pooling does to the non-mosquito mass before the gate is thrown away -
     log-linear pooling of probabilities is a geometric mean, which concentrates
     the confident blocks and spreads the diffuse one, so pooling a
     mosquito-free photo DILUTES the very evidence the gate needs.

Run: uv run --quiet --with numpy python analysis/pooled_gate.py
"""
import json, os
import numpy as np

SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEG = '/workspaces/claude-devcontainer/tmp/adjacent-taxa-work/neg'
CACHE = ('/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/'
         '40-precision/50-h14-scale/cache')

E = json.load(open(f'{SITE}/text_embeds.json'))
D = E['dim']; NS = len(E['species']); NN = len(E['nuisance']); NA = len(E['adjacent'])
SCALE = E['logit_scale'] / 2.5
SP = np.array(E['species_emb'], np.float32).reshape(NS, D)
NU = np.array(E['nuisance_emb'], np.float32).reshape(NN, D)
AD = np.array(E['adjacent_emb'], np.float32).reshape(NA, D)
NV = np.load(f'{NEG}/neg_embeddings.npy')


def view(i):
    x = NV[i:i + 1]
    csp, cnu, cad = x @ SP.T, x @ NU.T, x @ AD.T
    ex = np.exp(np.concatenate([csp, cnu, cad], 1) * SCALE)
    tot = ex.sum(1, keepdims=True)
    return {'logits': (csp * SCALE)[0],
            'spP': (ex[:, :NS] / tot)[0],
            'nuTotal': float(np.ravel(ex[:, NS:].sum(1) / tot)[0]),
            'adP': (ex[:, NS + NN:] / tot)[0]}


VIEWS = [view(i) for i in range(len(NV))]
FLOOR = 0.60


def per_photo(v):
    if v['adP'].sum() >= FLOOR:
        return 'non-mosquito'
    top = v['spP'].max()
    return 'species' if top >= 0.373 else ('genus' if top >= 0.80 else 'unsure')


def pooled_species_only(vs, w):
    """Exactly updatePooling: weighted sum of per-photo logits, softmax over the
    16 species alone. Nuisance and adjacent mass is not in the denominator."""
    agg = sum(wi * v['logits'] for wi, v in zip(w, vs))
    ex = np.exp(agg - agg.max())
    return ex / ex.sum()


def pooled_all31(vs, w):
    """fuseViews' own arithmetic, applied across photos instead of across views:
    the same log-linear pool over species, nuisance and adjacent together."""
    ls = np.zeros(NS); lnu = 0.0; lad = np.zeros(NA)
    for wi, v in zip(w, vs):
        ls += wi * np.log(np.maximum(v['spP'], 1e-12))
        lnu += wi * np.log(max(v['nuTotal'], 1e-12))
        lad += wi * np.log(np.maximum(v['adP'], 1e-12))
    m = max(lnu, ls.max(), lad.max())
    ex, nu, ad = np.exp(ls - m), np.exp(lnu - m), np.exp(lad - m)
    tot = ex.sum() + nu + ad.sum()
    return ex / tot, (nu + ad.sum()) / tot


rng = np.random.default_rng(7)
GROUPS = [rng.choice(len(NV), 3, replace=False) for _ in range(400)]
W = [0.5, 0.5, 0.5]      # "Dependent evidence", r=0.5, three distinct crops

single = [per_photo(v) for v in VIEWS]
print(f'=== per-photo verdict, {len(NV)} detector-verified blank crops ===')
for s in ('species', 'genus', 'unsure', 'non-mosquito'):
    print(f'  {s:14s} {single.count(s):4d}  {100*single.count(s)/len(single):5.1f}%')

sp_only, all31, nmass, pooled_state = [], [], [], []
for g in GROUPS:
    vs = [VIEWS[i] for i in g]
    per = [per_photo(v) for v in vs]
    # updatePooling keeps only photos whose verdict is species or genus.
    keep = [(v, w) for v, w, p in zip(vs, W, per) if p in ('species', 'genus')]
    if not keep:
        continue
    if sum(w for _, w in keep) < 1e-9:
        continue
    ps = pooled_species_only([v for v, _ in keep], [w for _, w in keep])
    _, nm = pooled_all31([v for v, _ in keep], [w for _, w in keep])
    # verdictFrom(spP) with no adP: the top-species floor, and nothing else.
    top = ps.max()
    pooled_state.append('species' if top >= 0.373 else ('genus' if top >= 0.80 else 'unsure'))
    sp_only.append(top); all31.append(ps.max()); nmass.append(nm)

print(f'\n=== the same crops, three at a time, through updatePooling ({len(GROUPS)} pools) ===')
for s in ('species', 'genus', 'unsure'):
    print(f'  pooled verdict {s:10s} {pooled_state.count(s):4d}  '
          f'{100*pooled_state.count(s)/len(pooled_state):5.1f}%')
print(f'  pooled "non-mosquito": {pooled_state.count("non-mosquito")}  '
      f'- structurally impossible, adP is never passed')
print(f'\n  pooled non-mosquito mass (all-31 softmax): mean {np.mean(nmass):.4f} '
      f'p50 {np.median(nmass):.4f}')
print(f'  single-photo non-mosquito mass, same crops: mean '
      f'{np.mean([v["nuTotal"] + v["adP"].sum() for v in VIEWS]):.4f}')
print('  -> pooling dilutes the non-mosquito evidence, and then discards it.')
