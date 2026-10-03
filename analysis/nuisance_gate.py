"""What would a 'this is not a mosquito' gate need? (measurement only, no change)

The app computes nuP - the nuisance posterior of the fused views - uses it at
main.js:1464 to decide whether to keep the detector crop, and then throws it
away. Nothing downstream can act on it, so a photo of a wall is ranked as
confidently as a photo of a mosquito.

Two numbers decide whether a gate can be fitted at all, and this measures the
one that is measurable:

  1. the nuisance posterior's distribution over TRUE mosquitoes. Any threshold
     below the top of that distribution rejects mosquitoes the app currently
     accepts, so it is a floor on where the gate may sit.
  2. the same distribution over non-mosquitoes - which sets where it may sit
     above.

Only (1) is measurable here. The 6,264-row cache is four sources, six species,
zero negatives, and the classifier that would produce a nuisance posterior for a
wall is not runnable in this container. So this reports (1) and states plainly
that (2) is missing, rather than quoting a false-positive rate derived from
mosquito-only rows.
"""
import csv, json
import numpy as np

EMB = json.load(open('text_embeds.json'))
SP = np.array(EMB['species_emb'], np.float64).reshape(16, -1)
NU = np.array(EMB['nuisance_emb'], np.float64).reshape(8, -1)
SP /= np.linalg.norm(SP, axis=1, keepdims=True); NU /= np.linalg.norm(NU, axis=1, keepdims=True)
A24 = np.concatenate([SP, NU]); SCALE = EMB['logit_scale'] / 2.5

for label, cache in (
    ('6,264-image cache (H/14, whole photo)',
     '/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/50-h14-scale/cache'),
    ('180-row two-view benchmark, whole frame (asis)',
     None)):
    if cache is None:
        EB = '/workspaces/claude-devcontainer/investigations/2026-10-02-mosquito-id/07-benchmark/results/emb'
        E = np.load(f'{EB}/bioclip25__asis.npy').astype(np.float64)
        rows = list(csv.DictReader(open('/workspaces/claude-devcontainer/investigations/2026-10-02-mosquito-id/07-benchmark/data/manifest.tsv'), delimiter='\t'))
        src = np.array([r['source'] for r in rows])
    else:
        E = np.load(f'{cache}/embeddings.npy').astype(np.float64)
        rows = list(csv.DictReader(open(f'{cache}/rows.tsv'), delimiter='\t'))
        src = np.array([r['source_dataset'] for r in rows])
        assert len(E) == len(rows), (len(E), len(rows))
    E /= np.linalg.norm(E, axis=1, keepdims=True)
    s = (E @ A24.T) * SCALE
    m = s.max(1, keepdims=True)
    p = np.exp(s - m); p /= p.sum(1, keepdims=True)
    nu = p[:, 16:].sum(1)
    q = np.percentile(nu, [50, 90, 99, 99.9, 100])
    print(f'\n{label}   n={len(nu)}')
    print(f'  nuisance mass  median {q[0]:.2e}  p90 {q[1]:.2e}  p99 {q[2]:.2e}  '
          f'p99.9 {q[3]:.2e}  max {q[4]:.4f}')
    for t in (1e-3, 1e-2, 0.05, 0.10, 0.20, 0.30, 0.50):
        print(f'  a gate at nuP >= {t:<5} would drop {100*(nu >= t).mean():6.3f}%  ({int((nu>=t).sum())} of {len(nu)} true mosquitoes)')
    if cache is None:
        for s_ in sorted(set(src.tolist())):
            k = src == s_
            print(f'    {s_:<24} n={int(k.sum()):4d}  max nuP {nu[k].max():.4f}')
