"""What the whole-frame view is worth, and what turning it off costs.

The app fuses two views of every cropped photo - the detector crop (`det`) and
the whole frame (`asis`) - and the whole frame is now optional. This measures
both states on the only labelled two-view cache there is: the 07-benchmark's 180
rows, each embedded by the shipped BioCLIP-2.5 ViT-H/14 with the app's own
16-species + 8-nuisance head and its own `logit_scale`. That is exactly the pair
of views `fuseViews` pools, and exactly the pair the toggle decides between.

The fusion reproduces `src/confidence/fuseViews.ts`: log-linear over the species
block, the nuisance mass pooled separately, one renormalisation over the two
together. The floor rule is the app's: species floor, else genus floor, else
`unsure`.

WHAT THIS CANNOT MEASURE, and it is the half that matters for `non-mosquito`:
every one of the 180 rows is a photograph of a mosquito. So the abstain rate and
the accuracy of what is said are measurable, and the false-positive side - how
often a crop-only photo names a species where the crop-and-frame pair would have
refused it - is not. That number needs a labelled negative set with both views
embedded, which does not exist. Quoting one here would be fiction.

Run from anywhere:

    uv run --with numpy python3 analysis/whole_frame_ablation.py
"""
import csv
import json
import os

import numpy as np

ROOT_SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = '/workspaces/claude-devcontainer'
EB = f'{ROOT}/investigations/2026-10-02-mosquito-id/07-benchmark/results/emb'
MAN = f'{ROOT}/investigations/2026-10-02-mosquito-id/07-benchmark/data/manifest.tsv'
TEMPERATURE = 2.5
SPEC_FLOOR, GENUS_FLOOR = 0.373, 0.80

EMB = json.load(open(f'{ROOT_SITE}/public/text_embeds.json'))
SP = np.array(EMB['species_emb'], np.float64).reshape(16, -1)
NU = np.array(EMB['nuisance_emb'], np.float64).reshape(8, -1)
SP /= np.linalg.norm(SP, axis=1, keepdims=True)
NU /= np.linalg.norm(NU, axis=1, keepdims=True)
A24 = np.concatenate([SP, NU])
SCALE = EMB['logit_scale'] / TEMPERATURE
GEN = np.array([n.split()[0] for n in EMB['species']])
GGEN = sorted(set(GEN.tolist()))

# gt_class slug -> the genus it covers. Asserted complete below rather than
# parsed: `culex` must not fall through to something that happens to be a genus.
SLUG = {'albopictus': 'Aedes', 'aegypti': 'Aedes', 'japonicus-koreicus': 'Aedes',
        'vexans': 'Aedes', 'geniculatus': 'Aedes', 'aedes_aegypti': 'Aedes',
        'aedes_albopictus': 'Aedes', 'aedes_geniculatus': 'Aedes',
        'aedes_koreicus': 'Aedes', 'aedes_vexans': 'Aedes',
        'culex': 'Culex', 'culex_pipiens': 'Culex', 'culex_quinquefasciatus': 'Culex',
        'culiseta': 'Culiseta', 'culiseta_longiareolata': 'Culiseta',
        'culiseta_annulata': 'Culiseta', 'anopheles': 'Anopheles'}


def index(f):
    return {r['path'].split('/')[-1]: int(r['idx'])
            for r in csv.DictReader(open(f'{EB}/{f}.files.tsv'), delimiter='\t')}


asis, det = index('bioclip25__asis'), index('bioclip25__det')
EA = np.load(f'{EB}/bioclip25__asis.npy').astype(np.float64)
ED = np.load(f'{EB}/bioclip25__det.npy').astype(np.float64)
man = list(csv.DictReader(open(MAN), delimiter='\t'))
unmapped = sorted({r['gt_class'] for r in man} - set(SLUG))
assert not unmapped, f'unmapped gt_class: {unmapped}'

rows = []
for r in man:
    b = next((c for c in (r['img_id'] + '.jpg', r['det_path'].split('/')[-1])
              if c in asis and c in det), None)
    if b:
        rows.append((r, asis[b], det[b]))
assert len(rows) == len(man), f'join lost rows: {len(rows)}/{len(man)}'


def post(idx, X):
    Z = X[idx]
    Z = Z / np.linalg.norm(Z, axis=1, keepdims=True)
    s = (Z @ A24.T) * SCALE
    m = s.max(1, keepdims=True)
    p = np.exp(s - m)
    p /= p.sum(1, keepdims=True)
    return p[:, :16], p[:, 16:].sum(1)


ia = np.array([x[1] for x in rows])
idt = np.array([x[2] for x in rows])
spA, nuA = post(ia, EA)
spD, nuD = post(idt, ED)
truegen = np.array([SLUG[r['gt_class']] for r, _, _ in rows])


def fuse(views):
    """views: list of (spP, nuTotal). fuseViews' arithmetic, vectorised."""
    ls = sum(np.log(np.maximum(v[0], 1e-12)) for v in views)
    ln = sum(np.log(np.maximum(v[1], 1e-12)) for v in views)
    mx = np.maximum(ln[:, None], ls).max(1)
    ex = np.exp(ls - mx[:, None])
    nu = np.exp(ln - mx)
    spP = ex / (ex.sum(1, keepdims=True) + nu[:, None])
    gP = np.stack([spP[:, np.where(GEN == g)[0]].sum(1) for g in GGEN], 1)
    state = np.where(spP.max(1) >= SPEC_FLOOR, 'species',
                     np.where(gP.max(1) >= GENUS_FLOOR, 'genus', 'unsure'))
    return spP, state


def report(name, spP, state):
    top = spP.argmax(1)
    ok = np.array([GEN[i] for i in top]) == truegen
    answered = state != 'unsure'
    print(f'{name:>26}  genus acc={ok.mean() * 100:5.1f}%  '
          f'answered={answered.mean() * 100:5.1f}%  '
          f'abstained={(~answered).mean() * 100:5.1f}%  '
          f'acc|answered={ok[answered].mean() * 100:5.1f}%')


print(f'rows {len(rows)}  (every row is a true mosquito; no negatives in this corpus)\n')
print('--- the two states, whole frame on vs off ---')
sp_fused, st_fused = fuse([(spA, nuA), (spD, nuD)])
sp_crop, st_crop = fuse([(spD, nuD)])
report('whole frame ON (2 views)', sp_fused, st_fused)
report('whole frame OFF (crop)', sp_crop, st_crop)

print('\n--- per-row movement, OFF relative to ON ---')
moved_abstain = (st_fused != 'unsure') & (st_crop == 'unsure')
moved_answer = (st_fused == 'unsure') & (st_crop != 'unsure')
print(f'  answered ON, abstained OFF   {moved_abstain.sum():3d} of {len(rows)}')
print(f'  abstained ON, answered OFF   {moved_answer.sum():3d} of {len(rows)}')
flip = (np.array([GEN[i] for i in sp_fused.argmax(1)]) !=
        np.array([GEN[i] for i in sp_crop.argmax(1)]))
print(f'  genus changed                {flip.sum():3d} of {len(rows)}')
lost = flip & (st_fused != 'unsure') & (st_crop != 'unsure')
print(f'  ... and both still answered  {lost.sum():3d} of {len(rows)}')

print('\n--- restricted to crops the app would keep ---')
# classifyImage keeps the crop only when the best species on it beats the best
# nuisance class, and reverts to the whole frame otherwise. A crop-only photo is
# therefore always a crop that passed that gate, so the crop-only column above
# includes rows the app would never score that way. This is the honest subset.
kept = spD.max(1) >= nuD
print(f'  crops passing the gate: {int(kept.sum())} of {len(rows)}')
for label, sp, st in (('whole frame ON ', sp_fused, st_fused),
                      ('whole frame OFF', sp_crop, st_crop)):
    top = sp[kept].argmax(1)
    ok = np.array([GEN[i] for i in top]) == truegen[kept]
    answered = st[kept] != 'unsure'
    print(f'{label}  genus acc={ok.mean() * 100:5.1f}%  '
          f'answered={answered.mean() * 100:5.1f}%  '
          f'abstained={(~answered).mean() * 100:5.1f}%  '
          f'acc|answered={ok[answered].mean() * 100:5.1f}%')

print('\n--- nuisance mass, the gate\'s evidence ---')
for label, nu in (('whole frame ON ', nuA), ('  crop view only', nuD)):
    print(f'{label}  median={np.median(nu):.2e}  p99={np.quantile(nu, 0.99):.2e}  max={nu.max():.3f}')
nu_fused, _ = fuse([(spA, nuA), (spD, nuD)])
print(f'  fused        median={np.median(nu_fused):.2e}  p99={np.quantile(nu_fused, 0.99):.2e}  max={nu_fused.max():.3f}')