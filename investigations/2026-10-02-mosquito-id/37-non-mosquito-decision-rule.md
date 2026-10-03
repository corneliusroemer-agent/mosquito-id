# 37 — The non-mosquito decision rule: what separates the two populations

Branch `agent/max-vs-max`, off `origin/main` (`2ac7a99`). All numbers below come
from one embedding extraction scored many ways, so every variant is compared on
identical rows, identical labels, identical embeddings. Reproduce with
`analysis/non_mosquito_rule.py` in the site repo; the table is
`37-decision-rules.tsv` beside this file.

## The answer, first

Against Cornelius's three-part requirement:

1. **Nothing in the crop → no confident mosquito claim.** Solvable, and not by
   max-vs-max. One nuisance cosine already catches 88.4% of blank crops at a 2%
   false-negative cost; max-vs-max manages 28.6%.
2. **A mosquito look-alike → no confident mosquito claim.** Not measured. It
   needs real look-alike photographs, which do not exist in this container, and
   which is why `36-negatives/photos/` is still empty.
3. **Saying what genus or class it is.** **This one fails, and no decision rule
   fixes it.** The seven adjacent classes win as the best non-mosquito match on
   46.3% of blank crops and on 46.3% of real mosquitoes — the naming is
   uninformative about which it is looking at.

**max-vs-max does not work — and the reason it does not work is not that the
populations are unseparable. They are separable. The encoder is not the limit; the
shipped formulation is.**

Both halves of that matter, because "max-vs-max lost" reads very differently from
"max-vs-max lost *and* nothing can win". A single unfitted cosine — `a photograph
of an empty background`, a nuisance class the app already computes and then sums
away — catches **88.4% of the negatives at a 2% false-negative budget**, against
max-vs-max's 28.6%. A held-out logistic over all 31 cosines reaches AUC 0.9906.
There is no threshold problem here to be solved by a better rule; there is a
formulation problem, and it is fixable. That one cosine catches **72.6% of the
negatives at the shipped rule's own 0.27% false-negative cost**, against the
shipped rule's 2.6%.

The ceiling confirms it. A logistic fit over all 31 cosines, scored on held-out
folds, reaches **AUC 0.9906** and catches 95.1% of negatives at 2% false negatives.
That is 28× better than any rule on the shipped family, and it is a *fitted* bound
that a one-threshold rule (the empty-background cosine, 88.4%) nearly reaches. The
information is in the embeddings; the shipped formulation discards it.

## The hypothesis loses

Max-vs-max was proposed as the obvious fix and was explicitly untested. Tested on
the same 700 negatives and the same 6,264 mosquitoes, it is **worse than the rule
that already ships**, at every matched false-negative budget:

| % of the 700 negatives caught | shipped as configured | shipped signal, re-floored | **max-vs-max** | best mosquito cosine | one nuisance cosine | fitted oracle |
|---:|---:|---:|---:|---:|---:|---:|
| at 0.27% FN (shipped cost) | 2.57% | 2.71% | **2.29%** | 4.29% | **72.57%** | 87.43% |
| at 1% FN | 2.57% | 14.29% | **11.71%** | 17.14% | **85.43%** | 92.57% |
| at 2% FN | 2.57% | 40.00% | **28.57%** | 48.14% | **88.43%** | 95.14% |
| at 5% FN | 2.57% | 85.57% | **81.57%** | 92.43% | **93.00%** | 97.14% |
| AUC | 0.9657 | 0.9657 | **0.9635** | 0.9733 | **0.9816** | 0.9906 |

The paired bootstrap over the 700 negatives puts the AUC difference between
max-vs-max and the shipped signal at −0.0023 [−0.0036, −0.0010], and between
max-vs-max and the bare best-mosquito cosine at −0.0098 [−0.0127, −0.0071];
max-vs-max wins in 0 of 2000 bootstrap draws.

### Why it loses, which is the useful part

The intuition behind the hypothesis is *half* right and the wrong half is the
important one. On these crops the non-mosquito mass is real but small and
**spread across fifteen classes**, while the mosquito mass is concentrated. The
best single adjacent or nuisance class carries **0.343** mean cosine on a negative;
the best single species carries **0.390**. The non-mosquito side does not win, and
it cannot win, because no one of the fifteen classes is ever close.

The worse fact is that the non-mosquito classes are not tracking non-mosquito-ness
at all. The best adjacent cosine is **higher on true mosquitoes (0.395) than on
blank crops (0.341)**. Comparing them against each other therefore mixes a weak
non-mosquito signal with a mosquito signal that moves the wrong way. The separation
that does exist is almost entirely on the mosquito side: the best mosquito cosine
is 0.592 on a mosquito and 0.390 on a crop. The two distributions barely overlap:
**82.9% of the crops sit below the mosquitoes' 1st percentile** (0.347) and none
reaches the median (0.609), but 7.6% sit above the mosquitoes' 5th percentile and
1.9% above the 10th. That upper tail of crops is exactly what a tight
false-negative budget cannot reach, and it is the whole of the residual
false-positive problem.

**The log-margin version is a genuinely different ranking and it is worse still**
(AUC 0.9521). `log` and subtraction do not commute, so "scale-free" here re-weights
large cosines less rather than removing a scale. It is not a more robust form of
the same comparison; it is a different, weaker statistic.

### The 0.2881 figure is the best single species, not the mass

The prior report's "mean posterior mass on mosquitoes over the negatives is
**0.2881**, against 0.9992 for real mosquitoes" mislabels the number, and the
mislabel is what made the previous conclusions look terminal. 0.2881 is the mean
**best single species** posterior — `P(max species)`. The **summed** mosquito mass
on the same 700 crops is **0.8107**, against 0.9874 on the mosquitoes. So the
non-mosquito mass on a blank crop is 0.189, not 0.71.

Both numbers separate the two populations, at very different operating points.
The sum is the one the shipped rule uses, and it is the weaker choice of the two.

| on the 700 negatives | value | on the 6,264 mosquitoes | value |
|---|---:|---|---:|
| summed mosquito mass, mean | 0.8107 | summed mosquito mass, mean | 0.9874 |
| best single species, mean | 0.2881 | best single species, mean | 0.6410 |
| best non-mosquito class, mean | 0.0630 | best non-mosquito class, mean | 0.0057 |
| best mosquito **cosine**, mean | 0.3901 | best mosquito **cosine**, mean | 0.5922 |

Read the last row against the cosines and the problem becomes legible. The best
species cosine is 0.59 on a mosquito and 0.39 on a crop, and **82.9% of the crops fall
below the mosquitoes' 1st percentile (0.347)** — though 7.6% clear the 5th and
1.9% the 10th, so the tails do overlap. Read the posterior rows and it looks
hopeless, because the softmax is dominated by a sixteen-way split among similar
species on a featureless crop. The separation was
in the cosine the whole time; the softmax buried it.

### The shipped constant, not the shipped rule

The shipped floor of 0.60 sits far out in the tail of a distribution that never
gets there. Swept over its own floor:

| `NON_MOSQUITO_FLOOR` | negatives caught | true mosquitoes rejected |
|---:|---:|---:|
| 0.10 | 67.00% | 3.34% |
| 0.20 | 39.29% | 2.00% |
| 0.30 | 18.00% | 1.17% |
| 0.40 | 10.14% | 0.78% |
| **0.60 (shipped)** | **2.57%** | **0.27%** |
| 0.80 | 0.29% | 0.05% |

The prior report read this sweep as "monotone the wrong way" and concluded no
threshold works. It is a floor behaving like a floor: the signal separates well
(AUC 0.9657) and the constant is simply in the wrong place. On the negatives the
non-mosquito mass has median 0.159, p95 0.487 and p99 0.680. **0.60 sits at the
97.4th percentile of the negatives it is supposed to catch**, so by construction
it can never fire on more than about one negative in forty.

### What max-vs-max would cost

At a 2% false-negative budget the loss is concentrated, not spread:

| species | rejected |
|---|---:|
| Anopheles | 94/1383 = 6.80% |
| Culex | 7/651 = 1.08% |
| Culiseta | 12/1473 = 0.81% |
| Aedes aegypti | 9/1446 = 0.62% |
| Aedes albopictus | 3/658 = 0.46% |
| Aedes japonicus | 1/541 = 0.18% |
| Aedes koreicus | 0/112 = 0.00% |
| **total** | **126/6264 = 2.01%** |

Anopheles pays eight times the average. A rule that costs 2% of real mosquitoes to
catch 29% of blank wall is a worse trade than lowering the floor, and much worse
than the one-cosine rule, which catches 88% at the same 2%.

## Can the app say what it is looking at? No, and this is the harder failure

Cornelius's requirement is three-part, and the third part is naming: something that
looks like a mosquito but is not should be rejected *and* identified. The seven
adjacent classes are meant to do the identifying.

Worth stating plainly before anything else: **at the shipped floor the gate fires
on 2.3% of the 700 blank crops, so the naming is rare in practice already** — the
sentence is drawn for roughly one crop in forty. What follows is what would
happen if the gate were fixed so that it fired often. It is not viable, and the
reason is not the threshold.

**On a blank crop the top mosquito is a closer match than any of the fifteen
non-mosquito classes.** The gap (best non-mosquito cosine − best mosquito cosine)
is **−0.047** on average and the non-mosquito side leads on only **8.0%** of the
700 crops. There is nothing to name, because nothing wins.

What is worse, **the naming carries almost no information about whether the crop
is blank.** The distribution of the winning non-mosquito class is nearly
identical on blanks and on real mosquitoes:

| winning non-mosquito class | 700 blank crops | 6,264 true mosquitoes |
|---|---:|---:|
| a biting midge (Ceratopogonidae) | 46.3% | 46.3% |
| a non-biting midge (Chironomidae) | 15.4% | 33.5% |
| a crane fly (Tipulidae) | 12.9% | 16.2% |
| a horsefly (Tabanidae) | 7.3% | 1.1% |
| a photograph of a moth | 9.7% | 0.2% |
| a hoverfly (Syrphidae) | 2.7% | 0.1% |
| a housefly (Muscidae) | 2.1% | 0.3% |

So the app would print "this does not look like a mosquito — it looks like a
biting midge" over blank wall essentially as readily as over a *Culex*. Even on
the 5% of blanks with the highest non-mosquito mass — the ones the gate would
catch first — the winning class is spread across seven classes at normalised
entropy 0.82, and the top answer covers 46% of them. It is not a constant, so it
looks informative; it is not informative.

**This is the part that redirects the project.** Rejecting blank crops is a
threshold problem with a measured solution (the empty-background cosine). Naming
them is a *text-tower* problem: `a biting midge` and `Culex pipiens` sit 0.715
apart in cosine, so the tower cannot tell a midge from a mosquito, from a wall,
or from each other. No decision rule fixes that. Either the adjacent prompts are
replaced with something the tower separates, or case 3 is dropped from the
requirement and the app says only "not a mosquito" — which is what the report's
`verdictSentence` already writes, followed by a class name it cannot support.

The honest way to settle this is the negative photo set that
`36-negatives/score_photos.py` was written for and that has never been filled:
real houseflies, hoverflies, crane flies and horseflies photographed with a phone.
With those, "does the gate fire *and* does it name the right thing" is a single
measurable question instead of a guess.

## The pooled card cannot say "not a mosquito" at all

Independent of any threshold, and confirmed at the code level.

`updatePooling` builds the pool and then calls `verdictFrom(pooledSpP)` with **one
argument**. The signature is `verdictFrom(spP, agreement, adP)`, so on the pooled
path `adP` is `undefined` and the guard `if (adP && adP.length)` skips the entire
non-mosquito branch. `pooledPosterior` also soft-maxes over the **16 species
alone**.

Those two facts compound. The adjacent mass is in neither the numerator nor the
denominator, so the pooled "posterior" is a normalised distribution over mosquitoes
and nothing else: three photos each carrying 97% biting midge pool to species
posteriors that sum to **exactly 1.000000** (confirmed independently on another
branch). The number is arithmetically incapable of expressing the evidence it was
built from, so **no value of `NON_MOSQUITO_FLOOR` can fix it** — this is not a
threshold to retune.

`tests/pooled-gate.test.mjs` pins this against the real `verdictFrom`: a pool
carrying **92% of its mass on Ceratopogonidae** returns `non-mosquito` when `adP`
is supplied and `unsure` when it is omitted — which is what the app does.

Two consequences, both visible in the production screenshot:

1. **A pooled card can never name a non-mosquito subject.** The state does not
   exist on that path at any threshold.
2. **Pooling dilutes the evidence it then throws away.** Log-linear pooling of
   probabilities is a geometric mean, which concentrates confident blocks and
   spreads diffuse ones. On the 700 crops the non-mosquito mass falls from a
   single-photo mean of 0.357 to a pooled mean of 0.284 (`analysis/pooled_gate.py`).

## Two rendering defects, one of which is the screenshot

**The abstention line has never rendered, and that is why the blank wall looks
confident.** `index.html:1097` carries an inline
`<p id="score-uncertain" style="display:none;">`. `main.js:2293-2298` only ever
sets `textContent`, `className` and `title` on that element — it toggles the
`shown` class, and the stylesheet's `#score-uncertain.shown { visibility: visible }`
cannot override an inline `display: none`. The CSS comment above the rule says
"main.js toggles visibility, never display", which is what the code intends and
the inline attribute defeats.

Checked in headless Chromium against the built page with the models blocked,
after doing exactly what `main.js` does:

```
inline: "display:none;"   computed display: none   computed visibility: visible
rendered: false   box height: 0
```

So on the photo in the screenshot — top species 28.6%, verdict `unsure` — the
line that should have read *"Not confident enough to name a genus"* is laid out
and painted at zero height. What is left is ten species with percentages and no
indication that the classifier declined to choose. This is the second half of the
reported defect and it is a one-attribute fix (delete the inline `style`), and it
is independent of every threshold discussed above: the app abstains correctly and
then hides its own abstention.

**The pooled card's "0.0" means "best of", not "no confidence".** The column is
`relScore = aggLogits[sp] - maxLogit`, a max-relative normalisation, shown to one
decimal. On the screenshot the pool is in fact *sharpened*: the runner-up sits
4.2 nats down, which is `exp(-4.2) = 1.5%` of the leader. On the 700 crops the
same pooled logit gap has median 0.85 nats and p90 2.05 nats, so the screenshot is
a more confident version of the same wrong answer, not a milder one.

The screenshot also does not show what it was described as showing. The full-photo
pane contains a large, clearly visible insect; what was classified was a
**99×50 px manual crop of blank wall** taken away from it. The negative is real,
and it is exactly the kind this benchmark holds — but the file is not the
background of a blank photo, and the numbers here are not measured on it.

## The negatives were re-derived from scratch, and they check out

The prior agent's crops were not committed, only its embeddings. Rather than
inherit them, all 700 were re-extracted in fp32 torch/`open_clip` from the crop
files, through a pipeline written independently of the one that produced them.
Every row reproduces the inherited embedding to **cosine 1.000000** (min
1.000000, all 700 above 0.9999). The prior agent's detector verification was
correct, and the whole table above is safe to quote.

The positive side is the one real caveat. The 6,264-row cache came from
`bioclip_2_5_int8.onnx`, a quantisation of the same tower (mean cosine to fp32
0.9907, min 0.947, measured in `int8_vs_fp32.json` before this work). The brief
asks for fp32, so a strided one-in-four sample (1,566 photos) was re-extracted in
fp32 with the same pipeline and every rule re-scored on it.

Every rule re-scored on 1,566 fp32 mosquitoes against the same 700 fp32 negatives.
For reference, the fp32 embedding of a photo sits at mean cosine 0.9901 to the INT8
embedding of that same photo (p5 0.9743, min 0.8716) — the quantisation is real,
it is just not directional.

| variant | AUC (INT8 positives, 6,264) | AUC (fp32 positives, 1,566) | caught @2% FN (INT8) | caught @2% FN (fp32) |
|---|---:|---:|---:|---:|
| shipped summed mass | 0.9657 | 0.9606 | 40.00% | 27.57% |
| max-vs-max | 0.9635 | 0.9587 | 28.57% | 19.14% |
| best mosquito cosine | 0.9733 | 0.9720 | 48.14% | 44.71% |
| one nuisance cosine | 0.9816 | 0.9813 | 88.43% | 88.71% |

**The control changes no conclusion.** Every AUC moves by at most 0.005, the
ordering of the four rules is identical on both sides, the one nuisance cosine is
the winner either way, and max-vs-max stays below the shipped signal. The fp32
sample is a quarter of the corpus, so its absolute operating points carry more
sampling error than the INT8 ones — which is why the table above keeps the INT8
numbers as the headline and uses fp32 only as a direction check.


## What I changed, and what I recommend

**One fix is on the branch: the abstention line.** Commit `3667268` alone removes
the inline `style="display:none;"` from `#score-uncertain`. It touches only
`index.html` and its probe, so it cherry-picks on its own if it should ship ahead
of the rest. Everything else below is a recommendation, not a change.

**I did not change the decision logic in `main.js`.** The hypothesis I was asked to
test loses, so there is nothing from this assignment to ship, and the change the
evidence *does* point at is a judgement call that is Cornelius's:

- **`NON_MOSQUITO_FLOOR` 0.60 → 0.30** is a one-line change that catches 18.0% of
  negatives for 1.17% of mosquitoes instead of 2.6% for 0.27%. It is the cheapest
  real improvement available and it keeps the rule the rest of the codebase
  already understands.
- **A single nuisance cosine used directly as the score** (`a photograph of an
  empty background`, or `a photograph of a wall`) catches 88.4% at 2% false
  negatives. The app already computes those cosines — `fuseViews` receives
  `nuTotal` and throws it away — so this needs a new constant and one branch, not
  a new model. This is the finding worth acting on, and it needs Cornelius's own
  photographs before it is fitted rather than measured.
- **Passing a pooled `adP` into the pooled `verdictFrom`** removes a capability gap
  that is a genuine bug, independent of every number above.
- **The abstention line** — done, commit `3667268`. Everything else below is open.
- **Dropping the class name from the non-mosquito sentence, or replacing the
  adjacent prompts**, is the decision on Cornelius's third requirement. The seven
  classes fire as the winning non-mosquito match at the same rate on blank crops
  as on real mosquitoes (46.3% biting midge on both), so the sentence currently
  makes a claim the encoder cannot support. That is a wording-or-prompts
  decision, and it should be made explicitly rather than left to ship.

The last three are unambiguous defects rather than tuning, and each is one or two
lines. They are reported rather than fixed on this branch because every one of them
changes what a user is told about a photograph, and that is a call to make once,
deliberately, rather than as a side effect of a measurement. The abstention line
was pushed on its own commit for exactly that reason: it is a rendering defect with
no threshold judgement in it.

## For the module refactor — the seam I would cut

Four agents have now diagnosed this logic by reading it. That is what the welded
2,700-line script costs, and it is worth being precise about the boundary.

### The pure functions the confidence decision needs

| function | signature | reads from outside | notes |
|---|---|---|---|
| `verdictFrom` | `(spP: number[], agreement: {agree: boolean} \| undefined, adP: number[] \| undefined) -> Verdict` | `EMB.species`, `EMB.adjacent`, `EMB.adjacent_common`, `adjacentNames()`, `SPECIES_CONFIDENCE_FLOOR`, `GENUS_CONFIDENCE_FLOOR`, `VIEW_DISAGREEMENT_VETOES_SPECIES`, `NON_MOSQUITO_FLOOR`, `speciesGenusIndex()` | **this is the seam.** It is already pure except for the module-level constants. Its one real defect is that `adP` is optional, so a caller that forgets it silently gets "no evidence" instead of a bug. |
| `speciesGenusIndex` | `() -> Map<string, number[]>` | `EMB.species` | memoised in `genusIndexCache`, a module-level `let` — the only mutable state in the chain |
| `genusOf` | `(speciesName: string) -> string` | `EMB.species` | pure |
| `fuseViews` | `(viewResults: ViewResult[]) -> FusedView \| null` | `EMB.species`, `adjacentNames()`, `genusScores`, `EMB.logit_scale`, `localViewScale()` | needs `EMB.logit_scale` and `TEMPERATURE` to recover cosines and logits from the fused posterior |
| `verdictSentence` | `(v: Verdict) => string` | `EMB.adjacent_common` | pure given a `Verdict` |
| `pooledPosterior` | `(aggLogits: Record<string, number>) => number[] \| null` | `EMB.species` | already standalone; **the missing sibling is a `pooledNonMosquito(aggAdLogits)` with the same shape** |

`ViewResult` is `{ spP, nuTotal, adP?, scale }` and `FusedView` is
`{ spP, nuP, adP, verdict, … }`. Those two types plus the five constants are the
whole surface.

### Where the seam should go

**`verdict.ts`, taking an explicit config object rather than reading module state.**
(Landed while this report was being written: the module is live at `f33e36f`, and
`adP` became a required argument at `5ff6efe` — the compiler flagged all twelve call
sites, and the pooled site now passes `[]` explicitly with the gap documented rather
than silently. That is the outcome this section was arguing for.)

```ts
export interface VerdictConfig {
  speciesFloor: number;
  genusFloor: number;
  vetoOnViewDisagreement: boolean;
  nonMosquitoFloor: number;
}
export function verdictFrom(spP, agreement, adP, cfg, EMB): Verdict
```

The reason is the defect this investigation found, not tidiness: `verdictFrom`
already treats `adP` as optional, and the pooled call site omits it. A required
parameter makes that omission a type error instead of a silently wrong verdict.
The same goes for `cfg` — `NON_MOSQUITO_FLOOR` is currently a bare `const` that
`tests/gate.test.mjs` has to re-derive by regex out of the source text, which is
the mechanism that let this go unnoticed.

### What the test harness should become

`tests/gate.test.mjs` lifts function bodies out of `main.js` with a regex and
`eval`s them. That is why a one-argument call site survived three agents. Once
`verdictFrom` and `fuseViews` are importable, the same checks become ordinary
imports and the pooled regression in `tests/pooled-gate.test.mjs` becomes a direct
call rather than a lifted-body reconstruction. **Recommend the refactor cut the
seam here first**, because this investigation's two findings — max-vs-max losing,
and the pooled gate being structurally unable to fire — are both bugs that only a
real import surface would have caught.

## Reproducing

| what | how |
|---|---|
| the rule comparison and the oracle | `uv run --with numpy python analysis/non_mosquito_rule.py OUT.tsv` |
| the pooled-path finding | `uv run --with numpy python analysis/pooled_gate.py` |
| the pooled regression, against real `verdictFrom` | `node --test tests/pooled-gate.test.mjs` |
| that `#score-uncertain` never renders | `node tests/abstention-line-probe.mjs` (serves the page itself) |
| re-extract either side in fp32 | `HF_HUB_OFFLINE=1 uv run --with open_clip_torch --with torch python analysis/extract_fp32.py {neg,pos4}` |
