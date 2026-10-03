# 03 - Geographic prior: which Culicidae occur around Basel?

Driving script: `03-inat/build_prior.py` (re-runnable; raw API responses cached in `03-inat/raw/`).

**Question.** Which mosquito species are actually recorded around Basel (47.56448 N, 7.57717 E) within
~50 km, and how commonly? This gives the candidate list and a weak geographic prior for the local-model
classification and the report.

**Queries.** iNaturalist `api.inaturalist.org` taxon 52134 (Culicidae), lat/lng radius=50 km
(522 obs, all dates); iNat Switzerland-wide species_counts (place 7236); GBIF `api.gbif.org` taxonKey 3346,
bbox 47.115-48.014 N / 6.911-8.243 E (~50 km N-S and E-W, corners up to ~70 km): 2222 records, of which
kept after filtering; plus a 100 km bbox sweep (5438 records) for nearest-record analysis and country=CH
(7059 records). Rate-limited to ~1 req/s; every response cached in `03-inat/raw/` (58 files).

## The main data trap: ECDC VectorNet datasets are region status tables, not point records

Of the 2222 GBIF bbox records, 1366 come from "VectorNet observations" (4abd984b), 351 from
"VectorDistributionStatus_2025" (b2390da7), 107 from "VectorDistributionStatus_2026" (43411a7a). These are
ECDC VectorNet tables in which **`occurrenceStatus=ABSENT` rows assert non-presence** and the two
"VectorDistributionStatus" datasets pin PRESENT rows **to region centroids** (e.g. one coordinate for all of
"Nordwestschweiz"), so naive aggregation claims Asian/African species "near Basel in 2026"
(Cx. tritaeniorhynchus, An. sacharovi, Ae. aegypti...). Handling:

- ABSENT rows: dropped everywhere (they are non-detections).
- VDS 2025/2026 PRESENT rows: excluded entirely (centroids); their content lives on as the
  [ecdc-regional-status.tsv](03-inat/ecdc-regional-status.tsv) side artefact.
- "VectorNet observations" PRESENT rows: **kept** - they are real field records (BG-Sentinel, ovitrap,
  dipping, human bait; 149 distinct sites, 1984-2021, including Basel-city trap sites ~1.0 km from our
  specimen site). Caveat: this dataset re-ships ~13 AIMSurv 2020 ovitrap records also present in the
  AIMSurv dataset (same sites, overlapping visit windows), so `gbif_count_bbox` double-counts at most 13
  records per affected species. GBIF ignores `!datasetKey` negation silently, so filtering happens in
  `build_prior.py`, not in the query.

## Ranked species list (~50 km, filtered)

Full data: [03-inat/culicidae-basel.tsv](03-inat/culicidae-basel.tsv) (species, inat_count_50km,
gbif_count_bbox, last_seen_year, invasive_flag + supporting columns). iNat and GBIF columns are
independent sources that overlap (iNat research-grade obs re-exported to GBIF) - do not sum them.

| species | iNat 50km | GBIF bbox | last seen | invasive | evidence class |
|---|---|---|---|---|---|
| Aedes (Stegomyia) albopictus | 60 (34 RG) | 167 | 2026-09 | **yes** | citizen science 2022-2026 on 4 platforms + ovitrap surveys 2020 (DE side), introduced repeatedly, established Riehen 2025 |
| Aedes (Hulecoeteomyia) japonicus | 45 (27 RG) | 119 | 2026-09 | **yes** | ovitraps + citizen science 2015-2026, established all around Basel |
| Culex pipiens (incl. torrentium) | 60 (1 RG) | 89 | 2026-09 | no | ubiquitous; mostly unconfirmed IDs; pipiens/torrentium unresolved in photos |
| Aedes detritus | 0 | 48 | 1998 | no | historic (1984-1998) French Rhine-floodplain records ~33 km |
| Culiseta annulata | 31 (5 RG) | 8 | 2026-08 | no | common, indoor/winter-active, 0.7 km |
| Aedes caspius | 0 | 44 | 1997 | no | historic (1984-1997) floodplain, ~33 km |
| Aedes geniculatus | 10 (6 RG) | 22 | 2025-09 | no | tree-hole species, 1.0 km (Basel trap) |
| Aedes vexans | 2 (1 RG) | 29 | 2023 | no | floodwater, Rhine plain; DE dataset 2011-2018 + recent |
| Anopheles plumbeus | 2 (1 RG) | 14 | 2025 | no | Basel trap site 1.0 km (2014), CH-wide 195 records |
| Culiseta longiareolata | 6 (3 RG) | 2 | 2025-09 | no | autumn/rafts in containers, 1.4 km |
| Coquillettidia richiardii | 1 | 1 | 2024 | no | 43 km (FR); CH-wide 163 (mostly literature) |
| Culex torrentium | 0 | 2 | 2009 | no | pipiens sibling; regionally Present (ECDC) |
| Culex territans | 0 | 2 | 2020 | no | 3.6 km, 2008 + 2020 |
| Aedes koreicus | 1 (needs_id) | 0 | 2025-06 | **yes** | Delémont 2025 iNat (needs_id), nearest confirmed 64 km, ECDC "Introduced" NWS 2026 |
| Culiseta glaphyroptera | 0 | 1 | 2019 | no | 43 km, 2019 |
| Culex stigmatosoma / Cq. linealis / Cs. incidens / Cx. quinquefasciatus | 1 each | 0 | - | no | single unconfirmed (needs_id/casual) iNat records of non-European species - noise, excluded |

Context: within 50 km, iNat also holds 43 family-level, 103 Culicinae-subfamily, 64 Aedes- and 53
Culex-genus-only and 18 "Culex pipiens complex"-level observations (unresolvable IDs; included in neither
column). Three iNat observations dated exactly 2026-10-02 20:27 +02:00 are almost certainly the specimen
itself, already uploaded (needs_id, coordinates not public).

## The invasive species situation near Basel

- **Aedes albopictus** - nearest record 0.7 km from the specimen site (iNat research-grade, Basel city,
  2023-10-17; 47.5673/7.569). 60 iNat obs within 50 km (2022-2026, 34 research-grade), plus 2020 ovitrap
  positives on the German side (47.796/7.550, Weil/Lörrach area) and Mulhouse 2023. ECDC
  VectorDistributionStatus 2025/2026 lists albopictus **Established** in Nordwestschweiz, Haut-Rhin,
  Territoire de Belfort and Freiburg im Breisgau (first-hand: [ecdc-regional-status.tsv](03-inat/ecdc-regional-status.tsv),
  from GBIF dataset [VectorDistributionStatus_2026](https://www.gbif.org/dataset/43411a7a-1503-4391-9791-e33801752053)
  and [_2025](https://www.gbif.org/dataset/b2390da7-9704-4215-b038-3727df6e7fee)). The claim in the briefing
  that Basel has been established "since ~2019" is **not supported**: the national reference centre ZNSteg
  announced the **first established population at Basel (Riehen, Basel-Stadt) only on 14 Nov 2025**
  (discovery by a resident via the MoustiQu app; mtDNA COI haplotype matching Italian/Freiburg/Lörrach
  populations) - [infozoonose-vet.ch](https://www.infozoonose-vet.ch/nachweis-einer-ersten-etablierten-population-von-stegomyien-tiger-mosquitoes-bei-basel)
  (page could not be fetched from this container - DNS for infozoonose*.ch does not resolve here; content
  verified via web-search snippets only). Earlier Basel records were introductions, not establishment;
  cantonal awareness campaign 2025
  ([quartierzeitung.ch](https://quartierzeitung.ch/de/2025/04/30/moustique-tigre-en-ville-in-der-stadt)).
- **Aedes japonicus** - established on every side of Basel (ECDC: Established in Nordwestschweiz, Haut-Rhin,
  TdB, Freiburg i. Br.). Nearest point record 2.4 km (Basel-Land surveillance site, 2015), Basel-city trap
  site 1.0 km (2018), 45 iNat obs (27 RG, 2020-2026), last 2026-09-11.
- **Aedes koreicus** - the only genuinely uncertain invasive. One unconfirmed iNat record (Delémont,
  2025-06-09, needs_id), nearest confirmed point 63.9 km (48.1034/7.8759, 2024-10-02), and ECDC 2026 status
  "Introduced" for Nordwestschweiz (2025: "Absent" for Solothurn/Aargau) - consistent with a nascent,
  low-density presence that citizen data barely registers. ECDC 2026 marks koreicus "Absent" in
  Haut-Rhin/TdB/Freiburg.
- **Aedes aegypti** - **no occurrence records within 100 km**; ECDC status "Absent" in all nearby regions.
  Any aegypti ID for this specimen would need extraordinary evidence.
- Aedes atropalpus: ECDC 2026 "Absent" in Nordwestschweiz; no local records. Ae. cretinus: absent.

Swiss monitoring (verified as far as the container's DNS allows): the national reference centre for invasive
mosquitoes (ZNSteg, University of Zürich, mandated by BAG/OFSP) runs early detection with ovitraps and the
MoustiQu app ([infozoonose.ch early detection](https://www.infozoonose.ch/de/frueherkennung-invasive-stegomyien)),
and infozoonose arbovirus surveillance screens Aedes albopictus where it occurs
([infozoonose.ch surveillance](https://www.infozoonose.ch/de/aktivitaten-surveillance)); annual reports at
[zns.uzh.ch](https://www.zns.uzh.ch/de/znsteg/berichte.html).

## Seasonality (month-of-year of local records, iNat + GBIF filtered)

| species | J | F | M | A | M | J | J | A | S | O | N | D | October note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Aedes albopictus | 1 | 0 | 0 | 1 | 7 | 8 | 30 | 45 | 46 | **17** | 2 | 0 | active, 3rd-highest month |
| Aedes japonicus | 1 | 0 | 7 | 14 | 17 | 18 | 18 | 18 | 21 | **3** | 1 | 0 | tail end of season |
| Culex pipiens | 7 | 8 | 2 | 4 | 4 | 2 | 12 | 15 | 3 | **10** | 4 | 15 | year-round, indoor |
| Culiseta annulata | 0 | 6 | 6 | 3 | 2 | 3 | 0 | 2 | 2 | **4** | 2 | 5 | classic indoor autumn/winter mosquito |
| Culiseta longiareolata | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 1 | **3** | 0 | 2 | larvae in October |
| Aedes vexans | 0 | 0 | 0 | 0 | 2 | 3 | 9 | 5 | 9 | 1 | 0 | 0 | mostly done by Oct |

(October column bolded; Cs. annulata overwinters as mated adult in cellars/rooms and is the classic mosquito
found indoors at dusk from October.)

## Recommended candidate list (ordered) and prior strength

1. **Aedes albopictus** - top candidate: commonest local Aedes, October-active, dusk-biter, matches the
   examiner's "dark body, white-spotted abdomen, banded legs".
2. **Culex pipiens** (incl. Cx. torrentium - not separable from photos) - equally common, indoor, but lacks
   the white-spotted abdomen; the reported morphology argues against it.
3. **Aedes japonicus** - nearly as common as albopictus, October tail; white thoracic stripes + banded legs,
   also matches the morphology.
4. **Culiseta annulata** - large banded indoor mosquito, peak indoors Oct-Feb; morphology (Aedes-type) and
   size would distinguish; keep mid-weight.
5. **Aedes geniculatus** - white-patched, tree-hole, autumn records; mid/low.
6. **Culiseta longiareolata** - autumn; low.
7. **Aedes vexans** - low (floodplain, mostly summer).
8. **Anopheles plumbeus** / An. maculipennis s.l. - low (plumbeus bites indoors; maculipennis complex
   regionally Present).
9. **Aedes koreicus** - low weight but **must stay on the list**: ECDC "Introduced" 2026, one needs_id
   citizen record in the region; exactly the rare-invasive-not-to-be-prior'd-away case.
10. Tail (≤1% each, keep only to complete the distribution): Aedes caspius, Aedes detritus,
    Culex territans, Coquillettidia richiardii, Culiseta morsitans/glaphyroptera, Aedes cinereus group,
    Aedes atropalpus, Aedes aegypti (no local evidence within 100 km).

**Prior strength: weak, deliberately.** Occurrence data here is collector-biased (citizen science clusters
where people live; surveillance targets invasives at fixed trap sites; natives such as Cx. torrentium,
Cs. morsitans, Ae. cinereus are certainly under-recorded). Counts should shape the tail of the distribution,
not the head: the head is decided by morphology + season + indoor context. The one place the prior should
*add* probability mass beyond what morphology alone would give: albopictus and japonicus (both common and
established), and koreicus keeps a non-trivial floor. A "rare invasive" prior'd away is the one mistake this
list must not make: albopictus was itself a rare invasive in the region until late 2025.
