"""What does the nuisance block buy ON TOP OF the adjacent gate? (measurement only)

measure_gate.py establishes that the two blocks separate negatives from positives
well and that their MASSES live on different scales. This asks the decision
question: at a matched budget of true mosquitoes lost, is adjacent-then-nuisance
better than adjacent alone, or is the nuisance half redundant?

The comparison is the honest one: for each positive budget B (the fraction of the
6,264 in-domain mosquitoes the gate is allowed to cost), pick the ADJACENT floor
that spends exactly B, then add the nuisance block at the HIGHEST floor that
still spends no more than B in total, and report what each catches of the 700
true negatives.
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


def joint(X):
    X = X / np.linalg.norm(X, axis=1, keepdims=True)
    s = (X @ TEXT.T) * SCALE
    s -= s.max(1, keepdims=True)
    p = np.exp(s); p /= p.sum(1, keepdims=True)
    return dict(nu=p[:, NS:NS + NN].sum(1), ad=p[:, NS + NN:].sum(1))


JN, JP = joint(NEGV), joint(POSV)
NP_ = len(JP['ad'])

print('== MATCHED-BUDGET COMPARISON')
print('   budget = true mosquitoes the gate may cost, out of 6,264')
print('   adj floor is set to spend it exactly; nuisance floor is then the highest')
print('   value that keeps the TOTAL within budget.')
print()
print('   budget | adj floor | neg caught | +nuis floor | neg caught | negatives the')
print('           | (adj only) |             |            | (+nuisance) | nuisance adds')
for b in (0.0005, 0.001, 0.002, 0.005, 0.01, 0.02):
    budget_n = max(1, int(round(b * NP_)))
    ad_only = np.sort(JP['ad'])[::-1][:budget_n]
    af = float(ad_only.min())
    hit_a_n = JN['ad'] >= af
    hit_a_p = JP['ad'] >= af
    spent = int(hit_a_p.sum())
    room = budget_n - spent
    best = None
    for t in np.arange(0.01, 0.61, 0.005):
        n_lost = int(((JP['nu'] >= t) & ~hit_a_p).sum())
        if n_lost <= max(0, room):
            best = t
    if best is None:
        print(f'   {b:.4f} |  {af:.3f}   |  {100*hit_a_n.mean():6.2f}%   '
              f'|  -- none fits --')
        continue
    tot_n = hit_a_n | (JN['nu'] >= best)
    tot_p = hit_a_p | (JP['nu'] >= best)
    adds = tot_n & ~hit_a_n
    print(f'   {b:.4f} |  {af:.3f}   |  {100*hit_a_n.mean():6.2f}%   '
          f'|    {best:.3f}    |  {100*tot_n.mean():6.2f}%   | '
          f'{int(adds.sum()):3d} (+{100*adds.mean():.2f}pp), '
          f'{int((tot_p & ~hit_a_p).sum())} extra mosquito lost')

print('\n== OVERLAP: how often do the two blocks fire on the same row?')
for t in (0.10, 0.30, 0.60):
    a, u = JN['ad'] >= t, JN['nu'] >= t
    print(f'  negatives @{t}: adj {int(a.sum())}, nuisance {int(u.sum())}, '
          f'both {int((a & u).sum())}')
a, u = JP['ad'] >= 0.60, JP['nu'] >= 0.10
print(f'  positives @adj0.60 / nu0.10: adj {int(a.sum())}, nuisance {int(u.sum())}, '
      f'both {int((a & u).sum())}')

print('\n== THE DECISIVE CHECK: is the nuisance signal present in rows the gate')
print('   currently calls a mosquito? (positive rows, above the adjacent floor)')
keep = (JP['ad'] < 0.60)
print(f'  {int(keep.sum())} of {NP_} positives pass the shipped gate.')
print(f'  their nuisance mass: p50 {np.percentile(JP["nu"][keep],50):.3e} '
      f'p99 {np.percentile(JP["nu"][keep],99):.3e} '
      f'p99.9 {np.percentile(JP["nu"][keep],99.9):.3e} '
      f'max {JP["nu"][keep].max():.4f}')
for t in (0.05, 0.10, 0.20):
    print(f'    a nuisance floor of {t} would cost {int((JP["nu"][keep] >= t).sum())} '
          f'of them ({100*(JP["nu"][keep] >= t).mean():.3f}%)')
print('\n  and of the 700 true negatives, how many sit in that same range?')
for t in (0.05, 0.10, 0.20):
    lo = (JN['nu'] >= t) & (JN['ad'] < 0.60)
    print(f'    nuisance in [{t}, inf) AND adjacent below 0.60: {int(lo.sum())} '
          f'({100*lo.mean():.2f}%)')
