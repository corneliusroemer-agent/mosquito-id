"""The candidate nuisance floors, with the increment over adjacent stated. (measurement only)"""
import csv, json, os
import numpy as np

SITE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NEG = '/workspaces/claude-devcontainer/tmp/adjacent-taxa-work/neg'
CACHE = ('/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/50-h14-scale/cache')
E = json.load(open(f'{SITE}/public/text_embeds.json'))
D, NS, NN, NA = E['dim'], len(E['species']), len(E['nuisance']), len(E['adjacent'])
SCALE = E['logit_scale'] / 2.5
TEXT = np.vstack([np.array(E['species_emb'], np.float32).reshape(NS, D),
                  np.array(E['nuisance_emb'], np.float32).reshape(NN, D),
                  np.array(E['adjacent_emb'], np.float32).reshape(NA, D)])
NEGV = np.load(f'{NEG}/neg_embeddings.npy').astype(np.float64)
POSV = np.load(f'{CACHE}/embeddings.npy').astype(np.float64)


def joint(X):
    X = X / np.linalg.norm(X, axis=1, keepdims=True)
    s = (X @ TEXT.T) * SCALE; s -= s.max(1, keepdims=True)
    p = np.exp(s); p /= p.sum(1, keepdims=True)
    return p[:, NS:NS + NN].sum(1), p[:, NS + NN:].sum(1)


nN, nP = joint(NEGV), joint(POSV)
ADJ = 0.60
base_n, base_p = nN[1] >= ADJ, nP[1] >= ADJ
print(f'SHIPPED (adjacent >= {ADJ}): catches {int(base_n.sum())}/700 negatives '
      f'({100*base_n.mean():.2f}%), costs {int(base_p.sum())}/6264 mosquitoes '
      f'({100*base_p.mean():.3f}%)\n')
print('  nu floor | adds neg | adds mosq | total neg caught | total mosq lost')
for t in (0.02, 0.03, 0.05, 0.08, 0.10, 0.15, 0.20, 0.25):
    add_n = (nN[0] >= t) & ~base_n
    add_p = (nP[0] >= t) & ~base_p
    print(f'   {t:.2f}    |  {int(add_n.sum()):4d}   |   {int(add_p.sum()):4d}   |'
          f'     {int((base_n | (nN[0]>=t)).sum()):4d} ({100*(base_n | (nN[0]>=t)).mean():5.2f}%) |'
          f'     {int((base_p | (nP[0]>=t)).sum()):4d} ({100*(base_p | (nP[0]>=t)).mean():5.3f}%)')

print('\n== the three candidate rules at the shipped floors')
def rule(name, fn):
    hn, hp = fn(nN), fn(nP)
    print(f'  {name:34} neg {int(hn.sum()):3d}/700 ({100*hn.mean():5.2f}%)  '
          f'mosq lost {int(hp.sum()):3d}/6264 ({100*hp.mean():5.3f}%)')
rule('adjacent only  (SHIPPED)', lambda J: J[1] >= 0.60)
rule('summed (adj+nu) >= 0.60', lambda J: (J[0] + J[1]) >= 0.60)
rule('either, each >= 0.60', lambda J: (J[0] >= 0.60) | (J[1] >= 0.60))
rule('either, adj 0.60 / nu 0.05', lambda J: (J[0] >= 0.05) | (J[1] >= 0.60))
rule('either, adj 0.60 / nu 0.10', lambda J: (J[0] >= 0.10) | (J[1] >= 0.60))
