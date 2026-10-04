# BioCLIP B/16's head: refitted, with a fitted background row

Measured 2026-10-04 on `agent/b16-head-refit`, off `main` 44f26aa. Every number is
`softmaxJoint` -> `nonMosquitoGate` / `fuseViews` -> `verdictFrom` driven from real B/16
features, not a re-implementation.

**The fitted head assumes CENTRE-CROP geometry** (short side to 224, centre crop the
overflow) — what `clipEmbed` does today. Its numbers are conditional on that. See
"Geometry".

## Before and after

| | shipped text head | refitted head |
| --- | ---: | ---: |
| **700 negatives refused by the gate** | 615 (87.86%) | **685 (97.86%)** |
| **2,450 real mosquitoes refused** | 561 (22.90%) | **20 (0.82%)** |
| what it names on the negatives | `a photograph of a wall` (312), `a photograph of a fly` (198) | `a photograph without a mosquito` (685) |
| species argmax | 24.61 | **62.24** |
| genus argmax | 62.90 | **83.06** |
| `logit_scale` / temperature | 100.0 / 2.5 = **40.0** | 2.5 / 2.5 = **1.0** |
| species row norms | 1.0 (all 16) | 3.6 – 28.8 |

Every axis improves. The defect Cornelius reported — 561 real in-domain mosquitoes
answered `a photograph of a fly` / `a photograph of a person` / `a photograph of a wall`
— falls to 20, and the gate now names background for what it is.

## The defect, measured

B/16's head has **no `adjacent` block** — no `adjacent` block — so its eight nuisance
rows are the gate's only evidence. On culico fifteen of the twenty-four non-species rows
are pure intercepts, which `informativeRows` reads as constants, so culico's nuisance
block cannot fire at all. B/16 is the opposite case: a text head carries **no bias
coordinate**, so `informativeRows` returns all-true and **all eight rows are live
evidence**.

Those eight are zero-shot text prompts, never fitted against a mosquito, so their block
mass rises exactly when the species block is unsure. On the 2,450 nameable test
mosquitoes the gate fired on 561 of them (22.90%), naming `a photograph of a person` on
101. `cosineOffsetsFor("webgpu-b16")` returns `{}` — those numbers are through the app's
own path, with no per-genus offsets.

## The eight rows are not the whole block: one fitted row fixes it

The first attempt at this change refitted only the species rows and raised the nuisance
floor, and shipped that trade: mosquitoes 561 -> 137, but negatives 615 -> 255. That
claim — "there is no setting that catches background without also catching insects" —
**was wrong, and an adversarial review found it.** It is true of the eight text rows; it
is not true of the block.

Adding one fitted row, `a photograph without a mosquito`, to the same softmax:

- fitted as a plain logistic detector on the 700 detector-verified background crops
  against 1,500 in-domain mosquitoes, on the app's transformed features, unrescaled;
- held out **by source photograph** — 538 photographs, up to two crops each — so a crop
  from a held-out photograph is never in the fit;
- the threshold set on the training folds as the cheapest one that loses zero training
  mosquitoes, then read on the held-out negatives.

| nuisance floor | negatives refused | mosquitoes refused |
| ---: | ---: | ---: |
| 0.05 | 100.0% | 54.0% |
| 0.20 | 99.3% | 6.4% |
| **0.30** | **97.9%** | **0.8%** |
| 0.60 | 90.6% | 0.04% |

At 0.30 the fitted row does the work and the eight text rows stop mattering: every one
of the 685 refusals is named `a photograph without a mosquito`. Against the shipped
head's 87.86% on negatives and 22.90% on mosquitoes, that is better on both axes — which
is what makes the floor raise safe here in a way it was not before.

This is the same repair culico's head received one commit earlier (`docs/HEADS.md`,
"The background row had to be refitted"). The label is identical. What differs is that
B/16's eight remaining rows are *text* rows rather than intercepts, so they carry image
information and `informativeRows` reads them — which is why B/16 needs the floor at all
and culico does not.

## What the refit is, precisely

The sixteen species rows are the coefficients of a 16-way multinomial logistic probe
fitted on 7,122 training photographs, on the **same transformed features the browser
produces**. `logit_scale` is 2.5, so `logit_scale / temperature` is exactly 1.0 — the only
scale at which `softmaxJoint`'s softmax *is* the probe's own. The eight shipped nuisance
rows are byte-for-byte unchanged; no nuisance row was invented.

Three things follow from B/16's shape, none of them true of culico's head:

1. **512-d, no bias coordinate.** `EMB.dim` is 512, the model's output width, so
   `clipEmbed`'s `feats` loop covers the whole vector and the app's transform is a plain
   L2 normalisation. The head stays 512-wide and declares no `bias_index`.
2. **The fitted intercept has nowhere to go.** `softmax(X@W.T + b)` is not
   `softmax(X@W.T)` — `b` is per-class, not a global shift. Fitting without an intercept
   costs **0.94 pp species and 0.53 pp genus** at C=10, which is what the honest fit costs.
3. **`logit_scale` 100 was 40x too sharp.** It is a temperature for a cosine readout;
   against a fitted head it scores **NLL 25.69 against 1.14** at scale 1.0 on the probe's
   own validation split. Sweeping 0.25–4.0 on validation, **1.0 is the optimum** — hence
   `logit_scale = temperature = 2.5`.

The fitted background row comes out at norm 20.2, inside the species rows' 3.6–28.8
range, so it competes in the shared softmax without rescaling anything.

## Per-engine floors

`floorsFor("webgpu-b16")` carries species 0.80, genus 0.90, **nuisance 0.30**. Species
and genus were fitted on one half of the held-out corpus and read on the other:

| | fitted on half A | reported on half B |
| --- | ---: | ---: |
| species accuracy at 0.80 | 95.3% | 92.8% |
| genus accuracy at 0.90 | 98.9% | 98.3% |

Both clear the ~88% accuracy target the shipped floors were chosen against. **Nothing
global was widened**: culico and H/14 keep `DEFAULT_FLOORS` in full, and
`tests/engine-floors.test.ts` asserts that.

## The label space, and the three classes it cannot name

The sixteen species columns are unchanged. The corpus also carries three genus-only
labels — a bare `culex`, `culiseta`, `anopheles`, 2,084 rows. They are **excluded from
the denominator**, not counted as errors: the head has no column for them, and folding
them into a member species would name a species the photograph was never identified as.
Every denominator above is the 2,450 test rows whose label *is* one of the sixteen.

## Off-corpus, and what the in-corpus numbers are worth

`24.61 -> 62.24` species and `62.90 -> 83.06` genus are **in-corpus**: the argmax over
the test split of the corpus the head was fitted on. No test rows entered the fit
(`leak_check` reports zero straddling groups). But culico's equivalent in-corpus 61.22
fell to 20.29 on unseen rows from a different corpus, so **62.24 should be read as "what
the fit bought", not "what it generalises to."** B/16's off-corpus number was not
measured in this pass — that is a real gap, not a formality.

The gate's numbers do not have this caveat in the same way: the 700 negatives and the
cross-validated held-out fractions are the gate's own evaluation set.

## Geometry

The head is fitted on **centre-crop** features. PR #55 proposes letterbox. **If letterbox
lands, this head and its floors are invalid.** Measured on 600 photographs under both
geometries on the same model:

- cosine(centre, letterbox) = **0.764** mean, min 0.234 — farther apart than the 0.865
  culico's `docs/HEADS.md` records for its analogous mismatch.
- Scored under letterbox, the head picks a **different species on 37.3%** of
  photographs, and its nuisance block regresses to 12.2% mosquito refusals.

There is no runtime guard on geometry. That is the sequencing risk, not the head.

**Pad area as a leakage channel.** Under letterbox the pad fraction is set by aspect
ratio, so if aspect correlates with label the grey border is a shortcut. Over all 14,072
corpus photographs: median aspect 1.333, 92.4% get some pad, 5.0% exceed 2:1. Pad
fraction explains **eta-squared 0.0345 of species** and **0.0002 of genus**. A probe
given *only* (aspect ratio, pad fraction) and no pixels reaches **val macro-F1 0.0259,
test species 9.78%** against 5.26% chance — a real but weak channel, far too weak to be
a usable shortcut, and not a reason to prefer either geometry.

## What the adversarial review changed

The review ran before this head was final and its findings are reflected here rather than
argued with:

- **The nuisance block was repairable.** The first version of this change asserted it was
  not. It is; see above. That is the single largest correction.
- **The defect count was quoted from the wrong path.** An earlier draft said 26.9% and 127,
  measured with H/14's per-genus cosine offsets applied to B/16, which the app does not do.
  The app-path figures are **22.90% and 101**, and both files now say so.
- **The mosquito fixture was 64 copies of one species.** `split_groups` orders the test
  split by class, so its first 64 nameable rows are all *Aedes aegypti* — the fixture did
  not contain the species the bug was reported against. It is now class-stratified across
  all sixteen, four per class where the corpus allows.

## What is not claimed

- Off-corpus behaviour is unmeasured; see above.
- The three genus-only corpus labels are excluded, not counted as errors.
- The floor of 0.30 is chosen on the 700 negatives, which are also the reported set. The
  *row* is cross-validated by source photograph; the *floor* is not, because the floor is
  a single scalar read off a monotone curve where 0.30 is not near a knee.
