# Score hardening: the non-mosquito gate, the two floors, and legible abstention

Branch `fix/scoring-hardening`. Measurements in `measure_gate.py`,
`measure_increment.py` and `measure_candidates.py` in this directory; each
reproduces `softmaxJoint` from the shipped embeddings rather than reimplementing
it, and runs in about 0.3 s.

Data:

- **negatives** — 700 detector-verified in-domain background crops
  (`tmp/adjacent-taxa-work/neg`), from 991 crops cut from our own corpus. Every
  one passed the YOLO detector at <0.15 confidence, so each is a crop from a real
  in-domain photo with no mosquito in it.
- **positives** — the 6,264-row in-domain mosquito cache
  (`investigations/2026-10-03-rewrite/40-precision/50-h14-scale/cache`), 16
  species head, four source datasets.

No model was retrained, re-exported, or re-run. Every embedding below was already
on disk.

## 1. The gate read the wrong block

`verdict.ts` reduced `adP` alone. The head carries three blocks in one softmax:

| block | count | what a row says |
|---|---|---|
| species | 16 | this is that mosquito |
| nuisance | 8 | *a photograph of a wall*, *of a hand*, *of a plant*, *of an empty background* |
| adjacent | 7 | Ceratopogonidae, Chironomidae, Simuliidae, Tipulidae, Syrphidae, Muscidae, Tabanidae |

The nuisance rows are the "this is not an insect photograph" statements, and the
gate never saw them. A blank piece of paper is exactly what those eight rows
describe, and exactly what the gate could not reject.

**Sum, or require nuisance?** Neither. The two blocks are different claims and
they take different actions:

- **adjacent** is "this is a different insect". A midge photo arguably *should*
  be answered as a midge — that is a real finding and it names a family the user
  can act on.
- **nuisance** is "there is nothing mosquito-like here". There is no family to
  name. Reporting `Ceratopogonidae` for a photograph of bare wall is a guess
  presented as a finding, and it is worse than useless: it names an insect that
  was never in the picture.

So they get **separate floors, separate verdict fields, and separate sentences**.
`Verdict` now carries `nonMosquitoKind` plus exactly one of `adjacent` /
`nuisance`, never both, and `verdictSentence` words them differently:

- adjacent → `This does not look like a mosquito - it looks like a biting midge (94% of the match).`
- nuisance → `There is no mosquito in this photo - it looks like a photograph of a wall (90% of the match).`

**The dependency the coordinator asked about is real and it is total.** Before
this fix the two cases were not "hard to tell apart" — they were *the same
string*, because the nuisance case could not reach the gate at all. Distinguishing
them is not a reporting change layered on top of the gate fix; it is only possible
because of it.

## 2. The 0.60 floor was never fitted for true negatives — measured

The doc comment said so. Measured, on both populations at once for the first time:

| rule | negatives caught (of 700) | mosquitoes lost (of 6,264) |
|---|---|---|
| **adjacent ≥ 0.60 (shipped)** | 11 — 1.57% | 15 — 0.239% |
| summed (adj + nu) ≥ 0.60 | 18 — 2.57% | 17 — 0.271% |
| either, each ≥ 0.60 | 11 — 1.57% | 15 — 0.239% |
| **either, adj 0.60 / nu 0.05 (shipped)** | 80 — 11.43% | 30 — 0.479% |
| either, adj 0.60 / nu 0.10 | 40 — 5.71% | 17 — 0.271% |

The floor was fitted on the wrong axis. It was expensive in the currency it *was*
fitted in (0.239% of true mosquitoes) and weak in the one it was not (1.6% of
true negatives), and adding the nuisance block at its own floor quadruples what
the gate rejects for 0.24 percentage points more false positives.

### Why one floor cannot serve both blocks

This is arithmetic, not taste. The nuisance mass distribution:

| | p50 | p90 | p99 | max |
|---|---|---|---|---|
| negatives (700) | 0.0093 | 0.0505 | 0.2249 | **0.4982** |
| positives (6,264) | 0.0000031 | 0.00015 | 0.0153 | **0.2043** |

**Nuisance mass never reaches 0.60 on anything measured** — 0.498 at the very
maximum over 700 real negatives, against a species floor of 0.373. A shared 0.60
would leave the nuisance path permanently unreachable: dead code that reads as
working, and the exact failure being fixed. Conversely adjacent mass on true
mosquitoes is an order of magnitude larger (p99 0.31, max 0.88), so it cannot
bear a low floor — at 0.10 the adjacent block costs 205 mosquitoes.

The two blocks separate well individually, which is what makes two floors viable:
AUC 0.9639 (adjacent) and 0.9722 (nuisance) against the same positives.

### Why 0.05

Swept, and it is a knee rather than a round number picked to look good:

| nuisance floor | adds negatives | adds mosquitoes lost | total caught | total lost |
|---|---|---|---|---|
| 0.02 | 177 | 45 | 188 (26.9%) | 60 (0.958%) |
| 0.03 | 124 | 30 | 135 (19.3%) | 45 (0.718%) |
| **0.05** | **69** | **15** | **80 (11.4%)** | **30 (0.479%)** |
| 0.08 | 37 | 4 | 48 (6.9%) | 19 (0.303%) |
| 0.10 | 29 | 2 | 40 (5.7%) | 17 (0.271%) |
| 0.20 | 9 | 1 | 20 (2.9%) | 16 (0.255%) |

0.05 costs what the adjacent block already cost (15 mosquitoes) for 6× the
coverage. 0.10 halves the benefit for a 0.03pp saving; 0.02 doubles the false
positive rate. **I did not tune either floor to make a number look good** —
`nonMosquito` stays at its shipped 0.60, and 0.05 is read off this curve.

### The floor could not honestly be set on the pre-existing data

The prior state of the art said outright that the negative side "could not be
measured at all: that cache contains no non-mosquito images". That was true
until the 700-crop negatives set existed. **Without that set this fix would have
had to be shipped unmeasured, and the honest move would have been to add the
nuisance block to the gate without changing any floor.** The floor work depends
on data that was not in the repo when the brief was written.

### The in-distribution false-positive cost is real and stated

Going from 15 to 30 lost mosquitoes is 15 extra real photos the app will refuse to
answer. At 0.479% of the in-domain set that is a defensible price for quadrupling
rejection of true negatives, but it is a price, not a free win, and it is the
number to argue with if anyone wants the floor moved.

## 3. Defect 3 (the `fused` scope bug) — already fixed, verified

PR #21, commit `3040bf6` "Keep the fused result the log line reports", is present
at the tip of `origin/main` and rebased onto this branch. `classifyViews` at
`src/app/main.js:1885` now reads `fused = applyViews(p, landed, views.length)` and
the `views_fused` log line reads `posteriorSummary(fused || {})`. Not re-fixed.

## 4. Abstention that says what it is unsure between

The `unsure` state rendered as one fixed line. That line is true of every
unconfident photo and therefore says nothing about any of them. `runnersUp` is
scoped to the leading genus, which is the wrong set when no genus is named — an
undecided photo is often torn between *Anopheles* and *Culex*, and naming
*Anopheles*' siblings would report a tie the posterior does not show.

`Verdict.candidates` carries the leading species **across genera**, and
`verdictSentence` names up to three of them:

> Not confident enough to name a genus - between japonicus, koreicus and geniculatus

Three existing tests pinned the old fixed string and were updated to assert both
halves — that the abstention still claims nothing, and that it now names the
candidates. **No layout changed, no new element, no status or processing text.**
The `unsure` verdict still returns `species: null` and `genus: null`, and the
four tests pinning `species: null` in the genus state pass unchanged.

## 5. Floors, and the abstention-quality distribution

The coordinator asked for the state distribution the shipped floors produce on the
cache, rather than another accuracy number. Adjacent-only and adjacent-or-nuisance
are **identical** here, because the 6,264 cache rows contain no negatives and the
nuisance block costs 0 of them at 0.05:

| state | count | share |
|---|---|---|
| species | 5,340 | 85.25% |
| genus | 142 | 2.27% |
| non-mosquito | 15 | 0.24% |
| **unsure** | **767** | **12.24%** |

**One photo in eight abstains.** Genus-level accuracy among named states is
95.13% and overall 81.10%. (Compared at genus level, not species: a quarter of the
cache rows carry a genus-only label like "Culiseta", and scoring those
species-exact reports 37.8% for a reason that has nothing to do with the gate.)

The species floor sweep says 0.373 is not abstaining too much, but the curve is
flat where it sits, which is worth knowing before anyone moves it:

| species floor | named | genus acc among named | overall |
|---|---|---|---|
| 0.20 | 97.91% | 91.15% | 89.24% |
| 0.30 | 92.00% | 93.51% | 86.03% |
| **0.373** | **85.25%** | **95.13%** | **81.10%** |
| 0.45 | 76.09% | 96.94% | 73.75% |
| 0.55 | 62.42% | 98.13% | 61.25% |
| 0.80 | 31.29% | 99.69% | 31.19% |

Overall accuracy peaks near 0.20–0.30 and falls monotonically as the floor rises,
which is the usual coverage/accuracy trade and not by itself evidence that 0.373
is too high — it was fitted for 90% coverage, and this curve says it delivers
95.1% at that coverage. **All three floors remain fitted on an all-mosquito cache.
This table is the evidence they have never been validated against abstention
quality, and it does not settle whether the values are right.**

## What was ruled out

- **A shared floor for both blocks.** Nuisance mass peaks at 0.498 (negatives) and
  0.204 (positives); 0.60 is unreachable. Pinned as a test.
- **Summing the blocks.** At a shared 0.60 it catches 18 negatives for 17 lost,
  versus 80 for 30 with separate floors. Summing also produces a third number that
  is on neither block's axis.
- **The adjacent block doing the nuisance block's job.** At every matched positive
  budget from 0.05% to 2%, the best nuisance floor that fits the budget adds **0
  extra negatives** while the floor stays at 0.60 — because at 0.60 the nuisance
  block cannot fire at all. This is what forced the second floor.
- **Tuning the floor for the headline number.** Not done; the full sweep is above.

## Known limitations, stated rather than hidden

1. **The negatives are in-domain background crops**, not photographs of walls. They
   are harder negatives than "a photograph of a wall" — they are often a mosquito's
   own habitat — so 11.4% caught is a *conservative* estimate for blank-wall
   rejection and the true figure is likely higher. It is also the only negative set
   that exists; there is no held-out set of photographed non-objects.
2. **The negatives are 700 crops from 991 candidates cut from the same corpus**,
   so they are correlated. Confidence intervals are not quoted because the
   correlation structure is not modelled.
3. **culico cannot reject anything, before or after this change.** Its 8 nuisance
   rows have exactly 1 non-zero coordinate each and its adjacent rows have 1152 of
   1153 — only the appended bias coordinate moves. Confirmed directly against
   `text_embeds_culico.json`. This is a **model** defect and is out of scope here.
   The gate logic is correct; culico's head gives it nothing to read.
4. **`pooling.ts` calls `verdictFrom` without `nuP`.** The pooled-across-photos
   card therefore reads the adjacent block only. `pooling.ts` is owned by another
   agent in this wave, so it is reported and not changed — see below.

## Change outside the briefed file set — flagged

`src/app/main.js:59`, the `verdictFrom` adapter, was changed from
`(spP, agreement, adP)` to `(spP, agreement, adP, nuP)`, forwarding `nuP` to
`verdictFrom`. This is one line, outside the `classifyViews`/`applyViews`/
`viewsFor` region, and it was made because the new e2e test drives the real gate
through `window.__mosqAsync.verdictFrom` and cannot pass nuisance evidence
otherwise. It is production-dead code (`main.js` calls `fuseViews`, which passes
`nuP` itself) and exists only for the test seam. Reverting it breaks
`e2e/tier1/empty-photo.spec.ts` and nothing else. **Revert it if the region
boundary is meant to be absolute.**

## For whoever picks up pooling

`src/confidence/pooling.ts:362` calls `verdictFrom(head, spP, null, adjP, floors)`.
The pooled-across-photos card computes no nuisance mass, so a pool of wall photos
is not gated by the nuisance block. `pooledPosterior` renormalises the species
posteriors against `adjP` only. Making that consistent means computing the pooled
nuisance mass on the same denominator and passing it as the sixth argument — the
same one-line shape as the `fuseViews` change. Not done here because that file is
another agent's.
