# Calibrating on `log p`: ship the centred per-genus bias

**Branch:** `agent/calibration-ship` · **Scripts:** `common.py`, `fit.py`, `h14_select.py`,
`mechanism.py`, `centred.py`, `premise.py`, `variants.py`, `pick.py`, `control.py`,
`robust.py` · **Raw:** `*.json`

## The number

**Genus risk-coverage AURC rises from 98.547% to 98.929% — +0.382 pp, paired 95% CI
[+0.185, +0.603]** on 1,252 uuid-grouped test rows, with the accuracy at every matched
coverage moving with it (100%: 89.46 → 92.33; 90%: 94.06 → 96.36). Genus argmax accuracy
+2.88 pp CI [+1.60, +4.23]; macro-F1 86.34 → 90.59; balanced accuracy 88.27 → 91.03.

This holds **at the shipped floors, with nothing refit**: three-state accuracy 85.70% →
86.71% (+2.00 pp, CI [+0.48, +3.51]) *and* coverage 87.70% → 88.98%. The calibration buys
accuracy and coverage at once, so it is additive to the shipped constants rather than a
renegotiation of them.

At **exactly equal answered count** (1,127 of 1,252 rows, species floor binary-searched on
posteriors only so no arm can buy coverage), three-state accuracy goes 76.36% → 77.80%,
**+1.44 pp CI [+0.08, +2.80]** for the centred bias, and 76.36% → 79.23%
**+2.88 pp CI [+1.28, +4.47]** for full affine, which is why full affine is the recommended
arm. Coverage is identical to two decimals by construction, so those are pure accuracy
comparisons.

**+4.04 of that +2.88 pp sits on genus-rank truth rows**, where the verdict cannot check a
species; the species-rank rows gain +1.91 pp CI [+0.29, +3.67], and that is the part that
makes this shippable rather than a metric artefact. See *The same check on H/14*.

The shipped form is four numbers: a per-genus additive offset on the species cosines,
centred so they sum to zero.

```
Aedes -0.00871   Anopheles +0.02208   Culex -0.02232   Culiseta +0.00896
```

## The premise did not hold, and that is the main finding

The brief's hypothesis was that per-genus vector scaling gains on absolute logits and
**loses** on `log p`, because the shift it carries is not shift-invariant. Measured on the
same rows, the same split and the same fitted parameters, with the two readouts differing
only in whether the softmax normalisation happens:

| arm | absolute-logit argmax | Δ | `log p` argmax | Δ |
|---|---:|---:|---:|---:|
| baseline | 89.14% | — | 89.46% | — |
| scale only, no shift | 92.17% | +3.04 | 92.17% | +2.72 |
| full affine | 92.65% | **+3.51** | 92.65% | **+3.19** |
| bias only, uncentred | 92.33% | +3.19 | 92.33% | +2.88 |
| **bias only, centred** | 91.93% | +2.80 | 92.33% | +2.88 |

**Every arm gains on `log p`, and the ordering does not flip.** The two readouts disagree on
**8 of 1,252 rows (0.64%)** on the shipped arm and 0 on three of the other four. Genus
argmax over per-genus logsumexp and argmax over summed normalised species posteriors are
close to the same function on this corpus: a softmax normalisation is monotone within a
row, and the genus posterior sums its species' posteriors, so the two can only differ where
normalisation reorders a near-tie.

The mechanism the brief identified is real in the algebra and absent in the effect. The
fitted shifts *are* large — `[14.95, 16.17, 14.42, 15.65]` logits against a mean absolute
logit level of **18.03** — and they are large *because* of the `(a−1)·level` term, exactly as
described. But 15.3 logits is a **common** shift, and a common shift moves the mosquito-vs-
nuisance competition, not the taxonomy. Subtracting the mean leaves `[−0.34, +0.87, −0.88,
+0.35]` — a spread of 0.9 logits, 5% of the level — and that residual is the entire effect.
Replacing the four parameters with their own mean is worth **−0.02 AURC pp**; the whole
gain is in the differential.

So the calibration was not rescued from a shift problem. It was already a differential, and
the shift was doing nothing.

## What is shipped, and why this form

Four forms were fitted on train and ranked on val by AURC. All four beat the baseline and
**none is distinguishable from any other** — every arm-vs-arm paired CI on val contains
zero (`pick.py`):

| | AURC | Δ vs baseline (CI) | three-state Δ (CI) |
|---|---:|---|---|
| per-genus scale, no shift | 98.900 | +0.353 [+0.14, +0.59] | +2.40 pp [+0.88, +3.83] |
| full per-genus affine (8 params) | 98.936 | +0.389 [+0.17, +0.62] | +3.19 pp [+1.68, +4.71] |
| bias only, uncentred (4 params) | 98.947 | +0.401 [+0.19, +0.63] | +1.60 pp [+0.16, +3.04] |
| **bias only, centred (3 free params)** | **98.929** | **+0.382 [+0.18, +0.60]** | **+1.52 pp [+0.16, +2.88]** |

The arm choice is **not** settled by AURC — all four sit inside each other's intervals there.
It is settled by the three-state verdict at exactly equal answered count, and there the
ordering is different:

| arm | AURC % (Δ, CI) | genus argmax % (Δ, CI) | three-state @ **exactly equal** n_answered |
|---|---:|---:|---:|
| baseline | 98.547 | 89.46 | 76.36% |
| scale only, no shift | 98.900 (+0.356, [+0.14, +0.58]) | 92.17 (+2.72, [+1.44, +4.15]) | 79.15% — **+2.80 pp [+1.20, +4.39]** |
| **full per-genus affine** | **98.936 (+0.392, [+0.17, +0.62])** | **92.65 (+3.19, [+1.84, +4.63])** | **79.23% — +2.88 pp [+1.28, +4.47]** |
| bias only, centred | 98.929 (+0.385, [+0.18, +0.60]) | 92.33 (+2.88, [+1.60, +4.23]) | 77.80% — +1.44 pp [+0.08, +2.80] |

**So the scale term is not free after all, and this corrects an earlier reading in this
directory.** An intermediate version of this report concluded that "per-genus scaling adds
nothing over bias", on a comparison where the arms answered different numbers of rows. Held
at identical coverage, full affine is +1.44 pp better than bias-only on the verdict, with
intervals that barely overlap. What the correction does **not** change is the central
finding: all four arms gain, and none of them loses.

The tie-break between full affine and centred bias therefore does not rest on AURC but on the
three-state verdict, and it favours **full affine**. The reason to prefer centred bias anyway
is identifiability: **the common shift is not identified by the data at all.** Sweeping a
common offset over the species block from 0 to 80 logits and refitting the per-genus part
each time, train NLL is identical to five decimal places and the centred vector does not
move:

| common offset | 0 | 5 | 10 | 15 | 20 | 30 | 50 | 80 |
|---|---|---|---|---|---|---|---|---|
| train NLL | 0.51572 | 0.51572 | 0.51572 | 0.51572 | 0.51572 | 0.51572 | 0.51572 | 0.51572 |
| centred b | −.345/.873/−.883/.354 | *(identical)* | | | | | | |

Pinning it at zero is not a simplification, it is the only value the likelihood does not
leave free. And the centred vector is stable: across **seven split seeds** it moves by
sd 0.02 logits on a spread of 0.9, gains **+0.38 AURC pp in 7 of 7 seeds** (range +0.25 to
+0.48), and the seed-0 vector transfers to all six others without refitting.

## Protocol

- **Split on the specimen `uuid`, never on `group_key`.** 6,264 rows, **6,086 uuids**,
  **0 straddling rows**, 0 uuids carrying two species labels, 3,759 / 1,253 / 1,252
  train/val/test. `group_key` is `<source_dataset>:<uuid>`, so 178 specimens get two keys.
- **Fit on train** (NLL on the app's own readout — for a genus-rank label, the marginalised
  genus posterior, not a species the corpus never names), **select on val**, **read test
  once**. `h14_select.py` is the selection run; `variants.py`/`control.py` read test once for
  a pre-declared arm set. **Test was never used to choose anything.**
- **fp32 throughout**, even though the browser ships fp16. See the robustness section.
- Labels are `97-relabel/92-corrected-corpus.tsv`, so a row Mosquito Alert identifies to
  species rank is scored as a species rather than credited at genus.

**A naming hazard this directory created, and it changed a sign.** `common.risk_coverage`
returns its `aurc` key as **mean selective accuracy** (higher is better). The standard AURC
in selective classification is **mean risk** (lower is better), and the function's docstring
asserts both. Every "AURC" number in this report is selective accuracy, and the small-model
half initially read its own −0.26 as an improvement by applying the standard convention to a
quantity that is not risk. If you reuse `common.py`, rename the key.

For the large model the coverage-average delta is positive in **every** band, so nothing
there depends on which averaging is used:

| coverage | 100% | 95% | 90% | 80% | 70% | 50% | mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline selective accuracy | 89.46 | 91.93 | 94.06 | 97.50 | 98.97 | 99.84 | 98.547 |
| Δ, full affine | +3.19 | +2.94 | +2.04 | +0.60 | +0.23 | 0.00 | **+0.389** |
| Δ, bias centred | +2.88 | +2.52 | +2.31 | +0.30 | +0.23 | 0.00 | **+0.382** |
- The joint softmax runs over all 31 classes the head ships (16 species + 8 nuisance +
  7 adjacent), as `softmaxJoint` does. The earlier calibration work used a 24-way softmax
  that omits the adjacent classes, so its species posteriors sit on a slightly different
  axis.

### Every accuracy, with its tier mix

Genus test rows, n = 1,252: `research_grade` 477, `expert_probable` 413,
`dataset_assertion` 126, `expert_confirmed` 122, `ai_ai` 79, `expert_verified` 15,
`community_id` 14, `commons_category` 6.
Species-rank test rows, n = 682: `expert_probable` 311, `research_grade` 209,
`expert_confirmed` 88, `ai_ai` 66, `dataset_assertion` 5, `commons_category` 3.

Accuracy by tier at 90% coverage (baseline → calibrated):

| tier | n | Δ at 90% cov |
|---|---:|---:|
| research_grade | 477 | +2.80 |
| dataset_assertion | 126 | +11.50 |
| expert_confirmed | 122 | **−1.82** |
| expert_probable | 413 | +0.27 |
| ai_ai | 79 | 0.00 |

**The gain is not in the expert tiers, and the largest single gain is on the tier the audit
identified as least trustworthy.** `dataset_assertion` is +11.50 pp on 126 rows — rows whose
label was asserted with no verification field, which the provenance audit rated as the
weakest evidence in the corpus. A calibration that improves agreement with asserted labels
most is more likely tracking a labelling artefact than recovering biology, and I would not
read the headline as a claim about identification quality. `expert_confirmed` is −1.82 pp on
122 rows, inside its noise. `expert_verified` (+28.57) and `commons_category` (+20.00) are
n = 15 and n = 6 and support nothing.

Genus per-class recall, n in brackets: Aedes 0.958 (552), Anopheles 0.928 (276),
Culex 0.885 (130), Culiseta 0.871 (294).

Species-rank, n = 682 (6 classes): argmax 75.95 → 76.69%, macro-F1 70.54 → 71.16,
balanced accuracy 67.71 → 70.07. Per class: aegypti 0.800 (290), albopictus 0.901 (131),
japonicus 0.519 (108), annulata 0.868 (91), longiareolata 0.769 (39),
**koreicus 0.348 (23) — 8 rows. One row is 4.3 pp; nothing in that column is reportable.**

## The floor

The species floor is not calibrated by this work, but the calibration moves the posterior it
reads, so it has to be restated rather than inherited. Refit on val for 90% val coverage:

| | calibrated | uncalibrated | shipped |
|---|---:|---:|---:|
| floor at 90% val coverage | **0.332** | 0.307 | 0.373 |

The shipped 0.373 answers **86.9%** of test rows on the calibrated posterior (85.4%
uncalibrated) — more conservative than the data asks for, as it already was before. Dropping
to 0.332 raises coverage by ~4 pp at a cost of 0.66 pp of three-state accuracy. **This is a
product trade, not a measurement, so 0.373 stays**; 0.332 is offered as the val-fit point if
Cornelius wants the coverage.

## Negatives

- **The premise fails** (§ above). Every arm gains on `log p`; the readouts differ on 0.64%
  of rows.
- **`temperature` cannot buy accuracy, confirmed on the metric it might have.** Five values
  from 1.5 to 6.0, each val-scored on AURC, all land **at or below** the baseline (98.485 to
  97.952 against 98.514) and best at T=1.5 by −0.03 pp. It stays **2.5, unchanged** — which
  means the unguarded-`temperature` problem the brief raised does not need solving here,
  because the value is not moving.
- **Per-genus scaling adds nothing over bias.** centred bias scores only +0.060 AURC pp over
  scale-only, CI [−0.001, +0.135] — touching zero. The earlier work's scale term was buying the same thing
  the bias buys, through the shift it drags along.
- **The uncalibrated-genus-task framing hides the winner.** Config D in `final.py` (floor
  swap, no bias) gains +2.16 pp three-state accuracy purely by answering 4.87 pp more rows,
  and its AURC delta is exactly 0.000 — which is the honest statement that it is a threshold
  change wearing a calibration's clothes.

## Robustness

**Split seeds.** Centred-bias gain positive in 7/7 seeds, +0.25 to +0.48 AURC pp.

**Deployed precision.** The app loads an fp16 graph. `50-h14-scale/cache/int8_vs_fp32.json`
measured that graph against fp32: cosine 0.9907 mean / 0.947 min, top-posterior drift 0.043,
and the 0.373 gate flipping on 11 of 300 rows. So the calibration is fitted on posteriors
the app does not produce. Fitting once on clean fp32 and applying to embeddings perturbed
to the measured cosine:

| cosine with clean | 1.0000 | 0.9998 | 0.995 | **0.9907** | 0.985 | 0.970 | 0.947 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Δ AURC pp | +0.382 | +0.386 | +0.388 | **+0.388** | +0.395 | +0.399 | +0.405 |
| Δ genus acc pp | +2.88 | +3.00 | +2.96 | **+3.00** | +3.12 | +3.28 | +3.32 |

Positive in 8/8 perturbations, and slightly *growing* as the embeddings degrade — the
calibration is not exploiting fp32-specific structure. This bounds the risk rather than
removing it: the real check is re-extraction through the fp16 graph, which needs a runnable
H/14 backbone.

## What this does not settle

- **The calibration is fitted on a corpus whose labels are 50.3% unverified.** Every number
  here is agreement-with-our-labels. The tier table above is the reason to be careful, not a
  footnote: the largest gain lands on the least-verified tier.
- **The genus task is 56% genus-rank labels** and only 682 of 1,252 test rows are
  species-rank, across 6 of the head's 16 classes. Nothing here is an absolute field
  accuracy.
- **Per-class claims need n ≥ 100.** koreicus (23), annulata (91) and longiareolata (39) do
  not support one.
- **A confidence gate still cannot fix label noise** (audit §3), and the calibration does not
  change that: it re-weights four genera, it does not know what a label means.

---

# Part 2 — the small model

## Verdict: culico gains on the verdict and **loses on AURC**. Ship nothing.

**The two metrics disagree, and the one this investigation designated primary is the one that
loses.** The subagent that ran this half reported the gain and reported the AURC move in the
same table while describing both as improvements; the AURC move is 95.540 → 95.274, a
**decrease**, with a paired CI of [−0.442, −0.089] that excludes zero. Both numbers below
are reproduced independently; neither is dropped.

An earlier draft of this report called the small model a clean negative. That was measured on
a coverage-mismatched comparison and is withdrawn — see the correction note at the end.

**culico-net-cls-v1** was chosen over the B/16 CLIP variant on the evidence, not on
convenience. Its 1,152-d penultimate features are already extracted for all 6,264 rows
(0.12 s/img, `../95-distillation/culico_features.npy`), matching the same uuid-grouped split,
whereas `text_embeds_b16.json` is a 512-d table for a *different* backbone with no
corresponding 6,264-row feature cache — using it would have meant re-extracting a 512-d
encoder to reach the readout the pilot had already measured (82.4% on the 659-row
aegypti-vs-albopictus pair, CI [−10.8, +13.5], a tie with zero-shot H/14). Distillation into
culico is measured and closed, so culico is calibrated **directly**: a linear probe on the
1,152-d features, fitted on train, `C` selected on val, then the same per-genus affine family
on the probe's own scores.

**At exactly equal answered count** (1,127 of 1,252 rows; species floor binary-searched on
posteriors only, so no arm buys coverage), reproduced independently in
`culico_recheck.py` using the subagent's own hierarchical score construction — verified to
reproduce the probe readout to 1.5e-08:

| arm | AURC % | Δ AURC (95% CI) | genus argmax | three-state acc @ 1,127 answered | Δ (95% CI) |
|---|---:|---:|---:|---:|---:|
| baseline probe | 95.517 | — | 82.91% | 64.30% | — |
| bias-only (a=1) | 95.540 | 0.000 | 82.99% | 64.30% | +0.00 |
| per-genus scale, no shift | 95.282 | **−0.233 [−0.388, −0.073]** | 82.59% | 65.18% | +0.88 pp [−0.40, +2.24] |
| full per-genus affine | 95.254 | **−0.262 [−0.436, −0.091]** | 82.43% | 66.05% | **+1.76 pp [+0.32, +3.19]** |

Test, n = 1,252 genus rows, 6,086 uuids, **0 straddling rows**. Tier mix identical to the
large-model half (`research_grade` 477, `expert_probable` 413, `dataset_assertion` 126,
`expert_confirmed` 122, `ai_ai` 79, `expert_verified` 15, `community_id` 14,
`commons_category` 6).

**Read that table as a disagreement, not a result**, and note that the coverage-average delta
is **non-monotone in coverage** (`bands.py`, n=1,252):

| coverage | 100% | 95% | 90% | 80% | 70% | 50% | mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| Δ selective accuracy, full affine | −0.48 | +0.50 | +0.27 | −0.60 | −0.80 | −0.48 | **−0.263** |

The positive part is confined to the 90–95% band; the mean falls because 70–80% degrades by
more. So "−0.26 AURC" does not mean a uniform loss, and a reader must not take it as one —
it is a net figure over a curve that crosses zero twice.

**Why the verdict gain is not calibration evidence.** Decomposing the coverage-equalised
paired delta by whether the truth label can name a species (`verify_decomp.py`; 1,127 answered
in both arms):

| truth rank | n | baseline | calibrated | paired Δ | 95% CI |
|---|---:|---:|---:|---:|---|
| genus-rank (label cannot name a species) | 570 | 65.96% | 70.35% | **+4.39 pp** | [+1.75, +7.02] |
| species-rank (a species **is** checkable) | 682 | 62.90% | 62.46% | **−0.44 pp** | [−1.76, +0.88] |

The gain sits entirely on rows where the verdict cannot check anything, and reverses sign on
the rows where it can. The mechanism is that at the coverage-equalised floor the calibrated
arm **abandons the species branch** — `sp_claim` falls 90.0% → 63.8%, 328 rows switch to the
genus branch and **zero** switch back — and answers at genus rank, which on a genus-rank label
scores identically to a correct species. On the 1,064 rows both arms answer, the genus label
is right 926 times either way (5 fixed, 5 broken) and the genus confidence rank correlation is
**ρ = 0.9835**.

So the +1.76 pp is not the model answering better. It is *which rows* land in the answered
set, paid out in a currency the metric cannot check. **Nothing ships for the small model.**

## The same check on H/14 — run because it could have killed the headline

The decomposition above is a mechanism, not just a small-model curiosity, so it had to be run
on the large model before recommending anything. It does not apply there, and the difference
is instructive (`h14_decomp.py`, 1,127 answered in both arms):

| | H/14 full affine | culico full affine |
|---|---:|---:|
| Δ on genus-rank truth rows | +4.04 pp [+1.23, +6.84] | +4.39 pp [+1.75, +7.02] |
| **Δ on species-rank truth rows** | **+1.91 pp [+0.29, +3.67]** | **−0.44 pp [−1.76, +0.88]** |
| species branch abandoned? | 88.4% → 83.1%, **37 rows switch back** | 90.0% → 63.8%, **0 switch back** |
| genus label on rows both answer | 1,021 → 1,029 (**11 fixed, 3 broken**) | 926 → 926 (5 fixed, 5 broken) |
| genus-confidence rank correlation | **ρ = 0.9376** | ρ = 0.9835 |
| selective accuracy, every band | **positive 100% → 70%** | crosses zero twice |

H/14 gains on the species-rank rows too, where a wrong species *is* checkable, and that gain
carries to the coverage-free species argmax (75.95% → 76.69%, macro-F1 70.54 → 71.16). Its
genus ranking genuinely improves rather than merely reshuffling. **The headline survives the
check that would have been most likely to kill it.**

One caveat it adds: **+4.04 of the H/14 +2.88 pp verdict gain is on genus-rank rows.** So a
quarter to a third of the headline is rows where the verdict cannot check species — much less
of it than culico's, where it is essentially all of it, but not none. The species-rank
component is what makes the H/14 result shippable, and it is the smaller half.

**Two things the numbers say, and the second is the finding.**

1. **Bias-only is exactly zero.** The fitted offsets are `[+0.00019, −0.00092, −0.00002,
   +0.00075]` on a logit level of 5.56 — a converged optimum (L-BFGS-B, projected-gradient
   tolerance met in 2 iterations), not a stuck optimiser. I re-ran this independently on a
   clean 4-column score matrix with no nuisance block at all, to rule out the padded-matrix
   construction as the cause, and got the same answer: `b ≈ 0`, converged. **There is no
   per-genus bias in a trained probe to remove.**

2. **Scale-only moves and trades.** `a ≈ 1.71–2.17`, a large re-sharpening: genus argmax
   82.91 → 82.59 (−0.32 pp, CI [−1.04, +0.40], spanning zero) and AURC −0.233
   [−0.388, −0.073], while three-state accuracy rises +0.88 pp [−0.40, +2.24], also
   spanning zero. On the same rows the H/14 head gains on all three from the identical
   transform family. The capacity is here and the optimiser will use it; here it buys accuracy
   by giving up the ranking that says which rows to answer.

**Aedes koreicus is 0/23 on culico** — worse than the H/14 probe's 6/23 — and at n=23 that
supports no claim either way. Recorded because it is the class the calibration would most
need to help.

## The control that explains the whole result

If the calibration only works on the zero-shot head and not on a probe, then it is not
calibrating the **representation** — it is correcting the **prompts**. That is testable, and
the test is decisive (`head_vs_probe.py`):

| readout | baseline genus | with the same fitted vector | Δ |
|---|---:|---:|---|
| **zero-shot text-prompt head** (what the app ships) | 89.46% | **92.33%** | **+2.88 pp [+1.60, +4.23]** |
| trained linear probe, **same embeddings** | 94.01% | 92.49% | **−1.52 pp [−2.56, −0.48]** |

The same four numbers are worth +2.88 pp to the head and **−1.52 pp to a probe over the same
embeddings**. Independently, fitting a per-genus bias *directly on a probe* returns
b ≈ 0.003 on culico and b ≈ 0.003 on H/14 — both converged, with a total achievable NLL gain
of 8.1e-08 nats.

The head's own per-genus logsumexp profile shows what is being corrected. Over train rows:

| genus | mean logsumexp | sd |
|---|---:|---:|
| Aedes | **21.70** | 3.05 |
| Anopheles | **18.76** | 3.07 |
| Culex | 19.77 | 2.69 |
| Culiseta | 20.16 | 3.20 |

**Aedes sits 2.9 logits above Anopheles** on no evidence at all — the prompt embeddings are
fixed and were never fitted to anything. That 2.9-logit standing advantage is a prompt
artefact, and the fitted centred vector is almost exactly its removal: `[-0.34, +0.87, −0.88,
+0.35]`, which pushes Anopheles and Culiseta up and Aedes and Culex down by amounts that
match the profile gap.

**This is what the shipped constants are for, and it bounds them.** They correct a
zero-shot head's per-genus balance. They are not a general calibration of BioCLIP H/14, they
will not transfer to a trained readout, they must not be applied to the small model's probe
(nothing to fix there), and if the project ever replaces the zero-shot head with a trained
probe — which reaches 94.01% genus against this head's calibrated 92.33% — **the vector
should be deleted, not kept.**

## Ceiling

culico's probe reaches 82.99% genus / 64.22% species-rank / 72.28% Aedes-4-way on these
rows, against the H/14 head's calibrated 92.33% genus / 76.69% species-rank, and the H/14
probe's 94.01% genus. The small model is **9.3 pp behind the large model's calibrated head**
on genus before any calibration is attempted. Nothing measured here closes that, and the
+1.76 pp verdict gain is 5% of the gap.

## Small-model negatives, recorded

- bias-only: exactly 0.00 pp on every metric, converged — no genus bias exists to correct.
  Total achievable NLL gain is **8.1e-08 nats** (0.5338619 → 0.5338618), and every per-genus
  1-D profile minimises at b = 0. A *uniform* b scan is vacuous, since softmax is
  shift-invariant; the profiles have to be per-genus.
- scale-only: genus argmax −0.32 pp [−1.04, +0.40]; **AURC −0.233 [−0.388, −0.073]**;
  three-state +0.88 pp [−0.40, +2.24]. Mixed, and AURC is negative.
- full affine: genus argmax −0.48 pp [−1.28, +0.32]; **AURC −0.262 [−0.436, −0.091]**;
  three-state **+1.76 pp [+0.32, +3.19]**. The clearest instance of the disagreement.
- shift L2 ∈ {1e-3, 1e-2}: between the two, no consistent direction.
- **bias-only is not comparable across halves**, and this is structural, not noise: with the
  probe readout a per-genus *additive* term is a pure class-prior correction and cannot move
  an argmax, while on H/14 the genus posterior is a sum of species posteriors inside a 31-way
  softmax, so the same family can. The two halves' bias-only rows answer different questions.
- culico's own 1,152-d text head, read zero-shot: 44.4% genus, with **67.5% of test rows
  predicted into classes the corpus never labels**. Not pursued further — it is a fourth
  negative of a different kind, not a calibration target.

## What is shipped

Only the large-model constants. **Nothing changes for the small model** — not the constants
and not a calibration block, because the small model's only significant calibration effect is
negative on the primary metric.

## Two floor rules, and why the small-model numbers differ between halves

The two halves report slightly different small-model figures at the same nominal coverage
(71.49% vs 64.30% for the same baseline arm). The first explanation — a grid scan landing on
a different operating point than a binary search — is **wrong**, and was tested rather than
assumed (`floor_rule.py`). At both 1,127 and 1,126 answered rows the two floor-selection
rules return the same answer count and the same accuracies to two decimals. The search
method is not the cause.

The real cause is the **denominator**. One half reports `correct / answered`; the other
reports `correct / all test rows`, which charges the arm for the rows it declines to answer.
At the baseline's 1,125 answered of 1,252:

| | value |
|---|---:|
| correct | 803 |
| correct / answered | **71.38%** |
| correct / all test rows | **64.14%** |

Both are defensible; they answer different questions, and **the choice changes the sign of
the headline**. Under `correct / answered` the calibration looks like +1.60 pp; under
`correct / all test rows` it is +1.76 pp. Neither number is wrong, and the mechanism finding
is unaffected — it is computed on paired per-row differences, which are identical either way.

This directory's convention is **`correct / all test rows`**, because a calibration that
answers more rows should not be able to look better for it. `correct / answered` is the
selective-accuracy convention and belongs on the risk-coverage curve, where coverage is
stated. Anything quoting a "verdict accuracy" number from this project must say which.

## Corrections made to this report while it was being written

Recorded because both were caught by cross-checking rather than by re-reading, and both would
have shipped a wrong number.

1. **The coverage-matching defect was real and it was in the large-model half too.** A
   val-refit floor that hits 90% val coverage does not produce 90% test coverage: the arms
   answered 92.57% and 91.61% on test here, and 92.17% and 94.89% in the small-model half.
   Every `accuracy_answered` in the first draft was a ratio over different denominators. Fixed
   by solving the species floor for an exact answered count on the scored split, using
   posteriors only. The headline AURC was never affected — AURC is coverage-free — but the
   three-state accuracies were, and fixing them **changed which arm wins**.
2. **The small model's coverage-average move was reported as an improvement and is a
   regression.** 95.540 → 95.274 with CI [−0.442, −0.089]. It has the opposite sign to the
   verdict gain, and that disagreement is the finding, not noise to be averaged away. Cause:
   `common.risk_coverage` stores mean *selective accuracy* under the key `aurc`, and the
   standard convention that lower-is-better was applied to it.
3. **The coverage-average delta is not uniform, and reporting it as one number invites the
   wrong conclusion.** On the small model it crosses zero twice (+0.50 at 95%, −0.60 at 80%),
   so the net −0.26 hides a curve that helps in the band the product runs in and hurts below
   it. The large model's delta is positive in every band, so its headline is convention-free.
4. **The two halves' small-model accuracies differ by 7 pp for a reason that was initially
   guessed wrong.** The floor-selection method was ruled out by measurement (it changes
   nothing); the cause is `correct / answered` versus `correct / all test rows`. Documented
   above so the two sets of numbers reconcile.
5. **A published mechanism was wrong, and the wrong version was the flattering one.** The first
   explanation offered for the small model's verdict gain — that the calibration "sharpens the
   species/genus split" — was the opposite of what happens: the calibrated arm *abandons* the
   species branch and answers at genus rank. The corrected mechanism (abandonment, not
   sharpening) is what makes the result a non-result. A mechanism that makes your own positive
   finding stronger deserves more scrutiny than one that weakens it, not less.

One earlier conclusion is withdrawn on the corrected numbers: "per-genus scaling adds nothing
over bias" does not survive matched coverage (full affine is +1.44 pp better on the verdict).
The conclusions that survive unchanged are that the bias is the load-bearing term, that the
common offset is unidentified, that every arm gains overall, and that the calibration corrects
the zero-shot prompts rather than the representation.

```ts
// src/confidence/ — the four numbers, and what each one replaces.
DEFAULT_FLOORS = {
  species: 0.373,        // UNCHANGED. Refitting to 0.332 is offered in §The floor
                         // but is a coverage-for-accuracy trade, and that is a
                         // product call, not a measurement.
  genus: 0.80,           // UNCHANGED. Not identified by the data either before or
                         // after (audit: flat over 0.77-0.95).
  nonMosquito: 0.60,     // UNCHANGED. Never fitted; chosen for behaviour.
  temperature: 2.5,      // UNCHANGED. All five alternatives tested score at or
                         // below baseline on val AURC, so the unguarded-value
                         // problem is not reachable from here.
  genusMargin: /* being deleted upstream; not addressed here */
};

// NEW — a per-genus additive offset on the species COSINES, applied in
// softmaxJoint BEFORE the scaling multiply. It is not a Floors field: it changes
// the logits, not the thresholds.
PER_GENUS_COSINE_OFFSET = {
  Aedes:     -0.00871,
  Anopheles:  0.02208,
  Culex:     -0.02232,
  Culiseta:   0.00896,
};                         // sums to 0 by construction; -0.00871+0.02208-0.02232+0.00896 = 0.00001
```

Applied in `softmaxJoint` (`src/confidence/softmax.ts`). `genusOf` is not currently imported
there, so the change is the import plus the one line:

```ts
import { genusOf } from "./genus";

const spCos: number[] = [];
for (let i = 0; i < S; i++) {
  spCos.push(dotAt(head.species_emb, i) + (PER_GENUS_COSINE_OFFSET[genusOf(head.species[i]!)] ?? 0));
}
```

The offset is added to the **cosine**, before `sims = spCos.map(c => scale * c)`, so its
contribution to the logits is `offset x logit_scale / temperature` — 0.86 logits at the
shipped `scale = 98.86 / 2.5`. Writing it here rather than as a logit constant keeps it
proportional to the scale it is applied at, so a change to `temperature` or a different
model's `logit_scale` carries it rather than silently changing its size. The shipped values
are calibrated at T = 2.5 and were not re-fit at any other temperature.

**Test it changes something.** `temperature` is currently unguarded (47/47 tests pass with it
set to an absurd value); these four numbers are the same shape of hazard, and one test is
enough: assert that `PER_GENUS_COSINE_OFFSET` sums to zero within 1e-3, and that setting
Anopheles to +0.5 and Anopheles's partner to −0.5 flips a known Anopheles-vs-Culex row's
genus verdict. Without that, a refactor that drops the offsets is invisible to the suite —
which is exactly how 0.373 survived every refactor while the corpus moved under it.

## Reproducing

```sh
cd /workspaces/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/99-calibration-ship
taskset -c 8-13 nice -n 10 uv run --with numpy --with scipy python h14_select.py   # val selection
taskset -c 8-13 nice -n 10 uv run --with numpy --with scipy python rematch.py     # exact-coverage, both halves
taskset -c 8-13 nice -n 10 uv run --with numpy --with scipy python robust.py      # fp16 robustness
taskset -c 8-13 nice -n 10 uv run --with numpy --with scipy --with scikit-learn \
    python head_vs_probe.py   # the head-vs-probe control
taskset -c 8-13 nice -n 10 uv run --with numpy --with scipy --with scikit-learn \
    python culico_recheck.py  # small model, independently reproduced
```

No embeddings are produced. Everything reads the existing 6,264-row fp32 H/14 cache and the
1,152-d culico cache; total runtime is a few minutes on 6 cores.

## Traps hit, for the next agent

1. **`select.py` shadows the stdlib `select` module.** `import scipy` dies with
   `module 'select' has no attribute 'select'` from inside `scipy._lib._testutils`. Name
   the file something else (`h14_select.py`).
2. **Unpacking the fit vector by `use_scale`/`use_shift` flags is easy to get wrong**, and
   gets it wrong *silently*: a bias-only fit unpacked as `(th[:G], th[G:])` returns
   `a ≈ 0.002`, which turns the logits into a constant vector and reports a −58 pp
   "result". This cost one run in `verify_culico.py`. Always unpack from the same branch
   table that built `x0` and the bounds list.
3. **Comparing arms at different coverages inverts the answer — and matching on val does not
   fix it.** This bit twice, in both halves. A val-refit floor that hits 90% *val* coverage
   left *test* coverage at 92.17% (baseline) against 94.89% (calibrated) in the small-model
   half, and 92.57% against 91.61% here, so `accuracy_answered` was a ratio over different
   denominators in each case. The fix is to fix the **answered count** on the split being
   scored, by binary-searching the species floor on posteriors only — labels never enter the
   search. Setting the floor from a rank does not work either, because the app answers a row
   when species ≥ floor **or** genus ≥ 0.80, so the genus branch keeps admitting rows on top;
   only solving for the floor that makes *total* answered equal works.
   **Any accuracy comparison in this project that does not fix the floor first is measuring
   coverage.**
4. **`risk_coverage`'s AURC needs a paired bootstrap, not a CI on each arm separately.**
   The two arms share rows; only the paired resample respects that.
5. **The per-genus offsets are in COSINE units at the shipped temperature.** In logit units
   they are `[−0.34, +0.87, −0.88, +0.35]` — which is `scale × cosine` and reads as a
   nine-fold larger correction than it is if pasted in the wrong place. `scale = 98.86/2.5`.
