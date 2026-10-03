# 06 — Aedes aegypti (and the other thin classes) training data: ceiling, harvest, manifest

Built 2026-10-03. Question: the Mosquito Alert challenge zip has 47 *Aedes aegypti* in a
10,357-image train split, and our own 112-image benchmark has 6. Is that a real scarcity of
the species, or an artefact of one sampled dataset?

**It is an artefact, and the real supply is 3–4 orders of magnitude larger than 47.** The
expert-validated ceiling for *A. aegypti* in Mosquito Alert is **188 reports** (not 47), and
across the six classes the challenge covers, Mosquito Alert's live API holds **70,108
expert-identified records** on its own. GBIF adds ~21,000 more images for *aegypti* alone.
This file records the ceiling numbers, the harvest, the verification, and the licence
position.

Everything on disk is in `06-aegypti-data/`: `images/`, `manifest.csv`, `scripts/`, `meta/`.
Host paths are `/Users/cr/code/claude-devcontainer/investigations/2026-10-03-precision/…`.

## The ceiling, per source

| class | Mosquito Alert API (expert) | GBIF (records w/ media) | Commons | total candidates |
|---|---|---|---|---|
| Aedes aegypti | **188** | 4,383 recs → 7,921 imgs | 35 | ~8,144 |
| Anopheles | **180** | 5,570 recs → 8,565 imgs | 92 | ~8,837 |
| Aedes albopictus | **47,116** | not harvested (see below) | 41 | 47,157+ |
| Culex | **19,907** | not harvested | 71 | 19,978+ |
| Aedes japonicus | **1,368** | not harvested | 11 | 1,379+ |
| Culiseta | **1,066** | 3,451 recs → 6,848 imgs | 43 | ~7,957+ |
| Aedes koreicus | **283** | not harvested | 0 | 283 |
| **total** | **70,108** | | **293** | |

MA numbers are the API's own `count` for a worldwide, all-time, positive-taxon query
(2026-10-03). GBIF numbers are what the licence × basis-of-record filter yields for
`taxon_key` at species or genus rank; they are *records*, and each record carries 1–8 images.

### The three numbers that matter

1. **MA *aegypti* is 188, not 47.** The frozen nightly dump holds **187**; the live API holds
   **188** — the extra one is a 2026-07-13 record from Portugal that postdates the dump's
   2026-02-24 freeze. So 187 was a *filter result*, not a supply limit, but it was close to
   the true expert ceiling: MA has only ever expert-identified 188 *aegypti* worldwide. **MA
   cannot supply aegypti volume at any level of effort.** It is ~1,300× smaller than the
   challenge's own albopictus class.
2. **The 47 was a European convenience slice.** MA's classification vocabulary is
   {albopictus, aegypti, none} — two species, and both are the *European* Stegomyia. The
   285,066 unclassified reports in the dump are `movelab_annotation: null` bite/site reports
   that were never put through the identification flow, not a hidden pool. MA's worldwide
   aegypti/albopictus ratio is ~1:250, and neither is rare where people actually photograph
   them.
3. **Anopheles exists on the platform; the dump could not show it.** 180 expert-identified
   records (114 genus, 53 *A. maculipennis* s.l., 13 *A. plumbeus*), 2021–2026, all
   `source: expert`. The dump's 3-value vocabulary was an artefact of the dump. The MA *webmap
   UI* cannot select Anopheles at all — it is silently absorbed into the "Other species"
   layer — so this is reachable only via the API.

## What was fetched

**32,155 images, 3.7 GB, 21,908 specimens** at the time of writing, from
`manifest.csv` (one row per image). Downloads were still running for MA albopictus and MA
Culex when this was written; re-run `scripts/build_manifest.py` for the final count.

| source | images | licence position |
|---|---|---|
| Mosquito Alert live API | 10,113 | **CC BY-NC-SA 4.0**, attribution to the Mosquito Alert Community required. NC: no commercial use. |
| GBIF (iNaturalist research grade + museum) | 21,358 | **CC0 1.0** 2,054 · **CC BY 4.0** 3,255 · **CC BY-NC 4.0** 16,004. Commercially usable subset = 5,309. |
| Wikimedia Commons | 39 | CC0 / PD / CC BY / CC BY-SA (per file, recorded). Share-alike applies to the BY-SA subset. |
| Mosquito Alert nightly dump (frozen) | 187 | same CC BY-NC-SA 4.0. Superseded by the API — kept as a cross-check. |

**Commercially clean total: ~5,348 images (16%)**, all from GBIF and Commons. The
commercially-usable ceiling is set by GBIF, not by MA: MA is NC by construction.

## Verification

`audit/AUDIT.md` has the method and the counts. I rendered random 24-cell contact sheets per
source (`scripts/contact_sheet.py`) and judged each cell by eye.

- **MA, 24 random *aegypti*: 24/24 contain a real mosquito, 0 look like *A. albopictus*.**
  Only ~6/24 are species-confirmable from the pixels (clear lyre thorax + banded legs); the
  rest are small or low-contrast. That is expected, not a defect: MA's experts routinely write
  in `edited_user_notes` that the lyre pattern "no se ve bien" and identify from leg banding
  and gestalt. The expert note travels with every row.
- **GBIF/iNaturalist research grade, 24 random *aegypti*: 1/24 is almost certainly *A.
  albopictus*** (bold black-and-white banding, single pale thoracic stripe), and ~4/24 are
  ambiguous between the two. **So the GBIF/iNat pool carries ~4–8% albopictus-in-aegypti
  contamination**, with a further ~17% ambiguous. n=24, so that is an order-of-magnitude
  estimate, not a rate.

The two sources fail in opposite directions and this is the single most important thing in
the dataset: **MA is trustworthy and ~30× smaller; GBIF/iNat is high-volume and carries a
measurable albopictus contamination.** `certainty_grade` is in the manifest precisely so a
consumer can choose, rather than mixing them into one pool where a systematic confusion
becomes invisible.

### Label hygiene actually applied

- Never trusted a category or filename. Commons candidates keep `commons_categories`,
  `commons_title` and `commons_description` so a human can re-check; MA keeps the expert's
  own note.
- **Life stage is recorded, not filtered.** 1,453 of the GBIF *aegypti* images are larva/egg/
  pupa. They are kept with `life_stage` set, because a larva labelled with the right species
  is still signal and costs nothing once it is a column.
- **`captive_cultivated != wild` is a hard reject**, as is `taxonomicStatus = SYNONYM` and
  unfetchable media identifiers. 839 GBIF records rejected, listed with reasons in
  `meta/rej_gbif_*.jsonl`.
- **Deduplicated by content hash**, not URL: the same photo reaches us from GBIF, iNaturalist
  and Commons under different URLs. Duplicates are logged as `dup_content_of` rows rather
  than stored twice (~500 across the harvest).
- **Split by specimen.** `group_key` is the unit: one GBIF occurrence, one MA report, one
  Commons file. 32,155 images resolve to 21,908 specimens — the *Aedes aegypti* pool is 7,851
  images over 4,551 specimens, so a naive image-level random split would leak roughly 40% of
  specimens across the boundary. Split on `group_key`, never on rows.

## Sex, blood-fed, gravid, environment — free supervision

These are recorded per image in the manifest because the MA platform's experts already
entered them; they cost nothing to carry.

- **`sex`: 2,511 images carry it**, and for *aegypti* specifically **51 of 188 (27%)** —
  49 female, 2 male. Across MA it is 2,511/10,113 (25%).
- **Expert-sourced, not community-reported** (`identification.result.source = expert`).
- It is **not in the frozen nightly dump at all** — I scanned all 285,066 dump records and the
  whole `translation_dict.json` for a sex field and there is none. The only sex signal in the
  dump is free text in `edited_user_notes`, which parses for just 5/187 (3%) of *aegypti* and
  0.3% dump-wide. So the API is the only route.
- **Heavy class imbalance: ~95% female.** A sex classifier trained on this would learn
  "female". Usable as an auxiliary attribute, not as a balanced target.
- Also carried: `is_blood_fed` (99 True / 1,892 False), `is_gravid`, `event_environment`
  (indoors 6,980 / outdoors 3,144 / vehicle 93), `ma_confidence_label` (Confirmed 4,148 /
  Probable 6,143), `ma_agreement`, `ma_uncertainty`, and the visual trait marks
  `appearance_thorax/abdomen/legs`.

**Verdict on sex: worth having, not worth a project.** 27% coverage on the class we care most
about, expert-sourced, and genuinely discriminative for exactly the albopictus/aegypti
boundary. It is a good auxiliary head on a model we are training anyway. It is not enough to
build or evaluate a sexing model on, and the 95/5 imbalance would make any such evaluation
misleading.

## Rejected, and why

| what | n | reason |
|---|---|---|
| GBIF *aegypti* immature life stage | 1,453 images | **kept**, flagged `life_stage` (exploration mode) |
| GBIF records, hard rejects | 839 | unfetchable identifier (153), `taxonomicStatus=SYNONYM` (185), non-wild (501) |
| MA popup thumbnails | 187 | `photo_html` lists the full-res original *and* its UI popup; fetching both would double the corpus with the same signal. Only originals fetched. |
| Commons GFDL-only, NC, ND | ~340 | GFDL-only is not a Commons-acceptable free licence; NC/ND excluded deliberately |
| Commons HTTP 429 | 45 | anonymous API rate limit, honoured with backoff (see below) |
| duplicate content | ~500 | same photo under a different URL |
| net/http failures | ~340 | 403/404/500, retried then given up |

## Findings worth keeping

- **`TAXON_ID_NOT_FOUND` is iNaturalist-id noise, not a misidentification signal.** It is on
  4,136 of 4,136 iNat-sourced GBIF records (100%) and 74 others. iNat publishes its own
  `taxonID` (e.g. 155453), which is of course absent from the GBIF backbone. My first pass
  downgraded 96% of the corpus on this flag, which would have made `certainty_grade`
  useless. The flags that *do* indicate a doubtful ID are `TAXON_CONCEPT_ID_NOT_FOUND` (24),
  `SCIENTIFIC_NAME_ID_NOT_FOUND` (2) and `INTERPRETATION_COLLISION`. All three are in the
  manifest as `gbif_issues` so the decision is auditable.
- **GBIF multi-value params must be repeated keys, not comma-joined.**
  `license=CC0_1_0,CC_BY_4_0` returns **HTTP 400 with an empty body** — which reads as "no
  results" if you do not check the status. And building the query with `dict(pairs)` silently
  collapses repeated keys to their last value: that gave 63 records instead of 4,383.
- **The MA API's `is_descendant_of` excludes the taxon itself.** Culex is genus id 10;
  19,883 of its records are identified *at genus rank*, so descendants-only returns **12**.
  `is_tree_of` is the operator that means "this taxon and everything under it" and returns
  **19,907**. This one operator is the difference between 12 and 19,895 records.
- **Commons `extmetadata` values are plain dicts, not lists** (`{"value":…,"source":…}`), and
  `License` is a *single* machine code (`pd`, `cc-by-sa-4.0`), not a comma-separated list.
  `LicenseShortName` is what a human sees. Also `cc-?by` does not match `"cc by"` — a space,
  not a hyphen — which silently rejected every CC BY-SA file until it was caught by reading the
  reject histogram.
- **Commons has a soft block that returns HTTP 200 with a 75 KB HTML API-help page.**
  `action=query` is mandatory; without it `json.loads` fails with a bare `JSONDecodeError`
  that looks exactly like a throttle.
- **The MA webmap's displayed TOTAL is consistently 0.5–1.5% below the API's `count`** for
  identical filters, unexplained. Use the API `count` for ceiling numbers.

## Scaling further — ready to run, not run here

The harvest is parameterised; these are one-liners against the scripts in `scripts/`.

```sh
# GBIF, any taxon, any licence mix. Culicidae (3346) is the volume play:
# 114,082 media records, ~813 species, of which 69,110 are CC0/CC-BY.
bash scripts/sweep_gbif.sh                     # 6 target taxa, runs concurrently
python3 scripts/gbif_fetch_records.py --taxon-key 3346 --out meta/gbif_recs_culicidae.jsonl
python3 scripts/gbif_candidates.py --records meta/gbif_recs_culicidae.jsonl \
    --out meta/cand_gbif_culicidae.jsonl --rejects meta/rej_gbif_culicidae.jsonl \
    --label Culicidae
python3 scripts/fetch_images.py --candidates meta/cand_gbif_culicidae.jsonl \
    --outdir images/gbif/culicidae --log meta/dl_gbif_culicidae.jsonl --workers 16

# GBIF Aedes albopictus (taxon 1651430) — 25,587 records CC0+BY alone.
# iNaturalist directly, for the non-research-grade pool GBIF does not ingest:
#   taxon 155453 = A. aegypti: 5,376 research-grade + 2,283 needs_id observations.
```

Throughput measured at **58 images/s** aggregate across 8 concurrent downloaders (14.3/s on a
single stream), ~120 KB/image after re-encoding, so 100k images ≈ 35 min and ≈ 12 GB. Disk was
never the constraint: the bind mount had **235 GB free** of 1.9 TB and I stopped at 3.7 GB.
`fetch_images.py` is resumable (existing files are skipped) and rewrites iNaturalist
`original.*` → `large.*` (1024 px) before fetching, which cuts transfer ~40×.

## Constraints, honestly

- **Verification is a 24-cell look per source, not exhaustive.** The 4–8% albopictus
  contamination figure is an order-of-magnitude estimate. Tightening it means more cells, not
  a cleverer method.
- **MA is NC.** 10,113 of 32,155 images (31%) cannot be used commercially. If that matters,
  the commercially clean set is the 5,348 GBIF+Commons images and MA should be dropped.
- **The MA dump is superseded.** The API is live and richer; the dump's only remaining value
  is as a cross-check on the 187 figure, which it confirms.
- **No model was trained and no embedding computed**, per the brief. Another agent is running
  the probe on existing embeddings.
- **Anopheles from MA is small (180) and European-skewed** (NLD 88, ITA 24, ESP 17). For
  Anopheles volume, GBIF is the source: 5,570 records → 8,565 images.

## Cross-links

- `investigations/2026-10-02-mosquito-alert-data/01-data-access.md` — the frozen dump's
  channels, schema and expert-validation codes. This file supersedes its "the live webmap's
  data endpoint was not located" open item: the endpoint is `https://api.mosquitoalert.com/v1/`,
  schema at `/v1/openapi.json`, unauthenticated.
- `investigations/2026-10-03-precision/03-ladder/web-findings.md` — the survey whose GBIF
  licence-filter finding this harvest operationalised.
- `investigations/2026-10-02-mosquito-id/10-github-pages/08-species-images/scripts/harvest5.py`
  — the Commons harvest whose throttling discipline `scripts/commons_harvest.py` reuses.
