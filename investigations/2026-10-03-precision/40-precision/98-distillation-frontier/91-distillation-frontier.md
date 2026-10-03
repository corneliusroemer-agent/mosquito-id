# Distillation frontier on culico-net-cls-v1: does anything beat the linear probe?

**Date:** 2026-10-03 · **Branch:** `agent/distillation-frontier` (in `corneliusroemer-agent/mosquito-id`)
· **Status:** four arms closed with intervals, one open. `HANDOFF.md` has the traps and the next step
per strand; this file is the finding.

## The number

**Nothing in the distillation family beats the linear probe.** Output distillation and feature
distillation on a frozen backbone are both negative, and more decisively than the prior report
managed, because the teacher here is a *trained* probe rather than the shipped zero-shot head. What
does beat the probe is **√-balanced class weighting, on the species task, by +2.67 pp macro-F1,
CI [+0.20, +5.33]** — the only interval in this study that excludes zero.

The one arm still running is partial fine-tuning of the backbone, which is the only arm that has
moved in the right direction on val and has **no test number and no interval yet**. Nothing should
be concluded from it until both exist.

## Split, and why it is uuid

6,264 rows, **6,086 uuids, 0 straddling rows, 0 uuids carrying two species labels**; 3,759 /
1,253 / 1,252 train/val/test, stratified by species. `group_key` is `<source_dataset>:<uuid>`, so a
specimen ingested by both `ma/` and `ma_api/` gets two keys; grouping on it leaks 178 specimens.
`common.py` prints the leak check on every run and `ci.py` asserts it.

Tasks, all scored on the same 1,252 uuid-split test rows: **`genus4`** (4 genera over all rows) and
**`species9`** (the 9 classes the corpus names — three of them genus-rank — over all rows).
**`aedes4`** exists only for comparability with the readout table in `../95-distillation/`.
424 of the 1,252 test rows are species-rank; their tiers are `2_expert_probable` 296,
`3_automated_only` 66, `1_expert_reviewed` 62. The full test set is `4_asserted_no_verification_field`
621, `2_expert_probable` 411, `1_expert_reviewed` 141, `3_automated_only` 79.

fp32 throughout. Fit on train, selected on val, test scored once per pre-declared configuration.
`A. koreicus` has 23 test rows — one row is 4.3 pp — so nothing is claimed from it.

## Results

Test macro-F1, and the paired bootstrap CI on the difference against the linear probe (2,000
resamples, paired over rows — the arms agree and disagree on the *same* rows, so an unpaired
interval would throw that away). Reproduce with `.venv/bin/python ci.py`.

| Task | linear probe | **√-balanced (p=0.5)** | uniform (p=1) | MLP head |
|---|---|---|---|---|
| genus4 | 0.7753 | 0.7821 · +0.68 pp **[−0.49, +1.89]** | 0.7706 · −0.47 pp [−2.10, +1.16] | 0.7707 · −0.46 pp [−2.67, +1.87] |
| **species9** | 0.5216 | **0.5484 · +2.67 pp [+0.20, +5.33]** | 0.5383 · +1.71 pp [−1.27, +4.60] | 0.5150 · −0.60 pp [−3.62, +2.40] |
| aedes4 | 0.4905 | 0.5042 · +1.35 pp [−0.80, +3.69] | 0.5113 · +2.06 pp [−1.90, +6.39] | 0.4914 · +0.09 pp [−3.25, +3.60] |

### √-balanced sampling: the one effect with an interval excluding zero

It moves macro-F1 **without moving accuracy** — species9 accuracy is 0.6558 → 0.6534, i.e.
down 0.24 pp while macro-F1 is up 2.67 pp. That divergence is the whole point of reporting macro-F1
and not accuracy, and it is visible in the per-class recall, baseline → √-balanced:

| class | n | recall |
|---|---|---|
| Culiseta longiareolata | 37 | 0.216 → **0.432** |
| Aedes japonicus | 108 | 0.352 → **0.454** |
| Aedes albopictus | 131 | 0.634 → **0.718** |
| Culex | 130 | 0.754 → 0.746 |
| Anopheles | 276 | 0.833 → 0.793 |
| **Aedes aegypti** | 290 | 0.759 → **0.669** |

The tail classes gain and the head class pays. A raw-accuracy comparison calls this a wash and a
per-class view calls it five wins and two losses; macro-F1 with an interval is what makes it
quotable. **Aedes koreicus (n=23) moves 0.000 → 0.043 — one row. Not quotable, reported only so the
column is not silently missing.**

On genus4 the same weighting is +0.68 pp [−0.49, +1.89] — indistinguishable from zero. Uniform
weighting (p=1) is worse than √ on species9 and no better on genus4, so **√ is the setting, not a
tuning knob between "natural" and "uniform"**: full balancing over-corrects, and √ is where the
trade lands.

### Output distillation: negative, and more decisively than the prior report

The prior negative in `../95-distillation/` was open to the objection that its teacher was badly
scaled — posterior entropy 0.10–0.24 nats against 1.386 uniform, so where it disagreed with a label
it disagreed at full confidence. **This teacher is a trained MLP probe on the H/14 embeddings**:
genus val accuracy 0.9282, test macro-F1 0.9113, and a posterior nowhere near one-hot. The
objection does not apply and the result is the same.

genus4, val macro-F1 of the MLP head, α = weight on KL to the teacher:

| α | 0.0 | 0.3 | 0.5 | 0.7 | 1.0 |
|---|---|---|---|---|---|
| val macro-F1 | **0.7711** | 0.7664 | 0.7604 | 0.7615 | 0.7419 (T=4) |

Monotone down in α, and temperature only deepens it (α=0.3 gives 0.7664 / 0.7543 / 0.7532 at
T=1/2/4). **Soft targets do not help a small student even when the teacher is well calibrated and
much stronger than the student.** That closes the direction properly rather than narrowly.

### Feature distillation on frozen features: also negative

Arm A — match the teacher's *penultimate embedding* rather than its softmax, through a 1152→1024
projection with a cosine loss. This is the arm the prior negative explicitly does not cover, because
features carry strictly more than a softmax over them.

genus4, val macro-F1: λ=0.1 → 0.7670, λ=0.3 → 0.7659, λ=1.0 → 0.7603, against **0.7711** at λ=0.
Also negative, and by a similar margin to output distillation. **The richer target did not help
either.** A negative on both the rich target and the poor one, from a teacher worth 0.9113, is
strong evidence that the information is not in the teacher at all as far as this student is
concerned — the teacher's knowledge lives in weights the 21M model does not have.

### Readout capacity: the MLP head is worse than the linear one

Across hidden size {256, 512, 1024}, dropout {0.1, 0.2, 0.3}, and both class weighting and
resampled minibatches, **no MLP configuration beat the linear probe** (best val macro-F1 0.7711 vs
0.7932 on genus4). The 21M features are already close to their linear ceiling on 3,759 training
rows. Every CI above includes zero. This is the context the other arms sit in: adding readout
capacity does not help, so a distillation arm has to add *information*, not capacity — and none of
them did.

## Open: arm B, partial fine-tune (the representation moves)

The one thing the prior negative's structural argument does not cover is a student whose
representation changes. Last 25% of the backbone (54 of 213 tensors, 9.89M params) plus a 592k
head, lr 1e-5 backbone / 1e-4 head, bs 16, genus4 **val** macro-F1:

| epoch | `ce` | `ce_fd` (λ=0.5 cosine to the H/14 embedding) |
|---|---|---|
| 1 | 0.7626 | 0.7588 |
| 2 | 0.8005 | 0.8028 |
| frozen-feature linear probe | 0.7932 | 0.7932 |

Both arms cross above the frozen probe at epoch 2, and the feature-distilled arm is ahead. Epoch 2
reproduced **bit-identically** across two independent runs, so the seed is stable.

**This is not a result yet.** It is a val number, the deltas are under a point, and test has not
been read for this arm. `ft_backbone.py` also reports a **linear probe on the moved feature** and
the **backbone drift norm**, which together separate "the representation got better" from "the
from-scratch head happened to fit" — that is the number to wait for. Epochs 3–4 were running at
handover.

## Not measured, and why

**Outgroups.** The brief requires that the classifier not call a non-mosquito a mosquito. **This
corpus cannot measure that** — all 6,264 rows are mosquitoes. I looked: `36-negatives/photos` in
the mosquito-id investigation is empty, and `03-inat/raw/` holds GBIF JSON but no downloaded
images. Any claim about nuisance rejection needs an image pool that does not exist here. This is a
real gap, not a rounding error.

## What to do next

1. **Finish the partial fine-tune and put a paired CI on it** before anything else. It is the only
   arm that has moved, and an effect with no interval is not a result.
2. **Adopt √-balanced weighting on the species task** — it is measured, it is free, and it is the
   only change here with an interval excluding zero. Re-check it against the from-scratch head and
   the augmentation arm before shipping, since those could move it.
3. **Do not spend more time on output or feature distillation on a frozen backbone.** Both closed.
   Full fine-tuning (`--frac 1.0`, ~50 min/epoch) is the one variant worth the hours.
4. **The species task is the real problem**: macro-F1 0.5216 against genus4 0.7753 on the same
   features and the same probe. Nothing here has attacked that gap head-on.

## Regenerating the caches (they are deliberately not in git)

| Cache | Cost | Command |
|---|---|---|
| `culico_features.npy` (6264×1152) | ~40 s | `extract_culico_ts.py`, or `../95-distillation/extract_culico.py` (ONNX, 0.12 s/img) |
| `50-h14-scale/cache/embeddings.npy` | see that directory | `../50-h14-scale/extract.py` |
| `cache/images_224_uint8.npy` (942 MB) | **40 s**, 0 failures | `cache_images.py` |
| 12 augmentation views, 3759 rows each | **50 min** (3,032 s, 4 threads, 0.807 s/row for all 12; decode is only 0.007 s/row) | `e-augment/extract_aug.py` |

The TorchScript release reproduces the cached ONNX features at **cosine 1.000000**, so
`ft_backbone.py` trains exactly the representation every other arm reads. Preserve that equivalence
if you swap the backbone.

Interpreter is `.venv/bin/python`; `python3` on PATH is the conda bioinfo env and has no torch,
onnxruntime or timm. `uv pip install --offline` works from cache here.

`distill_portable.py` is the same fine-tuning arm with every path and hyper-parameter as a CLI
argument and `--device mps|cpu|cuda`, so it runs off this container on a Mac's GPU. An MLX-native
port would need the original Keras source or a CoreML conversion of the ONNX, since the release
ships TorchScript and Keras, neither of which MLX loads.
