# culico-net on the site: what is live, what is broken, what is next

Written 2026-10-03 by the agent that shipped the culico rollout. Everything here
was measured; nothing is a plan presented as a result.

## Where the code is

| What | Where |
|---|---|
| Branch with the caveat removal + H/14 default | `agent/culico-caveat-accuracy` (pushed, **unmerged**, rebase onto `origin/main` first — main moves often) |
| Merged already | `main` via #13 (the rollout), #15 (warm-one-model + its test), #17 (e2e tier) |
| Closed | #16 — its subject, the caveat block, was deleted |
| Working worktree | `/workspaces/claude-devcontainer/tmp/mid-ship` |
| Analysis scripts | this directory; each is standalone and runnable |

The worktree is **ephemeral** (`/tmp`). If it is gone, recreate with
`git worktree add <dir> -b <branch> origin/main` and symlink `node_modules` to
`investigations/2026-10-02-mosquito-id/10-github-pages/site/node_modules`.

## What is live

R2 bucket `mosquito-id-models`, **2.03 GB of the 4 GB cap**, both CORS-verified:

- `culico-net-cls-v1-17-embed.onnx` — 85,378,550 bytes
- `text_embeds_culico.json` — 471,890 bytes

culico is **selectable and labelled `(experimental · 81 MB)` in the selector**.
**H/14 is the default** — restored deliberately, see below. The live site is
usable.

## Two structural facts that shaped the artefact

**The released culico ONNX exposes only its own 18-way head.** The 1152-d
penultimate feature is not an output; `extract_culico.py` added it by editing the
graph, so the cached features the probe was fitted on were never reachable from
the released file. `build_onnx.py` re-exports the released checkpoint with that
feature as a second output plus a constant `1.0` column, and `verify.py` shows it
reproduces the cached features **bit-exactly** (max abs diff 0.0). That is why the
shipped filename differs from the original by 188 bytes.

**The app's head has no bias term.** `softmaxJoint` computes a bare
`scale * dot(row, emb)`. A logistic probe's intercept has nowhere to go, so the
appended `1.0` coordinate carries it: the last column of each weight row *is* the
intercept. Both sides agree without a change to scoring code.

## The bug: species readout is broken

**Symptom.** Every photo reads "Not confident enough to name a genus". A CSV of
the ten sample photos showed `Aedes  0.0%  Not confident  0.0%` on all ten.

**The 0.0% is not a posterior.** Ten of the sixteen species in the app's label set
have **zero** species-rank training rows — every Culex and Anopheles row is
genus-rank only (2,034 rows), plus three Aedes and one Culiseta. Because there is
no within-genus evidence for those, the head gives each of them the **genus**
weight row. On a correctly identified Aedes photo, the three unlabelled Aedes
columns therefore carry a full-strength genus logit and outscore the species
probe, and `Aedes vexans` wins by default because nothing ever pushed it down.

`sample_check.py`, real exported ONNX over `public/samples/*`, app's arithmetic:

```
IMG-20261002-WA0007.jpeg   Aedes  88.0%   Aedes vexans   24.3%
PXL_...182628741.jpg       Aedes  85.8%   Aedes aegypti  41.6%
PXL_...182720758.jpg       Aedes  95.3%   Aedes vexans   29.1%
```

**7 of 10 name a species with no training data.** Genus posteriors are 78–95%, so
nothing is collapsing; the confidence floors are simply being cleared on a
readout whose leading species is meaningless.

`pin_test.py`, all 6,264 rows, both options:

| unlabelled rows carry | genus argmax | species argmax | genus coverage @0.80 |
|---|---:|---:|---:|
| the genus row (shipped) | **83.27%** | **22.61%** | 54.8% |
| pinned low | 57.04% | **71.03%** | 52.4% |

Neither is shippable. Pinning trades 26pp of genus for 48pp of species, and the
app's default read is a genus.

## What is NOT the cause — checked, so do not re-check

- **The ×18 background row does not break anything.** `resweep.py` reports catch,
  FP, genus F1, species F1 and genus accuracy at every multiplier from 0 to 64:
  **genF1, spF1 and genAcc are identical at all of them.** It costs nothing.
- **Offline and browser agree exactly.** `parity.py`: cached-feature pipeline vs
  the exported ONNX, same six photos, `max|ΔspP| = 0.00e+00`, genus posterior
  identical to 4 decimals. Every offline number transfers.
- **No off-by-one.** Deployed embeddings are 16×1153, 8×1153, 8×1153, all exact;
  1152 feature columns + 1 intercept, intercept column holds per-class values.
- **The H/14 per-genus calibration is not leaking.** `CALIBRATED_ENGINES` +
  `cosineOffsetsFor` give culico an empty offset map. Note the trap: `undefined`
  means "use the H/14 offsets", so opting out needs `{}` explicitly.
- **The load path works.** Engine initialises, detector runs, `views_fused` fires.

## Next steps, in order

1. **Refit the head hierarchically.** A genus-only label should be evidence about
   the genus, not a reason to copy the genus row into every species column. The
   design already exists: `run_culico.py`
   (`investigations/2026-10-03-rewrite/40-precision/99-calibration-ship/`) builds
   `Z[species i in genus g] = log P_probe(genus g) + log w(species i | genus g)`,
   with nuisance/adjacent pinned. **The obstacle is structural**: that 31-column
   matrix is not expressible in the app's flat dot-product head. Resolving how to
   express a shared genus term plus a within-genus term in a per-species weight
   row — a rank-1 constraint — is the actual problem, and the honest options are a
   small app change or accepting the genus/species trade above.
2. **Do not ship until species argmax is measured**, not just genus. Target is
   both above ~70% on their own task.
3. **Fine-tune checkpoints on test.** Per the frontier handoff, partial
   fine-tuning of culico's last 25% is the only arm still climbing (val macro-F1
   0.7626 → 0.8005 → **0.8141** vs frozen probe 0.7932, epoch 3 of 4). Per-epoch
   checkpoints are on disk, so this costs no training. **Score on test with a CI
   before believing it** — val has been the generous split in every arm. Do this
   after (1), because a broken readout would corrupt any measurement on top of it.
4. **The `device` pre-init throw**, cosmetic, last. `ort.env.webgpu.device = …`
   throws `Cannot assign to read only property 'device'` on a real GPU adapter
   (it succeeds on SwiftShader, which is why headless runs pass). It is inside a
   try/catch and is non-fatal — the session is already created. Fix by not
   assigning, or by checking `Object.isFrozen` first.
5. **Browser-harness traps**, if you run one. Port **4173 only** is on the R2
   CORS allowlist. Playwright here gives the **last** registered matching route
   precedence, not the first. The detector must be served a *loadable* ONNX stub,
   not aborted: the app awaits it before requesting the classifier, so a failed
   detector fetch throws out of init and the classifier is never requested — the
   test then asserts against an empty list and passes for the wrong reason.

## Honest limits of this report

The ten-sample numbers come from the **real exported ONNX through the app's own
arithmetic**, not from an observed browser session with the real detector. That
distinction matters. An earlier claim that a browser run showed culico "working"
was wrong in a way worth not repeating: it showed the model *running and naming
something*, which given a species argmax of 22.6% is not evidence it named
correctly.

## Useful measurements already banked

Genus probe: **79.07%** argmax on the 1,252 uuid-grouped test rows; at the
shipped floors **58.4% coverage at 90.01% accuracy** (CI 87.6–92.0). Reproduced
from the shipped head file through app arithmetic (`verify_app.py`), so these
describe the artefact as deployed.

Background row: fitted without intercept, fitted against a **different species
scale** than the shipped head — at native magnitude it catches **0%**, because
species logits reach ~2.1 and the row only ~0.27. Rescaled ×18 it catches
**72.86%** of held-out negatives at **0.02%** false positives. It goes in
`adjacent_emb`, not `nuisance_emb`: `verdict.ts` gates on `adP`. Anyone
re-deriving it will hit the same scale wall.
