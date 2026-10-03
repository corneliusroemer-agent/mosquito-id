# Mosquito identification app handoff

Updated 2026-10-03, Europe/Zurich. Working directory: `/Users/cr/code/claude-devcontainer/investigations/2026-10-02-mosquito-id/08-space`.

## Checkpoint and scope

The app is useful and the user likes the current direction. Latest code checkpoint is `ab26c8d` (`Add full-photo fallback and manual mosquito crop selection`), pushed to `origin/master` in `https://github.com/corneliusroemer/claude-devcontainer`. Earlier UI, pooling, clipboard and logging changes are also pushed. This handoff was written after that checkpoint.

The git repository is the parent devcontainer repository. There are numerous unrelated modified/deleted/untracked files outside this project: do not stage or revert them. It is a whitelist repository; use explicit `git add -f` paths for new project files. Local scratch belongs in `./tmp`, not global `/tmp`. The current environment is the macOS host with zsh, not the Linux environment described in the generic parent instructions.

## Running and development

```sh
cd /Users/cr/code/claude-devcontainer/investigations/2026-10-02-mosquito-id/08-space
./run-mac-native.sh --dev
```

Open `http://127.0.0.1:7860`. Without `--dev`, the runner starts normal Python. The runner resolves dependencies together in `.venv-mac`, installs the custom gallery component editable, and automatically enables Hugging Face offline mode when the BioCLIP weights/config are cached. Set `HF_HUB_OFFLINE=0` explicitly to refresh. Never print credentials; the user authorized the HF token in the parent repo's `.secrets`, whose README explains access.

The dev server was left running. Check port 7860 before starting another instance. Persistent application logs are `tmp/mac-native.log`; they include decoding, detection, selected crop, classification timings, failures, batch completion and manual classification. Latest observed logs show a six-image clipboard batch delivered successfully with zero failures. Exit 143 during prior restarts was SIGTERM from intentional process termination, not an inference exception. Find the actual server PID and kill that PID if needed; avoid broad `pkill -f`.

Python edits reload through Gradio. Models live under `gr.NO_RELOAD` so reload should preserve expensive model loading. Rebuilding the custom frontend requires a server restart and browser refresh: Gradio can retain the old JS asset hash across Python reload. Do not repeatedly restart while the user is processing images.

See `space-gradio/gallery-component/README.md` for exact frontend build commands. Compiled JS/CSS are tracked, so ordinary startup requires no Node build.

## Current implementation

Main backend: `space-gradio/app_mac.py`. It runs BioCLIP 2.5 ViT-H/14 through PyTorch on MPS (CPU fallback), with an ONNX YOLO detector. Detector confidence threshold is 0.70. Ultralytics was removed from the Mac dependency path, resolving the earlier incompatible NumPy pins.

The frontend is Gradio plus a custom Svelte gallery, not React. Component source is `space-gradio/gallery-component/frontend/Index.svelte`; backend contract is `backend/gradio_mosquitogallery/widget.py`; compiled assets live under `backend/gradio_mosquitogallery/templates/component/`.

- One mode accepts one or more photos, ZIP uploads and pasted clipboard images; processing starts automatically. Samples work and their button disappears after loading.
- Top left is a compact, always-open file picker. Top right shows actual per-image progress while processing, then combined results. The two top cards have matching 280px height.
- The gallery stays full width below. Fixed-size horizontally scrolling thumbnails use crops when available. Thumbnail clicks and arrows select cached results entirely in the browser; they do not rerun inference.
- Thumbnail checkboxes select photos of the same mosquito for pooling. Uploads may contain different mosquitoes. There is no separate combine checkbox.
- Selected full photo, zoomed crop and species scores appear together. The results table/CSV and aggregation options are below the images. Empty lower panels are hidden before loading.
- Completed status cards, redundant selection controls, single/batch tabs, title/introduction and process button were removed at the user's request. Retain progress during processing, but leave no blank progress area afterward.
- Clipboard listener: `space-gradio/clipboard-upload.js`. It forwards pasted image files through the existing uploader, ignores editable fields and deduplicates listeners. The user confirmed pasting works.

## Cropping: latest changes and outstanding verification

Bad crops were real: the detector sometimes gives higher confidence to a leg than the whole mosquito, and sometimes detects nothing despite a clear insect.

Implemented in `ab26c8d`:

1. Prefer a larger accepted detection containing at least 90% of the highest-confidence box and having at least twice its area. Keep separate insects separate.
2. Classify the full photo when no detector box passes the threshold.
3. Retry the full photo when a detector crop is dominated by nuisance prompts. A confident partial crop can still evade this test.
4. Fit the whole crop into the encoder's 224px square with CLIP-mean padding, instead of centre-cropping away insect ends. This changes pretrained preprocessing and needs comparative evaluation.
5. Add full-photo override and a manual rectangle cropper inside the Svelte gallery. Only normalized rectangle coordinates go to Python, which crops the cached unannotated source and reclassifies that photo. Manual edits update gallery, pooled results, table and CSV.
6. Keep Gradio cached files for one day with hourly cleanup, instead of deleting after 30 seconds. Originals used for manual cropping are cached at a maximum dimension of 1600px.

The manual rectangle editor renders, but the final drag → Apply crop → updated classification/table/CSV flow has **not yet been verified end to end**. This is the first next step. Test full-photo override too, and preserve the user's browser session by using a separate test tab. An earlier full-photo override classified successfully; table/CSV synchronization was added subsequently.

Gradio ImageEditor failed with `background_image` initialization errors in this app, even with default tools. The custom rectangle selector avoids it. Details: `space-gradio/docs/crop-selection.md`.

Tests run successfully before committing:

```sh
.venv-mac/bin/python tmp/check_crop_selection.py
.venv-mac/bin/python tmp/check_pooling.py
.venv-mac/bin/python -m py_compile space-gradio/app_mac.py space-gradio/gallery-component/backend/gradio_mosquitogallery/widget.py
```

`tmp/check_pasted_images.py` exercised the three problematic clipboard photos through the live Gradio API. All produced crops/classification after fallback changes. One selected the larger body box, one used full-frame fallback, and one still chose a partial leg crop: manual correction remains necessary. `tmp/inspect_detector.py` records the boxes and confirms output decoding/class names are consistent. Scratch test scripts are local, not durable tracked tests.

## Aggregation and score interpretation

Default method is `Dependent evidence`. For each included, usable photo, retain full-precision scaled species cosine logits. Remove exact duplicate crops by SHA-256 of dimensions and pixels. Sum logits, then divide by `1 + (n - 1) * rho`, where default assumed correlation `rho = 0.5`. Independent accumulation (`rho = 0`) and legacy weighted/equal arithmetic means remain available for comparison.

This correlation discount is a sensitivity heuristic, not an estimated dependence model or a calibrated posterior. At rho=1 it becomes mean logits. **Adding neutral views can shrink score gaps**, because the denominator increases; the UI options explain this limitation. The user strongly disliked arithmetic averaging diluting good photographs, and later objected to independent products displaying near-100% confidence. Do not describe the current compromise as statistically established or validated.

Combined bars show relative log-score gaps against the strongest group on a fixed -20 to 0 axis, with no percent probabilities and no delta symbol. Candidates beyond the visible area can scroll; do not change the scale between clicks. The per-photo species panel still displays its model softmax percentages, which include nuisance mass and are not calibrated identification probabilities. This distinction may merit further UI review.

Species are pooled before grouping. Group scores use stable log-sum-exp over `COMPLEX_OF` members (e.g. japonicus/koreicus, pipiens/torrentium, annulata/morsitans). Albopictus and aegypti are singleton groups, so their species/group scores match.

Research and reviewer findings: `subagents/01-score-pooling.md`, UI review: `subagents/02-ui-review.md`, overview: `subagents/00-synthesis.md`. Some report descriptions predate the latest fixed log-axis rendering; implementation is authoritative. Main statistical finding: calibrated, conditionally independent posteriors can be multiplied with prior correction, but zero-shot BioCLIP logits and correlated views do not establish those assumptions. Geographic priors should enter once per specimen, not once per picture.

## User preferences to preserve

- Keep the interface compact, visual and useful to end users. Avoid implementation/status text taking space.
- Keep thumbnail inclusion checkboxes in the gallery, crops as thumbnails, full photo beside zoomed crop, and vertical ranked bars.
- Cache navigation; only explicit crop changes should trigger reclassification. Pool selection/settings should use cached logits.
- Results table below photos; technical aggregation explanation is an aside at the bottom.
- Ask for analysis before major redesigns. Do not replace the accepted UI with another framework merely to simplify development.
- The user previously requested adversarial reviewers and a pooling research subagent. Existing reports are available; no claim of unperformed review.

## Next steps, in order

1. Verify manual rectangle drawing and Apply crop end to end, including retained selection, original-coordinate alignment, updated table/CSV, errors and navigation without inference. Fix any concrete failures.
2. Evaluate whole-image padding and crop policy on representative photos; automatic cropping remains fallible. Consider detector threshold/box policies only with measurements.
3. Evaluate aggregation on labeled multi-view specimens, including duplicates, blurry views and contradictory views. Avoid choosing confidence parameters by appearance alone.
4. HF hosting is the proposed easiest deployment route. No Space was deployed and no plan purchased in this session. Adapt MPS to CUDA, package the gallery/assets/samples, add ZeroGPU decorators and test model loading/callback compatibility. PRO is $9/month; dedicated GPU hosting is billed separately. Current ZeroGPU docs describe shared GPUs, daily quotas and queues, and Gradio compatibility. Check current terms before spending money.
5. A smaller browser/WebGPU model is a possible offline/server-unavailable fallback, with the larger hosted model available online. Nothing is exported or benchmarked yet. The current Python app does not run through WebGPU; ONNX Runtime Web offers a possible export/runtime route, subject to operator compatibility, download size and memory limits.
6. Training/fine-tuning and geographic priors remain exploratory. User notices European photos often receiving Culex quinquefasciatus and asks about Mosquito Alert data. Start with frozen BioCLIP embeddings plus a small classifier, retain a general/zero-shot path, and split by entire report/specimen to avoid leakage. Hold out geography and time; evaluate tropical data separately. European validation cannot establish worldwide or unseen-species performance. No dataset download or training has been done here.

Useful authoritative references:

- https://huggingface.co/docs/hub/spaces-zerogpu
- https://huggingface.co/pricing
- https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html
- https://onnxruntime.ai/docs/tutorials/web/large-models.html
- https://www.mosquitoalert.com/en/mosquito-images-dataset/
- https://pmc.ncbi.nlm.nih.gov/articles/PMC9930537/

The pushed commit range was scanned with TruffleHog: 385 chunks, no verified or unverified secrets. Unrelated parent-repo changes remain untouched.
