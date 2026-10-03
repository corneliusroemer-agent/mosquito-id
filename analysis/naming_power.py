"""Can the app NAME what it is looking at, as opposed to rejecting it?

The non-mosquito state renders a plain-language class name, so accepting a crop is
only half the claim - the name has to be worth printing. That is answerable
without any labels, and it is a different question from whether the gate fires.

Two things decide it:

  1. does the winning non-mosquito class actually WIN? On a blank crop the best
     mosquito may be a closer match than any of the fifteen non-mosquito classes,
     in which case there is no name to print.
  2. if it does win, does the distribution of winners differ between blank crops
     and real mosquitoes? If it does not, the name carries no information about
     what the photo contains, however varied it looks.

Run: uv run --quiet --with numpy python analysis/naming_power.py
"""
import json, os
from collections import Counter
import numpy as np

SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEG = '/workspaces/claude-devcontainer/tmp/adjacent-taxa-work/neg'
CACHE = ('/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/'
         '40-precision/50-h14-scale/cache')

E = json.load(open(f'{SITE}/text_embeds.json'))
D = E['dim']; NS = len(E['species']); NN = len(E['nuisance']); NA = len(E['adjacent'])
SP = np.array(E['species_emb'], np.float32).reshape(NS, D)
NU = np.array(E['nuisance_emb'], np.float32).reshape(NN, D)
AD = np.array(E['adjacent_emb'], np.float32).reshape(NA, D)
ADJ_NAMES = np.array(E['adjacent_common'])
NU_NAMES = np.array(E['nuisance'])
NV = np.load(f'{NEG}/neg_embeddings.npy')
PV = np.load(f'{CACHE}/embeddings.npy')


def stats(X):
    csp, cnu, cad = X @ SP.T, X @ NU.T, X @ AD.T
    bnm = np.maximum(cad.max(1), cnu.max(1))
    who = np.where(cad.max(1) >= cnu.max(1), 'adj:' + ADJ_NAMES[cad.argmax(1)],
                   NU_NAMES[cnu.argmax(1)])
    return bnm - csp.max(1), who


gn, wn = stats(NV)
gp, wp = stats(PV)

print('=== does the best non-mosquito class WIN? ===')
print('  gap = best non-mosquito cosine - best mosquito cosine')
print(f'    700 blank crops     mean {gn.mean():+.4f}  median {np.median(gn):+.4f}  '
      f'ahead on {100*(gn > 0).mean():.1f}%')
print(f'    6,264 mosquitoes    mean {gp.mean():+.4f}  median {np.median(gp):+.4f}  '
      f'ahead on {100*(gp > 0).mean():.1f}%')

print('\n=== does the NAME differ between blanks and mosquitoes? ===')
cn, cp = Counter(wn), Counter(wp)
print(f'  {"winning non-mosquito class":36s} {"blanks":>10s} {"mosquitoes":>12s}')
for k in sorted(set(cn) | set(cp), key=lambda k: -(cn.get(k, 0) + cp.get(k, 0))):
    print(f'  {k:36s} {100*cn.get(k,0)/len(wn):9.1f}% {100*cp.get(k,0)/len(wp):11.1f}%')
sh = list(cn.values())
h = -sum((v / sum(sh)) * np.log(v / sum(sh)) for v in sh) / np.log(len(sh))
print(f'\n  normalised entropy of the blank-crop answer: {h:.3f} over {len(cn)} classes')
top1 = cn.most_common(1)[0]
print(f'  the single most likely answer covers {100*top1[1]/len(wn):.1f}% of blanks '
      f'({top1[0]}) and {100*cp.get(top1[0],0)/len(wp):.1f}% of real mosquitoes')
print('  -> a near-identical distribution means the name carries almost no')
print('     information about whether the crop is blank.')
