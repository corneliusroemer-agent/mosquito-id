#!/usr/bin/env python3
"""Does the shipped head's non-mosquito gate actually fire?

Reads only public/text_embeds_culico.json -- with the background row installed --
and re-derives adP through the app's own arithmetic, then asks the same question
the gate asks: does the adjacent mass clear 0.60?
"""
import json, sys
import numpy as np
sys.path.insert(0, "/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/99-calibration-ship")

HEAD = "/workspaces/claude-devcontainer/tmp/mid-ship/public/text_embeds_culico.json"
POS = "/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/95-distillation/culico_features.npy"
NEG = "/workspaces/claude-devcontainer/investigations/2026-10-02-mosquito-id/36-negatives/culico_neg_features.npy"
TEMPERATURE, FLOOR = 2.5, 0.60

d = json.load(open(HEAD))
S, N = len(d["species"]), len(d["nuisance"])
AD, D = len(d["adjacent"]), d["dim"]
scale = d["logit_scale"] / TEMPERATURE
print(f"adjacent block: {AD} rows, last = {d['adjacent'][-1]!r}")
print(f"scale {scale}, floor {FLOOR}")

rows = (np.array(d["species_emb"]).reshape(S, D),
        np.array(d["nuisance_emb"]).reshape(N, D),
        np.array(d["adjacent_emb"]).reshape(AD, D))

def adp(E):
    E = E.astype(np.float64)
    E /= np.linalg.norm(E, axis=1, keepdims=True)
    emb = np.concatenate([E, np.ones((len(E), 1))], axis=1)
    sims = np.concatenate([r @ emb.T for r in rows], 0) * scale
    sims = sims.T
    p = np.exp(sims - sims.max(1, keepdims=True)); p /= p.sum(1, keepdims=True)
    return p[:, S + N:].sum(1)

pos, neg = adp(np.load(POS)), adp(np.load(NEG))
print(f"\npositives (in-domain mosquitoes, n={len(pos)}):")
print(f"  would be called non-mosquito: {100*(pos>=FLOOR).mean():.2f}%   max adP {pos.max():.3f}")
print(f"negatives (crops with no mosquito, n={len(neg)}):")
print(f"  caught by the gate:           {100*(neg>=FLOOR).mean():.2f}%   min adP {neg.min():.3f}")
