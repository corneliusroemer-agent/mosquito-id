# 04 — Local models: culico-net + BioCLIP family on CPU

Driving scripts (all in `04-local-models/scripts/`): `run_cls.py` (culico-net-cls over the 12-image set, routes `torchscript|onnx`, thread-count arg), `run_cls_fastai_asshipped.py` (fastai route as shipped), `run_det.py` (YOLO11n detector), `run_bioclip.py` (zero-shot BioCLIP/2/2.5 over the fixed 14-species list), `export_bioclip_onnx.py` + `bioclip_onnx_serve.py` (ONNX-export feasibility), `validate_preproc.py` (bit-exactness check), `aggregate.py` (specimen-level majority). Raw per-image JSON: `04-local-models/data/*.json`; annotated detector frames: `04-local-models/data/det/predict/`. Everything CPU-only on the arm64 box (16 cores, 27 GB RAM, no docker); venv = `04-local-models/.venv`.

Input set: 10 auto-cropped body images (`02-images/crops/`) + 2 scutum/head zooms (`02-images/scutum/`) of one dead specimen (Basel, 2026-10-02). Caveat up front: `182741226_head.jpg` is mostly blank paper — the mosquito sits at the bottom edge — so its per-image votes are noise. `182720758_head.jpg` is a good close-up but a tilted, near-lateral view, not a dorsal scutum shot.

## 1. Which loading route worked

**culico-net-cls-v1** (`iloncka/culico-net-cls-v1`, TinyViT-21M, 224 px, 18 classes, Apache-2.0, train split 16,580 images). Repo ships `.pkl` (fastai), `.pt` (TorchScript), `.onnx` — and no `config.json`, so the transformers pipeline route is out.

- **fastai `load_learner` on the `.pkl`: loads only with fastai < 2.8** (installed 2.7.19). fastai 2.8+ fails at unpickle: the pickle references `fastcore.transform.Pipeline`, which moved to the `fasttransform` package — fastai raises `Downgrade to fastai<2.8.0`. So the brief's route (1) works, but with a pin.
- **The `.pkl` carries NO resize transform** — `dls.after_item` is just `ToTensor`, `after_batch` is `/255` + ImageNet-normalize. The training data (16,580 images) must already be 224×224. Consequence: `learn.predict()` on a real photo feeds the **full-size image (1400×859) into a 224-trained net** and returns `class_background` with p≈1.0 on every single image (see `data/cls_fastai_asshipped.json`). The library-as-shipped route is not just slow, it is wrong for any input larger than 224 px. You must resize to 224 yourself.
- **`.pt` is a self-contained TorchScript module** — the best non-fastai artifact. Load with `torch.jit.load`, no fastai, no timm, no vocab file needed at runtime (but the class order is the pickle's `dls.vocab`, extracted once into `run_cls.py`).
- **`.onnx` (85 MB) runs in onnxruntime** unchanged — this is the best serving artifact. Input `input.1` [1,3,224,224] (static batch), output 18 logits (no softmax).
- Preprocessing replicated by hand: bilinear **squish-resize to 224×224**, `/255`, mean (0.485, 0.456, 0.406), std (0.229, 0.224, 0.225). Verified bit-exact against fastai's own 224-resized path: input tensors and logits differ by **0.0** (`validate_preproc.py`). The timm route (2) and culicidaelab route (3) were not needed — TorchScript/ONNX dominate them for serving — but culicidaelab's docs confirm this model family as their default classifiers.

**culico-net-det-v1** (`...-nano.pt`, YOLO11n, 5.4 MB, **AGPL-3.0**): `ultralytics.YOLO(path)` just works. Classes: `{0: aegypti, 1: albopictus, 2: culiseta, 3: japonicus-koreicus}`.

**BioCLIP family** via `open_clip.create_model_and_transforms('hf-hub:imageomics/bioclip[-2|-2.5-vith14]')`: all three load and run out of the box with open_clip 3.3.0 (params 150 M / 428 M / 986 M). Zero-shot against the fixed 14-specimen candidate list with 3 prompt templates per species ("a photograph of {s}.", "a mosquito of the species {s}.", "{s}, family Culicidae."), template-averaged, softmax over `logit_scale · cos`.

## 2. What each model predicted (one specimen, 12 views)

Top-1 per image (probability in parentheses). Body crops first, scutum zooms last; "majority" = top-1 votes across the 10 body crops.

| image | culico-net-cls (18 sp.) | BioCLIP B/16 | BioCLIP 2 B/16 | BioCLIP 2.5 H/14 |
|---|---|---|---|---|
| IMG-20261002-WA0007 | class_background (0.998) | Aedes vexans (0.941) | Aedes albopictus (0.800) | Aedes albopictus (0.965) |
| PXL_…182523087 | anopheles_arabiensis (0.973) | Aedes albopictus (0.677) | Aedes albopictus (0.684) | Aedes albopictus (0.996) |
| PXL_…182614990 | anopheles_arabiensis (0.924) | Aedes albopictus (0.300) | Aedes koreicus (0.464) | Aedes albopictus (0.970) |
| PXL_…182628741 | class_background (1.000) | Aedes aegypti (0.939) | Culex pipiens (0.583) | Culex pipiens (0.567) |
| PXL_…182632161 | anopheles_arabiensis (0.852) | Aedes albopictus (0.579) | Aedes koreicus (0.238) | Aedes japonicus (0.598) |
| PXL_…182639488 | anopheles_arabiensis (0.996) | Aedes vexans (0.679) | Aedes albopictus (0.374) | Aedes albopictus (0.968) |
| PXL_…182720758 | aedes_triseriatus (0.932) | Aedes vexans (0.491) | Aedes koreicus (0.476) | Aedes albopictus (0.957) |
| PXL_…182737596 | aedes_albopictus (0.877) | Aedes vexans (0.984) | Aedes albopictus (0.530) | Aedes albopictus (0.916) |
| PXL_…182741226 | anopheles_sinensis (0.451) | Aedes vexans (0.932) | Aedes albopictus (0.675) | Aedes albopictus (0.941) |
| PXL_…182754446 | culiseta_annulata (0.399) | Aedes vexans (0.594) | Aedes koreicus (0.878) | Aedes koreicus (0.524) |
| 182720758_head | aedes_geniculatus (0.656) | Aedes vexans (0.588) | Aedes albopictus (0.760) | Aedes albopictus (0.727) |
| 182741226_head ⚠ blank | anopheles_sinensis (0.965) | Aedes albopictus (0.697) | Aedes koreicus (0.384) | Aedes aegypti (0.899) |

**Majority across the 10 body crops:**

| model | majority view |
|---|---|
| culico-net-cls | *anopheles_arabiensis* ×4 (mean p 0.94), class_background ×2, then 4 singles — **no coherent answer, and its confident guess is a non-European Anopheles** |
| BioCLIP B/16 | *Aedes vexans* ×5 (mean p 0.83), *Ae. albopictus* ×4 |
| BioCLIP 2 B/16 | *Ae. albopictus* ×5 (mean p 0.61), *Ae. koreicus* ×4 |
| BioCLIP 2.5 H/14 | ***Ae. albopictus* ×7 (mean p 0.96)**, then pipiens/japonicus/koreicus ×1 each |

Only BioCLIP 2.5 produces both coherence across crops and high confidence, and its answer fits what is visible in the crops (black body, white abdominal spot rows, banded legs — an "tiger mosquito" Aedes pattern) and Basel's known established *Ae. albopictus* population. One specimen is an anecdote, not an accuracy benchmark — but the *inconsistency* of culico-net-cls across crops of the same specimen (six different classes over 12 views, all but two with p>0.85) is measurable here and disqualifying for single-image use. The YOLO detector found and boxed the mosquito in 2 of 3 full frames (0.87 conf), calling it `aegypti` — genus-level "Aedes" is the trustworthy part of that; aegypti is not established in Switzerland.

## 3. Serving numbers (CPU, arm64, 16 cores)

Peak RSS from `/usr/bin/time -v`; latency medians over 11 warm images after one cold image; disk = weights on disk (HF cache measured with `du -shL`).

| model / route | disk | load (s) | text embed, one-time (s) | median s/img @16 thr | best s/img | peak RSS |
|---|---|---|---|---|---|---|
| culico-net-cls, fastai `.pkl` as-shipped | 99 MB | 3.5 | — | 0.6–1.15 (and wrong) | — | 1.88 GB |
| culico-net-cls, TorchScript `.pt` | 87 MB | 0.8 | — | 0.144 | — | 673 MB |
| **culico-net-cls, ONNX f32, 8 threads** | **85 MB** | **0.15** | — | 0.100 @16 thr | **0.026 (≈38 img/s)** | **280 MB** |
| culico-net-det, ultralytics YOLO11n @1600 px | 5.4 MB | 0.04 (first frame 1.1–1.5) | — | 0.38/frame | — | 763 MB |
| BioCLIP B/16, torch | 571 MB | 3.2 | 0.45 | 0.157 | 0.061 (ORT image tower) | 1.72 GB (torch) / 649 MB (ORT-only) |
| BioCLIP 2 B/16, torch | 1.6 GB | 5.3 | 1.24 | 0.408 | — | 2.86 GB |
| BioCLIP 2.5 H/14, torch | 3.7 GB | 4.8 | 2.87 | 0.604 | — | 8.30 GB |

Thread scaling matters more than expected (culico-net-cls ONNX, s/img): 1 thr 0.110 · 2 thr 0.061 · 4 thr 0.038 · **8 thr 0.026** · 16 thr 0.100 — the full 16-core box is *slower* than 8 threads for the small model. Pin `intra_op_num_threads` (onnxruntime) / `torch.set_num_threads`; do not serve at "all cores".

**ONNX export feasibility: established, cheap.** culico-net-cls already ships ONNX. BioCLIP's image tower exports with one `torch.onnx.export` call (opset 17, needs the small `onnx` package): 1.0 s export, 345 MB f32, cosine parity 1.000000 vs torch, 53–61 ms/img at 8 threads. Since text embeddings are computed once at startup against your candidate list, request-time serving needs the image tower only — no torch, no open_clip, no transformers (see `bioclip_onnx_serve.py`: onnxruntime + numpy + PIL). BioCLIP 2 / 2.5 image towers were not exported but have the same architecture shape; cost expected similar per GB.

## 4. Verdict: hostable as a public API on this box?

Yes for all of them — the question is which one deserves the RAM.

- **Cheapest useful service:** culico-net-cls ONNX. 85 MB disk, 280 MB RSS, 26 ms/image at 8 threads on one process — a single 1-core-ish container serves ~38 identifications/s. But it is the *least correct* model here (scattered crops, `class_background` fires on real mosquitoes, non-European species at p>0.9). Hostable, not trustworthy as a sole identifier; its own ecosystem (culicidaelab) treats it as one component of a pipeline, behind a detector/segmenter.
- **Detector:** trivial to host (5.4 MB, 0.38 s/frame at 1600 px) and genuinely useful as the stage that finds the mosquito and gives a genus hint. Two license flags for a public API: the detector weights are **AGPL-3.0** (the classifier is Apache-2.0 — mixed licensing within the same HF author), and `ultralytics` itself is AGPL-3.0.
- **Best accuracy per second: BioCLIP 2.5 H/14.** 0.60 s/image warm and 8.3 GB RSS in plain fp32 torch — comfortably hostable on 27 GB, ~1.7 identifications/s per process, and it was the only model whose answers were both coherent and plausible. fp16 or an ONNX-exported image tower would roughly halve the RAM (not measured).
- **Sweet spot architecture** (what I would actually serve): text tower offline; image tower of BioCLIP 2.5 (accuracy) or BioCLIP B/16 (cost) as ONNX in onnxruntime, plus the 5.4 MB YOLO in front to reject non-mosquito images and provide crops. All-CPU, no docker needed, single venv.

## 5. Traps hit (all reproducible, all silent or confusing)

1. fastai ≥ 2.8 cannot unpickle the shipped `.pkl` at all (`fastcore.transform.Pipeline` moved to `fasttransform`) — pin `fastai<2.8` (2.7.19 works).
2. The `.pkl` has **no resize transform**: `learn.predict()` sends full-size photos (1400×859) into the 224-trained net and returns `class_background` p≈1.0 for every image. Any pipeline copying "just call predict" (including the culicidaelab quickstart path) silently produces garbage on real photos.
3. `torch.set_num_threads(0)` raises — 0 is not "default" (use no call at all).
4. uv venv has no `pip`; install with `uv pip install --python .venv/bin/python`.
5. `ultralytics` needs `cv2` → `opencv-python` wants `libGL.so.1` (absent here) → install `opencv-python-headless`. Do it in one step (`--reinstall`) — installing headless over regular then uninstalling regular deletes the shared `cv2/` files and breaks the venv.
6. ultralytics resolves `project=` against its global `runs_dir`, not the cwd — annotated output landed in `/workspaces/claude-devcontainer/runs/` until I passed an absolute path.
7. `du -sh` on HF model dirs shows KB because of the blob/symlink layout — use `du -shL`.
8. The HF `hf download --local-dir` copies are real files (85+99+87 MB for cls), while `.cache/huggingface` holds the BioCLIP blobs (571 MB / 1.6 GB / 3.7 GB).

## 6. Artefacts

- `04-local-models/scripts/` — the seven scripts named above (reproducible end-to-end; total runtime ~2 min excluding model downloads).
- `04-local-models/data/` — `cls_torchscript.json`, `cls_onnx.json` (8-thread canonical), `cls_fastai_asshipped.json`, `bioclip.json`, `bioclip2.json`, `bioclip25.json`, `aggregate_summary.json`, `det/det_results.json`, `det/predict/*.jpg` (3 annotated frames).
- `04-local-models/models/` — culico-net weights (cls onnx/pt/pkl, det pt) and `bioclip_visual_b16.onnx` (345 MB, the exported image tower).
