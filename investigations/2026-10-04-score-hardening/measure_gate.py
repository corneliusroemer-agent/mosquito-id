"""What does the non-mosquito gate cost and catch, per block? (measurement only)

One embedding extraction, two scorings. Reproduces `softmaxJoint` exactly:
cosine against the 16 species + 8 nuisance + 7 adjacent rows, scaled by
logit_scale / TEMPERATURE, one softmax over all 31.

  negatives  700 detector-verified in-domain background crops
             (/workspaces/claude-devcontainer/tmp/adjacent-taxa-work/neg)
  positives  the 6,264 in-domain mosquito photos
             (investigations/2026-10-03-rewrite/40-precision/50-h14-scale/cache)

Reports the ADJACENT mass and the NUISANCE mass separately, because the two
blocks are different claims and the brief is whether one floor can serve both.
Also reports the verdict-state distribution the shipped floors produce over the
positive cache, which is the abstention-quality question.
"""
import csv, json, os
import numpy as np

SITE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NEG = '/workspaces/claude-devcontainer/tmp/adjacent-taxa-work/neg'
CACHE = ('/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/'
         '40-precision/50-h14-scale/cache')
T = 2.5

E = json.load(open(f'{SITE}/public/text_embeds.json'))
D, NS, NN, NA = E['dim'], len(E['species']), len(E['nuisance']), len(E['adjacent'])
SCALE = E['logit_scale'] / T
TEXT = np.vstack([
    np.array(E['species_emb'], np.float32).reshape(NS, D),
    np.array(E['nuisance_emb'], np.float32).reshape(NN, D),
    np.array(E['adjacent_emb'], np.float32).reshape(NA, D)])
NEGV = np.load(f'{NEG}/neg_embeddings.npy').astype(np.float64)
POSV = np.load(f'{CACHE}/embeddings.npy').astype(np.float64)
ROWS = list(csv.DictReader(open(f'{CACHE}/rows.tsv'), delimiter='\t'))
assert len(POSV) == len(ROWS) == 6264, (len(POSV), len(ROWS))
NU_NAMES = E['nuisance']


def joint(X):
    """softmaxJoint, vectorised. Returns per-row species/nuisance/adjacent mass."""
    X = X / np.linalg.norm(X, axis=1, keepdims=True)
    s = (X @ TEXT.T) * SCALE
    s -= s.max(1, keepdims=True)
    p = np.exp(s)
    p /= p.sum(1, keepdims=True)
    sp, nu, ad = p[:, :NS], p[:, NS:NS + NN], p[:, NS + NN:]
    return dict(sp=sp, nu=nu, ad=ad,
                spTotal=sp.sum(1), nuTotal=nu.sum(1), adTotal=ad.sum(1),
                topSpecies=sp.max(1), topNu=nu.max(1), topAd=ad.max(1))


JN, JP = joint(NEGV), joint(POSV)
P = f'heads: {NS} species, {NN} nuisance, {NA} adjacent | scale {SCALE:.3f}'
print(f'\n== {P}')
print(f'negatives {len(JN["nuTotal"])}   positives {len(JP["nuTotal"])}')

print('\n== MASS DISTRIBUTIONS')
for k in ('adTotal', 'nuTotal', 'topAd', 'topNu', 'spTotal'):
    qn = np.percentile(JN[k], [50, 90, 99, 100])
    qp = np.percentile(JP[k], [50, 90, 99, 99.9, 100])
    print(f'  {k:9} neg  p50 {qn[0]:.3e}  p90 {qn[1]:.3e}  p99 {qn[2]:.3e}  max {qn[3]:.3e}')
    print(f'  {"":9} pos  p50 {qp[0]:.3e}  p90 {qp[1]:.3e}  p99 {qp[2]:.3e}  '
          f'p99.9 {qp[3]:.3e}  max {qp[4]:.3e}')

print('\n== GATE: fires when mass >= T. false negatives = real mosquitoes lost.')
print('   (neg caught % | pos lost % [count])')
grid = [0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90]
print('  floor | adjacent-only | nuisance-only | either-of-both')
for t in grid:
    a = (100 * (JN['adTotal'] >= t).mean(), 100 * (JP['adTotal'] >= t).mean(), int((JP['adTotal'] >= t).sum()))
    u = (100 * (JN['nuTotal'] >= t).mean(), 100 * (JP['nuTotal'] >= t).mean(), int((JP['nuTotal'] >= t).sum()))
    e = (100 * ((JN['adTotal'] >= t) | (JN['nuTotal'] >= t)).mean(),
         100 * ((JP['adTotal'] >= t) | (JP['nuTotal'] >= t)).mean(),
         int(((JP['adTotal'] >= t) | (JP['nuTotal'] >= t)).sum()))
    print(f'  {t:.2f}  | {a[0]:5.1f}% | {a[1]:6.3f}% [{a[2]:4d}]'
          f' | {u[0]:5.1f}% | {u[1]:6.3f}% [{u[2]:4d}]'
          f' | {e[0]:5.1f}% | {e[1]:6.3f}% [{e[2]:4d}]')

print('\n== SUM vs EITHER at 0.60 (the two candidate readings of the fix)')
for name, fn in (
    ('summed (ad+nu) >= t', lambda J: J['adTotal'] + J['nuTotal']),
    ('max (ad, nu)  >= t', lambda J: np.maximum(J['adTotal'], J['nuTotal'])),
    ('either fires        ', lambda J: np.maximum(J['adTotal'], J['nuTotal'])),
):
    t = 0.60
    s = fn(JN), fn(JP)
    print(f'  {name}  neg caught {100*(s[0]>=t).mean():5.1f}%  pos lost {100*(s[1]>=t).mean():6.3f}% [{int((s[1]>=t).sum())}]')

print('\n== WHICH NEGATIVE CLASS IS DOING THE WORK')
for t in (0.60,):
    hit = JN['nuTotal'] >= t
    if hit.sum():
        w = JN['nu'][hit].mean(0)
        for i in np.argsort(-w)[:5]:
            print(f'  nuisance floor {t}: {100*hit.mean():5.1f}% of negatives fire; '
                  f'top nuisance class is {NU_NAMES[i]!r} on {100*w[i]:.0f}% of them')
    hit = JN['adTotal'] >= t
    if hit.sum():
        print(f'  adjacent floor {t}: {hit.sum()} of {len(hit)} negatives fire '
              f'({100*hit.mean():.1f}%)')

print('\n== SHIPPED FLOORS: verdict-state distribution over the 6,264 positives')
FLOORS = dict(species=0.373, genus=0.80, nonMosquito=0.60)


def states(J, use_adj, use_nu):
    """verdictFrom's state machine over these posteriors, as a single view."""
    spm = J['sp']
    top = spm.max(1)
    genus_of = np.array([n.split(' ')[0] for n in E['species']])
    uniq_g = np.unique(genus_of)
    G = np.stack([spm[:, genus_of == g].sum(1) for g in uniq_g], 1)
    topGenusP = G.max(1)
    nm = np.zeros(len(top), bool)
    if use_adj:
        nm |= J['adTotal'] >= FLOORS['nonMosquito']
    if use_nu:
        nm |= J['nuTotal'] >= FLOORS['nonMosquito']
    st = np.full(len(top), 'unsure', dtype=object)
    gen_ok = topGenusP >= FLOORS['genus']
    st[top >= FLOORS['species']] = 'species'
    st[gen_ok & (top < FLOORS['species'])] = 'genus'
    st[nm] = 'non-mosquito'
    return st


for label, ua, un in (
    ('SHIPPED (adjacent only)', True, False),
    ('after fix (adjacent OR nuisance)', True, True),
):
    st = states(JP, ua, un)
    c = {k: int((st == k).sum()) for k in ('species', 'genus', 'non-mosquito', 'unsure')}
    n = len(st)
    print(f'  {label:32} ' + '  '.join(f'{k} {v} ({100*v/n:.2f}%)' for k, v in c.items()))

# Genus-level accuracy. A quarter of the cache rows carry a GENUS label only
# ("Culiseta", "Anopheles"), so a species-exact comparison scores them wrong for a
# reason that has nothing to do with the gate. Compared at genus level, which is
# what those rows can actually support.
print('\n== ACCURACY of the named states (genus level: the cache has genus-only rows)')
truth_s = np.array([r['species'] for r in ROWS])
truth_g = np.array([t.split(' ')[0] for t in truth_s])
pred_g = np.array([E['species'][i].split(' ')[0] for i in JP['sp'].argmax(1)])
for label, ua, un in (('adjacent only', True, False), ('adjacent OR nuisance', True, True)):
    st = states(JP, ua, un)
    named = st != 'unsure'
    sp = st == 'species'
    print(f'  {label:22} named {named.sum():5d}/{len(st)} ({100*named.mean():5.2f}%)  '
          f'genus acc among named {100*(pred_g[named] == truth_g[named]).mean():5.2f}%  '
          f'overall {100*(pred_g[named] == truth_g[named]).sum()/len(st):5.2f}%  '
          f'| species-state acc {100*(pred_g[sp] == truth_g[sp]).mean():5.2f}%')

print('\n== SPECIES FLOOR SWEEP: is 0.373 abstaining too much, or too little?')
print('   floor | named % | genus acc among named | overall acc')
for f in (0.20, 0.30, 0.373, 0.45, 0.55, 0.65, 0.80):
    ok = (JP['sp'].max(1) >= f) & (JP['adTotal'] < 0.60)
    n = len(ok)
    acc = (pred_g[ok] == truth_g[ok]).mean()
    print(f'  {f:.3f} | {100*ok.mean():6.2f}% | {100*acc:20.2f}% | {100*ok.sum()*acc/n:12.2f}%')

print('\n== IS A NUISANCE FLOOR DEFENSIBLE? The separation, not the floor.')
def auc(sn, sp):
    s = np.concatenate([sn, sp])
    lab = np.concatenate([np.ones(len(sn)), np.zeros(len(sp))])
    o = np.argsort(-s); lab = lab[o]
    return float(np.trapezoid(np.cumsum(lab) / len(sn), np.cumsum(1 - lab) / len(sp)))


for k in ('adTotal', 'nuTotal'):
    print(f'  AUC({k}) negatives vs positives = {auc(JN[k], JP[k]):.4f}')
print(f'  AUC(adjTotal + nuTotal)           = {auc(JN["adTotal"] + JN["nuTotal"], JP["adTotal"] + JP["nuTotal"]):.4f}')

print('\n  Best honest operating point for a NUISANCE-ONLY gate, by the positive budget:')
print('   floor | neg caught % | pos lost % [count]')
for t in (0.02, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50):
    a = (100 * (JN['nuTotal'] >= t).mean(), int((JP['nuTotal'] >= t).sum()))
    print(f'   {t:.2f}  | {a[0]:11.2f}% | {100*a[1]/len(JP['nuTotal']):6.3f}% [{a[1]:4d}]')
print('\n  Same, for an ADJACENT-ONLY gate:')
for t in (0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70):
    a = (100 * (JN['adTotal'] >= t).mean(), int((JP['adTotal'] >= t).sum()))
    print(f'   {t:.2f}  | {a[0]:11.2f}% | {100*a[1]/len(JP['adTotal']):6.3f}% [{a[1]:4d}]')

print('\n== WHAT THE NUISANCE BLOCK DOES ON NEGATIVES THAT DO NOT TRIP 0.60')
sub = JN['nuTotal'] < 0.60
print(f'  {sub.sum()} of {len(sub)} negatives sit below the nuisance floor.')
w = JN['nu'][sub].mean(0)
for i in np.argsort(-w)[:5]:
    print(f'    top nuisance on those: {NU_NAMES[i]!r} at {100*w[i]:.1f}% mean posterior')
best = JN['nu'][sub].max(1)
print(f'  their best single nuisance class: p50 {np.percentile(best,50):.3f} '
      f'p99 {np.percentile(best,99):.3f} max {best.max():.3f}')
print('  -> a MAX-over-nuisance-classes rule, which is what a "this photo is a\n'
      '     wall" question actually asks, not the mass the gate currently reads.')

print('\n== MAX-OVER-CLASSES vs MASS, nuisance block')
print('   floor | neg caught % (best-nuisance) | pos lost % [count]')
for t in (0.10, 0.20, 0.30, 0.40, 0.48, 0.55, 0.60):
    a = (100 * (JN['topNu'] >= t).mean(), int((JP['topNu'] >= t).sum()))
    print(f'   {t:.2f}  | {a[0]:11.2f}% | {100*a[1]/len(JP["topNu"]):6.3f}% [{a[1]:4d}]')

print('\n== CULICO: nuisance and adjacent rows in feature coordinates')
C = json.load(open(f'{SITE}/public/text_embeds_culico.json'))
for k in ('nuisance_emb', 'adjacent_emb'):
    A = np.array(C[k], np.float64).reshape(-1, C['dim'])
    nz = (A != 0).sum(1)
    print(f'  {k}: {A.shape[0]} rows x {A.shape[1]} coords; non-zero per row '
          f'{sorted(set(nz.tolist()))}')
print(f'  culico nuisance labels: {len(C["nuisance"])}  adjacent: {len(C["adjacent"])}')
