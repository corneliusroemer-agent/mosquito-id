# 86 - Can a geographic / seasonal prior be benchmarked on our corpus?

**Verdict: no. Not on the current 6,264-row corpus, and not with any image model.** Half the
species-label entropy is readable from the `country` string alone; a prior with no image at all
scores **88.8%** on the Aedes 4-way task against the shipped image model's **79.8%**. The prior
beats the image, so every fused number is uninterpretable. This is a corpus-design result, not a
model result, and it does not depend on which encoder is used — TaxaBind, CLIP or the shipped
H/14 head all sit behind the same prior.

Scripts: `investigations/2026-10-03-rewrite/40-precision/60-geographic-prior/`
(`tables.py`, `prior_only.py`, `image_only_baseline.py`, `fuse_and_control.py`, `controls.py`),
artefacts in `.../60-geographic-prior/cache/`. Split: stratified by `group_key`, seed 0, 60/20/20,
fitted on TRAIN, scored on VAL/TEST — the `40-calibration/calibrate.py` recipe. Embeddings are the
existing fp32 H/14 cache; `analysis_int8_scale.json` was not touched.

## The two tables

`cache/label_x_country.tsv` — species x country, all 6,264 rows. The Aedes subset (2,757 rows)
is the part that matters:

| country | n (Aedes rows) | aegypti | albopictus | japonicus | koreicus |
|---|---|---|---|---|---|
| Austria | 697 | 0 | 326 | 370 | 1 |
| Spain | 230 | 6 | 192 | 32 | 0 |
| Hungary | 164 | 0 | 9 | 59 | 96 |
| Italy | 104 | 0 | 84 | 5 | 15 |
| Mexico | 380 | 380 | 0 | 0 | 0 |
| United States | 421 | 421 | 0 | 0 | 0 |
| Argentina | 54 | 54 | 0 | 0 | 0 |
| Uruguay | 44 | 44 | 0 | 0 | 0 |

**70 of the 79 countries that carry any Aedes row carry exactly one species.** The USA contains no
albopictus and no japonicus; Austria contains no aegypti; Mexico, Argentina and Uruguay are
100% aegypti. This is not an ecological curiosity — it is what happens when a country is harvested
for a target species. The four rows above that do mix are the four countries the harvest targeted
for more than one species, and even there the majority is 59–96%.

`cache/source_x_country.tsv` — source x country. `mosquito_alert_api` (2,866 rows) is
overwhelmingly European; `gbif` (3,172) is global. **MI(country; source) = 0.875 bits = 72% of the
source's entire entropy**, against MI(country; species) = 1.248 bits. A "geographic prior" keyed on
country is substantially a source detector: knowing someone is in Austria tells you the row is a
MosquitoAlert citizen-science submission.

**MI(country; species) = 1.248 bits out of H(species) = 2.55 bits — 49% of the label is in the
country field.** 27.8% of Aedes test rows sit in a `country|month` cell that is ≥95% one species in
the training split.

## Timestamps are recoverable — and that turns out to be the second problem

`rows.tsv` has no time column, but `06-aegypti-data/manifest.csv` carries `event_date`/`year` and
joins to every row on `local_path` (6,264/6,264 matched). Coverage: MosquitoAlert API 2,866/2,866,
MA dump 187/187, gbif 3,055/3,172, commons 24/39. **A seasonal prior is therefore not
data-blocked** — the axis exists.

It is blocked by the harvest (`cache/temporal_spread.tsv`):

| species | n | distinct years | top year | share of rows | distinct days |
|---|---|---|---|---|---|
| Aedes aegypti | 1446 | 25 | 2020 | 22% | 854 |
| **Aedes albopictus** | **658** | 9 | **2026** | **98%** | **87** |
| Aedes japonicus | 541 | 10 | 2023 | 25% | 387 |
| Aedes koreicus | 112 | 7 | 2022 | 47% | 92 |
| Anopheles | 1383 | 58 | 2025 | 16% | 951 |
| Culex | 651 | 10 | 2024 | 55% | 405 |
| Culiseta | 1473 | 35 | 2021 | 26% | 1014 |

Aedes albopictus — the taxon a European geographic prior exists to help with — is 98% August/
September 2026, 87 distinct days. albopictus month-of-year is 314 in August and 283 in September
against ≤6 in every other month. That looks exactly like a species that peaks in late summer, and it
is equally exactly what a single download batch looks like. **The corpus cannot distinguish the
two**, and only the taxon where the two are indistinguishable is the one the prior is for.

## Prior alone, image alone, fused (TEST split)

| task | prior alone (no image) | image only | fused (w=1) |
|---|---|---|---|
| Aedes species 4-way (n=554) | **88.81%** | 79.78% | 89.17% |
| Genus 4-way (n=1257) | 66.98% | 90.21% | 71.68% |
| Aedes vs rest (n=1257) | 80.43% | 96.5% | — |

Country alone, hard argmax, no month: Aedes 4-way 48.4%, genus 4-way 64.8%, Aedes-vs-rest 79.6%
(against majority baselines of 23.5 / 44.0 / 56.0). With smoothed `country|month` and backoff the
Aedes prior alone reaches 88.81%.

Per-class, Aedes 4-way — the gain is entirely two buckets:

| class | n | image | fused | delta |
|---|---|---|---|---|
| Aedes aegypti | 290 | 82.1% | 98.6% | +16.6pp |
| Aedes albopictus | 132 | 92.4% | 91.7% | −0.8pp |
| Aedes japonicus | 109 | 64.2% | 63.3% | −0.9pp |
| Aedes koreicus | 23 | 52.2% | 78.3% | +26.1pp |
| **total** | **554** | **79.78%** | **89.17%** | **+9.39pp** |

Fused genus 4-way **loses 18.5pp** (90.21 → 71.68), almost all of it on the three non-Aedes genera
(Culex −38.9pp, Culiseta −25.1pp, Anopheles −16.2pp). The prior is not weak help at genus level; at
genus level it is actively harmful, because it is confidently wrong wherever the country was
harvested for something else.

## The two controls that settle it

**Prior-shift.** Replace every European row's prior with the pooled non-European prior — a
deliberately wrong prior. Fused Aedes 4-way falls 89.17% → **52.71%**. The prior genuinely fires, so
the fused number is not one of the byte-identical no-ops from the last Europe-prior attempt.

**Within-country label permutation.** Shuffle the species labels of the Aedes rows *inside each
country* (seed 1). This destroys every real geography↔species relation while leaving the per-country
class counts intact. Fused Aedes 4-way still reaches **84.66%** against image-only 79.78% — 84% of
the +9.39pp "gain" survives having removed the geography entirely.

So the fused improvement is reproducible from the corpus's per-country class histogram alone. That
histogram is a record of what we chose to download, not of mosquito ecology. There is no weighting,
temperature or encoder that makes this number mean anything.

## TaxaBind

Not the blocker. `MVRL/taxabind-vit-b-16` is public and ungated (`hf api … gated=false private=false`,
siblings include `open_clip_pytorch_model.bin` + tokenizer), so it could have been run. It was not,
because the confound is upstream of the encoder: swapping the image model changes the 79.78% image-only
number and leaves the 88.81% prior-alone number exactly where it is. A *weaker* image model would
make the benchmark more confounded, not less, so running TaxaBind cannot rescue it. If the corpus
is fixed (below), the right first run is TaxaBind image-only on the same split with its own
OpenCLIP text tower — never against the 1024-d H/14 `text_embeds.json`, which would be a dimension
mismatch rather than a result.

## What would make this benchmarkable

Both defects are in how the corpus was built, and both are fixable at the sampling stage:

1. **Decorrelate country from label.** Stratified sampling — a fixed number of images per species
   per country — makes P(label | country) close to uniform by construction, so a prior has to be
   right about ecology rather than about what we happened to fetch. The current corpus fails this
   by 49% of label entropy; it needs to fail by near zero.
2. **Date the collection, not the upload.** `event_date` from MosquitoAlert is when the citizen
   photographed the mosquito, which is fine, but the harvest then concentrated 98% of one species
   inside one August–September window. Sampling across the year fixes it; more careful curation of
   the same download will not.
3. **Record provenance at row level** so `source` can be held out as a control, or read alongside
   country (they are 72% mutually informative as it stands).

A fourth, weaker point: even fixed, a prior benchmark needs an image model weak enough that there
is headroom. At 90.2% genus and 96.5% on the Aedes gate, the shipped head leaves the prior nothing
to add — a fused prior that cannot move a number is not a result either, in the other direction.

## Artefacts

- `cache/label_x_country.tsv`, `cache/source_x_country.tsv` — the two confounding tables
- `cache/month_coverage.tsv` — timestamp coverage by source and country
- `cache/temporal_spread.tsv` — the harvest-window collapse per species
- `cache/rows_joined.tsv` — `rows.tsv` + `event_date`/`month`/`year`, 0 unmatched
- `cache/controls.log` — prior-alone, per-class, shift and permutation controls
