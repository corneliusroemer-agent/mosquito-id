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

`clipEmbed` normalises over the embedding including this coordinate. For a head
that has one this matters — dividing the intercept by the feature norm is exactly
how the bias stays comparable to the weights, and how the head can express "this
class scores `-0.6` against everything" at all.

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