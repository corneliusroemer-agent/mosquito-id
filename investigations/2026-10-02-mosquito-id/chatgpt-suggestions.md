Goal: identify mosquito species from ordinary photographs, preferably through an API or a model that an agent can run locally. Target use includes European/Swiss mosquitoes, so useful taxa include *Culex pipiens*, *Culiseta annulata*, *Aedes japonicus*, *Aedes koreicus*, *Aedes albopictus*, etc.

## Recommended stack

### 1. Kindwise Insect.id — easiest purpose-built HTTP API

This is probably the best first thing to test.

- Product: `insect.id` by Kindwise
- REST API specifically for insect/terrestrial-invertebrate image identification.
- >14,000 taxa.
- Returns ranked suggestions with probabilities.
- Accepts multiple images of one specimen.
- Can accept location/time, which can improve classification.
- Provides taxonomy, GBIF ID and iNaturalist taxon ID.
- Has a Python SDK (`kindwise-api-client`) as well as plain REST.
- Images can be submitted as base64 or URL.
- Web demo permits 10 identifications/month.
- Commercial service/API key required for programmatic use.
- Vendor reports 92% of queries have the correct identification in the top 3. Treat this as vendor-reported rather than independent validation.

Example:

```python
from kindwise import InsectApi

api = InsectApi(API_KEY)

r = api.identify(
    "mosquito.jpg",
    details=["gbif_id", "inaturalist_id", "taxonomy"],
)

for x in r.result.classification.suggestions:
    print(x.name, x.probability)
```

Their underlying REST pattern is also documented publicly:

```http
POST https://insect.kindwise.com/api/v1/identification
Api-Key: ...
Content-Type: application/json

{
  "images": ["<base64>"],
  "similar_images": true
}
```

The example repository demonstrates this exact interface.

Useful links:
- Kindwise insect.id: https://www.kindwise.com/insect-id
- API docs: https://insect.kindwise.com/docs
- examples: https://github.com/flowerchecker/insect-id-examples

For an agent, I would query this first and retain at least the top 5 predictions rather than taking top-1.

---

### 2. BioCLIP 2.5 Huge — strongest open local model I found

Current model:

`imageomics/bioclip-2.5-vith14`

This is a general biological vision-language model rather than a mosquito-specific classifier. It is particularly attractive because the agent can supply its own candidate species list.

- Fully downloadable from Hugging Face.
- MIT licensed.
- OpenCLIP interface.
- ViT-H/14.
- Trained on an expanded TreeOfLife-200M dataset lineage.
- Zero-shot classification against arbitrary taxonomic names.
- No external API is required.
- Excellent fit for an M-series Mac if PyTorch/MPS handles the model comfortably; CPU inference is also possible but slower.

https://huggingface.co/imageomics/bioclip-2.5-vith14

Basic loading:

```python
import open_clip

model, _, preprocess = open_clip.create_model_and_transforms(
    "hf-hub:imageomics/bioclip-2.5-vith14"
)
tokenizer = open_clip.get_tokenizer(
    "hf-hub:imageomics/bioclip-2.5-vith14"
)
```

The important trick is **do not ask it to classify against every species on Earth**.

Construct a plausible candidate set such as:

```python
species = [
    "Culiseta annulata",
    "Culiseta morsitans",
    "Culex pipiens",
    "Culex torrentium",
    "Aedes japonicus",
    "Aedes koreicus",
    "Aedes albopictus",
    "Aedes vexans",
    ...
]
```

Then calculate image/text similarities. Also test hierarchical prompts:

```text
a photograph of Culiseta annulata
a mosquito of the species Culiseta annulata
Culiseta annulata, family Culicidae
```

and average prompt embeddings.

BioCLIP 2.5's general benchmarks are substantially better than previous BioCLIP versions. On the two Meta-Album insect classification benchmarks, reported zero-shot top-1 accuracies are:

| model | Insects | Insects 2 |
|---|---:|---:|
| BioCLIP | 34.9% | 20.5% |
| BioCLIP 2 | 55.3% | 27.7% |
| **BioCLIP 2.5 Huge** | **68.2%** | **30.8%** |

These are generic insect benchmarks rather than mosquitoes specifically.

BioCLIP 2.5 is therefore the open model I would test first.

Original BioCLIP remains useful if the H/14 model is inconvenient:

`imageomics/bioclip`

It is ViT-B/16, much smaller, trained on TreeOfLife-10M (>450k taxa).

BioCLIP 2 is the middle option:

`imageomics/bioclip-2`

It is also open and was trained on about 214 million biological images spanning roughly 952k taxa.

---

### 3. Build a geographic prior with iNaturalist and/or GBIF

This is likely to improve BioCLIP substantially.

The useful part of iNaturalist for an agent is its biodiversity database/API rather than its proprietary CV classifier.

Use observations to answer:

> Which Culicidae have actually been recorded around Basel / Switzerland / neighbouring regions?

Then use those taxa as BioCLIP candidates and potentially use observation frequency as a weak prior.

iNaturalist API:
https://api.inaturalist.org/v1/

It can query observations by:
- taxon
- place
- coordinates/bounding box
- quality grade
- date
- etc.

iNaturalist recommends roughly ≤1 request/s and around 10k requests/day.

The observation search supports geographic filtering and taxonomic filtering.

GBIF is another good source:

https://api.gbif.org/v1/occurrence/search

Its Occurrence API is fully documented with OpenAPI and can retrieve species observations by taxon/geography.

Possible agent architecture:

```text
location
   ↓
iNaturalist + GBIF
   ↓
candidate Culicidae list
   ↓
BioCLIP 2.5 image/candidate similarities
   ↓
combine with occurrence prior
```

Do not make the geographic prior too strong: rare invasive species are exactly the cases where identification may be interesting.

---

### 4. iNaturalist itself

iNaturalist has an excellent CV classifier, but its current full classifier is **not exposed as a supported image-identification API**.

Its normal API is excellent for:
- observations
- taxa
- geographic priors
- uploading observations
- retrieving human/community identifications.

The full current species model remains private. iNaturalist releases only small models covering roughly 500 taxa for testing/on-device applications.

Therefore:

```text
image → iNaturalist API → AI suggestions
```

is not currently a supported workflow.

One could programmatically create an iNaturalist observation and later retrieve human identifications. That is useful as an asynchronous expert/community validation channel, but not as immediate model inference.

API:
https://www.inaturalist.org/pages/api+reference

---

### 5. CulicidaeLab / culico-net — useful specialist model

Hugging Face:

`iloncka/culico-net-cls-v1`

https://huggingface.co/iloncka/culico-net-cls-v1

- TinyViT, ~21M parameters.
- 224×224.
- Local inference through `transformers`, `timm`, or fastai.
- Apache-2.0.
- Training dataset has about 18k images.
- Purpose-built mosquito classifier.

Very easy:

```python
from transformers import pipeline

clf = pipeline(
    "image-classification",
    model="iloncka/culico-net-cls-v1",
)

print(clf("mosquito.jpg", top_k=10))
```

There is also:

`iloncka/culico-net-det-v1`

https://huggingface.co/iloncka/culico-net-det-v1

YOLO11n detector with four output categories:

- *Aedes aegypti*
- *Aedes albopictus*
- *Culiseta*
- *Aedes japonicus/koreicus*

Model is only ~5.4 MB.

This model is particularly relevant to a possible *Culiseta* specimen, but note that its `Culiseta` prediction is genus-level and `japonicus/koreicus` is deliberately merged.

There is also a mosquito-specific SAM2 segmentation model:

`iloncka/culico-net-segm-v1-nano`

Useful if one wants to extract the insect before sending the crop to another classifier.

Potential pipeline:

```text
raw photo
  ↓
culico-net segmentation/detection
  ↓
tight mosquito crop
  ↓
BioCLIP 2.5
```

This may reduce background/domain effects.

---

### 6. MosquitoDL — older but properly published/reproducible

GitHub:

https://github.com/jypark1994/MosquitoDL

Dataset:
- about 3,600 images
- eight mosquito species
- deliberately includes different poses and damaged specimens

The paper/repository reports >97% classification accuracy after transfer learning and augmentation.

Main limitation: narrow species/geographic domain. It should be regarded as a benchmark/research implementation rather than a universal mosquito identifier.

---

### 7. German mosquito wing classifier / BALROG

Repository:

https://github.com/KNolte19/MosquitoWingClassifier_publication

This one is scientifically interesting because it targets mosquitoes in a European context.

- Code and data are public.
- Main models cover 21 mosquito species.
- Uses wing images rather than arbitrary phone photos.
- Includes explicit robustness experiments.
- Associated work examines limitations/domain robustness.
- Hosted BALROG demo exists, although the repo says access is password-protected.

For a difficult specimen, photographing an isolated wing under magnification and running this may give stronger species-level evidence than whole-body classifiers.

A newer related project from the same group is:

https://github.com/KNolte19/ITHILDIN

It performs:
- insect-wing segmentation
- landmark detection
- classification
- geometric morphometrics

and is actively under development.

This is worth investigating if the agent can work from microscope/macro wing images.

---

### 8. Other GitHub mosquito classifiers

There are numerous YOLO/Flask/student projects. Most are lower priority.

One representative model reports:

- six classes
- 946 images
- precision 0.545
- recall 0.674
- mAP@0.5 0.644
- Culiseta precision only 0.375
- japonicus/koreicus precision 0.253

So it provides a useful warning about how hard realistic mosquito identification is.

An Alberta-specific PyTorch project includes model weights and a Flask app:

https://github.com/AHZR199/Mosquito-Species-Identification-Model

Potentially useful if Canadian species overlap, but lower priority for European material.

---

## Audio identification

For live mosquitoes, flight audio is another modality.

BioDCASE 2026 ran a dedicated **Cross-Domain Mosquito Species Classification** challenge with 271,380 recordings from nine mosquito species. Data, baseline code and checkpoints are public.

https://biodcase.github.io/challenge2026/task5
https://github.com/Yuanbo2020/CD-MSC

Species include:
- *Aedes aegypti*
- *Aedes albopictus*
- *Culex quinquefasciatus*
- *Culex pipiens*
- several *Anopheles*

The major lesson is domain shift: baseline balanced accuracy was ~0.88 on seen domains but only ~0.18 on unseen domains. This is unusually good evidence that headline mosquito-classifier accuracy can collapse when acquisition conditions change.

Not useful for a dead specimen, but highly relevant to any future automated trap.

---

## Recommended agent strategy

For each specimen:

1. Keep all original photographs.
2. Detect/segment the mosquito and make several crops.
3. Query **Kindwise insect.id** with 3–5 complementary images and location.
4. Use **iNaturalist + GBIF APIs** to construct a geographic candidate list of Culicidae.
5. Run **BioCLIP 2.5 Huge** locally against that candidate list.
6. Run `culico-net-cls-v1` and, where applicable, `culico-net-det-v1`.
7. Ask a capable multimodal LLM to inspect explicit morphological characters rather than merely naming a species.
8. Compare all outputs.
9. Report probabilities/rankings rather than collapsing immediately to one answer.
10. If species-level identification remains ambiguous, identify which anatomical view is needed next: dorsal thorax, lateral abdomen, tarsi, wing venation/scales, palps, or genitalia.
11. Optionally upload to iNaturalist to get community/expert identification.

A sensible evidence structure would be:

```json
{
  "kindwise": {
    "top_candidates": []
  },
  "bioclip_2_5": {
    "candidate_set": [],
    "scores": []
  },
  "culico_net": {},
  "geographic_prior": {
    "inat": {},
    "gbif": {}
  },
  "morphological_analysis": {
    "observed_characters": [],
    "diagnostic_characters_missing": []
  },
  "consensus": {
    "family": null,
    "genus": null,
    "species": null,
    "confidence": null,
    "alternatives": []
  }
}
```

## What I would test first

For ordinary phone/macro photographs:

```text
Kindwise insect.id
        +
BioCLIP 2.5 Huge
        +
iNaturalist/GBIF geographic candidate set
        +
culico-net
```

These are complementary:

- **Kindwise:** purpose-built hosted insect classifier.
- **BioCLIP 2.5:** strongest-looking open general biological model and lets us control the candidate set.
- **iNat/GBIF:** strong geographic/ecological prior.
- **culico-net:** mosquito-specific independent classifier.

The interesting experiment is to run all four on the same mosquito photos and inspect whether *Culiseta annulata* emerges independently.