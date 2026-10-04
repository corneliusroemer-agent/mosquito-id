# Head files: what one has to declare, and what a refit has to fill in

A "head" is one `public/text_embeds_*.json`: a label list per block, the
embeddings for those labels, and `logit_scale`. `softmaxJoint` scores an image
against every row of the head in one softmax, and the non-mosquito gate reads the
two blocks that are not species.

Two things about a head file are not obvious from its shape and have cost the app
a regression each. Both are now stated by the file itself rather than inferred.

## `bias_index`: which coordinate is the intercept

The app's head is a bare dot product, so a linear probe's intercept has nowhere to
go. For culico the model graph appends a constant `1.0` coordinate to the
embedding and the head's last weight column is the matching intercept. The head
declares which coordinate that is:

```json
{ "dim": 1153, "bias_index": 1152 }
```

A head from a text encoder has no such coordinate and omits the key. Nothing in
the app can infer it: for H/14 the last coordinate is an ordinary feature, so
"the last one" would be wrong.

`clipEmbed` normalises over the embedding including this coordinate, so the
coordinate the app scores is `1/n` per photograph rather than `1.0` — which is
how a placeholder row can express "this class scores `-0.6` against everything" at
all, since its intercept column is a fixed number divided by a feature norm that
is roughly 35. A head that has one and wants a *fitted* intercept has to be
fitted on the post-normalisation vector rather than on the 1152 features with a
separate intercept; see "culico's fitted head" below.

## Blocks that are not fitted

A 16-species linear probe fitted on 16 species has no training signal for "a
photograph of a wall" or for `Ceratopogonidae`. culico's head carries all sixteen
anyway, because the gate and the score panel read them, and fifteen of them are
placeholders: rows whose only non-zero weight is the intercept coordinate.

A placeholder is a constant. It scores the same on every photograph, so its
posterior rises exactly when the classifier is unsure about the species. Read as
evidence, a block of placeholders fires the gate on hesitation and names whichever
row the file lists first. `informativeRows` (`src/confidence/softmax.ts`) is what
stops it: the gate sums and ranks only rows with weight outside the intercept
coordinate, so a block with none of them cannot fire and a block with one of them
is that one row's detector.

Measured on culico, on the same 700 detector-verified in-domain background crops
and 6,264 in-domain mosquitoes used to fit the floors, with the app's own
preprocessing:

| | nuisance rows that carry image information | adjacent rows that do |
| --- | --- | --- |
| culico | 0 of 8 | 1 of 8 (`a photograph without a mosquito`) |
| H/14 | 8 of 8 | 7 of 7 |

Reading all of culico's rows put 3,730 of the 6,264 mosquitoes in the
non-mosquito state, every one named `a photograph of a person`, from the eight
identical placeholder rows in the nuisance block. Reading only the fitted rows:

- **0 of 6,264** in-domain mosquitoes refused, against 3,730 before.
- **414 of 700** negatives refused, all named `a photograph without a mosquito`,
  which is the fitted background row doing its job.

The adjacent floor of 0.60 needed no change and was never wrong for culico. It was
unreachable, because the one real detector shared a block total with seven
constants that could never push that total anywhere.

### What a refit has to do

Fitting the placeholder rows is the real repair and is a data job, not a code one.
`tests/culico-head.test.ts` pins the counts, so a head that fills them in fails
that test — which is the signal to re-measure the block's floor for that engine
rather than a silent change in what the app refuses.
## culico's fitted head: how a probe becomes something this app can run

Refitted 2026-10-04. The species rows are now the coefficients of a 16-way
multinomial logistic probe fitted on 7,122 training photographs; the other two
blocks are byte-for-byte what they were. `tests/culico-head-refit.test.ts` holds
the result to the numbers below.

### What the app actually computes

For one photograph, `clipEmbed` produces

```
e = [raw(1152), 1.0] / sqrt(sum(raw^2) + 1)          # 1153 long, == EMB.dim
```

and `softmaxJoint` produces, for one head row `r`,

```
logit = (logit_scale / temperature) * (e . r)
```

A head row is therefore an arbitrary vector and the app's logit is that dot
product times one scalar. A sklearn probe's own posterior is `softmax(X @ W.T)`
on whatever `X` it was fitted on, so the probe reproduces itself in the app only
if three things hold at once:

1. **It is fitted on `e`, all 1153 of it, with no separate intercept.**
   `clipEmbed` divides the constant `1.0` by the feature norm along with
   everything else, so the bias coordinate is not 1.0 at scoring time — it is
   `1/n` per photograph, and `n` runs from 26 to 95 across this corpus. Fitting
   on the 1152 features with an intercept and then pasting that intercept into
   column 1152 would apply it divided by a different `n` on every row. Fitted on
   `e`, the intercept is a weight on that coordinate and it varies with the
   photograph exactly as the app's does.

2. **The rows are the coefficients, unrescaled.** A text head's rows are unit norm
   because its readout is a *cosine*: the dot product has to land in `[-1, 1]` for
   `logit_scale = 100` to be a temperature. A fitted linear readout has its own
   scale and its margins are the confidence signal, so re-normalising its rows
   would throw away the only thing that says how sure the classifier is.
   `tests/culico-head-refit.test.ts` asserts the rows are not all one norm.

3. **`logit_scale` equals `temperature`, so the scale is exactly 1.0.** It is 2.5
   and `DEFAULT_FLOORS.temperature` is 2.5, and that is not a coincidence to
   preserve: 1.0 is the *only* scale at which the app's softmax is the probe's own
   softmax. The value 2.5 was fitted against the previous head's rows and has no
   meaning here; it survives because the arithmetic requires it, and
   `localViewScale(head) === 1` is asserted so a future edit that rescales the
   rows or retunes the temperature fails rather than quietly changing what the
   browser reports.

Measured on 64 held-out photographs, the app's species posterior renormalised
over the species block matches the probe's own distribution to **1.4e-8**, and the
winning species agrees on 64 of 64. `main.js` narrows `species_emb` to
`Float32Array` on load and the tests read the JSON's numbers directly; that costs
nothing — over all 20,336 corpus rows the argmax is unchanged and the largest
posterior shift is 2.6e-8.

The renormalisation is not a fudge. `softmaxJoint` puts species, nuisance and
adjacent in ONE softmax, so the species posteriors are the probe's times the
probability that the photograph is a mosquito at all — which is the quantity the
gate and the fusion are built to read. On those 64 the other two blocks take
between 0.4% and 28% of the mass, entirely from the fifteen placeholder rows.

### The features have to be the ones the browser produces

The probe corpus was extracted with culico's own ImageNet statistics at 256.
`clipEmbed` feeds `CLIP_MEAN`/`CLIP_STD` at 224. On the same photographs the two
land in different places — **cosine 0.865**, relative L2 distance 0.52 between the
1152-d feature vectors. A head fitted on the first is scored against the second in
the browser. The refit uses features extracted through `clipEmbed`'s own geometry
and normalisation, which costs about 1.7 points of species accuracy against the
ImageNet-extracted fit and is the honest number.

### How the row size was chosen, and why that was the axis

`logit_scale` multiplies every logit together, so it cannot trade the species block
against the blocks it shares a softmax with. The *size of the species rows* can,
and the L2 penalty `C` is exactly that size.

This matters because the background row is not on the species block's scale and
never moves with it. `a photograph without a mosquito` is a fitted row of norm 18,
and the fifteen placeholders sit at a fixed logit of about -0.6 on a typical
photograph. A saturated head drowns both; a calibrated probe does not. At `C = 100`
the refitted rows come out at norm ~112 and the same detector refuses only **8.3%**
of the 700 background crops instead of the shipped head's 59.1% — the gate is
dead, and no floor or temperature brings it back, because scaling every logit
together leaves the ratio between them unchanged.

So `C` was chosen against what the app does, on data the fit never saw:

> Among the `C` values whose species rows keep the 700-negative refusal rate within
> 5 points of the shipped head's, take the best val macro-F1.

The 700 detector-verified background crops are the gate's own held-out set, not
part of the probe split, so they are legitimate selection data. The species **test**
rows are not in this decision. `C = 3` qualifies at 56.3% and wins on val macro-F1
over the other qualifiers.

Sampling is `unbalanced` (every training row the split leaves), chosen on the same
val macro-F1 before `C` was chosen; every other arm is a strict subset of it and
none beat it at any `C`. Training is the train split only — 7,122 of 14,072 rows,
grouped on the specimen, zero groups straddling.

The head's label space is fixed at its existing sixteen. The corpus also carries
three genus-only labels (a bare `culex`, `culiseta`, `anopheles`, 2,084 rows) that
the head cannot name; they are dropped from the loss rather than folded into a
member species, because folding picks a species the photograph was never
identified as.

### What the refit changed, measured through the app's own code path

Every number below is `softmaxJoint` -> `fuseViews` -> `verdictFrom` driven from
real features, not a re-implementation.

**These are in-corpus numbers, and the qualifier is load-bearing.** The test split
is 2,450 of the 2,850 test rows whose label is one of the head's sixteen columns;
the other 400 are a bare `culex` / `culiseta` / `anopheles`, which the app has no
column for and which are excluded from the denominator rather than counted as
errors. The corpus is the one the head was fitted on, so this measures what the
fit bought, not what it generalises to.

| readout | previous head | refitted |
| --- | ---: | ---: |
| species argmax | 15.88 | **61.22** |
| genus argmax | 65.39 | **82.33** |

Verdict-state distribution on the 6,264-row in-domain cache, single view, at the
shipped floors:

| state | previous head | refitted |
| --- | ---: | ---: |
| `species` | 63 (1.01%) | 4,183 (66.83%) |
| `genus` | 2,564 (40.99%) | 325 (5.19%) |
| `unsure` | 3,637 (58.15%) | 1,754 (28.01%) |
| `non-mosquito` | 0 | 1 (0.02%) |

The abstention rate more than halves, in the direction that matters: the previous
head claimed a species on 1 photograph in 100. **No floor was refitted** — these
are the shipped 0.373 / 0.80 / 0.60 / 0.05 against a sharper posterior than they
were calibrated for.

### Off-corpus, where the refit is not uniformly better

The 6,264-row cache is a different corpus from the 14,072-row one: GBIF plus a
Mosquito Alert set, against an iNaturalist-heavy training corpus. 1,553 of its rows
are in the training corpus by exact path; the other 4,711 were never seen. Scored
on the unseen rows only, on identical rows for both heads:

| slice | species, previous -> refitted | genus, previous -> refitted |
| --- | ---: | ---: |
| all 4,711 unseen | 5.86 -> **20.29** | 83.95 -> **58.01** |
| 2,004 whose label is one of the 16 species | 13.77 -> **47.70** | 92.61 -> **80.99** |
| 2,921 GBIF, unseen | 4.28 -> 12.19 | 82.78 -> **44.74** |
| 1,564 Mosquito Alert API, unseen | 8.95 -> **33.82** | 85.87 -> 79.22 |

Three things are worth stating plainly about that table.

1. **Every row in the 6,264 cache whose label is one of the sixteen species is
   Aedes** - all 2,004 of them. The "genus over nameable rows" line is therefore an
   Aedes-only comparison, not a general one. The refit gains 33.9 pp of species
   there and loses 11.6 pp of genus, and its 381 genus errors go to Culex (264),
   Culiseta (91) and Anopheles (26).

2. **The genus loss is a property of the head, not of the floors.** It is measured
   on the *argmax*, which no floor can move: the refit ranks the wrong genus
   highest on 11.6 points more unseen Aedes rows than the previous head does. A
   floor decides when the app speaks, not what it says when it does, so a
   per-engine genus floor can at best abstain away the rows it gets wrong, and
   only if those rows carry a visibly lower posterior.

3. **Where the app is closest to its real input the refit is better on both.**
   On unseen Mosquito Alert rows - the source nearest what a phone actually
   submits - species goes 8.95 -> 33.82 and genus is roughly flat at 85.87 -> 79.22.

### Where the shipped floors actually put the refit

Accuracy among the photographs each head claims, through the app's own gate and
floors, on the same 2,450-row test split:

| | previous head | refitted |
| --- | ---: | ---: |
| `species` claims | 24 (1.0% of rows), **8.3% correct** | 1,813 (74.0%), **71.2% correct** |
| `genus` claims | 668 (27.3%), **92.7% correct** | 144 (5.9%), **94.4% correct** |
| abstains | 71.8% | 20.1% |

The genus floor is sound for this head: 94.4% correct where it fires, better than
the previous head's 92.7%. The species floor is not — 71.2% against the ~88% the
0.373 threshold was fitted to deliver. For contrast the previous head's species
claims were 8.3% correct, so this is not the old floor being safer; it is both
being unsafe and the new one being less so.

The two blocks the gate reads were not touched:

### Per-engine floors

`DEFAULT_FLOORS` were fitted on BioCLIP H/14's posteriors. A floor is an absolute
threshold on a posterior, so inheriting one across engines is a claim the
inheriting engine has never been tested for. `floorsFor(engineKey)` sits beside
`cosineOffsetsFor` in `../app/modelConfig` with the same shape: absent means the
shipped floors, explicitly, and only culico has an entry.

Its values were fitted on **one half** of a held-out corpus and read on the other,
because the decision is about how the head behaves on photographs it was not
fitted on:

| | fitted on half A | reported on half B | in-corpus |
| --- | ---: | ---: | ---: |
| species accuracy at 0.80 | 91.6% | 91.6% | 96.7% |
| genus accuracy at 0.90 | 99.7% | 99.8% | 99.3% |

Both meet the ~88% accuracy target the shipped floors were chosen against, which
is what a floor is for. The cost is coverage. Through the app's own gate and
floors, on 2,450 in-corpus test rows and on 2,361 held-out off-corpus rows:

| head / floors | slice | `species` | `genus` | abstains |
| --- | --- | --- | --- | ---: |
| refitted, shipped floors | in-corpus | 74.0% of rows, 71% correct | 5.9%, 94% | 20.1% |
| refitted, `floorsFor(culico)` | in-corpus | 20.2%, **93% correct** | 19.8%, **99%** | 60.0% |
| refitted, shipped floors | off-corpus | 65.8%, 25% | 4.4%, 93% | 29.8% |
| refitted, `floorsFor(culico)` | off-corpus | 12.1%, 40% | 17.1%, **97%** | 70.8% |

Two of those numbers need their denominators, which are not the same number:

- **The off-corpus 40% species figure is a floor imposed by the corpus's
  labelling, not by the model.** 56% of the 6,264-row cache carries a genus-only
  label, and on those rows no species answer can be right. Restricted to the rows
  whose label *is* one of the sixteen columns, the same head at the same 0.80
  floor is **91.6% correct at 11.9% coverage**.
- The in-corpus figures are over the 2,450 test rows whose label is one of the
  sixteen columns, which is every row in that split's denominator.

So the refitted head names a species far less often than it did under the shipped
floors, and is far more often right when it does. That is the correct behaviour
for a head this far from its training distribution, and it is the reason the
`reports: "species"` declaration and the floors are separate things: the head can
name a species, and 0.80 is how sure it has to be before the app does.

**What the per-engine floors do not fix.** The off-corpus *genus* regression in
the section above is a property of the head, measured on the argmax: at the
shipped 0.80 and matched coverage of ~38%, the refitted head answers 87.3% and
the previous head 99.2% on photographs neither was fitted on. Raising culico's
genus floor to 0.90 recovers the accuracy contract - 97% where it fires - but by
abstaining on the rows it would get wrong, which takes genus coverage from 44.2%
of photographs to 17.1%. That is a **mitigation, not a fix**, and it is the whole
reason the off-corpus genus numbers stay in this file rather than being tuned
away.

### The blocks the gate reads

| | previous head | refitted, row preserved | refitted, row refitted |
| --- | ---: | ---: | ---: |
| nuisance rows carrying image information | 0 of 8 | 0 of 8 | 0 of 8 |
| adjacent rows carrying image information | 1 of 8 | 1 of 8 | 1 of 8 |
| of the 700 negatives, refused as background | 59.14% | 56.29% | **86.14%** |
| of 1,500 in-domain mosquitoes, lost to that row | 0 (0.00%) | 0.13% | **0.00%** |
| of the 6,264 in-domain cache, falsely refused | 0 | 2 | **1** |

The middle column is the state after the species rows alone were refitted and the
background row was left exactly as it shipped. The right column is the current
head. The difference between them is the subject of the next section.

The fifteen placeholder rows are still placeholders, so the nuisance block still
cannot fire the gate — see `informativeRows` above. Note that their *mass* is not
zero and never was: they take 0.4%-28% of the joint posterior. `informativeRows`
is what stops that mattering, and `tests/culico-head.test.ts` is what stops a
later refit from quietly filling them in.

### The background row had to be refitted, not just preserved

`a photograph without a mosquito` was fitted against the OLD species logits. It
shares a softmax with them, so moving the species block moves the competition it
has to win, and preserving it cost 3 points of negative detection (59.14% ->
56.29%) while the row itself still separated background cleanly.

The obvious repair is to refit the row on the same features at the new scale, and
it works. The 700 negatives are grouped into four folds **by source photograph** -
538 photographs, up to two detector crops each - so a crop from a held-out
photograph is never in the fit and the detector is scored on negatives it has
never seen:

| row | negatives refused (held out) | in-domain mosquitoes lost |
| --- | ---: | ---: |
| shipped with the head | 56.29% | 0.13% |
| joint refit, C = 10 | 70.57% | 0.00% |
| joint refit, C = 100 | 84.57% | 0.00% |
| joint refit, C >= 1000 | **86.14%** | **0.00%** |

The sweep plateaus at the unregularised limit, so the shipped row is a plain
logistic fit with no L2 penalty at all, and `C` is not a parameter of it. That is
the right reading of a binary detector with 2,200 rows and 1,153 features.

**What it costs, measured:** nothing on the species side. The row's logit on an
in-domain mosquito is far enough down that the species block's total posterior
mass moves by +0.0014 on average and never down. On the 6,264-row cache the
refusals fall from 2 to 1. On the 2,450-row in-corpus test split the row now
refuses 5 photographs (0.2%) that it previously let through, which is the price
of a detector that catches 30 points more background.

**What it does not fix, and what it makes newly open.** The species rows' `C` was
chosen by a rule whose first clause was "keep the background row alive". That
clause no longer binds, so the rule should be re-run: on val macro-F1 alone it now
selects `C = 30` (0.5512) over the shipped `C = 3` (0.5058), worth +0.54 pp
species and +0.40 pp genus on the test split at 76.57% negative refusal instead
of 89.57%. **That is not a swap**, because the per-engine floors above were fitted
against `C = 3`'s posterior scale and would have to be re-derived. It is a full
re-pass and is recorded here rather than done.

### One behavioural change nobody asked about, checked anyway

`main.js` decides whether to trust the detector's crop by comparing the best
species posterior against the best nuisance posterior. A refit that is far more
confident than the shipped head could have flipped that comparison and started
rejecting crops. Measured on the 6,264-row cache: the crop is rejected on
**0 of 6,264** photographs under both heads, so the detector crop is still used
everywhere. Nothing changed, but it was the one place where "sharper species
block" could have had a cost nobody was looking for.

### What this made the app able to say

Sixteen distinct weight rows means no two species are the same output any more,
so `resolvableGroups` is empty on culico's head and the app names species rather
than genus. `ModelConfig.reports` for `webgpu-culico` follows it to `"species"`
and the ` · genus only` note drops off the dropdown. The machinery that collapses
a group is unchanged and still tested, on `groupedHead` in `tests/fixtures.ts` and
`public/text_embeds_grouped-fixture.json` — a fixture, because after this refit no
shipped head has a group and a test that wanted one would have had nothing to ask.
