## Goal

Investigate vision models for mosquito species identification, with emphasis on:

1. strong general biological/species-recognition models,
2. insect-specific foundation models,
3. mosquito-specific classifiers,
4. very small models suitable for browser-side inference,
5. combinations of models that give better uncertainty estimates than any individual model.

The eventual target is a static web app that can work entirely client-side, with no inference server.

Do not optimize only for raw top-1 accuracy. We care about:
- accuracy on genuinely independent mosquito photographs,
- calibration / knowing when the model is uncertain,
- genus/family accuracy when species-level identification is impossible,
- robustness to segmentation/cropping/background,
- model size and browser deployability,
- useful disagreement between independently trained models.

## Existing context

We already have a mosquito benchmark pipeline. BioCLIP embeddings / zero-shot classification have been tested.

Important observation from previous experiments:
- BioCLIP-style models can work surprisingly well.
- A domain-specific classifier could be much smaller.
- Ground-truth/test leakage and augmented variants of the same source image are major concerns for mosquito datasets.
- An independent tiny model may be useful even if its standalone accuracy is below the large model, because disagreement can help detect uncertain predictions.

The core idea to investigate is therefore:

> Use one relatively strong generalist or insect model as the main classifier, while running one or more tiny independently trained mosquito/insect models alongside it. Use agreement, margins, embedding distances, and taxonomy consistency to estimate confidence.

## Models to investigate

### 1. BioCLIP family

Test at least:

- `imageomics/bioclip`
  - original BioCLIP
  - ViT-B/16
  - roughly 86M parameters for the image tower
  - useful compact general-biology baseline

- BioCLIP 2 if straightforward to obtain

- `imageomics/bioclip-2.5-vith14`
  - current large high-performing reference model
  - likely too large for browser deployment
  - useful as an approximate upper bound / teacher

For our fixed mosquito species list, do not assume the text encoder needs to ship.

Experiment with:

1. precompute text embeddings for every candidate taxon,
2. retain only image encoder at deployment,
3. compare:
   - raw species names,
   - scientific names,
   - `a photograph of <species>`,
   - descriptions containing genus/family,
   - multiple prompts averaged per species.

Also investigate prototype classification:
- generate image embeddings for known reference specimens,
- classify queries using nearest prototypes / class centroids,
- compare against text zero-shot classification.

This could be much better for mosquitoes because species labels contain little morphological information.

### 2. TaxaBind

Model:
- `MVRL/taxabind-vit-b-16`

Test it similarly to BioCLIP.

Interesting extra angle:
TaxaBind supports ecological/location information.

For mosquitoes, geographic priors may be extremely informative.

Explore a clean separation between:

```text
visual likelihood
× geographic prior
× seasonal prior
```

Do not let geography conceal poor visual classification. Report image-only results separately.

### 3. Insect-Foundation

Find and download the model from the Insect-Foundation project associated with:

> Insect-Foundation: A Foundation Model and Large-scale 1M Dataset for Visual Insect Understanding

Approximately ViT-B/16 / 85M parameters.

This is a high-priority experiment because its representation was trained specifically for fine-grained insect morphology.

Try:
- frozen embeddings + nearest centroid,
- k-NN,
- logistic regression / linear probe,
- possibly small MLP probe if enough training images exist.

Compare directly against BioCLIP embeddings on exactly the same splits.

### 4. BIOSCAN-trained models

High priority:

- `birder-project/rdnet_t_ibot-bioscan5m`
  - RDNet-T
  - ~22.8M parameters
  - self-supervised on BIOSCAN-5M

Also inspect:
- `birder-project/vit_b16_ls_franca-bioscan5m`
- other BIOSCAN-5M pretrained Birder models if there are newer/smaller/better ones.

The 22.8M RDNet is especially attractive.

Again test:
- frozen embeddings,
- nearest-centroid/prototype classifier,
- logistic regression,
- linear probe.

Important caveat:
BIOSCAN imagery may consist mainly of standardized specimen photographs and may differ strongly from arbitrary phone photographs of mosquitoes.

Measure this explicitly rather than assuming transfer will work.

### 5. CulicidaeLab mosquito models

Investigate the Hugging Face user/project:

- `iloncka`

Start with:
- `iloncka/culico-net-cls-v1`
  - TinyViT
  - ~21.2M parameters
  - ONNX checkpoint available
  - 17-species classifier

Also inspect the collection:

> mosquito-classification-17-top-5

Especially find the PVTv2-B0 model:
- reportedly ~3.4M parameters

Other architectures reportedly include:
- EVA02-Tiny
- ConvNeXtV2-Pico
- CoAtNet-Nano
- TinyViT

Download all sufficiently small candidates if easy.

Do not trust the reported >90% accuracy without independent testing.

Check exactly how their train/test split was generated.

In particular determine whether:
- rotations/crops/segmentations derived from one original photo can occur across train/test,
- multiple near-duplicate images of one specimen occur across splits,
- backgrounds were synthetically modified,
- test images correspond to the deployment domain.

Our benchmark must use source-photo-level grouping wherever possible.

## Search for additional models

Search Hugging Face, GitHub and recent literature for:

```text
insect foundation model
insect image embedding model
insect species classification pretrained
mosquito species classifier
mosquito classification ONNX
mosquito TinyViT
Culicidae classifier
BIOSCAN pretrained model
iNaturalist pretrained model
species recognition foundation model
fine grained biological image classification
```

Also look for very small generalist models trained on:
- iNaturalist,
- Observation.org,
- iNaturalist/OpenImages hybrids,
- BIOSCAN,
- insect museum collections.

Interesting architectures include:
- MobileNetV3
- EfficientNet-Lite
- MobileViT
- TinyViT
- FastViT
- EfficientFormer
- EdgeNeXt
- ConvNeXt Pico/Nano
- PVTv2-B0

Prioritize models under:
- 5M params,
- 25M params,
- 100M params.

## Generalist models

Also test whether ordinary general-purpose vision encoders give useful mosquito representations.

Potential candidates:
- DINOv2
- DINOv3 if available
- SigLIP / SigLIP2
- OpenCLIP
- EVA
- modern small self-supervised ViTs

Do not run every huge model.

Pick a few representative models with strong general visual embeddings.

The important experiment is:

> Does a generic embedding + mosquito-specific linear/prototype head outperform biological zero-shot classification?

It may.

Fine-grained recognition often benefits from a good generic representation once the class boundary is learned from examples.

## Classification approaches to compare

For each suitable encoder, calculate embeddings once and evaluate several cheap heads.

### A. Text zero-shot

For CLIP-like models:

```text
image embedding ↔ species text embedding
```

### B. Reference-image prototypes

For each species:

```text
prototype_species = mean(reference image embeddings)
```

Then cosine similarity.

Also try multiple prototypes per species using clustering.

### C. k-nearest neighbours

Try:
- k=1
- k=3
- k=5
- distance-weighted voting

### D. Logistic regression

Frozen embeddings + multinomial logistic regression.

This is an important baseline and likely very strong.

Use regularization selected only on training/validation data.

### E. Hierarchical classification

Predict:

```text
family → genus → species
```

or derive these levels from species scores.

Record accuracy at each taxonomic level.

For a UI, saying:

> definitely Culicidae, probably Aedes, species uncertain

is much more useful than simply giving a low-confidence wrong species.

## Segmentation and crops

Evaluate every major model under at least:

1. original image,
2. mosquito crop,
3. segmented mosquito on neutral background,
4. optionally crop + some surrounding context.

Do not assume segmentation helps.

Some models may use context beneficially; others may be harmed by background.

For multi-photo user submissions, also evaluate aggregation across images.

Possible aggregation rules:
- average logits,
- average normalized embeddings,
- product of probabilities,
- majority vote,
- max evidence per morphological region.

## Ensemble / independent verification

This is one of the main things to investigate.

Suppose:

```text
large model = BioCLIP / Insect-Foundation
small model = 3.4M mosquito PVTv2
```

Even when the small model has lower top-1 accuracy, disagreement may strongly predict errors.

Calculate features such as:

```text
large_top1
small_top1
same_genus
same_species
large_margin
small_margin
large_entropy
small_entropy
embedding_distance_to_nearest_class
embedding_distance_to_second_class
```

Then ask:

> Conditional on these signals, how often is the primary prediction correct?

Examples worth measuring:

```text
P(correct | both models agree)
P(correct | models disagree)
P(correct | agree at genus but not species)
P(correct | primary margin > x)
P(correct | primary and tiny model both high confidence)
```

A tiny model that is only 80–85% accurate could be extremely useful if:

```text
large + tiny agree → 97–99% correct
large + tiny disagree → flag as uncertain
```

This is more useful than simply averaging their logits.

## Diversity matters

Try to choose ensemble members with genuinely different training histories.

Ideal:

```text
BioCLIP
    broad taxonomic image-text training

BIOSCAN encoder
    barcode-linked insect specimen imagery

CulicidaeLab tiny classifier
    mosquito-specific supervised training
```

Errors may be less correlated than between three architectures trained on the same dataset.

Measure error correlation explicitly.

For each pair calculate:
- fraction both correct,
- fraction only A correct,
- fraction only B correct,
- fraction both wrong,
- conditional correctness under agreement,
- Cohen's kappa or similar agreement statistic if useful.

## Out-of-distribution detection

This matters a lot for a real app.

Include negatives such as:
- non-mosquito flies,
- crane flies,
- midges,
- moth flies,
- other insects,
- spiders,
- bad/blurry images,
- empty backgrounds.

Test whether models can distinguish:

```text
known mosquito species
unknown mosquito species
non-mosquito
unidentifiable image
```

Potential signals:
- distance from class prototypes,
- low maximum similarity,
- high entropy,
- disagreement between models,
- inconsistent taxonomic predictions.

Do not normalize a 17-class classifier into always claiming one of 17 mosquitoes without an OOD check.

## Calibration

Measure:
- reliability curves,
- Expected Calibration Error,
- Brier score,
- selective accuracy / risk-coverage curves.

Risk-coverage is particularly useful.

For example report:

```text
coverage   accuracy among accepted predictions
100%       ...
90%        ...
75%        ...
50%        ...
```

This tells us whether the app can safely say:

> I can't identify this one.

Also calculate these curves using ensemble disagreement as the rejection signal.

## Benchmark hygiene

This is critical.

Ensure splitting happens at the original-photo / specimen level.

Avoid leakage from:
- augmented copies,
- rotations,
- segmentation variants,
- different crops,
- duplicate uploads,
- near-identical frames.

Where source grouping is uncertain, use perceptual hashing or embedding similarity to inspect possible duplicates.

Have one final test set that is never used for:
- selecting models,
- choosing prompts,
- selecting thresholds,
- tuning probes,
- choosing ensemble rules.

Prefer genuinely external photographs where possible.

## Browser deployment

For promising models determine:

- parameter count,
- FP32 size,
- FP16 size,
- INT8 size,
- ONNX availability,
- ONNX export success,
- ONNX Runtime Web compatibility,
- WebGPU compatibility,
- input resolution,
- inference time.

Especially benchmark:

```text
PVTv2-B0 mosquito
RDNet-T BIOSCAN
TinyViT mosquito
BioCLIP ViT-B image tower
```

If feasible, quantize promising models to INT8.

A few-MB verification model running alongside a ~100 MB main encoder is entirely acceptable.

## Potential final architecture

A plausible design to evaluate is:

```text
image
  │
  ├── segmentation / mosquito crop
  │
  ├── main biological/insect encoder
  │      └── prototype or linear species classifier
  │
  └── tiny mosquito classifier
         └── independent prediction
```

Then:

```text
main prediction
+ tiny-model agreement
+ taxonomic consistency
+ prototype distance
+ multi-image consistency
        ↓
confidence / abstention
```

Optionally add geographic priors afterwards.

Example UX:

```text
Aedes geniculatus
confidence: high

Why:
- main model strongly favours A. geniculatus
- independent mosquito model agrees
- all submitted photos agree
- nearest alternative is substantially farther away
```

versus:

```text
Likely Aedes
species uncertain

The two classifiers disagree between
A. geniculatus and A. japonicus.
```

## Deliverables

Produce:

### 1. Model inventory

A machine-readable table, preferably CSV/JSON/Markdown, containing:

```text
model
HF/repository URL
training dataset
architecture
parameters
checkpoint size
input size
biology/insect/mosquito specialization
zero-shot capable
embedding capable
ONNX available
license
browser-deployment notes
```

### 2. Benchmark results

For every model/pipeline:

```text
top1 species accuracy
top3
genus accuracy
family accuracy
macro F1
per-species accuracy
calibration
model size
inference speed
```

### 3. Embedding comparison

For embedding models compare:

```text
zero-shot text
nearest centroid
kNN
logistic regression
```

### 4. Ensemble analysis

At minimum compare:

```text
best large model alone
best tiny model alone
large + tiny agreement/rejection
large + second independent encoder
```

Report selective accuracy / coverage.

### 5. Recommendation

Identify:

- best raw-accuracy model,
- best <100 MB model,
- best <25M-param model,
- best ~5M-param model,
- best embedding model,
- best independent verifier,
- best practical browser ensemble.

Base conclusions on our independent test data rather than published headline accuracy.

## Priority order

Do the experiments roughly in this order:

1. Get CulicidaeLab PVTv2-B0 working.
2. Get BIOSCAN RDNet-T embeddings.
3. Get Insect-Foundation embeddings.
4. Compare them against existing BioCLIP embeddings.
5. Train identical logistic-regression/prototype heads.
6. Measure pairwise disagreement and selective accuracy.
7. Add generic DINO/SigLIP-style embeddings only if they remain competitive or add useful diversity.
8. Test ONNX/browser deployment for the winners.

The central question is not simply "which model has the highest accuracy?"

The useful question is:

> What is the smallest combination of independently trained models that gives high species accuracy and reliably recognizes when the evidence is insufficient?