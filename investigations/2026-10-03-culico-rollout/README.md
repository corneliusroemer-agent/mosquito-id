# culico-net rollout

`HANDOFF.md` is the entry point: what is live, what is broken, and what to do
next. The scripts beside it are the ones that produced its numbers, each
standalone and runnable:

| Script | What it establishes |
|---|---|
| `build_onnx.py` | re-exports the released checkpoint with the 1152-d feature and the intercept column |
| `verify.py` | the export reproduces the cached features bit-exactly |
| `fit_probe.py` | fits the head and emits `text_embeds_culico.json` |
| `verify_app.py` | re-derives every shipped number from the head **file** via the app's arithmetic |
| `install_background.py` | puts the fitted background row into `adjacent_emb` |
| `verify_gate.py` | what the non-mosquito gate does on positives and negatives |
| `resweep.py` | background-row multiplier sweep with species recall reported |
| `pin_test.py` | the genus-row-vs-pinned-row trade that is the current defect |
| `parity.py` | offline cached features vs the exported ONNX, same photos |
| `sample_check.py` | the ten public sample photos through the real ONNX |
| `verdict_check.py` | species label counts and which head rows are untrained |

They import `common.py` from
`investigations/2026-10-03-rewrite/40-precision/99-calibration-ship/` and read the
feature cache from `.../95-distillation/culico_features.npy`. Run them under
`taskset -c 8-13 nice -n 10` — cores 0-6 belong to another job on this box.
