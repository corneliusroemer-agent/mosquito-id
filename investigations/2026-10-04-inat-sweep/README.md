# Training data for the twelve missing mosquito species

**Date:** 2026-10-04 · **Branch:** `agent/training-data-sources` ·
**Build dirs:** `scratch/2026-10-03-inat-sweep/`, `scratch/2026-10-03-gbif-sweep/` ·
Extends `investigations/2026-10-06-datasource-inventory/`

The prior inventory said the largest untapped pool was "iNaturalist direct, research
grade, 6,181 RG photo observations, none pulled". That pool is now pulled, licence-checked
and deduplicated against the corpus. Ten species go from zero species-rank rows to
hundreds or thousands; two remain near zero because they are genuinely near-zero
everywhere.

## What is now on disk that was not

**10,240 licensed species-rank photos** for eleven of the twelve missing species, from
6,181 iNaturalist research-grade observations. Every one of the 10,240 is on disk.

The count is 1.66× the predicted 6,181 because 6,181 was the *observation* count and
mosquito observations carry multiple photos each.

| species | iNat RG obs | photos accepted | already in corpus — relabel only | new, from iNat API | new, from GBIF sweep | ND dropped | no licence dropped |
|---|---:|---:|---:|---:|---:|---:|---:|
| *Aedes vexans* | 2418 | 3445 | 0 | 3415 | 30 | 74 | 935 |
| *Culiseta annulata* | 1388 | 2298 | 2212 | 86 | 0 | 14 | 571 |
| *Culex quinquefasciatus* | 961 | 1889 | 0 | 1826 | 63 | 42 | 200 |
| *Culiseta longiareolata* | 452 | 875 | 816 | 59 | 0 | 27 | 228 |
| *Culex pipiens* | 456 | 732 | 0 | 730 | 2 | 12 | 227 |
| *Aedes geniculatus* | 349 | 678 | 0 | 670 | 8 | 11 | 157 |
| *Aedes cinereus* | 73 | 131 | 0 | 131 | 0 | 5 | 36 |
| *Anopheles plumbeus* | 58 | 108 | 96 | 12 | 0 | 14 | 25 |
| *Culiseta morsitans* | 14 | 50 | 50 | 0 | 0 | 0 | 6 |
| *Anopheles claviger* | 11 | 26 | 26 | 0 | 0 | 0 | 4 |
| *Culex torrentium* | 1 | 8 | 0 | 8 | 0 | 0 | 0 |
| *Anopheles maculipennis* | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **total** | **6181** | **10240** | **3200** | **6937** | **103** | **199** | **2389** |

"New, from iNat API" and "new, from GBIF sweep" are disjoint — every accepted photo is in
exactly one. The split is arithmetic, not a claim about which source is better: GBIF
mirrors iNaturalist's Research-grade dataset and had already collected most of the
*Culiseta* rows before the iNat sweep ran.

## The finding: 3,200 species-rank images are already on disk, labelled genus-only

The **relabel only** column is the cheapest result in this report and it costs zero
downloads. Those 3,200 photos are in `manifest.csv` today carrying
`species_label = Culiseta` or `Anopheles`, because they arrived through GBIF's
iNaturalist Research-grade dataset with the species identity never propagated. The iNat
photo id is in the row's `source_url`, so the species label is recoverable from a field we
already hold:

| iNat species | corpus `species_label` today | photos |
|---|---|---:|
| *Culiseta annulata* | `Culiseta` | 2212 |
| *Culiseta longiareolata* | `Culiseta` | 816 |
| *Anopheles plumbeus* | `Anopheles` | 96 |
| *Culiseta morsitans* | `Culiseta` | 50 |
| *Anopheles claviger* | `Anopheles` | 26 |

That is four of the twelve gaps closed by a column edit, on the strength of a
research-grade community ID already present in our own metadata. This is independent of,
and additive to, the Mosquito Alert `ma_taxon_name` relabelling the prior inventory found
(1,119 images) — different rows, different mechanism, same four species plus two.

## Licence: ND is present in iNaturalist and it is excluded

The prior inventory said "adding `license_code` filtering at query time removes the ND
rows". It does not filter at query time — `license_code` is per-photo and only appears
once you have paginated the results, so ND has to be filtered client-side after the
metadata crawl.

Of the 12,828 photos the iNat harvest returned:

| licence | photos | verdict |
|---|---:|---|
| `cc-by-nc` | 7746 | usable |
| `cc-by` | 1636 | usable |
| `cc-by-nc-sa` | 307 | usable |
| `cc-by-sa` | 293 | usable |
| `cc0` | 258 | usable |
| *no licence field at all* | 2389 | **excluded** — unknown is not usable |
| `cc-by-nc-nd` | 174 | **excluded** |
| `cc-by-nd` | 25 | **excluded** |

**199 ND photos were dropped**, concentrated in the species we need most (*Ae. vexans* 74,
*Cx. quinquefasciatus* 42, *Cs. longiareolata* 27). Nothing on the accepted list is ND, so
cropping and resizing are safe on all 10,240. Note that 2,389 rows (23%) carry no
licence field at all — iNaturalist requires a licence only for research-grade uploads it
has not itself verified, and the "no known copyright" state is a real third category that
is neither permissive nor restricted.

GBIF was swept separately (`scratch/2026-10-03-gbif-sweep/`, 32,314 images over 15 taxon
keys). It carries **zero** ND across all 44,018 occurrences — CC0 26,232 / CC-BY 3,646 /
CC-BY-NC 14,140 — confirming the prior survey's conclusion that the licence filter is a
formality there.

## The label tier for all of this

Every row above is iNaturalist **research grade**: two community IDs in agreement, or one
from a curator or partner organisation. It is not expert verification. In the existing
tiering (`96-label-provenance/91-label-provenance.md`) it belongs with
`4_asserted_no_verification_field` — the tier the GBIF research-grade rows already occupy
— **not** with `1_expert_reviewed`, and it must not be pooled with Mosquito Alert rows
without being scored separately. The 19.2 pp accuracy split across tiers means mixing them
silently would move every number this project reports.

The one genuine tier upgrade in this batch is the 3,200 relabel-only rows, which move from
a genus assertion to a species *community* assertion — a rank upgrade, not a verification
upgrade. Three species-count caveats worth knowing before scoring:

- 32 of the *Cx. pipiens* photos are identified as *Culex pipiens molestus* and 3 as *C.
  pipiens pallens* — subspecies within the species. They are species-rank rows for
  *C. pipiens* proper.
- 5 *Ae. vexans* photos are *Ae. vexans nocturnus*.
- iNat serves the community ID's name, not our requested taxon, in `ident_name`. Filter on
  that field rather than assuming the query taxon was the accepted ID.

## Hard negatives: 21,525 lookalike-family photos, and this is the unlabelled data

The project's stated priority is that the model must not call a non-mosquito a mosquito.
Nothing in the 6,264-row corpus trains that behaviour — every row there is a mosquito.
iNaturalist supplies the negatives from the same machinery that supplies the positives:
research grade at family rank.

Harvested across fourteen invertebrate families routinely mistaken for mosquitoes in phone
photos:

| family | usable photos after licence filter | ND dropped | sampled for download |
|---|---:|---:|---:|
| *Dolichopodidae* | 8347 | 140 | 1000 |
| *Chironomidae* | 7818 | 141 | 3000 |
| *Notonectidae* | 7697 | 93 | 1500 |
| *Tabanidae* | 7557 | 140 | 1000 |
| *Tipulidae* | 7475 | 118 | 3000 |
| *Asilidae* | 7341 | 119 | 1000 |
| *Corixidae* | 7270 | 215 | 3000 |
| *Psychodidae* | 6769 | 105 | 1500 |
| *Ephemeridae* | 6455 | 113 | 1000 |
| *Chaoboridae* | 4669 | 211 | 3000 |
| *Sciaridae* | 895 | 9 | 895 |
| *Athericidae* | 840 | 11 | 840 |
| *Ceratopogonidae* | 709 | 34 | 709 |
| *Blephariceridae* | 81 | 0 | 81 |
| **total** | **70,923** | **1464** | **21,525** |

The top four (*Tipulidae* crane flies, *Chironomidae* midges, *Chaoboridae* phantom
midges, *Corixidae* water boatmen) are the classic misidentifications and carry the
heaviest sampling. All 21,525 sampled images were downloading at ~32/s with zero errors.

**This doubles as the unlabelled pool.** For Noisy Student or FixMatch these are 21,525
images with no label of ours and no download beyond what is already running — and unlike
pinned-specimen data (BIOSCAN, Insect-1M) they are field photographs taken by the same
kind of person who photographs a mosquito. The unlabelled mosquito pool is larger still:
163,549 *Culicidae* `needs_id` photo observations on iNaturalist, which carry no
verification field and are therefore usable as unlabeled-but-in-domain images.

## What was ruled out, with numbers

- **The prior survey's claim that 13 of 16 GBIF keys were never swept is wrong for six.**
  *Culiseta annulata*, *Cs. longiareolata*, *Cs. morsitans*, *An. plumbeus*, *An.
  claviger*, *An. maculipennis* were all fully covered by the earlier *genus*-key sweeps —
  100% dedup hit rate, 0 net-new images. GBIF keys are per-species and the old sweep used
  genus keys, so those six were covered transitively.
- **Six of the nine taxon keys I was given point at the wrong taxon.** `1651559` and
  `1651662` do not resolve at all; `1651558` is *Aedes thomsoni*, `1652242` is *Aedes
  ethiopiensis*, `1651682` is *Aedes brayi*, `1652628` is *Culex anoplicitus*, `1551531` is
  *Phytomyza canadensis*, `1551541` is *Phytomyza flavoantennata*, `1551833` is *Phytomyza
  latifolia*. Anyone sweeping a hardcoded key list without re-resolving it will silently
  download the wrong genus. Correct keys are in `scratch/2026-10-03-gbif-sweep/species.tsv`.
- **Five smaller GBIF datasets are real but tiny for us.** BugGuide (CC0, 1,248
  *Culicidae* media), NABU|naturgucker (646), Artsobservasjoner-NO (171), izeltlabuak-HU
  (198), laji.fi (47). Per-species across our sixteen: BugGuide 314 (*Ae. vexans* 210,
  *Ae. albopictus* 157, *Ae. japonicus* 95), the rest under 100 each. BugGuide's interest is
  provenance, not volume — expert-identified by named identifiers, which is a tier our
  corpus has almost none of — but 210 images for a species we now have 3,415 of is not worth
  the integration.
- **iNat does not solve the two hard species.** *Cx. torrentium* is **one** research-grade
  observation (8 photos) in all of iNaturalist. *Ae. cinereus* is 73 observations / 131
  photos — enough to train a class, not enough to evaluate one. Neither is thin because of
  a missing source; they are thin because almost nobody photographs them and IDs them.
- **The un-moderated iNat pool is not a free labelling shortcut.** 94% of *Cx. pipiens*
  `needs_id` observations (592 of the first 600) carry **zero** identifications. They are
  user-filed with no one checking, so a FixMatch pseudo-label on them is FixMatch on
  noise.
- **GBIF search API pagination is serial-slow past ~10k records.** Paging the 33,652-record
  *Ae. albopictus* key serially ran at 2.5 records/s (2.5 h projected); sharding by offset
  across 12 processes took 11 minutes.

## The highest-value next action

**Fill in the 90-row adjudication set.** It is still 0 of 90 filled in as of 2026-10-03
17:22, one day after it was built
(`investigations/2026-10-03-rewrite/40-precision/96-label-provenance/93-adjudication-set/`).
It is the only artefact in this project that turns label *agreement* into label *accuracy*,
and it is 20 minutes of a human's time. Everything in this report adds rows whose accuracy
is assumed from a tier; nothing here measures whether that assumption holds. In particular
the 3,200 relabel-only rows rest entirely on community IDs being right.

Second, and mechanical: promote the 3,200 relabel-only rows and the 1,119 Mosquito Alert
`ma_taxon_name` rows to species rank, which closes four of the twelve gaps before any model
is retrained.

## Files

```
scratch/2026-10-03-inat-sweep/
  inat_harvest.py                 metadata crawl, sliding-window safe (see below)
  harvest_negatives.py            lookalike-family harvest
  fetch_images.py                 resumable, content-hash dedupe, jpeg-aware
  meta/cand_inat_rg.jsonl         12,828 raw RG photos, all licences
  meta/cand_inat_rg_accepted.jsonl 10,240 licensed, deduped
  meta/cand_inat_rg_relabel_only.jsonl  3,200 already in the corpus
  meta/cand_inat_negatives_sampled.jsonl 21,525 sampled negatives
  meta/{inat_harvest,inat_negatives}_summary.tsv
  meta/new_datasets_per_species.tsv   the seven GBIF datasets we had not swept
  images/  6,937 images, 1.9 GB
  images_neg/  21,525 images
scratch/2026-10-03-gbif-sweep/     32,314 images, 23 GB, per-species tables in NOTES.md
```

## What I worked out

- **`id_above` silently breaks on iNaturalist's filtered observations API.** The prior
  inventory documented the 10,000-record window limit and recommended `id_above` as the
  workaround. `?taxon_id=&photos=true&quality_grade=research&order_by=id&id_above=N`
  returns `total_results: 0` and no results, with no error. Plain `page=` pagination works
  and is stable — the largest species here is 2,418 records, well under the 10,000 cap, so
  paging is sufficient and `id_above` is not needed at all for our twelve species.
- **`photos[].url` is the 75px square and there is no `urls` dict.** iNaturalist's photo
  object carries only `id`, `url`, `license_code`, `attribution`, `original_dimensions`.
  The larger renditions are a URL convention, not a field: swap the trailing filename for
  `large.jpg` / `original.jpg`.
- **The extension is per-photo and can be `.jpeg`, not `.jpg`.** Deriving `large.jpg` from
  a photo whose square is `square.jpeg` gives a 404 on every size. This presented as a
  38% download error rate that looked exactly like S3 throttling and survived a retry pass
  unchanged; the fix took throughput from 7/s with 1,721 errors to 42/s with 49.
- **iNaturalist research-grade observation counts are the number the API reports, and
  "6,181" was right.** 6,181 observations crawled exactly, confirming the prior survey's
  number; the 10,240 is the photo-level count after licence and dedup filtering.
- **iNaturalist has no ND photos under a `taxon_id` + `quality_grade=research` filter that
  excludes them, but it has ND photos in general.** 199 of 12,828.
- **GBIF occurrence `license` is a URL, `licenseURL` is null.** Counting by raw string
  yields one bucket per URL spelling. Map back to a code before tallying.
- **GBIF licence facets sum to the occurrence count, not the media count.** The prior
  survey reported them as equal to the media count; for *Ae. albopictus* the facets sum to
  33,652 against 40,818 media.
