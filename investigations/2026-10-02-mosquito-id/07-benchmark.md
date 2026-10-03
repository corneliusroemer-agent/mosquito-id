# 07 — Classifier benchmark: which model actually identifies European mosquitoes on labelled photos?

Driving script: `07-benchmark/scripts/run_all.sh` (stages idempotent; each runnable standalone; venv `../04-local-models/.venv` reused, nothing reinstalled).

**Question.** Which candidate model best identifies European mosquito species on labelled benchmark images (top-1/top-3), under different crop pipelines? This decides the cascade's classifier tier.

**Answer in one paragraph.** On the benchmark that matches deployment — 112 real European citizen-science phone photos (Mosquito Alert 2023) — BioCLIP 2.5 (ViT-H/14) image tower zero-shot is clearly the strongest classifier: **84.8% top-1 / 93.8% top-3 on detector crops** (89.3/96.4 with ground-truth crops). BioCLIP-2 (L/14) is second (75.9/95.5). **BioCLIP B/16 collapses on real photos** (26.8/68.8; culiseta 5% top-1) — the cheap tier 04 suggested as a cost option does not survive contact with the actual domain. culico-net-cls confirms its 04 verdict: in-domain champion (89.7% on its own CulicidaeLab test split) but unusable out-of-domain (13–32% on real photos). Detector crop quality is the accuracy bottleneck below IoU≈0.5, and a second segmenter (SAM2) does **not** fix it: tightening boxes leaves accuracy flat (−0.9 pt) because the failures are detector misses/wrong-object boxes, which SAM inherits. Crop pipeline to ship: **YOLO det crop → classifier** (as-is frames lose ~4 pt for 2.5 and are catastrophic for B/16/culico; segm adds 0.8 s/img for nothing).

## 1. Benchmark composition (180 images, ~340 MB on disk)

| arm | source | n | classes (GT) | domain | license |
|---|---|---|---|---|---|
| primary | [mosquito-alert/ai-mosquito-alert-challenge-2023](https://huggingface.co/datasets/mosquito-alert/ai-mosquito-alert-challenge-2023) | 112 | albopictus 28, culex (genus) 28, culiseta (genus) 22, japonicus-koreicus 22, aegypti 6 (out-of-region control), anopheles 6 (control) | real European phone photos, median frame 1926×2253, median GT-bbox coverage 8.5% of frame area | CC-BY-NC-SA-4.0 (non-commercial; fine for benchmarking + a non-commercial tool — flag before any commercial use) |
| secondary | [iloncka/mosquito-species-classification-dataset](https://huggingface.co/datasets/iloncka/mosquito-species-classification-dataset) test split | 68 | 7 European species × 8: albopictus, koreicus, geniculatus, vexans, pipiens, annulata, longiareolata + quinquefasciatus/aegypti × 6 | lab-reared colony images, 224×224 **pre-segmented mask-blended composites** (not raw photos) | CC-BY-SA-4.0 |

Selection: `fetch_mosquito_alert.py` samples stratified by class × bbox-coverage quartile (seed 7) and downloads **only** those members via HTTP range requests into the remote zip (116 MB pulled of a 10.4 GB archive, 1m50s). CulicidaeLab carved from the 20 MB test parquet. Both subsets reproducible via `data/mosquito_alert/subset.csv` / `data/culicidaelab/subset.csv`.

Domain honesty, stated up front: Mosquito Alert labels are expert-moderated citizen science (I hit at least one phone *screenshot* with a "Favorite" heart UI inside the aegypti class — real-world mess is in the GT); CulicidaeLab is synthetic-looking 224 px composites from colony specimens, so it double-samples the easy domain — and its 89.7% culico-net-cls score is **in-lineage** (that model trained on the sibling train split), i.e. a ceiling estimate for a dedicated classifier, not evidence of generalisation. Neither arm is a Swiss field test; koreicus exists only as n=8 (CulicidaeLab) and inside the merged japonicus-koreicus class (MA).

## 2. Setup

Four crop pipelines per image (all crops on disk under `07-benchmark/data/crops/`): **asis** = dataset image as fed in; **det** = culico-net-det-v1-nano (YOLO11n, imgsz 1600) box crop — the deployment shape (full frame → detect → crop); **segm** = culico-net-segm-v1-nano (SAM 2.1 Hiera-Tiny) box-prompted on the full frame, crop to mask bbox; **gt** = ground-truth bbox crop (MA only; oracle ceiling). Detector misses fall back to the as-is image (10/180).

Zero-shot prompt set: 16 candidate species (04's 14 + Culex quinquefasciatus + Anopheles plumbeus) × 3 templates + 8 nuisance prompts (person, hand, wall, fly, butterfly, moth, plant, empty background), template-averaged, softmax over `logit_scale · cos` jointly over species+nuisance. Scoring happens in a shared **scored-class space** (albopictus, aegypti, japonicus-koreicus, culex, culiseta, anopheles, vexans, geniculatus, other-mosquito, nuisance) so genus-level MA labels and species-level CL labels are comparable and japonicus/koreicus merge exactly as the benchmark and the field demand (topic 03: pipiens/torrentium not photo-separable). culico-net-cls is scored in the same space through its own 18-class head. Per-image predictions: `results/predictions_long.tsv`.

## 3. Main results

**Mosquito Alert, n=112 (the deployment-domain number):** top-1/top-3 %

| model | asis | det | segm | gt (oracle) |
|---|---|---|---|---|
| BioCLIP 2.5 H/14 (torch, fp32) | 81.2 / 95.5 | **84.8 / 93.8** | 83.9 / 93.8 | 89.3 / 96.4 |
| BioCLIP-2 L/14 | 74.1 / 97.3 | 75.9 / 95.5 | 73.2 / 93.8 | 76.8 / 98.2 |
| BioCLIP B/16 (ONNX tower) | 32.1 / 67.9 | 26.8 / 68.8 | 28.6 / 67.0 | 31.2 / 73.2 |
| culico-net-cls (ONNX, footnote arm) | 13.4 / 46.4 | 29.5 / 52.7 | 26.8 / 59.8 | 32.1 / 60.7 |

**CulicidaeLab, n=68 (lab composites; culico row is in-lineage):**

| model | asis | det | segm |
|---|---|---|---|
| BioCLIP 2.5 H/14 | 55.9 / 80.9 | 17.6 / 45.6 | 19.1 / 38.2 |
| BioCLIP-2 L/14 | 39.7 / 69.1 | 16.2 / 51.5 | 22.1 / 52.9 |
| BioCLIP B/16 | 19.1 / 45.6 | 8.8 / 27.9 | 7.4 / 22.1 |
| culico-net-cls | **89.7 / 100.0** | 19.1 / 57.4 | 17.6 / 48.5 |

Sampling error: n=112 means ±~7 pt at 95% for the MA top-1 figures; treat <5 pt differences as noise (the tables are in `results/scores_per_model_pipeline.tsv` + pivots `main_table_*.tsv`).

## 4. Crop pipelines: what actually matters

- **Detector quality is the bottleneck.** YOLO found the mosquito in 170/180 images; on MA, box IoU vs GT: median 0.77, but **27.5% of boxes sit below IoU 0.5** (15 below 0.3). Accuracy tracks it: bioclip-2.5 top-1 on det crops is 46% where IoU<0.3, 87% at 0.3–0.5, 91–95% above 0.5. A bad box still *confidently* wrong: misplaced boxes scored up to 0.89 detector confidence, so a confidence gate alone won't catch them.
- **Feeding full frames is worse than cropping for every model except the already-weak B/16** (2.5: 81→85 asis→det; the asis penalty concentrates in frames where the mosquito is <2% of frame area).
- **SAM2 segm does not pay for itself.** It tightens boxes (mask-bbox IoU vs det box 0.81; smaller than det box in 57% of cases) yet accuracy is flat-to-worse (2.5 MA: 84.8→83.9; CL 17.6→19.1, noise). Because its prompt IS the det box, SAM inherits wrong-object boxes (the heart-icon screenshot, the blank-wall anopheles). +0.80 s/img (CPU, measured) for no accuracy — skip in v1; revisit only if the detector is replaced with something stronger.
- **GT-crop ceiling is +4.5 pt over det for 2.5** (89.3 vs 84.8) — the det→classify chain recovers most of what a perfect crop would give.

## 5. Calibration and confusion

- **The nuisance head behaves like a broken-crop detector.** bioclip-2.5's nuisance wins on MA det crops are 2/112, and those two boxes had IoU≈0.02 with GT (median IoU 0.78 where a mosquito class wins). On CulicidaeLab det crops it fires 20/68 — correctly signalling that YOLO crops of 224 px composites are mutilated. B/16 fires nuisance 44× on MA det crops — it is not confident, it is lost.
- **The Basel-critical confusion is japonicus-koreicus → albopictus** (6 of 8 asis errors for 2.5; 3/5 with GT crops): on real photos the two Stegomyia-region lookalikes pull toward albopictus. culex (93–100%) and albopictus (89–96%) are the reliable classes; culiseta is crop-sensitive (77 asis → 95 with GT crops). aegypti and anopheles controls are n=6 each — aegypti confuses *into* albopictus (2–3 of 6), consistent with Stegomyia siblings being group-level, not species-level, reliable.
- koreicus alone (CulicidaeLab, n=8): only 2/8 correct for 2.5, errors scattered — species-level koreicus separation is not there zero-shot; the merged japonicus-koreicus class is the honest granularity (matches MA's label design and topic 03's list).
- BioCLIP-2's top-3 (95.5–98.2) edges 2.5's — its top-1 is lower but its ranked list is excellent; relevant if the cascade surfaces top-3 + prior to the user.

## 6. Which classifier tier — recommendation, not a ship call (no pre-registered bar; judge together)

| tier | accuracy (MA det) | cost/image CPU | RAM | disk | notes |
|---|---|---|---|---|---|
| culico-net-cls | 29.5% | 26–38 ms | 280 MB | 85 MB | footnote: in-domain only |
| BioCLIP B/16 (ONNX) | 26.8% | ~61 ms | 649 MB | 345 MB | cheap AND wrong on real photos — eliminated |
| BioCLIP-2 L/14 | 75.9% (top-3 95.5) | ~250 ms | 2.9 GB | 1.7 GB | best ranked-list; fp16/int8 ONNX untested |
| **BioCLIP 2.5 H/14** | **84.8%** (89.3 oracle-crop) | ~480 ms @8thr (0.60 @16thr, 04) | 8.3 GB | 3.7 GB | the accuracy tier; fp16/ONNX export untested (04 showed B/16 exports bit-exact; same route applies) |

I'd recommend: **YOLO det → BioCLIP 2.5 zero-shot + nuisance gate + topic-03 weak geographic prior**, accepting 0.86 s and ~9 GB per identification process; BioCLIP-2 as the budget variant if RAM forces it (−9 pt top-1, similar top-3). B/16 should not serve this task despite its cost sheet. Full chain with SAM2 (1.7 s) is strictly dominated. No fine-tuned head exists yet; a phase-2 **linear probe on the MA train split (10,357 images)** is cheap: one-off embed ≈ 83 min CPU at 2.5's 0.48 s/img (≈25 min across 3 parallel processes; ≈10 min with B/16), logistic-regression training <1 min, serving cost identical to zero-shot — and it is the obvious first lever against the japonicus/albopictus pull. Doing so keeps MA's non-commercial license attached to the resulting artifact.

## 7. Basel specimen side table (qualitative — NO ground truth, excluded from all accuracy numbers)

`results/basel_side_table.tsv` + `results/predictions_with_basel.tsv`. Under the benchmark prompt set on the 10 body crops as-is, BioCLIP 2.5 says **albopictus 7/10** (p 0.91–1.00), japonicus-koreicus 2/10, culex 1/10 — coherent with 04 and with Basel's established albopictus. Caveat the chain exposes: when YOLO *re-crops* those same already-tight crops (the deployment path for user photos), 4/10 flip to **Aedes aegypti top-1** with albopictus second — crop perturbation alone moves Stegomyia species calls (and aegypti is ECDC-Absent within 100 km, topic 03). Consequence for the cascade: treat species output inside Stegomyia as group-level and let the weak geographic prior arbitrate; don't over-trust a single crop's species label.

## 8. Deliverables for the human eye

- **Contact sheets** (24 stratified benchmark images; labels carry det conf, IoU vs GT, mask/det area ratio):
  - `07-benchmark/results/sheets/crops_quality_grid.jpg` — one row per image: as-is | YOLO det | SAM2 segm | GT bbox
  - `sheet_asis.jpg`, `sheet_det.jpg`, `sheet_segm.jpg`, `sheet_gt.jpg` — per-pipeline grids
- **HF-Space test pack** (`07-benchmark/results/testpack/`, 4.2 MB): 10 labelled MA images (2 each albopictus/culex/culiseta/japonicus-koreicus + 1 aegypti + 1 anopheles, downscaled to ≤1600 px) + the 10 Basel crops + `expected-labels.tsv` (file, expected species, bbox present y/n).

## 9. Traps hit (all reproducible)

1. **pandas 3.0**: `df['a'] = df.b = None` silently skips the attribute-form target — column `b` never appears. Assign separately.
2. **SAM2/hydra**: `build_sam2()` only resolves config names inside the pip package (`configs/sam2.1/sam2.1_hiera_t.yaml`); an absolute path to the downloaded yaml dies in hydra's search path.
3. **culico-net-cls ONNX has a static batch of 1** (the BioCLIP B/16 tower export used dynamic batch) — batched feeds fail with a dimension error; run per-image.
4. Silently-wrong glob hardcoding: my embed stage listed pipelines as a fixed tuple, so a `segm`-only run matched nothing and exited 0 having done nothing. Discover pipeline dirs dynamically; assert counts.
5. Double-extension file naming (`<id>.jpeg.jpg`) broke basename joins twice (sheets + scoring); resolve to one canonical `.jpg` and strip exactly one extension when joining.
6. remotezip reads a 10.4 GB zip's central directory in ~2 s; member extraction ran at ~1 MB/s effective — 112 images in 1m50s, no full download.

## 10. Not done / limits

- kNN/linear-probe with birder-BIOSCAN or MA-trained heads: out of scope today, costed in §6.
- fp16/int8 or ONNX export of 2.5/2 (serving-cost lever, accuracy-neutral expected, untested).
- Prompt-set sensitivity not swept (single 3-template set, reused from 04 for comparability).
- n=112/68: fine for tier separation (the gaps are 30–55 pt), too small for <5 pt calls; aegypti/anopheles/koreicus cells are anecdotal.
- No Swiss-field test set exists in this investigation; the honest deployment claim is bounded by MA's domain (European citizen-science phone photos, expert-moderated labels).
