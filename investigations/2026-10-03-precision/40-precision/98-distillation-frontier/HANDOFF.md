# HANDOFF — distillation frontier on culico-net-cls-v1 (21M)

**Branch:** `agent/distillation-frontier` · **Written:** 2026-10-03 18:30 CEST, mid-run, by an agent
that was told to hand off at 45 min rather than finish. **Two fine-tune jobs and one sweep were
still running when this was written** — see §5 for how to pick them up.

## 0. Read this first: two non-obvious facts about this repo

1. **`investigations/` is gitignored by design.** The repo is a whitelist (`.gitignore` line 7 is
   `/*`), so nothing under `investigations/` is tracked — not the sibling agents' work either. I
   force-added *this directory's* scripts, JSON and reports to the branch and nothing else; the
   ~90 MB of feature caches, checkpoints and logs stay untracked. If you add files here, expect the
   same.
2. **`git add -f` silently stages nothing on this checkout.** It exits 0 and `git diff --cached`
   stays empty. What works:
   ```sh
   h=$(git hash-object -w FILE); git update-index --add --cacheinfo 100644,$h,FILE
   ```
   (`git hash-object` without `-w` also fails, with `fatal: unable to read <sha>` at commit time.)
   This cost me two attempts; do not repeat it.

## 1. Where things stand

Committed and pushed: the harness, the sweep driver, the fine-tune script, the portable off-box
script, `cached_results.json` (partial), the future-work ledger. Not committed: every `.npy`
feature cache, every `.pt` checkpoint, all logs.

Running or runnable, with reproduction commands:

| Strand | State | Command |
|---|---|---|
| Arm A/B/D on cached features (`run_cached.py`) | **genus4 done**, species9/aedes4 not started | `taskset -c 0-6 OMP_NUM_THREADS=4 .venv/bin/python run_cached.py` |
| Arm B partial fine-tune, `--arms ce` | epoch 1 of 4 done | `taskset -c 0-6 OMP_NUM_THREADS=2 .venv/bin/python ft_backbone.py --arms ce --tasks genus4 --tag ftce --epochs 4 --frac 0.25 --bs 16` |
| Arm A/B partial fine-tune, `--arms ce_fd` | epoch 1 of 4 done | same with `--arms ce_fd --tag ftfd --lam 0.5` |
| Arm E augmentation (subagent) | **extraction complete** (12 view caches), scoring not run | see §5 |

Interpreter: `.venv/bin/python` (torch 2.14.1, onnxruntime 1.30.0, timm 1.0.30, pillow, numpy,
sklearn). **`python3` on PATH is the conda bioinfo env and has no torch, no onnxruntime and no
timm** — every script here fails on it.

## 2. The numbers

All on the uuid-split test set: 1,252 rows, **6,086 uuids for 6,264 rows, 0 straddling rows, 0
multi-label uuids**, 3,759/1,253/1,252. Tier mix of the test set, which travels with every number
below: `4_asserted_no_verification_field` 621, `2_expert_probable` 411, `1_expert_reviewed` 141,
`3_automated_only` 79. Of the 1,252 test rows, **424 are species-rank**; their tiers are
`2_expert_probable` 296, `3_automated_only` 66, `1_expert_reviewed` 62.

Reproduce: `.venv/bin/python analyse.py` (reads `cached_results.json`).

### Baselines, test macro-F1

| Readout | genus4 | species9 | aedes4 |
|---|---|---|---|
| linear probe on culico features (`run_cached.py`) | **0.7753** | not run | not run |
| linear probe (`e-augment/arms.py`, its own head) | 0.7840 | **0.5451** | 0.5035 |
| H/14 MLP probe, the teacher | **0.9113** | not run | not run |

Two probe implementations disagree by 0.9 pp on genus4 (0.7753 vs 0.7840) — different head, same
features, same split. Treat sub-pp differences between them as noise. **species9 macro-F1 of 0.5451
is the number that matters most and it is low**: the species task is where the small model is weak.

### Arm B, output distillation (`B_kd`) — negative, and a stronger negative than the prior report

Teacher is a **trained** MLP probe on the H/14 embeddings (genus val accuracy 0.9282, test macro-F1
0.9113), not the shipped zero-shot head. Its posterior is nowhere near one-hot, so this is not the
badly-scaled teacher the prior negative was about.

genus4, val macro-F1: α=0 → **0.7711**; α=0.3, T=1 → 0.7664; α=0.5, T=1 → 0.7604; α=0.7 → 0.7615;
α=1.0, T=4 → 0.7419. Monotone down in α, and temperature only makes it worse (0.7664 → 0.7543 →
0.7532 at T=1/2/4). **Soft targets do not help even from a well-scaled teacher.**

### Arm D, √-balanced sampling — no effect worth having

genus4, val-selected: class weighting p=0.5 on the linear head gives test macro-F1 0.7820 against
0.7753 at p=0 (+0.67 pp, inside noise for this n and this probe); resampled minibatches on the MLP
head give 0.7709 against 0.7711. **Do not adopt on this evidence.**

### Arm B, capacity — the MLP head is worse than the linear one

Across hidden size {256, 512, 1024}, dropout {0.1, 0.2, 0.3} and both weighting and resampling, no
MLP configuration beat the linear probe on genus4 (best val 0.7711 vs 0.7932). The 21M features are
already close to their linear ceiling on 3,759 rows. This is the context every other arm sits in:
**adding readout capacity does not help, so a distillation arm has to add information, not capacity.**

### Arm B, partial fine-tune — **the one positive signal, not yet resolved**

Last 25% of the backbone (54 of 213 tensors, 9.89M params) plus a 592k head, lr 1e-5 (backbone) /
1e-4 (head), bs 16. Val macro-F1 on genus4:

| epoch | `ce` | `ce_fd` (λ=0.5, cosine to the H/14 embedding through a 1152→1024 projection) |
|---|---|---|
| 1 | 0.7626 | 0.7588 |
| 2 (first run, discarded by the scoring bug) | **0.8005** | **0.8028** |
| frozen-feature linear probe | 0.7932 | 0.7932 |

Both arms cross above the frozen probe at epoch 2, and the feature-distilled arm is ahead. **This is
not yet a result**: the 2-epoch run was lost to the bug in §4, epoch 1 of the 4-epoch rerun
reproduced it exactly (0.7626 / 0.7588, bit-identical, so the seed is stable), and epochs 2–4 are
still running. Test has **not** been read for the fine-tune arms yet, so there is no test number
and no CI.

## 3. What I concluded, and how firmly

- **Output distillation is dead, confidently.** Two independent experiments, two different
  teachers, one shipped zero-shot and one trained, both negative and monotone in α. A linear-probe
  student cannot be taught from a posterior; that negative is now closed properly rather than
  narrowly.
- **√-balanced sampling: no.** Too small to call either way at this n; it should not change any
  other arm's conclusion, and it did not.
- **Extra readout capacity: no.** Consistent across 18 MLP configurations.
- **Moving the representation: unresolved, mildly promising.** The 2-epoch evidence is +0.7 pp and
  +1.0 pp val macro-F1 over the frozen probe, which is within the range of a seed's worth of noise.
  It needs the 4-epoch test number before anyone quotes it.
- **The species task is the real problem.** species9 macro-F1 0.5451 against genus4 0.7840 on the
  same features and the same probe. Nothing in this directory has yet attacked that gap directly.

## 4. Traps, with the exact error

1. **Test scoring indexed the wrong array and lost a 22-minute run.**
   `IndexError: index 1252 is out of bounds for axis 0 with size 1252` at
   `ft[tr].astype(np.float64)` — `ft` held only the test features, indexed with global train
   indices. Fixed, and `ft_backbone.py` now snapshots the head every epoch
   (`{tag}_{arm}_ep{n}.pt`) and scores test **only** for the val-selected epoch. The original also
   had the subtler bug of scoring test from the *final* weights while reporting a val-*selected*
   epoch; the snapshot fixes that too. Keep the snapshots — a 2 MB file is cheaper than 22 minutes.
2. **`.venv/bin/python` has no `numpy` for about 10 seconds after `uv pip install` reports success.**
   `ls` of `site-packages` showed 12 entries while `uv pip list` showed numpy 2.5.3 installed. If an
   import fails right after an install, re-run it; do not reinstall.
3. **TorchScript cannot take hooks.** `register_forward_hook` on a `RecursiveScriptModule` raises
   `RuntimeError: register_forward_hook is not supported on ScriptModules`. To reach the 1152-d
   feature you must walk the graph by hand: `head.2(head.1(head.0(backbone(x))))`. See §5.
4. **`getattr(m, '0')`, not `m.0`** — `'0'` is not a valid Python identifier so `m.0` is a
   `SyntaxError`, not a `NameError`.
5. **`np.random.Generator.choice` rejects probabilities that do not sum to 1** — renormalise the
   *drawn* vector (`pr = w[y]; pr /= pr.sum()`), not the class table.
6. **`timm` is not a drop-in for the release**, though it is very close: `tiny_vit_21m_224` matches
   **213 of 213** backbone tensors after stripping the `model.` prefix, but its `attention_biases`
   are a **49/196/49** token grid in the release against **144/576/144** in timm's 224 config, so
   `load_state_dict` raises on ten keys. All 213 shapes match; only the attention geometry differs.
   This is why the fine-tune trains tensors rather than LoRA adapters.
7. **Use the TorchScript release, not a re-implementation.** Its forward reproduces the cached ONNX
   features at **cosine 1.000000** on every row checked, so the fine-tuned model and the cached
   features are the same representation. That equivalence is the thing to preserve.

## 5. What is unfinished, and the next concrete step for each

**Arm A/B partial fine-tune — the decisive strand.** Two jobs are mid-epoch-1 of 4. Let them run;
`grep -E "ep[0-9]|TEST" ft_ce_genus4.log ft_ce_fd_genus4.log`. Each epoch is ~11 min alone, ~17 min
under contention. When they finish, `ftce_genus4.json` / `ftfd_genus4.json` carry the val-selected
test macro-F1, balanced accuracy, per-class recall, the backbone drift norm, and a **linear probe on
the moved feature** (`test_linear_probe_on_moved_feature`) which is the honest read on whether the
*representation* improved, separate from the from-scratch head. Then repeat on `species9`
(`--tasks species9`), which is where the headroom is.

**Arm A, feature distillation, on frozen features.** The `lam` sweep in `run_cached.py` never
reached — the sweep died in the KD stage's last configs when I restarted it. It will run after
genus4 finishes. **Do not skip it**: it is the cheapest test of whether matching the teacher's
penultimate feature helps at all, and it is the arm the prior negative explicitly does not cover.

**Arms species9 and aedes4 on cached features.** Not started. Straightforward — the driver loops
over `["genus4", "species9", "aedes4"]`.

**Arm E, augmentation.** Extraction is **done**: `cache/aug_{rot_p10,rot_p20,blur_r1,blur_r2,
contrast,brightness,crop_rrc,hflip,downres,identity,union,hflip_s2}.npy`, each (3759, 1152) float32,
train rows only, seed 20261003, 3,032 s wall, 0.807 s per row for all 12 views at 4 threads
(0.007 s decode, 0.598 s inference). `e-augment/aug_results.json` currently holds **baselines only** —
`arms` is an empty dict. So arm E is **extraction-complete and measurement-pending**, which is the
best possible state to inherit: the expensive part is banked. The next step is to run
`e-augment/arms.py` to fill in the per-transform table. The `hflip_s2` cache is the second independent
view needed for the 1-view-vs-2-views question, and `identity` + `union` are the weak/strong pair
arm C needs.

**Full fine-tune (`--frac 1.0`).** Measured 0.80 s/img fwd+bwd at 4 threads, ~50 min/epoch. Long
but the coordinator has cleared multi-hour runs, and this is the strongest version of the arm that
shows a positive signal. Worth it once the partial run has told you which direction to push.

**Paired bootstrap CIs.** `common.paired_boot_scalar(y, pa, pb, fn)` is written and unused. Every
delta quoted above is a point estimate on 1,252 rows; **none of them has a CI yet**. That is the
single biggest gap in this handoff — do it before quoting any delta.

**Arm C (teacher on fresh views).** Not started. Needs the `identity`/`union` caches, which exist.
The full FixMatch variant with an EMA teacher recomputed per step does not fit on CPU; the
cached-strong-view version does.

**Outgroup / "does not call a non-mosquito a mosquito".** **Not measured at all, and the corpus
cannot measure it** — all 6,264 rows are mosquitoes. I looked: `36-negatives/photos` is empty, and
`03-inat/raw/` holds GBIF JSON but no downloaded images. Any claim about mosquito-vs-nuisance
rejection needs an image pool that does not exist here yet.

## 6. Would continuing be worth it?

**Yes, and the reason is specific.** Three of the five arms (B-kd, D, capacity) are cleanly negative
and should not be revisited. But two things are open and both are cheap relative to what has already
been spent: the 4-epoch partial fine-tune is ~35 minutes from a test number on the only arm that has
ever moved in the right direction, and the feature-distillation `lam` sweep on frozen features has
never run. The banked augmentation caches turn a 50-minute extraction into a minutes-long
measurement.

The single most valuable thing a fresh agent can do first is put a **CI on the fine-tune delta**,
because +0.7 pp on 1,252 rows may be nothing, and "moving the representation helps" should not enter
anyone's notes until it is known.

Off-box: `distill_portable.py` is self-contained — corpus TSV, backbone, teacher embeddings and all
hyper-parameters are CLI arguments, `--device mps|cpu|cuda`. An MLX-native port would need the
original Keras source or a CoreML conversion of the ONNX, since the release ships TorchScript and
Keras, neither of which MLX loads.

## 7. Ledger

`95-future-work-ledger.md` in this directory. Per the coordinator's 18:24 update it is **stale and
needs revising**: entries 1–5 were written when I believed CPU time was prohibitive. Only entry 1
(LoRA) is a genuine structural impossibility; the rest are now just slow, which is permitted.
