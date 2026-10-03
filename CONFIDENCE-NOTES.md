# The confidence subsystem: what it is, and what is wrong with it

Written after extracting the whole of it into runnable modules
(`src/confidence/`), which is the first time this arithmetic has been able to be
executed in isolation rather than read.

## The shape

Five pure functions, all now taking `EMB` (the head: labels + embeddings) and a
`Floors` object as **parameters** rather than reading module-scope globals:

| Module | Exports |
| --- | --- |
| `confidence/genus.ts` | `genusOf`, `speciesGenusIndex` |
| `confidence/softmax.ts` | `softmaxJoint`, `adjacentNames` |
| `confidence/genusScores.ts` | `genusScores` |
| `confidence/viewAgreement.ts` | `viewAgreement`, `agreementSentence` |
| `confidence/verdict.ts` | `verdictFrom`, `verdictSentence` |
| `confidence/fuseViews.ts` | `fuseViews` |
| `confidence/pooling.ts` | `splitPoolable`, `poolingWeights`, `aggregateLogits`, `pooledCandidates`, `pooledPosterior`, `pooledVerdict` |
| `confidence/scorebar.ts` | `scoreRow`, `pooledScoreRow` |

The floors and their derivations are in `confidence/types.ts`, in one place:

```
SPECIES_CONFIDENCE_FLOOR  0.373
GENUS_CONFIDENCE_FLOOR    0.80
NON_MOSQUITO_FLOOR        0.60   <- chosen for behaviour, NOT fitted
GENUS_MARGIN              0.02
TEMPERATURE               2.5
VIEW_DISAGREEMENT_VETOES_SPECIES  true
```

## The bug: the pooled card names species no photo claimed

**This is the three-blank-photos screenshot (`bogusresults.png`), and it is
real.** It is not a rendering artefact.

The per-photo verdicts were correct: each of the three blank background photos
read ~28.6% on its top species, below `SPECIES_CONFIDENCE_FLOOR` = 0.373, so each
one reached only the `genus` state or abstained, and **none of them claimed a
species**. The pooled card then named `Culex pipiens`.

The cause is that the pool **sharpens**. `updatePooling` sums per-photo logits
and softmaxes the aggregate, which is

```
softmax( Σ_i log p_i )  =  normalize( geometric mean of p_1..p_k )
```

For near-identical posteriors, cubing raises the winner. Working the real head
and the real floors:

```
per photo   top species 0.355 / 0.350 / 0.360   all below 0.373 -> no claim
            top genus   0.875 / 0.872 / 0.879   all above 0.80  -> genus state
            => genus state, so all three ARE included in the pool

pooled k=2  top species 0.4070   above 0.373
pooled k=3  top species 0.4625   above 0.373  -> SPECIES CLAIM
pooled k=5  top species 0.6501
```

Nothing about the evidence improved between k=1 and k=3. The transformation did
it: each photo contributes `log p`, and adding three `log p`s is cubing.

**Why this is a defect and not a design choice:** both floors were fitted on
single- and two-view posteriors. `SPECIES_CONFIDENCE_FLOOR` = 0.373 is the
90%-coverage point measured on a 659-row corpus of *individual* classifications.
The pool is a different distribution - systematically sharper - and the species
floor is being read off it anyway. A threshold calibrated on one distribution is
not valid on another.

`tests/regressions.test.ts` asserts the current behaviour, with the arithmetic
in the comment, so the failure is legible when a fix lands.

### Options, none of which is "raise the floor"

- **Gate the pool on the photos, not on the pooled posterior.** A pool may only
  reach a species claim if the *individual* photos cleared the species floor.
  Directly matches the intuition - pooling is for more evidence, not more
  resolution - and is checkable against the existing per-photo benchmarks.
- **Calibrate a separate pool floor** on pooled posteriors from the labelled
  cache. Principled, but needs the cache re-scored through the pooling path.
- **Report the pool at genus granularity only**, dropping the species claim from
  the pooled card. Cheapest, loses real signal on genuine multi-photo sets.

The first is the one the data supports and the cheapest to check.

## The same card can never say "not a mosquito"

Independent of any threshold, and found separately: `updatePooling` calls
`verdictFrom(pooledSpP)` with no adjacent posteriors, and `pooledPosterior`
softmaxes over the 16 species **alone**. So the adjacent mass is absent from the
numerator *and* from the denominator - the pooled species posteriors are inflated
to sum to exactly 1 as if no other class existed - and the non-mosquito branch
never runs at all.

With the real head:

```
three photos, each 97% biting midge
  per-photo verdict                     non-mosquito   (the gate does fire)
  pooled species posteriors sum to      1.000000       (adjacent mass in neither term)
  pooled verdict                        species        <- a midge, called a mosquito
```

This is not a threshold problem, so no floor value changes it. Carrying the
adjacent classes through the pool is a prerequisite for the pooled card being
able to say "not a mosquito" at all, and it is independent of the species-floor
fix above.

`adP` is now a **required** parameter of `verdictFrom`. It was optional, so
`updatePooling`'s omission arrived as `undefined` - which is exactly what a
deliberate empty array also looks like, so the omission and the intent were
indistinguishable and the compiler accepted both. The one caller with genuinely
no adjacent evidence, `pooledVerdict`, now passes `[]` on its own line with the
gap documented: the omission can no longer happen by forgetting an argument, only
by writing that line.

## Also found, lower severity

**`updatePooling`'s comment described a formula the code did not implement.** It
says the pool is log-linear, `log p ∝ Σ_v log p_v`, and that this is "the pooled
posterior exactly". The code sums per-photo *logits* (`scale * cos`), which is
`normalize(geometric mean)` — equal to `Σ log p` only when the weights sum to 1.
Under "Dependent evidence" with duplicates they do not: two distinct photos at
r=0.5 each weigh 1/1.5, summing to 4/3. The two forms agree up to a positive
scale factor whenever weights are equal, so this has never produced a wrong
number — but the comment is not describing the code, and it is the kind of
comment that makes the next person reason about the wrong thing. Now that
`pooling.ts` owns the arithmetic, the derivation sits next to it.

## Things that are correct and worth not "fixing"

- **`splitPoolable` excludes `unsure`, `non-mosquito`, pending and errored
  photos**, and only those. A `genus`-state photo contributes, which is right:
  its evidence is sound, only its resolution is coarser. This part is right and
  the exclusion of `non-mosquito` is what makes that state safe to introduce.
- **The view-disagreement veto** is correctly placed and correctly narrow. It
  demotes into the genus branch rather than past it, so the genus floor still
  decides the rest — and it is inert when there is only one view, because
  `viewAgreement` returns `null` below two views and `null` is not a
  disagreement.
- **`fuseViews` refuses to pool across scales** and falls back to the first view
  rather than producing a number that looks fused but is not. Correct.
- **The non-finite guards** (`scoreRow`, `pooledScoreRow`, `pooledPosterior`)
  all work. `pooledPosterior` returns `null` rather than `NaN` on both a single
  non-finite logit and an all-`Infinity` aggregate.

## What is still untested

The DOM rendering, the crop geometry, the model plumbing and the worker
boundary. `src/app/main.js` is ~2,980 untyped lines and none of it has unit
tests; `e2e/smoke.spec.ts` only proves the page boots. That is the next seam.
