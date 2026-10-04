# 36 — Adjacent taxa as named classes, and a "this is not a mosquito" outcome

Branch `agent/adjacent-taxa` (pushed). Base `c472a12`, rebased onto `8a69909` so the
view-disagreement veto and the new non-mosquito state coexist in `main.js`.

## What this does

Two independent changes that arrived as one branch because they answer the same
reported defect.

1. **Seven phylogenetically-adjacent Diptera are now named classes** —
   Ceratopogonidae, Chironomidae, Simuliidae, Tipulidae, Syrphidae, Muscidae,
   Tabanidae — scored in the *same* softmax as the sixteen mosquito species, so
   "this is a biting midge" competes with "this is a mosquito" on the same numbers
   instead of through a second, separately-scaled score.

2. **"This is not a mosquito" is now an outcome.** The app computed a nuisance
   posterior, used it to decide whether to keep the detector crop, and then threw
   it away — so a photograph of plain paper came back as a confident species. When
   a non-mosquito class wins, the score panel names the plain-language subject and
   drops the sixteen-row mosquito ranking.

Runtime cost: unchanged in kind. No new model, no new weights, no download. Seven
rows of 1024 floats in a file that already shipped sixteen.

## The mechanism was already there, and it is reused

`softmaxJoint` already scored `EMB.nuisance` alongside `EMB.species` in one
softmax. The adjacent classes join that same softmax as a third block. Fusion pools
all three log-linearly (`fuseViews`), and the per-class adjacent identities are
kept — collapsing them to one number, as the nuisance classes are, would throw away
the only reason they were added.

`verdictFrom(spP, agreement, adP)` takes the adjacent posterior as a third
argument and checks it **before** any species claim. `VIEW_DISAGREEMENT_VETOES_SPECIES`
is untouched and still governs species claims; `adP` is orthogonal to `agreement`.

## Method: the embeddings are provably on the existing scale

A new row of floats is worthless if it is not on the same text-tower scale as the
sixteen rows already shipped, and a subtly different encoder is the easy way to get
this wrong. So `build_adjacent.py` first re-encodes the shipped sixteen species
(three templates each, averaged, renormalised) and the eight nuisance classes from
their prompts, and **asserts cosine > 0.9999 against the file it is extending**
before writing anything. It reproduces both to ~1e-7. `logit_scale` (98.8645) and
`dim` are preserved exactly; `nuisance_emb` is byte-identical.

One detail that matters if anyone regenerates these: the shipped **nuisance
prompts carry no trailing period**. Adding one moves them to cosine 0.914 and
silently moves eight classes.

## Does adding seven classes damage the sixteen mosquitoes?

## Does adding seven classes damage the sixteen mosquitoes?

This was the blocking question, so it is answered first and with the whole table.
Scored on the 6,264-row cache, softmax reproduced exactly as `softmaxJoint` builds
it (logit_scale / TEMPERATURE, one denominator over species + nuisance + adjacent).

**Label caveat, load-bearing:** only 2,757 of the 6,264 rows carry a species label
and **all of them are Aedes**. The other 3,507 are genus-rank (Culex, Culiseta,
Anopheles) and cannot be scored for 16-way species accuracy at all. Species accuracy
is therefore reported on the 2,757 species-rank rows only; genus accuracy is reported
across all 6,264.

| metric | n | BEFORE (16+8) | AFTER (16+8+7) | change |
|---|---:|---:|---:|---:|
| species top-1, species-labelled rows only | 2,757 | 0.7700 | 0.7700 | **0.0000** |
| genus-rank accuracy, all rows | 6,264 | 0.9017 | 0.9017 | **0.0000** |
| mean posterior mass on mosquitoes | 6,264 | 0.9992 | 0.9874 | −0.0118 |
| rows where an adjacent class is argmax | 6,264 | — | 42 (0.67%) | new |

Rows flipped correct→wrong: **0**. Rows flipped wrong→correct: **0**. The argmax is
monotone in the species cosines, so an unchanged argmax table is the expected
result rather than a surprise — what the new classes can change is the *posterior*,
and it does: the mean mass on mosquitoes falls by 1.2 points.

**The cost is not zero, and it is not in accuracy.** On 0.67% of true mosquito rows
an adjacent class takes more mass than the best mosquito — mostly biting midges
(2,903 rows have Ceratopogonidae as the *highest-scoring adjacent class*, which is
what a biting-midge prompt on a Culex should look like). That is the false-negative
side of the gate, it exists at **any** floor including zero, and it is what
`NON_MOSQUITO_FLOOR` exists to absorb.

## The binding limitation: the false-positive rate is not measurable from that cache

**The 6,264-row cache contains no non-mosquito images. Zero.** So the false-positive
rate — how often paper gets called a mosquito, which is the defect Cornelius
actually reported — cannot be estimated from it at any threshold, and no number in
this report is extrapolated to cover it.

What *was* available for the false-positive side is a photograph of paper: one
anecdote. A gate tuned against one anecdote is a gate that fits one anecdote.

**What would fit it:** labelled photographs of real non-mosquito scenes scored
through the same path — see the shopping list below. Until those exist,
`NON_MOSQUITO_FLOOR = 0.60` is **chosen for behaviour, not fitted**, and its
comment in `main.js` says exactly that.

## In-domain negative benchmark

Cornelius's idea, and the right one: build the negatives out of **our own** mosquito
photos. GBIF negatives and the MosquitoDL "Non vectors" set are domain-mismatched —
dried specimens, museum photography, other countries — so a gate that works on them
tells you nothing about a phone photo of paper. A background crop from our own corpus
shares the camera, the lighting, the photographer's hands and the surface.

- **Sources:** the 6,264 in-domain photos in `cache/rows.tsv`.
- **Crops per source:** up to 2, from 4 corner squares (34% of the shorter side) and
  a top strip (28% of height), shuffled so no single scene is over-weighted. Sources
  under 320px on a side and crops under 160px are skipped.
- **Verification:** every crop is run through the app's *own* detector
  (`yolo11n-mosquito-det-640.onnx`, the shipped release asset) with the app's own
  letterbox and its exact `chwFromCanvas` preprocessing. A crop is kept **only if the
  detector fires no box at all** — the threshold used is 0.15, three times
  below the app's `DET_CONF` of 0.50 (which was 0.70 when this ran), so a
  mosquito the detector is *unsure* about
  also disqualifies the crop. Ground truth by a stricter detector is the only kind
  worth having.

**Two bugs in the first verification pass, both mine, both caught only because the
number looked impossible:** the app divides detector input by 255 and does **no**
mean/std normalisation (I applied ImageNet stats), and the detector's class channels
start at offset `4*N`, not `4` — I was reading box coordinates as confidences and got
values up to 636 against a 0.70 threshold. Result: 991 of 991 crops rejected as
"containing a mosquito", which is what a mis-wired detector looks like. A negative
benchmark verified against the wrong preprocessing would have "measured" a 100%
false-positive rate and been entirely fictional.

### RESULT: the gate does not fix the reported defect

700 detector-verified in-domain negatives, scored through the app's own arithmetic:

| `NON_MOSQUITO_FLOOR` | negatives caught | **still called a mosquito** | real mosquitoes wrongly rejected |
|---:|---:|---:|---:|
| 0.00 | 6.7% | **93.3%** | — |
| 0.30 | 6.4% | **93.6%** | 0.67% |
| 0.50 | 3.7% | **96.3%** | 0.45% |
| **0.60 (shipped)** | 2.3% | **97.7%** | 0.27% |
| 0.70 | 0.9% | **99.1%** | 0.11% |
| 0.80 | 0.3% | **99.7%** | 0.05% |
| 0.90 | 0.0% | **100.0%** | 0.00% |

Mean posterior mass on mosquitoes over these negatives is **0.2881** — the model
does move, from the 0.9992 it puts on real mosquitoes down to 0.29, which is a real
signal. But 0.29 still loses to sixteen mosquitoes splitting 0.71, so the argmax is
wrong **97.7% of the time at the shipped floor**.

**This is a blocking finding and I am reporting it as one rather than shipping the
number as a success.** The feature as built does not stop a photograph of paper from
coming back as a mosquito. It makes the failure rarer (93.3% → 97.7% is the wrong
way to read that column — read the "caught" column: 6.7% → 2.3%, so raising the
floor makes it *worse* at catching) — precisely, raising the floor trades false
negatives for false positives and this gate is on the wrong side of that trade
almost everywhere.

Note the floor sweep is nearly monotone in the wrong direction: **every** floor
catches fewer negatives than the floor above it, because the non-mosquito mass on
these crops never concentrates. There is no threshold on this signal that separates
the two populations, and the reason is visible in the class counts.

### Why it fails: the winning class is almost never an adjacent taxon

| winning class on the 700 negatives | count | block |
|---|---:|---|
| a housefly | 574 | adjacent |
| a photograph of a hand | 353 | nuisance |
| a crane fly | 121 | adjacent |
| a photograph of a wall | 117 | nuisance |
| a photograph of a butterfly | 104 | nuisance |

That is the diagnosis:

1. **The adjacent classes work as designed.** Housefly and crane fly win on 695 of
   700 crops. The taxonomy is doing its job — a background crop from a phone photo
   genuinely does look most like another fly.
2. **But a generic fly does not outrank sixteen mosquitoes.** `a housefly` and
   `Culex pipiens` are separated by only 0.715 cosine in text space. The gate needed
   the non-mosquito classes to be *clearly* better, and "clearly another fly" is not
   clearly better than "clearly a mosquito" to this encoder.

So the failure is not a bad threshold. It is that **the nuisance signal the app
already had is real but too weak, in this formulation, to beat a sixteen-way
species softmax**, and adding seven more classes in the same softmax does not change
that — it adds seven more competitors to the mosquito side's advantage.

### What this means for the shipped branch

The code is correct and the measurement is honest, but **the reported production
defect is not fixed by this branch.** Shipping it adds seven named classes and a
verdict state that fires on 2.3% of negatives, at a cost of 0.27% of real
mosquitos. That is a small net improvement, not the fix.

Three things follow, and they are separable:

- **The seven classes are worth keeping** regardless: species accuracy is provably
  unchanged (0 rows flipped), and when the gate does fire it names a specific family
  rather than shrugging.
- **The gate needs a different formulation**, not a different threshold. The obvious
  candidate is to normalise the non-mosquito mass against the *best* mosquito rather
  than summing sixteen of them — `best_sp = 0.2881` here, against a housefly
  posterior that is evidently higher than 0.2881, so a max-vs-max comparison would
  fire on most of these crops. That is a real hypothesis and it is **untested**: it
  changes what the softmax means, and testing it is cheap (the embeddings are
  cached) but it is a different design and was out of scope here.
- **The negative set is harder than the reported case.** Median crop is 261px of
  frame texture; a phone photo of paper is a whole flat sheet filling the frame. The
  97.7% figure should therefore be read as an upper bound on the failure rate, not
  as a prediction of it — but it is an upper bound in the direction that makes the
  feature look *worse*, and Cornelius's own photos are what would settle it. The
  harness below takes them.

## What Cornelius should photograph

Drop them in `investigations/2026-10-02-mosquito-id/36-negatives/photos/` and run
`score_photos.py` — it scores through the app's real path and prints, per image, the
best mosquito, the best non-mosquito class, and whether the gate would have fired.

The set needs **varied surface** (paper — matte and glossy, printed and blank;
fabric — cotton, denim; skin; a wooden table; a wall; a tiled floor; a hand) and
**varied conditions** (bright and dim, in-focus and motion-blurred, close and far,
a couple at typical phone angles). Several should be **deliberately awkward for the
app**: a mosquito present but small, or off to one side, or partially out of frame —
because "not a mosquito" and "a mosquito you have to look for" are different cases and
only one of them is currently a verdict state. A few should be hard negatives of the
adjacent taxa themselves — a housefly, a hoverfly, a crane fly, a horsefly — since
those are the classes whose prompts are closest to the mosquitoes' and therefore the
ones most likely to be the false positives.


## Prompt quality check

The Culex finding — two sibling prompts at cosine +0.7872, near-indistinguishable —
is the precedent, so the prompt set was checked before shipping rather than after.

- adjacent vs adjacent, max cosine **0.810**
- adjacent vs species, max cosine 0.623
- adjacent vs the nuisance "fly" class, max 0.715

The 0.810 is **biting midge vs non-biting midge**, which is above the Culex
threshold and worth stating plainly: the text tower does not clearly separate
Ceratopogonidae from Chironomidae, so the app will tend to say "a biting midge" for
either. That is a real limit on the specificity of the claim, not a defect in the
implementation — and it is the reason the sentence says what it can support ("this
does not look like a mosquito — it looks like a biting midge") rather than naming a
species it has not earned.

## Scoping notes

- **`SPECIES_CONFIDENCE_FLOOR` (0.373) and `GENUS_CONFIDENCE_FLOOR` (0.80) are
  unchanged.** No touch to the score-row flush, the `Number.isFinite` bar guards, the
  progress meter, the verdict line, delete-all, the 240px `.combined-scores`
  reservation, or the mobile ordering from `c472a12`.
- **`text_embeds_b16.json` is NOT updated.** The shipped 512-dim B/16 file's text
  tower could not be identified: no candidate in the HF cache reproduces its species
  rows (best cosine 0.221) or its `logit_scale` of exactly 100.0 (the in-repo tower
  gives 92.92). Guessing a tower and shipping 7 rows on the wrong scale would be
  worse than leaving the secondary engine exactly as it is. **Consequence: on the
  B/16 engine the non-mosquito state cannot fire** — `adjacentNames()` returns empty,
  `fuseViews` pools nothing, `verdictFrom` finds no `adP`. That is the safe
  direction to fail (the engine behaves as it does today), and it is why the gate is
  written to degrade to "no evidence" rather than to a default. The B/16 dropdown is
  not the default engine; `webgpu-fp16` is.
- **The pooled-genus headline was left alone.** Cornelius reported he cannot see it,
  because it renders only when the pooled verdict is coarser than a species — a
  confident pool deliberately says nothing. That is a real design decision that does
  not match what he asked for, but fixing it means reworking another agent's merged
  feature, which this branch should not do. Noted here for a separate change.

## Reproducing

| what | how |
|---|---|
| add the classes to an embeddings file | `tmp/adjacent-taxa-work/build_adjacent.py <path> <open_clip_model_id> <dim>` |
| measure the mosquito-accuracy impact | `tmp/adjacent-taxa-work/eval_species.py <text_embeds.json>` |
| build + verify the negatives | `tmp/adjacent-taxa-work/neg/make_negatives.py`, then `neg/verify_embed.py` |
| score Cornelius's own photos | `36-negatives/score_photos.py [DIR]` |

Gate tests: `node --test tests/gate.test.mjs` — 23 checks, 6 of them new for the
non-mosquito state (it names a non-mosquito, it outranks a species claim rather than
only an unsure one, a small mass leaves the verdict alone, absent classes cannot fire,
views without them pool to none rather than to a flat split, and the floor is the
shipped one).
