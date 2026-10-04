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
winning species agrees on 64 of 64.

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
real features, not a re-implementation. Test split = 2,450 held-out-specimen
mosquitoes from the 16 classes.

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
| `non-mosquito` | 0 | 2 (0.03%) |

The abstention rate more than halves, in the direction that matters: the previous
head claimed a species on 1 photograph in 100. **No floor was refitted** — these
are the shipped 0.373 / 0.80 / 0.60 / 0.05 against a sharper posterior than they
were calibrated for, and they survive it. They should be re-derived before they
are trusted on the species claim, because 66.8% of photographs now clear a
0.373 species floor against 0.24% before, and nothing has checked what that
66.8% is made of on a corpus that was not the one they were fitted on.

The two blocks the gate reads were not touched:

| | previous head | refitted |
| --- | ---: | ---: |
| nuisance rows carrying image information | 0 of 8 | 0 of 8 |
| adjacent rows carrying image information | 1 of 8 | 1 of 8 |
| of the 700 negatives, refused as background | 59.14% | 56.29% |
| of 1,500 in-domain mosquitoes, lost to that row | 0 (0.00%) | 2 (0.13%) |

The fifteen placeholder rows are still placeholders, so the nuisance block still
cannot fire the gate — see `informativeRows` above. Note that their *mass* is not
zero and never was: they take 0.4%-28% of the joint posterior. `informativeRows`
is what stops that mattering, and `tests/culico-head.test.ts` is what stops a
later refit from quietly filling them in.

### What this made the app able to say

Sixteen distinct weight rows means no two species are the same output any more,
so `resolvableGroups` is empty on culico's head and the app names species rather
than genus. `ModelConfig.reports` for `webgpu-culico` follows it to `"species"`
and the ` · genus only` note drops off the dropdown. The machinery that collapses
a group is unchanged and still tested, on `groupedHead` in `tests/fixtures.ts` and
`public/text_embeds_grouped-fixture.json` — a fixture, because after this refit no
shipped head has a group and a test that wanted one would have had nothing to ask.
