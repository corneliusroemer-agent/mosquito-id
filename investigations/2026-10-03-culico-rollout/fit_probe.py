#!/usr/bin/env python3
"""Fit the culico probe and emit a text_embeds-shaped file the browser consumes.

STRUCTURAL FACT THAT SHAPES THIS
--------------------------------
The app's `softmaxJoint` computes, per class, `scale * dot(row, emb)` -- a pure
dot product with NO bias, against an embedding clipEmbed has already
L2-normalised. It has no hierarchical readout: the 31-column score matrix
run_culico.py builds is an ANALYSIS artefact, not something the shipped code can
consume. The head here is therefore a flat weight matrix, one row per species,
dot-producted and softmaxed, and every construction below had to be expressible
in that form.

TWO THINGS THAT FALL OUT OF IT
-------------------------------
1. No bias term, so the features carry an appended constant 1.0 coordinate and
   the last weight column IS the intercept. The ONNX graph appends the same 1.0
   (build_onnx.py) so both sides agree exactly. The final refit uses
   `fit_intercept=False` so the bias is not counted twice.

2. The corpus labels only 6 of the app's 16 species at species rank -- every
   Culex and Anopheles row is genus-rank only (2,034 rows), so there is no
   within-genus evidence for those genera at all. A flat 16-species probe would
   leave 10 species, Culex pipiens among them, with no training rows and no
   fitted direction.

   The head handles this the way the evidence allows, and stays expressible:
   every species in a genus the corpus does not label at species rank shares the
   GENUS probe's row. The genus posterior is then the sum over members of the
   same exponential, which is monotone in the genus row, so the genus decision
   is unchanged and the within-genus split is uniform by construction rather
   than invented. Aedes and Culiseta, which the corpus does label at species
   rank, get their own species-probe rows. Head species inside those two genera
   that the corpus never labels take the floor constant, so their genus still
   sums to 1 rather than silently disappearing from the softmax.

The nuisance and adjacent blocks are pinned for the same structural reason and a
stronger one: culico's probe has no usable non-mosquito channel, and the honest
encoding of "this model cannot answer that question" is a logit that never wins,
not a fabricated weight that looks like an answer.
"""
from __future__ import annotations
import json, sys, pathlib
import numpy as np
from sklearn.linear_model import LogisticRegression
from scipy.special import logsumexp

sys.path.insert(0, "/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/99-calibration-ship")
import common as C

HERE = pathlib.Path("/workspaces/claude-devcontainer/tmp/culico-ship")
FEATS = "/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/95-distillation/culico_features.npy"
APP_EMBEDS = "/workspaces/claude-devcontainer/investigations/2026-10-02-mosquito-id/10-github-pages/site/public/text_embeds.json"

C_GRID = (0.01, 0.1, 0.3, 1.0, 3.0, 10.0, 30.0, 100.0, 300.0)
NU_LEVEL = float(np.log(1e-9))   # the shipped value from run_culico.py
OUT_DIM = 1153                   # 1152 feature + 1 constant


def augment(E: np.ndarray) -> np.ndarray:
    """L2-normalise each feature row and append the constant coordinate."""
    E = E / np.linalg.norm(E, axis=1, keepdims=True).astype(np.float32)
    return np.concatenate([E, np.ones((len(E), 1), np.float32)], axis=1).astype(np.float64)


class FakeHead:
    """Just enough Head for common.verdicts."""
    def __init__(self, species, genera, gidx):
        self.species, self.genera, self.gidx = species, genera, gidx
        self.S, self.N, self.AD = len(species), 8, 0
        self.nu_slice = slice(self.S, self.S + self.N)
        self.adj_slice = slice(self.S + self.N, self.S + self.N)


def fit(X, y, mask_tr, mask_va, classes, tag):
    """Multinomial LR, C chosen on val by NLL, refit without its own intercept."""
    ci = {c: i for i, c in enumerate(classes)}
    Xtr, ytr = X[mask_tr], np.array([ci[v] for v in y[mask_tr]])
    Xva, yva = X[mask_va], np.array([ci[v] for v in y[mask_va]])
    if len(set(ytr.tolist())) < 2 or len(set(yva.tolist())) < 2:
        raise ValueError(f"{tag}: split too small to fit ({len(set(ytr))} train / {len(set(yva))} val classes)")
    best = None
    for Cv in C_GRID:
        m = LogisticRegression(C=Cv, solver="lbfgs", max_iter=5000).fit(Xtr, ytr)
        s = m.decision_function(Xva)
        nll = float((logsumexp(s, axis=1) - s[np.arange(len(s)), yva]).mean())
        if best is None or nll < best["nll"]:
            best = {"C": Cv, "nll": nll}
    m = LogisticRegression(C=best["C"], solver="lbfgs", max_iter=5000,
                           fit_intercept=False).fit(Xtr, ytr)
    print(f"  {tag:<10} C={best['C']:<6g} val_nll={best['nll']:.4f} "
          f"train_acc={100*(m.decision_function(Xtr).argmax(1)==ytr).mean():.2f}% "
          f"n_train={len(ytr)} n_val={len(yva)}")
    # fit() encodes names to integer codes, so classes_ is a CODE list and coef_
    # rows are in that same positional order. Pairing them back to names is a
    # zip over two identically-ordered sequences -- sklearn's classes_ is
    # sorted numerically here, not by the name order `classes` was given in.
    order = {i: classes[k] for k, i in enumerate(m.classes_)}
    return m, best, {order[int(i)]: i for i in m.classes_}


def main():
    rows, truth = C.load_rows(), C.load_truth()
    tr, va, te = C.uuid_split(rows)
    E = augment(np.load(FEATS))
    assert E.shape == (len(rows), OUT_DIM), E.shape
    n = len(rows)
    TR, VA, TE = (np.zeros(n, bool) for _ in range(3))
    TR[tr], VA[va], TE[te] = True, True, True

    ref = json.load(open(APP_EMBEDS))
    species = list(ref["species"])
    genus_of = np.array([s.split(" ")[0] for s in species])
    genera = sorted(set(genus_of.tolist()))
    gidx = {g: np.where(genus_of == g)[0] for g in genera}
    gi = {g: i for i, g in enumerate(genera)}

    T = C.truth_arrays(C.Head(), rows, truth)
    g_true = np.array([s.split(" ")[0] for s in T["sp"]])
    g_true_i = np.array([gi[g] for g in g_true])
    in_head = T["s_i"] >= 0
    sp_head = np.array([species[i] if i >= 0 else "__out__" for i in T["s_i"]])

    print("probes:")
    g_probe, g_best, g_codes = fit(E, g_true, TR, VA, genera, "genus")

    # Genera the corpus labels at species rank get a within-genus split; the rest
    # share the genus row. Measured, not assumed: a genus qualifies only if its
    # labelled species cover a real share of its rows.
    sp_by_genus = {}
    for g in genera:
        rows_g = g_true == g
        labelled = np.array([s for s, keep in zip(sp_head, rows_g & in_head) if keep])
        if rows_g.sum() and len(set(labelled)) >= 2 and (in_head & rows_g).sum() >= 30:
            sp_by_genus[g] = sorted(set(labelled))
    print(f"  species-rank genera: { {g: len(v) for g, v in sp_by_genus.items()} }")

    sp_probes = {}
    for g, classes in sp_by_genus.items():
        rows_g = g_true == g
        y = np.array([c if c in classes else "__genus_only__" for c in sp_head])
        keep = (rows_g) & (y != "__genus_only__")
        try:
            sp_probes[g] = fit(E, y, keep & TR, keep & VA, classes + ["__genus_only__"], g[:8])
        except ValueError as exc:
            print(f"  {g[:8]:<10} no within-genus split: {exc}")
            sp_probes[g] = None

    # ---- expand to the app's full label set
    S = len(species)
    W = np.full((S, OUT_DIM), 0.0)
    W[:, -1] = NU_LEVEL
    provenance = {}

    for g, i in g_codes.items():
        for k in gidx[g]:
            W[k] = g_probe.coef_[i]
            provenance[species[k]] = f"genus probe ({g})"

    for g, probe in sp_probes.items():
        m, _, local = probe if probe else (None, None, {})
        for k in gidx[g]:
            name = species[k]
            if local and name in local:
                W[k] = m.coef_[local[name]]
                provenance[name] = f"species probe ({g})"
            else:
                W[k] = W[k]  # keeps NU_LEVEL on the constant column only
                provenance[name] = "PINNED: corpus never labels this species"

    Z = E @ W.T
    Zfull = np.concatenate([Z, np.full((n, 15), NU_LEVEL)], 1)

    def posterior(mask):
        Zm = Zfull[mask]
        p = np.exp(Zm - Zm.max(1, keepdims=True)); p /= p.sum(1, keepdims=True)
        sp = p[:, :S]
        return sp, np.stack([sp[:, gidx[g]].sum(1) for g in genera], 1), p

    sp_all, g_all, p_all = posterior(np.ones(n, bool))
    R_all = {"spP": sp_all, "gP": g_all, "top_s": sp_all.argmax(1),
             "top_g": g_all.argmax(1), "adP": p_all[:, S:].sum(1)}
    sp_tr, g_tr, _ = posterior(TR)
    sp_te, g_te, p_te = posterior(TE)
    spm = TE & in_head

    print(f"\nTRAIN genus argmax {100*(g_tr.argmax(1)==g_true_i[TR]).mean():.2f}%")
    print(f"TEST  genus argmax {100*(g_te.argmax(1)==g_true_i[TE]).mean():.2f}% (n={int(TE.sum())})  "
          f"species {100*(sp_te[in_head[TE]].argmax(1)==T['s_i'][spm]).mean():.2f}% (n={int(spm.sum())})")

    R = {"spP": sp_te, "gP": g_te, "top_s": sp_te.argmax(1), "top_g": g_te.argmax(1),
         "adP": p_te[:, S:].sum(1)}
    Vall = C.verdicts(FakeHead(species, genera, gidx), R_all, T, floors=C.FLOORS, m=np.ones(n, bool))
    V = {k: v[TE] for k, v in Vall.items()}
    nn, k = int(V["ans"].sum()), int(V["ok"].sum())
    lo, hi = C.wilson(k, nn)
    print(f"\nshipped floors on test: coverage {100*nn/TE.sum():.1f}%  "
          f"acc_answered {100*k/max(nn,1):.2f}%  CI95 [{100*lo:.2f}, {100*hi:.2f}]  n={nn}")
    nm = p_te[:, S:].sum(1).max()
    print(f"max non-mosquito mass {nm:.2e} (floor {C.FLOORS['nonMosquito']}) -- the gate cannot fire")

    nus, ads = list(ref["nuisance"]), list(ref.get("adjacent") or [])
    full = np.zeros((S + len(nus) + len(ads), OUT_DIM))
    full[:S] = W
    full[S:, -1] = NU_LEVEL
    out = {
        "species": species, "nuisance": nus, "adjacent": ads,
        "adjacent_common": list(ref.get("adjacent_common") or []),
        "dim": OUT_DIM, "logit_scale": 1.0 * C.TEMPERATURE,  # app divides by TEMPERATURE -> net scale 1.0
        "species_emb": [float(x) for x in full[:S].reshape(-1)],
        "nuisance_emb": [float(x) for x in full[S:S+len(nus)].reshape(-1)],
        "adjacent_emb": [float(x) for x in full[S+len(nus):].reshape(-1)],
    }
    dst = HERE / "text_embeds_culico.json"
    json.dump(out, open(dst, "w"))
    print(f"\nwrote {dst} ({dst.stat().st_size/1024:.0f} KB)")
    print("  pinned species: " + ", ".join(s for s, p in provenance.items() if p.startswith("PINNED")))

    json.dump({"genus_probe_C": g_best["C"], "genus_val_nll": g_best["nll"],
               "species_rank_genera": {g: len(v) for g, v in sp_by_genus.items()},
               "test_genus_argmax_acc": float(100*(g_te.argmax(1)==g_true_i[TE]).mean()),
               "test_genus_n": int(TE.sum()),
               "test_species_argmax_acc": float(100*(sp_te[in_head[TE]].argmax(1)==T["s_i"][spm]).mean()),
               "test_species_n": int(spm.sum()),
               "coverage_pct": 100*nn/TE.sum(), "acc_answered_pct": 100*k/max(nn,1),
               "acc_answered_ci95": [100*lo, 100*hi],
               "pinned_species": [s for s, p in provenance.items() if p.startswith("PINNED")],
               "provenance": provenance,
               "nu_level_nats": NU_LEVEL, "max_non_mosquito_mass": float(nm)},
              open(HERE / "culico_probe_metrics.json", "w"), indent=2)


if __name__ == "__main__":
    main()
