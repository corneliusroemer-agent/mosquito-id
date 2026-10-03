"""What is a two-view disagreement worth? Fit an abstention threshold on val.

The only labelled two-view cache is the 07-benchmark one: 180 rows, embeddings
for the detector crop (`det`) and the whole frame (`asis`) of each, from the
shipped BioCLIP-2.5 ViT-H/14 with the app's own 16-species + 8-nuisance head and
its own logit_scale. That is exactly the pair of views main.js fuses.

Scored at GENUS, not species: gt_class is one of ten benchmark slugs, and a slug
like `culex` or `culiseta` covers several species, so "did the head pick the slug's
representative species" is not a question the corpus can answer. Genus is also what
the genus floor makes a claim about.

Split 60/20/20 by source:class group, seed 0 - the same split discipline
calibrate.py used for SPECIES_CONFIDENCE_FLOOR. The threshold is read off val and
scored once on test.
"""
import csv, json
import numpy as np

ROOT = '/workspaces/claude-devcontainer'
EB = f'{ROOT}/investigations/2026-10-02-mosquito-id/07-benchmark/results/emb'
MAN = f'{ROOT}/investigations/2026-10-02-mosquito-id/07-benchmark/data/manifest.tsv'
TEMPERATURE, SEED = 2.5, 0
SPEC_FLOOR, GENUS_FLOOR = 0.373, 0.80

EMB = json.load(open('text_embeds.json'))
SP = np.array(EMB['species_emb'], np.float64).reshape(16, -1)
NU = np.array(EMB['nuisance_emb'], np.float64).reshape(8, -1)
SP /= np.linalg.norm(SP, axis=1, keepdims=True); NU /= np.linalg.norm(NU, axis=1, keepdims=True)
NAMES = EMB['species']
A24 = np.concatenate([SP, NU]); SCALE = EMB['logit_scale'] / TEMPERATURE
GEN = np.array([n.split()[0] for n in NAMES])
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

files = lambda f: {r['path'].split('/')[-1]: int(r['idx'])
                   for r in csv.DictReader(open(f'{EB}/{f}.files.tsv'), delimiter='\t')}
asis, det = files('bioclip25__asis'), files('bioclip25__det')
EA = np.load(f'{EB}/bioclip25__asis.npy').astype(np.float64)
ED = np.load(f'{EB}/bioclip25__det.npy').astype(np.float64)
man = list(csv.DictReader(open(MAN), delimiter='\t'))
unmapped = sorted({r['gt_class'] for r in man} - set(SLUG))
assert not unmapped, f'unmapped gt_class: {unmapped}'

rows = []
for r in man:
    b = next((c for c in (r['img_id'] + '.jpg', r['det_path'].split('/')[-1])
              if c in asis and c in det), None)
    if b: rows.append((r, asis[b], det[b]))
assert len(rows) == len(man), f'join lost rows: {len(rows)}/{len(man)}'

def post(idx, X):
    Z = X[idx]; Z = Z / np.linalg.norm(Z, axis=1, keepdims=True)
    s = (Z @ A24.T) * SCALE; m = s.max(1, keepdims=True)
    p = np.exp(s - m); p /= p.sum(1, keepdims=True)
    return p[:, :16], p[:, 16:].sum(1)

ia = np.array([x[1] for x in rows]); idt = np.array([x[2] for x in rows])
spA, nuA = post(ia, EA); spD, nuD = post(idt, ED)

# fuseViews: log-linear over species, nuisance mass pooled separately, one renorm.
ls = np.log(np.maximum(spA, 1e-12)) + np.log(np.maximum(spD, 1e-12))
ln = np.log(np.maximum(nuA, 1e-12)) + np.log(np.maximum(nuD, 1e-12))
mx = np.maximum(ln[:, None], ls).max(1)
ex = np.exp(ls - mx[:, None]); nu = np.exp(ln - mx)
spP = ex / (ex.sum(1, keepdims=True) + nu[:, None])

top = spP.argmax(1)
topgen = np.array([GEN[i] for i in top])
gP = np.stack([spP[:, np.where(GEN == g)[0]].sum(1) for g in GGEN], 1)
truegen = np.array([SLUG[r['gt_class']] for r, _, _ in rows])
ok = topgen == truegen

ranked = np.sort(spP, 1)[:, ::-1]
margin = (ranked[:, 0] - ranked[:, 1]) * 100
agree = (spA.argmax(1) == top) & (spD.argmax(1) == top)
# What the app ships today: species floor, else genus floor, else unsure.
state = np.where(spP.max(1) >= SPEC_FLOOR, 'species',
        np.where(gP.max(1) >= GENUS_FLOOR, 'genus', 'unsure'))
correct = ok & (state != 'unsure')   # a claim counts right only if it was made

grp = np.array([f"{r['source']}:{r['gt_class']}" for r, _, _ in rows])
rng = np.random.default_rng(SEED); assign = {}
for c in sorted(set(grp.tolist())):
    g = np.array([i for i in range(len(rows)) if grp[i] == c])
    g = g[rng.permutation(len(g))]; k = len(g)
    for x in g[:int(.6 * k)]: assign[x] = 'train'
    for x in g[int(.6 * k):int(.8 * k)]: assign[x] = 'val'
    for x in g[int(.8 * k):]: assign[x] = 'test'
part = np.array([assign[i] for i in range(len(rows))])
VA, TE = part == 'val', part == 'test'
print(f'rows {len(rows)}  train {int((part=="train").sum())}  val {int(VA.sum())}  test {int(TE.sum())}')
print(f'genus accuracy: asis {ok.mean() if False else (np.array([GEN[i] for i in spA.argmax(1)])==truegen).mean():.3f}'
      f'  det {(np.array([GEN[i] for i in spD.argmax(1)])==truegen).mean():.3f}  fused {ok.mean():.3f}')

def line(mask, label):
    n = int(mask.sum())
    if not n: return f'{label:>26}  n=0'
    ans = mask & (state != 'unsure')
    return (f'{label:>26}  n={n:3d}  genus acc={ok[mask].mean()*100:5.1f}%'
            f'  answered={100*ans.sum()/n:5.1f}%  acc|answered={correct[mask & (state!="unsure")].mean()*100 if ans.sum() else float("nan"):5.1f}%')

print('\n--- agreement splits the accuracy ---')
for nm, m in (('val', VA), ('test', TE), ('all', np.ones(len(rows), bool))):
    print(line(m & agree, f'{nm} views agree'))
    print(line(m & ~agree, f'{nm} views disagree'))

print('\n--- fused margin (pts), disagreeing rows: genus accuracy above a cut ---')
for nm, m in (('val', VA & ~agree), ('test', TE & ~agree)):
    cells = []
    for t in (1, 2, 3, 5, 10, 20, 30):
        k = m & (margin >= t)
        cells.append(f'>={t}:n={int(k.sum())},{ok[k].mean()*100 if k.sum() else float("nan"):.0f}%')
    print(f' {nm}: ' + ' '.join(cells))

print('\n--- rule: disagree AND fused margin < T => unsure.  T fitted on val ---')
print(f'{"T":>4} {"val cov%":>9} {"val acc|ans":>12} | {"test cov%":>10} {"test acc|ans":>13} {"test n dropped":>15}')
for T in (-1, 0, 1, 2, 3, 5, 10, 20, 30, 50, 100):
    drop = (~agree) & (margin < T)
    out = []
    for m in (VA, TE):
        keep = m & ~drop; ans = keep & (state != 'unsure')
        out += [100 * ans.sum() / max(int(m.sum()), 1),
                correct[ans].mean() * 100 if ans.sum() else float('nan'),
                float((m & drop).sum())]
    vcov, vacc, vdrop, tcov, tacc, tdrop = out
    print(f'{T:5.0f} {vcov:9.1f} {vacc:12.1f} | {tcov:10.1f} {tacc:13.1f} {tdrop:15.0f}')

# ---- Is the fused MARGIN the right severity measure inside the disagreeing set?
#
# marginPts is the only severity number viewAgreement currently carries. The rows
# above say it is not separating: disagreeing accuracy is flat in margin on val.
# The alternative is the WEAKER view's own confidence - min over views of that
# view's top posterior. A contradiction between two sure views is the case worth
# catching; a flat view next to a decided one is a case the species floor already
# handles, because the fused posterior is dragged flat with it.
minP = np.minimum(spA.max(1), spD.max(1))
print('\n--- disagreeing rows: weaker view\'s confidence (minP) ---')
for nm, m in (('val', VA & ~agree), ('test', TE & ~agree)):
    cells = []
    for t in (0.3, 0.373, 0.5, 0.7, 0.9):
        k = m & (minP >= t)
        cells.append(f'>={t}:n={int(k.sum())},{(ok[k].mean()*100 if k.sum() else float("nan")):.0f}%')
    print(f' {nm}: ' + ' '.join(cells))

print('\n--- rule: disagree AND minP >= T => unsure (the contradiction gate) ---')
print(f'{"T":>5} {"val cov%":>9} {"val acc|ans":>12} | {"test cov%":>10} {"test acc|ans":>13} {"test n dropped":>15}')
for T in (0.0, 0.3, 0.373, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95):
    drop = (~agree) & (minP >= T)
    out = []
    for m in (VA, TE):
        keep = m & ~drop; ans = keep & (state != 'unsure')
        out += [100 * ans.sum() / max(int(m.sum()), 1),
                correct[ans].mean() * 100 if ans.sum() else float('nan'),
                float((m & drop).sum())]
    vcov, vacc, vdrop, tcov, tacc, tdrop = out
    print(f'{T:5.3f} {vcov:9.1f} {vacc:12.1f} | {tcov:10.1f} {tacc:13.1f} {tdrop:15.0f}')

# How many disagreeing rows are already caught by the shipped floors? If most are,
# the gate only has to catch the residue, and the residue is where minP earns its
# place.
print('\n--- residue: disagreeing rows the shipped floors already answer ---')
for nm, m in (('val', VA & ~agree), ('test', TE & ~agree)):
    ans = m & (state != 'unsure')
    print(f' {nm}: answered {int(ans.sum())}/{int(m.sum())}  acc {ok[ans].mean()*100:.1f}%'
          f'  of which minP>=0.373: n={int((ans&(minP>=0.373)).sum())},'
          f'acc={ok[ans&(minP>=0.373)].mean()*100 if (ans&(minP>=0.373)).sum() else float("nan"):.1f}%')
