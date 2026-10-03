"""Does the fitted per-genus vector scaling survive being applied where the app applies it?

Reproduces 90-uuid-split/91-uuid-split.md's fit (same seed, same uuid-grouped split, same
val-only class-balanced objective) and recovers the fitted parameters, which that script
computed but never persisted. Then measures what the transform does under the logit
conventions the app actually has.

The finding, in one line: the transform is NOT shift-invariant, and fuseViews only ever
has relative logits, so the measured +1.83pp is not reachable from the fused posterior.

  uv run --quiet --with numpy --with scipy python analysis/per_genus_scaling_level_check.py

Reads only; writes nothing. The corpus lives in the rewrite investigation tree.
"""
import collections, csv, json
import numpy as np
from scipy.optimize import minimize

SITE = __import__("pathlib").Path(__file__).resolve().parent.parent
CACHE = ("/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/"
         "40-precision/50-h14-scale/cache")
SEED, TEMPERATURE = 0, 2.5

E = np.load(f"{CACHE}/embeddings.npy").astype(np.float64)
rows = list(csv.DictReader(open(f"{CACHE}/rows.tsv"), delimiter="\t"))
n = min(len(E), len(rows)); E, rows = E[:n], rows[:n]
sp_true = np.array([r["species"] for r in rows])
uuid = np.array([r["group_key"].split(":", 1)[1] for r in rows])

EMB = json.load(open(SITE / "text_embeds.json"))
S = np.array(EMB["species_emb"], np.float64).reshape(16, -1)
NU = np.array(EMB["nuisance_emb"], np.float64).reshape(8, -1)
S /= np.linalg.norm(S, axis=1, keepdims=True)
NU /= np.linalg.norm(NU, axis=1, keepdims=True)
SP_NAMES, NS = list(EMB["species"]), 16
SCALE = EMB["logit_scale"] / TEMPERATURE
SP_GENUS = np.array([x.split(" ")[0] for x in SP_NAMES])
TRUE_GENUS = np.array([s.split(" ")[0] for s in sp_true])
GEN = sorted(set(SP_GENUS.tolist()))
gi = {g: np.where(SP_GENUS == g)[0] for g in GEN}

E = E / np.linalg.norm(E, axis=1, keepdims=True)
sims = (E @ np.concatenate([S, NU]).T) * SCALE
P24 = np.exp(sims - sims.max(1, keepdims=True)); P24 /= P24.sum(1, keepdims=True)
g_true_i = np.array([GEN.index(x) for x in TRUE_GENUS])


def split_by(key):
    rng = np.random.default_rng(SEED)
    assign = {}
    for c in sorted(set(sp_true.tolist())):
        g = np.array([x for x in np.unique(key) if sp_true[key == x][0] == c])
        g = g[rng.permutation(len(g))]; k = len(g)
        for x in g[:int(.6 * k)]: assign[x] = "train"
        for x in g[int(.6 * k):int(.8 * k)]: assign[x] = "val"
        for x in g[int(.8 * k):]: assign[x] = "test"
    return np.array([assign[g] for g in key])


P = split_by(uuid)          # the CLEAN specimen-uuid split
VA, TE = P == "val", P == "test"


def lse(a, axis=1):
    m = a.max(axis=axis, keepdims=True)
    return (m + np.log(np.exp(a - m).sum(axis=axis, keepdims=True))).squeeze(axis)


def fit_vector_scaling(Z, y, M, w, l2=1e-4):
    ym, Zm = y[M], Z[M]
    w = w / w.sum() * len(ym); K = Zm.shape[1]
    x0 = np.concatenate([np.ones(K), np.zeros(K)])

    def nll(th):
        a, b = th[:K], th[K:]
        zz = Zm * a + b; mx = zz.max(1, keepdims=True)
        return (w * (mx[:, 0] + np.log(np.exp(zz - mx).sum(1))
                     - zz[np.arange(len(ym)), ym])).sum() / len(ym) \
            + l2 * ((a - 1.0) ** 2).sum() + l2 * (b ** 2).sum()

    def grad(th):
        a, b = th[:K], th[K:]
        zz = Zm * a + b; mx = zz.max(1, keepdims=True)
        ez = np.exp(zz - mx); Pp = ez / ez.sum(1, keepdims=True)
        oh = np.zeros_like(Pp); oh[np.arange(len(ym)), ym] = 1.0
        D = (Pp - oh) * w[:, None] / len(ym)
        return np.concatenate([(D * Zm).sum(0) + 2 * l2 * (a - 1.0), D.sum(0) + 2 * l2 * b])

    r = minimize(nll, x0, jac=grad, method="L-BFGS-B",
                 bounds=[(1e-2, 1e2)] * K + [(-5, 5)] * K)
    return r.x[:K], r.x[K:]


GL = np.stack([lse(sims[:, gi[g]]) for g in GEN] + [lse(sims[:, NS:])], axis=1)
y5 = np.array([GEN.index(x) for x in TRUE_GENUS])
cnt = collections.Counter(y5[VA])
w = np.array([1.0 / cnt.get(int(c), 1) for c in y5[VA]])
A, B = fit_vector_scaling(GL, y5, VA, w)
SPG = np.array([GEN.index(g) for g in SP_GENUS])


def genus_argmax(z24):
    """The app's own readout: softmax over the head, sum species posteriors within a genus."""
    zz = z24 - z24.max(1, keepdims=True)
    p = np.exp(zz); p /= p.sum(1, keepdims=True)
    return np.stack([p[:, gi[g]].sum(1) for g in GEN], 1).argmax(1) == g_true_i


def calibrated(level):
    """level = 0 keeps the absolute logits the fit was made on.

    fuseViews does not have absolute logits: it pools log p over views and works from
    there, so the honest test is the same transform on log p. level is subtracted from
    EVERY column before the transform, because a level shift that left the nuisance and
    adjacent columns at a different level would not be the shift the fit assumes.
    """
    z = sims - level
    z = z.copy(); z[:, :NS] = z[:, :NS] * A[SPG] + B[SPG]
    return z


if __name__ == "__main__":
    m = TE
    base = genus_argmax(sims)[m].mean() * 100
    ref = genus_argmax(calibrated(0.0))[m]
    rng = np.random.default_rng(12345)

    def ci(ok):
        d = ok[m].astype(float) - genus_argmax(sims)[m].astype(float)
        bs = [d[rng.integers(0, len(d), len(d))].mean() for _ in range(4000)]
        return np.percentile(bs, 2.5) * 100, np.percentile(bs, 97.5) * 100

    mx = sims.max(1, keepdims=True)
    logZ = np.log(np.exp(sims - mx).sum(1))[:, None] + mx   # true absolute logZ
    assert np.abs((sims - logZ) - np.log(np.exp(sims - mx)
               / np.exp(sims - mx).sum(1, keepdims=True))).max() < 1e-9

    print("fitted parameters (clean uuid split, class-balanced, val-only):")
    for k, g in enumerate(GEN):
        print(f"   {g:<10} scale={A[k]:.16f}  bias={B[k]:+.16f}   (val n={cnt.get(k, 0)})")
    print(f"   __nuisance__ scale={A[4]:.16f}  bias={B[4]:+.16f}  (no true rows)")
    print(f"\ngenus argmax on the clean test split (n={int(m.sum())}): baseline {base:.2f}%")
    for lbl, level in [("absolute logits (as fitted)", 0.0),
                       ("log p  <- what fuseViews has", logZ),
                       ("best species at 0", None)]:
        z = calibrated(sims.max(1, keepdims=True) if level is None else level)
        full = genus_argmax(z)
        ok = full[m]
        lo, hi = ci(full)
        print(f"   {lbl:<32} {ok.mean()*100:6.2f}%   ({ok.mean()*100-base:+.2f}, "
              f"CI [{lo:+.2f}, {hi:+.2f}])  differs from absolute on "
              f"{int((ok != ref).sum())} rows")
    print("\nThe scale term multiplies the LEVEL, so it only exists on absolute logits:")
    print("   (a_g - 1) x mean logit =",
          {g: round(float((A[k] - 1) * sims[:, :NS].mean()), 2) for k, g in enumerate(GEN)},
          "logits of per-genus offset")
