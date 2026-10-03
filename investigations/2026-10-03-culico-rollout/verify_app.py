#!/usr/bin/env python3
"""Re-derive every shipped number from the head FILE, using the app's own
arithmetic transcribed from softmaxJoint + localViewScale + verdictFrom.

This is the check that matters: fit_probe.py computed its metrics from the
probe's internal weights. This one reads only public/text_embeds_culico.json
and the cached features, exactly as the browser will, so a mistake in the
serialisation -- a transposed matrix, a wrong logit_scale, the intercept in the
wrong column -- shows up here as a different number.
"""
import json, sys
import numpy as np
sys.path.insert(0, "/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/99-calibration-ship")
import common as C

HEAD = "/workspaces/claude-devcontainer/tmp/mid-ship/public/text_embeds_culico.json"
FEATS = "/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/95-distillation/culico_features.npy"
TEMPERATURE = 2.5

d = json.load(open(HEAD))
species, D = d["species"], d["dim"]
S, N = len(species), len(d["nuisance"])
AD = len(d.get("adjacent") or [])
print(f"head: S={S} N={N} AD={AD} dim={D} logit_scale={d['logit_scale']}")

scale = d["logit_scale"] / TEMPERATURE
print(f"app scale = logit_scale/TEMPERATURE = {scale}")

# dotAt() in softmaxJoint: plain dot of a row against the unit embedding.
rows = (np.array(d["species_emb"]).reshape(S, D),
        np.array(d["nuisance_emb"]).reshape(N, D),
        np.array(d["adjacent_emb"]).reshape(AD, D))

E = np.load(FEATS).astype(np.float64)
E /= np.linalg.norm(E, axis=1, keepdims=True)   # clipEmbed normalises
emb = np.concatenate([E, np.ones((len(E), 1))], axis=1)   # the ONNX's constant coord

sims = [r @ emb.T for r in rows]
sims = np.concatenate([s * scale for s in sims], axis=0).T   # (n, S+N+AD)
ex = np.exp(sims - sims.max(1, keepdims=True))
p = ex / ex.sum(1, keepdims=True)
spP, nuP, adP = p[:, :S], p[:, S:S+N].sum(1), p[:, S+N:].sum(1)

genus_of = np.array([s.split(" ")[0] for s in species])
genera = sorted(set(genus_of.tolist()))
gidx = {g: np.where(genus_of == g)[0] for g in genera}
gP = np.stack([spP[:, gidx[g]].sum(1) for g in genera], 1)

rows_meta, truth = C.load_rows(), C.load_truth()
T = C.truth_arrays(C.Head(), rows_meta, truth)
_, _, te_idx = C.uuid_split(rows_meta)
te = np.zeros(len(rows_meta), bool); te[te_idx] = True   # uuid_split returns INDICES
gi = {g: i for i, g in enumerate(genera)}
g_true_i = np.array([gi[s.split(" ")[0]] for s in T["sp"]])
in_head = T["s_i"] >= 0

genus_acc = 100*(gP[te].argmax(1) == g_true_i[te]).mean()
spm = te & in_head
sp_acc = 100*(spP[te][in_head[te]].argmax(1) == T["s_i"][spm]).mean()
print(f"\nfrom the head FILE, app arithmetic:")
print(f"  test genus argmax   {genus_acc:.2f}%  (n={int(te.sum())})")
print(f"  test species argmax {sp_acc:.2f}%  (n={int(spm.sum())})")
print(f"  max non-mosquito mass {adP.max():.2e}  (floor {C.FLOORS['nonMosquito']})")

# The three-state rule at the shipped floors, via common.verdicts.
class FH:
    def __init__(s):
        s.species, s.genera, s.gidx = species, genera, gidx
        s.S, s.N, s.AD = S, N, 0
        s.nu_slice = slice(S, S+N); s.adj_slice = slice(S+N, S+N)
R = {"spP": spP, "gP": gP, "top_s": spP.argmax(1), "top_g": gP.argmax(1), "adP": adP}
V = {k: v[te] for k, v in C.verdicts(FH(), R, T, floors=C.FLOORS,
                                      m=np.ones(len(rows_meta), bool)).items()}
nn, k = int(V["ans"].sum()), int(V["ok"].sum())
lo, hi = C.wilson(k, nn)
print(f"  shipped floors: coverage {100*nn/te.sum():.1f}%  acc_answered {100*k/max(nn,1):.2f}%  CI95 [{100*lo:.2f}, {100*hi:.2f}]")

ref = json.load(open("culico_probe_metrics.json"))
ok = (abs(genus_acc - ref["test_genus_argmax_acc"]) < 0.01 and
      abs(sp_acc - ref["test_species_argmax_acc"]) < 0.01)
print(f"\n  matches fit_probe.py: {ok}  "
      f"(file {ref['test_genus_argmax_acc']:.2f}/{ref['test_species_argmax_acc']:.2f})")
sys.exit(0 if ok else 1)
