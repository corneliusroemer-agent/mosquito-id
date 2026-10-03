# Distillation pilot: does H/14's classifier quality transfer into a small student?

**Date:** 2026-10-03 · **Branch:** `agent/distillation-pilot` · **Script:** `distill.py` ·
**Table:** `92-distillation-results.tsv` (172 configurations) · **Raw:** `q1_results.json` ·
**Features:** `/Users/cr/code/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/50-h14-scale/cache/`

## Verdict

**Q1 is a negative, and it is negative structurally rather than marginally.** Teacher soft targets
do not improve a student head over hard labels on either task; the best mixing setting is worth
+0.56 pp on genus (CI [−0.24, +1.44]) and −0.91 pp on species (CI [−2.54, +0.54]). Pure soft-target
training is 4.2 pp worse on genus and 8.5 pp worse on species, both CIs excluding zero.

The reason is not that the targets are badly tuned. **The teacher's posterior is a linear function
of the same embeddings the student consumes**, so a linear student trained on it can at best
reproduce the teacher — and it does, to within five training rows. The distillation target is the
teacher, and nothing in the teacher's posterior sits above the teacher.

The 21M student does not close the gap either: **culico-net-cls-v1 reaches 82.1% genus / 69.8%
species against H/14's probe at 93.9% / 87.7%.** It approaches neither, beats neither, and a
val-fit blend of the two adds +0.32 pp on genus (CI [−0.48, +1.12]) and exactly nothing on species.

This is the seventh negative in this project and the first one that is closed by a structural
argument rather than a measurement.

The positive finding is adjacent and belongs to the same run: **on a 21M specialist the linear
probe is worth +37.7 pp genus and +56.0 pp species over the model's own head**, and the result that
looks like "a small model nearly matching a large one" is a readout effect on top of a model that
scores 44% / 14% unaided. Distillation moved neither number.

## Method

- **Split:** grouped on the **specimen uuid** (`group_key` split on `:`), 60/20/20, seed 0,
  stratified within species. **6,086 uuids for 6,264 rows, 0 straddling rows, 0 multi-label uuids**;
  3,759 train / 1,253 val / 1,252 test. Implemented in `split.py`; the leak check prints on its own.
- **Embeddings:** the existing 6,264 × 1,024 float32 H/14 cache, L2-normalised. Nothing re-extracted.
- **Teacher:** the shipped head (`text_embeds.json`), 16 species prompts, `logit_scale` 98.86.
- **Tasks:** genus 4-way (n test 1,252) and Aedes species 4-way (n test **552**, not the 97 from
  the DINOv2 bake-off — that was a 1,101-row subset).
- **Student:** one linear head (AdamW, 300 epochs, cosine schedule, batch 256), identical across all
  arms. Sweeps: weight decay {1e-4, 1e-3, 1e-2} for hard labels; teacher temperature T ∈ {1, 2, 4,
  8, 16, 32, 64, 128} and mixing weight α ∈ {0.3, 0.5, 0.7, 0.9} for soft and mixed. 43 configurations
  per (backbone, task). Fit on train, **selected on val**, test scored once per configuration.
- **fp32 throughout.** No fp16 or int8 number appears in this report.

## Q1 — the teacher's knowledge, transferred

All numbers are test accuracy of the val-selected configuration within each arm, 6,264-row cache.

| Task | Teacher (16-way) | Teacher (marginalised) | hard | soft | mixed | soft − hard | mixed − hard |
|---|---|---|---|---|---|---|---|
| genus 4-way | 89.14% | 89.54% | **93.93%** | 89.78% | 94.49% | −4.15 pp [−5.83, −2.64] | +0.56 pp [−0.24, +1.44] |
| Aedes 4-way | 75.72% | 79.17% | **87.68%** | 79.17% | 86.78% | −8.51 pp [−11.60, −5.25] | −0.91 pp [−2.54, +0.54] |

Paired bootstrap over test rows, 2,000 resamples, on the val-selected model of each arm.

The H/14 hard-label arm reproduces the independent probe report (93.9% genus there, 93.9% here;
87.3% there, 87.7% here), and the teacher columns reproduce it too (zero-shot genus 90.2% /
species 77.0% there, 89.1% / 75.7% here). Same corpus, different uuid-grouped split — a 1 pp
difference, consistent with the ~1.0–1.4 pp optimism the leak was worth.

### The soft-target student converges to the teacher, not above it

The teacher scores a row by `argmax_j TEX[j] · x` — a bias-free linear layer on the very embeddings
the student reads. So the soft-target objective is asking the student to reproduce a function it
already has access to, and its ceiling is the teacher's accuracy, not the labels'. Measured three
ways, it lands there:

| | teacher agrees with the hard label on train | soft student (T=1) train acc | teacher's test acc | soft student test acc |
|---|---|---|---|---|
| genus 4-way | 91.09% | 90.96% | 89.54% | 89.78% |
| Aedes 4-way | 80.77% | 80.71% | 79.17% | 79.17% |

Five training rows and two, respectively. **Distillation onto the teacher's own representation
returns the teacher.** The +4.4 pp that separates the teacher's readout from a trained probe lives
in what the hard labels say, not in the shape of the teacher's posterior.

### The posterior carries almost no graded information

The teacher's posterior over the task's classes has a mean entropy of **0.101 nats on genus and
0.243 on Aedes, against 1.386 for uniform**. It is close to one-hot. Where it disagrees with the
label it disagrees *confidently*: 8.9% of genus training rows and 19.2% of Aedes training rows
carry a target whose argmax is the wrong class. That is the classic failure mode of soft targets
with a badly scaled teacher — it is label noise at full confidence, and the student inherits it in
proportion to α. The measured behaviour matches: test accuracy falls monotonically as α rises
(at T=8, α = 0.3 → 0.5 → 0.7 → 0.9 gives 94.5 → 94.2 → 93.2 → 91.9 on genus).

### Ruled out: the targets were simply too peaked

The sweep runs T to 128, which flattens the posterior well past uniform. Soft-only test accuracy
on genus is 89.78% at T=1, 89.46% at T=8, 89.46% at T=16, 89.46% at T=32, 89.30% at T=64,
**89.38% at T=128**. There is no interior optimum: as T → ∞ the soft target approaches the class
prior and the student approaches the prior predictor, which is the floor, not a ceiling. On Aedes
the same sequence runs 79.71 → 78.80%. Softening further cannot help because the information is
not in the posterior, it is in the labels.

### Mixing does not rescue it

The classic α-schedule is the best soft-containing arm and it still lands on the null. Genus picks
α=0.3, T=8 (94.49% vs 93.93%); Aedes picks α=0.3, T=8 and gets 86.78% against 87.68%. Val-fit
ceilings (best val accuracy reachable by any config in the arm) and the cheating oracles are in
`q1_results.json`; the largest gap is 1.3 pp, on Aedes mixed (0.8678 selected, 0.8804 oracle), and every oracle sits within 1.3 pp of its arm's val-selected number, so no
configuration was being missed by val selection.

### Per class, with n

Genus 4-way, n test = 1,252 (Aedes 552, Anopheles 276, Culex 130, Culiseta 294):

| Arm | Aedes | Anopheles | Culex | Culiseta |
|---|---|---|---|---|
| hard | 97.5% | 92.4% | 89.2% | 90.8% |
| soft | 96.4% | 82.6% | 96.2% | 81.3% |
| mixed | 97.1% | 92.8% | 93.1% | 91.8% |

Aedes 4-way, n test = 552 (aegypti 290, albopictus 131, japonicus 108, **koreicus 23**):

| Arm | aegypti | albopictus | japonicus | koreicus |
|---|---|---|---|---|
| hard | 96.6% | 83.2% | 81.5% | **not measured (n=23)** |
| soft | 82.8% | 90.8% | 63.0% | **not measured (n=23)** |
| mixed | 94.8% | 84.0% | 80.6% | **not measured (n=23)** |

koreicus has 23 test rows — one row is 4.3 pp, and the arms land at 30.4%, 43.5% and 30.4% on it.
Nothing in that column is quotable.

## The negative is not a label-quality artefact

Only a minority of the test set is expert-confirmed, so the whole comparison is repeated on that
subset alone (tiers from `../96-label-provenance/rows_joined.tsv`).

Genus 4-way test, n = 1,252 — **137 expert-confirmed (10.9%)**:

| Arm | expert-confirmed (n=137) | expert-probable (413) | MA machine (79) | unverified (623) |
|---|---|---|---|---|
| teacher (marginalised) | 86.9% | 90.1% | 100% | 88.4% |
| hard | 92.0% | 91.5% | 100% | 95.2% |
| soft | 86.1% | 90.3% | 100% | 88.9% |
| mixed | **92.7%** | 93.2% | 100% | 95.0% |

Aedes 4-way test, n = 552 — **86 expert-confirmed (15.6%)**:

| Arm | expert-confirmed (n=86) | expert-probable (183) | MA machine (66) | unverified (217) |
|---|---|---|---|---|
| teacher (marginalised) | 84.9% | 61.2% | 100% | 85.7% |
| hard | **93.0%** | 72.7% | 97.0% | 95.4% |
| soft | 83.7% | 62.3% | 100% | 85.3% |
| mixed | 89.5% | 73.8% | 97.0% | 93.5% |

On expert-confirmed rows the ordering is unchanged: soft below hard on both tasks, mixed +0.7 pp on
genus and −3.5 pp on Aedes. **The distillation negative does not come from noisy labels.**

Two things the tier table does show, and they are not about distillation:

- The **MA machine-labelled tier scores 97–100% for every arm**, including the teacher's zero-shot
  head. Those rows come from a classifier trained on the same labels being scored, so the tier
  measures agreement with the labelling model, not accuracy.
- The **teacher collapses on expert-probable Aedes rows (61.2%)** while every trained readout holds
  72–74%. Whatever "expert_probable" marks is a subset the text prompts handle badly.

## Q3 — does the 21M student approach or beat the teacher?

### What the 21M specialist is actually worth on this corpus

**The readout is doing nearly all of the work.** culico-net-cls-v1's **own 18-way head, no probe
at all**, on the same 1,252 uuid-split test rows:

| Readout | genus (n=1,252) | Aedes 4-way (n=552) |
|---|---|---|
| culico-net-cls-v1, own 18-way head, no probe | 44.41% | 13.77% |
| **+ linear head on the same features** | **82.11%** | **69.75%** |
| H/14 zero-shot, shipped head | 89.14% | 75.72% |
| H/14 + linear head | 93.93% | 87.68% |

**The probe is worth +37.7 pp on genus and +56.0 pp on species.** A 21M model with a linear head
lands 7.0 pp behind a 632M zero-shot model on genus and 6.0 pp behind on species, at 1/30th the
parameters — and it gets there entirely by readout, not by the model having learned our task.
That also reconciles the 13–32% figure quoted for this model elsewhere: **13.77% is its own head**,
which is what that number always was.

Per class, own head versus probe, with n:

| Task | class | own head | + linear head |
|---|---|---|---|
| genus | Aedes (552) | 57.1% | 90.6% |
| genus | Anopheles (276) | 16.3% | 77.9% |
| genus | Culex (130) | 4.6% | 68.5% |
| genus | Culiseta (294) | 64.6% | 76.2% |
| Aedes | aegypti (290) | 7.9% | 83.4% |
| Aedes | albopictus (131) | 40.5% | 64.9% |
| Aedes | japonicus (108) | 0.0% | 53.7% |
| Aedes | koreicus (23) | **not measured** | **not measured** |

The own head is confident and badly calibrated for this corpus: it sends 103 of 552 Aedes rows to
`class_background`, 125 of 276 Anopheles rows to Culiseta, and only 3 of 130 Culex rows to any
Culex class. 67.5% of its predictions land on one of the ten culico classes absent from this corpus,
or on `class_background`. Its specialist features are fine; its 18-way label space is the wrong
shape for this corpus.

Three caveats on all of the above:

- **No before/after existed for this model on this corpus before this pilot.**
  `05-tower-bakeoff/tower_results.json` holds only `bioclip25_h14` and its `culico_smoke.log` is an
  embedding shape. The own-head row above is the missing baseline, measured now.
- **The class mapping is inferred, then checked.** No released artefact lists culico's 18 output
  indices. They are recovered from the label column of its training dataset
  (`iloncka/mosquito-species-classification-dataset`, 18 distinct strings, fastai's vocab is sorted)
  and the inference is validated by structure: the model puts 315 of 552 Aedes rows on an *aedes*
  class and 190 of 294 Culiseta rows on a *culiseta* class, which a wrong ordering would not
  produce. Species-level indices within a genus are not separately verified.
- **culico-net-cls-v1 was fine-tuned on a mosquito dataset containing aegypti, albopictus, koreicus,
  Anopheles and Culiseta** — most of this corpus's label space. Whether individual test rows are in
  its training set is not checked here, so 82.11% is an upper bound on out-of-domain performance.

### Against the teacher

**Neither.** Same model, same head and split, on its own 1,152-d penultimate features extracted
from the released ONNX:

| Task | H/14 probe | culico probe | gap |
|---|---|---|---|
| genus 4-way (n=1,252) | 93.93% | 82.11% | −11.8 pp |
| Aedes 4-way (n=552) | 87.68% | 69.75% | −17.9 pp |

Distillation does not narrow it, and it does not widen it either: **on culico's own features every
soft-containing target is at or below the hard-label control.** Soft-only is −1.8 pp (genus) and
−3.4 pp (Aedes); mixed is −0.5 pp and −0.9 pp with both CIs spanning zero. The best culico number
under any target is 82.11%, which is its hard-label control. So this pilot moved the small model
by nothing: the accuracy it has comes from the linear probe, which is the pre-existing control
condition, and the distillation direction is the one thing that was tried and did not help.

A val-fit blend of the two probes' log-probabilities (`beta` = weight on the culico arm, chosen on
val) recovers **+0.32 pp on genus** at beta=0.25 (CI [−0.48, +1.12]) and **0.00 pp on species** —
val selects beta=0, the H/14 arm alone. Both blend arms are fitted at a fixed wd=1e-4, so the H/14
arm scores 93.77% here against 93.93% for its own val-selected weight decay; the blend delta is
measured against its own beta=0 baseline either way. Consistent with the five earlier negatives: another frozen
backbone decorrelated from H/14 and nothing converts.

Per class, culico hard-label probe, with n:

| Task | per-class test recall (n) |
|---|---|
| genus | Aedes 90.6% (552), Anopheles 77.9% (276), Culex 68.5% (130), Culiseta 76.2% (294) |
| Aedes 4-way | aegypti 83.4% (290), albopictus 64.9% (131), japonicus 53.7% (108), **koreicus not measured (23)** |

## What a follow-up would have to change

Distillation of a *target* is dead on this corpus, because the target is a linear map of features
the student already has. What that does **not** rule out is changing the student's parameters:

- **An MLP or LoRA head** instead of one linear layer. The +56 pp the probe already buys says the
  readout has headroom, and nothing here tested whether a deeper one has more.
- **Backpropagating into the backbone.** This pilot never updated a single culico weight, so
  "21M is not enough" was never tested — only "21M features plus a linear head" was.
- **Distillation onto unlabelled images.** Every arm here trained on our labels. The teacher's
  posterior on rows we have no label for is the one source of signal that this corpus does not
  provide, and the α-schedule result does not speak to it: on labelled rows the teacher's posterior
  was wrong and confident 9–19% of the time, which says nothing about its value where there is no
  label to contradict it.

## What agreement with the teacher means here

Our labels and our benchmark rows come from the same sources, and 66 of the 552 species test rows
are labelled by Mosquito Alert's own image classifier. A student agreeing with the teacher is
partly agreeing with a partly circular reference. This does not change the verdict — the arms are
compared against each other on identical rows and identical splits — but it does mean **no number
in this report should be read as an absolute field accuracy.** The 93.9% genus figure is a
consistency-with-our-labels figure.

## What this closes

- **Soft-target distillation of BioCLIP H/14 onto any linear readout is a dead end on this corpus.**
  The teacher's posterior is a linear map of the embedding the student already has, has almost no
  entropy left to transfer, and disagrees confidently with the labels on 9–19% of training rows.
  No temperature, mixing weight or model architecture changes the first two facts.
- **The teacher's advantage over a trained probe is in its labels, not its posterior.** Every route
  that carries the posterior across — soft targets, mixing — returns the teacher's own 89.5% /
  79.2% ceiling, and the hard labels are worth +4.4 / +8.5 pp over that.
- **A 21M specialist is not a substitute for a 632M generalist here.** −11.8 / −17.9 pp against
  H/14's probe, and distilling into it does not close the gap. It is within 7.0 / 6.0 pp of
  H/14 *zero-shot*, which is a real result for a 21M model but does not close the ranking gap. Together with Insect-Foundation (−20 to −29 pp) and
  BIOSCAN's +2 to +3.4 pp oracle ceiling, **backbone substitution is closed as a direction.**
- **What is left is the representation itself** — H/14's, fine-tuned on labels — which is a
  training run, not a pilot, and this experiment says nothing about it. The pilot's contribution is
  to rule out the cheap proxy for that run.

## Reproducing

```sh
cd /Users/cr/code/claude-devcontainer/investigations/2026-10-03-rewrite/40-precision/95-distillation
python split.py                       # leak check, ~1 s
OMP_NUM_THREADS=4 taskset -c 0-7 nice -n 10 \
  uv run --with numpy --with torch --with scikit-learn python distill.py   # 183 s
```

`extract_culico.py` produced `culico_features.npy` in 760 s for 6,264 images, and
`culico_own_head.py` the 1,252-row own-head logits (`culico_own_logits.npy`) in ~190 s. Both .npy
files are gitignored; regenerate with `--with onnx --with onnxruntime --with pillow --with numpy`,
then `python rescore_own_head.py` to rescore the saved logits without re-running the model.
Deterministic: seed 0 for the split, the network init and the bootstrap.

## Two corrections the run produced

- **`group_key` splitting leaks.** 6,264 rows carry 6,264 distinct `group_key` values and 6,086
  distinct specimens, because `group_key` is `<source_dataset>:<uuid>` and a specimen ingested by
  both `ma/` and `ma_api/` gets two keys. A group split on `group_key` is therefore a plain row
  split for exactly the rows that need grouping. `../95-prototype-heads/91-prototype-heads.md`
  reasons from "6,264 groups for 6,264 rows, so there is no repeated-specimen leakage here" — that
  inference does not hold. Grouping on the uuid gives **0 straddling rows** and moves the genus
  result by about 1 pp.
- **culico-net-cls-v1's penultimate feature is 1,152-d, not 1,024-d**, and its released ONNX graph
  runs only at batch 1 (TinyViT's attention reshapes to hardcoded `[1,H,W,C]`). Extraction measured
  **0.12 s/img**, not the 0.026 s/img in the model card summary — 6,264 images took 760 s on 4
  cores. Neither figure changes any conclusion here, but a 6,264-image pass is ~13 min, not ~3.
