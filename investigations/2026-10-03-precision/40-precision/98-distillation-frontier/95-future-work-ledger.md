# Future-work ledger — distillation on the small model

**Date:** 2026-10-03 · **Branch:** `agent/distillation-frontier` · **Host:** 14-core arm64 devcontainer,
no GPU, shared with four other agents (`taskset -c 0-6`, `OMP_NUM_THREADS=4`).

**Revised 18:40 after the coordinator's compute update**: cost is no longer a reason to exclude an
arm -- multi-hour CPU runs are permitted and up to 11 of 14 cores may be used when siblings are idle.
Only entry 1 below is a genuine structural impossibility. The others are *slow*, and
`ft_backbone.py --frac 1.0 --epochs 3` (~2.5 h) is the variant the full fine-tune deserves.

| # | Idea | Why it could not run here | Requirement |
|---|---|---|---|
| 1 | **True LoRA on the culico backbone** | LoRA needs an assignable `nn.Module`. The release ships as TorchScript, on which `register_forward_hook` raises `RuntimeError: not supported on ScriptModules`, and the partial-fine-tune arm therefore trains tensors rather than low-rank adapters. A `timm` reconstruction is 213/213 tensor matches on `tiny_vit_21m_224` but its `attention_biases` are pinned to a **49/196/49** token grid that no timm release config reproduces (timm's 224 config wants 144/576/144), so a faithful `nn.Module` needs the original Keras graph. | The Keras source of `culico-net-cls-v1` (this project has only the `.onnx`/`.pt`/`.keras` exports), or `peft` + a verified TinyViT port. |
| 2 | **Full fine-tune of all 213 backbone tensors** | Measured **0.80 s/img** fwd+bwd at bs 8 on 4 threads — **50 min/epoch** on 3,759 rows. *Now permitted:* `ft_backbone.py --frac 1.0 --epochs 3`, ~2.5 h, and it should be run before any more partial-fine-tune variants. | ~4 cores for 2.5 h, or a GPU to make it minutes. |
| 3 | **FixMatch with an EMA teacher recomputed each epoch (arm C proper)** | The teacher must be recomputed from the *current* backbone on a strongly-augmented view every step, which doubles the forward cost and cannot be cached. The cached-strong-view variant is cheap and is the one to run first; the per-step variant is ~2x the forward cost on top of an already 50 min/epoch backbone. | Same run as entry 2, plus patience. |
| 4 | **A better teacher** | The H/14 MLP probe (92.8% val genus accuracy) is the strongest teacher available on this box. A larger or externally-trained teacher is untested. | A second pretrained backbone and a GPU to distill it. |
| 5 | **Distillation across input resolutions** | culico-net-cls-v1 exports at 224 only; `tiny_vit_21m_384`/`512` are separate timm configs with no matching release weights. | A 384 export of the release. |

## What is *not* on this list, and why

The prior negative in `../95-distillation/` is **not** repeated here and its structural argument is
only partly carried over. That report's teacher was the shipped zero-shot head, a bias-free linear map
of the very embeddings the student read, so the student's ceiling was the teacher. Here the teacher is
a *trained* MLP probe (genus val accuracy 92.8% against the zero-shot head's 89.1%, and a posterior
far from one-hot), and the student head is an MLP whose penultimate layer moves under both the feature
and the output loss. Both differences are the point of the re-test.


## Additions after the CI run

| # | Idea | Why it matters | Requirement |
|---|---|---|---|
| 6 | **A non-mosquito image pool** | The corpus is 6,264 mosquitoes and zero outgroups, so "does not call a non-mosquito a mosquito" is **unmeasurable here**. `36-negatives/photos` in the mosquito-id investigation is empty and `03-inat/raw/` is GBIF JSON with no downloaded images. Any nuisance-rejection claim needs this pool built first. | Download and label ~500 non-mosquito insect images. Nothing on this box blocks it; it is a data-collection task, not a compute task. |
| 7 | **The species task, head on** | species9 macro-F1 0.5216 against genus4 0.7753 on the same features and probe, and √-balanced weighting is the only thing that moved it (+2.67 pp). The genus/species gap is the actual problem in this model, and no arm here attacks it directly. | — |
