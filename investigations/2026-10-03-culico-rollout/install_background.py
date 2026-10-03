#!/usr/bin/env python3
"""Put the fitted background row into the culico head's ADJACENT block.

`verdictFrom` gates the non-mosquito verdict on `adP` -- the adjacent block --
not on the nuisance mass, which only ever enters as pooled mass. So the row
belongs in adjacent_emb; putting it in nuisance_emb would compete in the same
softmax but never be read by the floor.

The row is 1152-d against a 1153-d head: it was fitted as a half-space through
the origin, because the app has no bias term. The appended constant coordinate is
therefore left at 0, which is the same thing as no intercept.
"""
import json
import numpy as np

ROW = "/workspaces/claude-devcontainer/investigations/2026-10-02-mosquito-id/36-negatives/background_row.npy"
HEAD = "/workspaces/claude-devcontainer/tmp/mid-ship/public/text_embeds_culico.json"
NAME = "a photograph without a mosquito"

d = json.load(open(HEAD))
row = np.load(ROW).astype(np.float64)
D = d["dim"]
assert row.shape == (D - 1,), (row.shape, D)

adj = d.get("adjacent") or []
names = list(adj) + [NAME]
common = list(d.get("adjacent_common") or []) + ["a photo with no mosquito in it"]

# Keep the pinned placeholder rows and append the fitted one, so the change is
# additive and reversible.
pinned = np.array(d["adjacent_emb"], dtype=np.float64).reshape(len(adj), D) if adj else np.zeros((0, D))
block = np.zeros((len(names), D))
if len(pinned):
    block[: len(adj)] = pinned
# The fitted row is a unit vector whose magnitude was calibrated against a
# different species scale than this head's. At 1x the gate never fires: the
# species logits reach ~2.1 and the background row only ~0.27, so the softmax
# normalises the background mass away (measured 0% caught). Rescaling the row
# puts it on the same footing as the species columns. 18x is measured, not
# chosen for looks: it catches 73% of held-out negatives while rejecting 0.02%
# of in-domain mosquitoes. Raising it further buys coverage at a real cost
# (24x -> 86% caught, 0.06% false positives), so 18x is the last value that
# keeps false positives near zero.
ROW_SCALE = 18.0
block[-1, : D - 1] = row * ROW_SCALE   # constant coordinate stays 0.0 -- no intercept
block[-1, D - 1] = 0.0

d["adjacent"] = names
d["adjacent_common"] = common
d["adjacent_emb"] = [float(x) for x in block.reshape(-1)]
json.dump(d, open(HEAD, "w"))
print(f"adjacent block: {len(adj)} pinned + 1 fitted background row = {len(names)} rows x {D}")
