"""Which non-mosquito decision rule separates the two populations? (measurement only)

One embedding extraction, many scorings, so every variant is compared on identical
rows, identical labels and identical embeddings. Nothing here changes the app.

  negatives  700 detector-verified in-domain background crops from our own corpus
             (investigations/2026-10-02-mosquito-id/36-negatives)
  positives  the 6,264 in-domain mosquito photos of the 50-h14-scale cache

Two blocks of results. The first asks how each candidate RULE does. The second
asks what the embeddings could support at all - the same question asked of a
logistic fit over all 31 cosines with held-out predictions - because a rule that
loses to a ceiling nobody can reach is a different situation from one that loses
to a ceiling that is close.

Writes the comparison table to TSV.

Run: uv run --quiet --with numpy python analysis/non_mosquito_rule.py [OUT.tsv]
"""
import csv, json, os, sys
import numpy as np

SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEG = '/workspaces/claude-devcontainer/tmp/adjacent-taxa-work/neg'
CACHE = ('/workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/'
         '40-precision/50-h14-scale/cache')
SCALE_T = 2.5                       # TEMPERATURE in main.js

E = json.load(open(f'{SITE}/text_embeds.json'))
D = E['dim']; NS = len(E['species']); NN = len(E['nuisance']); NA = len(E['adjacent'])
SCALE = E['logit_scale'] / SCALE_T
TEXT = np.vstack([
    np.array(E['species_emb'], np.float32).reshape(NS, D),
    np.array(E['nuisance_emb'], np.float32).reshape(NN, D),
    np.array(E['adjacent_emb'], np.float32).reshape(NA, D)])
NAMES = E['species'] + E['nuisance'] + E['adjacent']
NEGV = np.load(f'{NEG}/neg_embeddings.npy')
POSV = np.load(f'{CACHE}/embeddings.npy')
ROWS = list(csv.DictReader(open(f'{CACHE}/rows.tsv'), delimiter='\t'))


def views(X):
    """One photo's softmaxJoint arithmetic: the 31 cosines and the joint posterior."""
    c = X @ TEXT.T
    ex = np.exp(c * SCALE)
    return {
        'c': c,
        'bsp': c[:, :NS].max(1),                            # best mosquito, cosine
        'bnm': c[:, NS:].max(1),                            # best non-mosquito class, cosine
        'nm': ex[:, NS:].sum(1) / ex.sum(1),                # nuisance + adjacent mass
    }


def rules(V):
    """Candidate decision scores. Every one is 'higher = more non-mosquito'."""
    return {
        # What main.js ships: the SUM of fifteen non-mosquito classes, thresholded.
        'shipped_summed_mass': V['nm'],
        # max-vs-max, the hypothesis: the raw cosine gap between the best
        # non-mosquito class and the best single mosquito.
        'max_vs_max': V['bnm'] - V['bsp'],
        # The scale-free form of the same comparison. log and subtraction do not
        # commute, so this is a DIFFERENT ranking, and a worse one.
        'log_margin': np.log(np.maximum(V['bnm'], 1e-9)) - np.log(np.maximum(V['bsp'], 1e-9)),
        # A bare floor on how mosquito-like the photo is. No non-mosquito class is
        # involved, so the gap between this row and max_vs_max is what the adjacent
        # classes actually contribute to the decision.
        'best_mosquito_cos': -V['bsp'],
        # The best non-mosquito class alone, with no mosquito side to compare to.
        'best_non_mosquito_cos': -V['bnm'],
        # One single nuisance class, used directly as a score. The app already has
        # this cosine; it throws it away by summing it into a mass.
        'cos_empty_background': V['c'][:, NAMES.index('a photograph of an empty background')],
        'cos_wall': V['c'][:, NAMES.index('a photograph of a wall')],
    }


def auc(sn, sp):
    s = np.concatenate([sn, sp])
    lab = np.concatenate([np.ones(len(sn)), np.zeros(len(sp))])
    lab = lab[np.argsort(-s)]
    return float(np.trapezoid(np.cumsum(lab) / len(sn), np.cumsum(1 - lab) / len(sp)))


def fit_logistic(Z, y):
    w = np.zeros(Z.shape[1])
    for _ in range(200):
        p = 1 / (1 + np.exp(-np.clip(Z @ w, -30, 30)))
        g = Z.T @ (p - y) / len(y)
        H = (Z * (p * (1 - p))[:, None]).T @ Z / len(y) + 1e-3 * np.eye(Z.shape[1])
        w -= np.linalg.solve(H, g)
    return w


def cv_oracle(X, y, n_neg, K=5):
    """Held-out scores for a logistic over all 31 cosines. Crops of one source photo
    are forced into the same fold - neg_manifest.tsv names every crop
    <source-index>_<family>.jpg, so the prefix identifies the source."""
    rng = np.random.default_rng(0)
    src = np.array([r['file'].split('_')[0] for r in
                    csv.DictReader(open(f'{NEG}/neg_manifest.tsv'), delimiter='\t')])
    uniq = np.unique(src)
    fold_of_src = {s: i % K for i, s in enumerate(rng.permutation(uniq))}
    nf = np.array([fold_of_src[s] for s in src])
    pf = rng.permutation(len(X) - n_neg) % K
    oof = np.zeros(len(X))
    for k in range(K):
        te = np.concatenate([np.where(nf == k)[0], n_neg + np.where(pf == k)[0]])
        tr = np.concatenate([np.where(nf != k)[0], n_neg + np.where(pf != k)[0]])
        mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-9
        w = fit_logistic((X[tr] - mu) / sd, y[tr])
        oof[te] = ((X[te] - mu) / sd) @ w
    return oof


VN, VP = views(NEGV), views(POSV)
RN, RP = rules(VN), rules(VP)
BUDGETS = (0.0027, 0.01, 0.02, 0.05)

out = []
for k in RN:
    sn, sp = RN[k], RP[k]
    a = auc(sn, sp)
    t = np.quantile(sp, 1 - 0.0027)
    row = {'variant': k, 'fitted': 'no (one threshold)',
           'auc': round(a, 4),
           'negatives_caught_pct_at_shipped_fn': round(100 * (sn > t).mean(), 2)}
    for b in BUDGETS:
        t = np.quantile(sp, 1 - b)
        row[f'caught_pct@fn_{b:.4f}'] = round(100 * (sn > t).mean(), 2)
        row[f'thr@fn_{b:.4f}'] = round(float(t), 4)
    out.append(row)

X = np.vstack([VN['c'], VP['c']])
y = np.concatenate([np.ones(len(NEGV)), np.zeros(len(POSV))])
oof = cv_oracle(X, y, len(NEGV))
row = {'variant': 'ORACLE logistic over all 31 cosines (held-out)', 'fitted': 'yes, 31 weights, 5-fold',
       'auc': round(auc(oof[:len(NEGV)], oof[len(NEGV):]), 4)}
for b in BUDGETS:
    t = np.quantile(oof[len(NEGV):], 1 - b)
    row[f'caught_pct@fn_{b:.4f}'] = round(100 * (oof[:len(NEGV)] > t).mean(), 2)
    row[f'thr@fn_{b:.4f}'] = round(float(t), 4)
out.append(row)

cols = list(out[0].keys())
for r in out[1:]:
    for c in cols:
        r.setdefault(c, '')
dest = sys.argv[1] if len(sys.argv) > 1 else '/tmp/decision_rules.tsv'
with open(dest, 'w') as f:
    w = csv.DictWriter(f, fieldnames=cols, delimiter='\t')
    w.writeheader()
    for r in out:
        w.writerow(r)

print(f'{"variant":42s} {"AUC":>6s} {"fitted":>30s} ' + ' '.join(f'@{b:.2%}FN' for b in BUDGETS))
for r in out:
    print(f'{r["variant"]:42s} {r["auc"]:6.4f} {r["fitted"]:>30s} ' +
          ' '.join(f'{r[f"caught_pct@fn_{b:.4f}"]:7.2f}%' for b in BUDGETS))
print('\nwrote', dest)
