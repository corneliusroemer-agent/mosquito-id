# Changelog

One section per day, newest first, in the order things reached `main`.

**An entry is added when the work merges to `main`** — not when the branch is opened, and not
in a separate pass afterwards. Whoever merges writes the entry, so a merged change without one
is a merge that did not finish. See `AGENTS.md`.

Categories: **Feature**, **Bug Fix**, **Documentation**, **Testing / Reliability**,
**Internal**. References are `[#NN](…/pull/NN)` for pull requests, `[#NN](…/issues/NN)` for
issues, and a short SHA for a commit that reached `main` directly.

## 2026-10-04

### Feature

- **Whole-frame view is now optional, and the score fusion honours it.**
  `1b637d7` — the uncropped view can be excluded from the fusion rather than always
  contributing. Followed by a confidence router that scores an unconfident crop on its own
  instead of pooling it ([#84](https://github.com/corneliusroemer-agent/mosquito-id/pull/84),
  `58f8e2f`). The whole-frame toggle turned out to be a no-op in practice — see
  [#85](https://github.com/corneliusroemer-agent/mosquito-id/issues/85).
- **A re-run classifies the crops already on screen** instead of sending every photo back
  through the detector ([#56](https://github.com/corneliusroemer-agent/mosquito-id/pull/56),
  `68f540e`), and runs **one photo at a time** so a 30-photo batch does not lock the page
  ([#44](https://github.com/corneliusroemer-agent/mosquito-id/pull/44), `c18e3af`).
- **The app offers an explicit re-run when the engine no longer matches the scores on
  screen** ([#47](https://github.com/corneliusroemer-agent/mosquito-id/pull/47), `832dab9`).
- **Detector confidence threshold lowered to 0.50**, declared once at
  `src/app/modelConfig.ts` (`8b59441`), recovering macro-F1 the old 0.70 left on the table
  ([#74](https://github.com/corneliusroemer-agent/mosquito-id/issues/74)). The report that
  chose it was decided on macro-F1 alone, which is now recorded as a defect
  ([#80](https://github.com/corneliusroemer-agent/mosquito-id/issues/80)).
- **Detector drawing**: the detached far wing is dropped and the drawing enlarged
  ([#60](https://github.com/corneliusroemer-agent/mosquito-id/pull/60), `4b0e765`).
- **Favicon** ([#48](https://github.com/corneliusroemer-agent/mosquito-id/pull/48), `5343010`).
- **Bulk photo actions moved into the gallery header** — Select all / Select none / Delete
  all (`47a5836`).
- **Photos are named by number and filename together**
  ([#63](https://github.com/corneliusroemer-agent/mosquito-id/pull/63), `39f699d`).
- **The build's commit SHA is shown in the footer, linked to the commit**
  ([#43](https://github.com/corneliusroemer-agent/mosquito-id/pull/43), `00bdd6b`).
- **Engine calibration, three heads refitted against their own posteriors** — culico scored
  at floors fitted to culico (`dd803d0`), B/16 given a background row so the nuisance gate
  stops refusing mosquitoes ([#62](https://github.com/corneliusroemer-agent/mosquito-id/pull/62),
  [#58](https://github.com/corneliusroemer-agent/mosquito-id/pull/58)), and H/14 given
  per-engine floors ([#57](https://github.com/corneliusroemer-agent/mosquito-id/pull/57)).
  The H/14 floors were taken back the same day once the gate's other side was measured
  ([#64](https://github.com/corneliusroemer-agent/mosquito-id/pull/64), `197b201`).

### Bug Fix

- **The footer stops shifting as the per-step timing text changes width**
  ([#88](https://github.com/corneliusroemer-agent/mosquito-id/pull/88)) — each timing gets a
  fixed-width slot with tabular figures, so `81` → `144` cannot re-flow the line
  ([#83](https://github.com/corneliusroemer-agent/mosquito-id/issues/83)). CLS 0.0026 → 0.
- **The model progress bar no longer reads 100% before the model can run**
  ([#73](https://github.com/corneliusroemer-agent/mosquito-id/pull/73), `3c35106`).
- **A rejected crop no longer costs a photo its place in the pool** — fixed in
  [#27](https://github.com/corneliusroemer-agent/mosquito-id/pull/27) on 2026-10-03, and the
  whole-frame toggle's effect on the pool pinned by
  [#67](https://github.com/corneliusroemer-agent/mosquito-id/pull/67).
- **Six findings from the adversarial review of the re-run change**, addressed together
  ([#66](https://github.com/corneliusroemer-agent/mosquito-id/pull/66), `0a4bb8f`).
- **Three faults in `reprocess.spec.ts`** plus a `sessDet` setter on the test seam
  ([#50](https://github.com/corneliusroemer-agent/mosquito-id/pull/50), `0b793e3`) — closes
  [#49](https://github.com/corneliusroemer-agent/mosquito-id/issues/49).
- **A comment that contradicted the router it documented** corrected (`e4987d1`).

### Testing / Reliability

- **Thumbnails are encoded at thumbnail size, not photo size** (`fad8e29`) — `toDataURL` on a
  full-resolution canvas cost 16.8 s over 30 photos
  ([#72](https://github.com/corneliusroemer-agent/mosquito-id/issues/72)). A scratch canvas
  per resample step (`d19ab2c`), and each photograph resampled once for both the detector
  and the classifier (`1e901b2`).
- **`thumbnailUrl`'s pixels are now asserted**, so a black tile cannot pass the geometry
  tests again (`07359dc`) — fourteen geometry tests had passed on entirely black thumbnails
  ([#77](https://github.com/corneliusroemer-agent/mosquito-id/issues/77)).
- **The resample's geometry is asserted, not just that its ink survived** (`14dbf28`).
- **CI is expected green on every commit** (`4f43d0a`), **two CI assertions corrected to
  measure what they claim** (`08f0ba7`), and **runs are queued instead of cancelled**
  ([#65](https://github.com/corneliusroemer-agent/mosquito-id/pull/65), `a224f28`).
- **The crop's geometry and the whole-frame toggle are pinned**, including during a re-run
  ([#67](https://github.com/corneliusroemer-agent/mosquito-id/pull/67), `a6c7931`).
- **The whole-frame specs' confident-crop guard now reads the posterior the router reads**
  ([#89](https://github.com/corneliusroemer-agent/mosquito-id/pull/89)) — it compared a
  renormalised max against a threshold applied to the joint posterior, which coincides on the
  fp16 head and is ~2x inflated on a head with adjacent rows
  ([#85](https://github.com/corneliusroemer-agent/mosquito-id/issues/85)). The one-view
  precondition is now asserted rather than stated in a comment, and an assertion that could not
  fail is deleted.
- **The head JSON is versioned on the build SHA**, so a stale head cannot be served, and a
  cache write no longer costs the download
  ([#69](https://github.com/corneliusroemer-agent/mosquito-id/pull/69), `302e710`).

### Internal

- **`main.js` typed** — the view path (`414b137`), the embedding path (`f0844e9`), and the
  photo record and rev guard (`2beb8c6`), with the type-safety boundary stated and measured
  (`7f51154`).
- **Engine construction gated on the route**, and the model no longer copied to cache it
  ([#46](https://github.com/corneliusroemer-agent/mosquito-id/pull/46), `9401376`).

### Documentation

- **The Playwright exit-code claim in `TESTING.md` corrected**
- **A repo-level skills directory**, with a `writing-style` skill (linkify code references,
  commits and sources; permalinks pinned to `main` outside a branch) and a `creating-skills`
  skill ([#87](https://github.com/corneliusroemer-agent/mosquito-id/pull/87)).
  ([#54](https://github.com/corneliusroemer-agent/mosquito-id/pull/54), `93bfa76`), and the
  CORS port constraint and silent-pass trap documented (`098027b`,
  [#33](https://github.com/corneliusroemer-agent/mosquito-id/issues/33)).
- **The known-reds table corrected** — both entries had already been fixed in `08f0ba7`
  (`25d7329`), and five broken claims in the `DET_CONF` comment fixed (`1608218`).
- **The resample-once measurement and the review's answers recorded** (`f0babee`,
  `64b7f1b`, `49a7b09`).

## 2026-10-03

### Feature

- **The site itself**: a static GitHub Pages app with WebGPU inference, models served from
  Cloudflare R2 (GitHub Releases have no CORS), deployed by Actions (`67c508a`, `fb5a85b`,
  `0ecacb4`, `02006cc`).
- **culico-net-cls-v1 ships as a second classifier**, a 21M-parameter TinyViT against
  BioCLIP's much larger encoders ([#13](https://github.com/corneliusroemer-agent/mosquito-id/pull/13),
  `68ece86`).
- **Two views of each photo are classified and fused** (`8741653`), scored on the same scale
  as un-fused ones (`f7a6e62`).
- **A genus is claimed when the species is not clear enough** (`21ae4e4`), and the pooled
  result leads with a genus headline (`828d56c`).
- **The non-mosquito state names what the photo is instead of ranking species it is not**
  (`36c992b`), and the nuisance block is read in the gate
  ([#24](https://github.com/corneliusroemer-agent/mosquito-id/pull/24), `2b5604d`).
- **Two views naming different species can no longer reach a species claim** (`8a69909`).
- **An unsure photo is pooled down-weighted rather than dropped**
  ([#25](https://github.com/corneliusroemer-agent/mosquito-id/pull/25), `e34d94f`).
- **One pooled row per group the head can separate** (`ab8e6b4`).
- **The species guide routes in-app**, so Back preserves classifier state (`9ba501d`), and
  **reference photographs appear on species pages** (`207dc05`) — all 40 species now have
  them (`22ff8fe`), each with licence and source links (`9b8212a`). All 16 shipping species
  have at least one (`5139d1a`).
- **The default classifier model is picked from device signals** (`5cdac50`), defaulting to
  one that stays on the GPU, and **species names are shown instead of complexes**
  (`5ce2dbd`).
- **The whole photo renders in the panel that says "Full photo"** rather than a placeholder
  (`ed17b9b`, `1a59d90`).
- **Camera capture, mobile styling, corrected crop aspect** (`0d72055`).
- **6,181 research-grade iNaturalist rows pulled in for twelve missing species**
  ([#22](https://github.com/corneliusroemer-agent/mosquito-id/pull/22)).

### Bug Fix

- **The classifier no longer reports 94% confidence at 85% accuracy** (`8162d07`) — the
  floors are wrong for the scale they gate. Recorded as
  [#38](https://github.com/corneliusroemer-agent/mosquito-id/issues/38).
- **culico's zeroes fixed two ways**: export the output order, and read it
  name-independently ([#19](https://github.com/corneliusroemer-agent/mosquito-id/pull/19),
  `e813965`) — it had been scoring 28.5% genus where a probe on its own features scored 80.5%
  ([#28](https://github.com/corneliusroemer-agent/mosquito-id/issues/28)).
- **The score panel's abstention line had never rendered** (`af6703f`) — an inline
  `display:none` beat the `.shown` class (`19c99e5`).
- **Adjacent classes can now name what they are looking at** (`771eae3`); before this the
  non-mosquito state named a class the app could not put into words.
- **The pooled card's reserved 240px restored** (`cafa280`), and the defect pinned with
  `adP` made required (`efd1368`).
- **Thumbnail strip click handling fixed and specified**
  ([#20](https://github.com/corneliusroemer-agent/mosquito-id/pull/20), `ee9841c`); the fused
  result is what the log line reports
  ([#21](https://github.com/corneliusroemer-agent/mosquito-id/pull/21), `3040bf6`).
- **The app reports only what the loaded head can actually resolve**
  ([#23](https://github.com/corneliusroemer-agent/mosquito-id/pull/23), `eccd942`) — addresses
  [#52](https://github.com/corneliusroemer-agent/mosquito-id/issues/52).
- **A footer fix restored after the adjacent-taxa merge clobbered it** (`2ac7a99`).
- **CI red on every `main` commit fixed** — a wall-clock threshold in `reactivity.spec.ts`
  ([#32](https://github.com/corneliusroemer-agent/mosquito-id/issues/32)), and an
  `empty-photo.spec.ts` row count asserted from before pooling listed excluded photos
  ([#31](https://github.com/corneliusroemer-agent/mosquito-id/issues/31)).
- **Reprocessing after an engine switch** ([#45](https://github.com/corneliusroemer-agent/mosquito-id/issues/45)),
  and the whole-photo toggle's frozen-or-crashed behaviour
  ([#42](https://github.com/corneliusroemer-agent/mosquito-id/issues/42)).

### Documentation

- The investigation write-ups and their index
  ([#6](https://github.com/corneliusroemer-agent/mosquito-id/pull/6),
  [#7](https://github.com/corneliusroemer-agent/mosquito-id/pull/7)), the distillation
  frontier on culico-net-cls-v1 ([#12](https://github.com/corneliusroemer-agent/mosquito-id/pull/12)),
  and **the standing record of what Cornelius wants**
  ([#14](https://github.com/corneliusroemer-agent/mosquito-id/pull/14)).

### Testing / Reliability

- **Two tiers of browser tests, a strip spec, and two thumbnail fixes**
  ([#17](https://github.com/corneliusroemer-agent/mosquito-id/pull/17), `6ad4eaf`) — part of
  [#33](https://github.com/corneliusroemer-agent/mosquito-id/issues/33).
- **Only the selected model's ONNX is fetched**, asserted
  ([#15](https://github.com/corneliusroemer-agent/mosquito-id/pull/15), `ff069e7`).

### Internal

- **The confidence subsystem extracted into tested TypeScript modules**, and the app wired to
  the extracted modules so the tests exercise what ships
  ([#2](https://github.com/corneliusroemer-agent/mosquito-id/pull/2), `a85b09c`, `6f50cc1`).
- **`main.js` split into modules**: 12 extractions, 3125 → 2065 lines
  ([#11](https://github.com/corneliusroemer-agent/mosquito-id/pull/11), `60f14e3`) — addresses
  [#34](https://github.com/corneliusroemer-agent/mosquito-id/issues/34), partially: the size
  half is done, the type-checking half is not.
- **The build's commit SHA is stamped into asset URLs on every deploy** (`0e48727`) and into
  the page URL as `?build=` ([#26](https://github.com/corneliusroemer-agent/mosquito-id/pull/26)).
- **Layout stability, a long run of shifts removed**: photos no longer resize the page as they
  load and get deleted (`e4ba253`), the page no longer sizes itself to its content (`19b72ad`),
  every results row has a fixed shape (`2d1b4b0`), the score panel stops shifting when a photo
  enters or leaves pending (`48fa707`), cards stop toggling display (`ef3b388`), and both top
  cards are the same height (`edf4e99`).
- **INT8 removed** — it cost accuracy and a rejected crop its pool place
  ([#27](https://github.com/corneliusroemer-agent/mosquito-id/pull/27), `194fa53`).
- **The crop geometry is drawn from one predicate, so both panels always agree** (`e6a5ff6`),
  and a drag is mapped through the cover window before storing (`bed0010`, `c7c93d0`).
- **The Svelte rewrite parked**; precision work moved out from under it
  ([#9](https://github.com/corneliusroemer-agent/mosquito-id/pull/9)), and
  `investigations/` made the ground truth for every report
  ([#8](https://github.com/corneliusroemer-agent/mosquito-id/pull/8)).
- **The deploy workflow's indentation restored**
  ([#3](https://github.com/corneliusroemer-agent/mosquito-id/pull/3)).

## Known issues at this point

Open, and cross-referenced above where a change touches them:

- [#85](https://github.com/corneliusroemer-agent/mosquito-id/issues/85) — the whole-frame
  toggle has no effect on the aggregate scores.
- [#83](https://github.com/corneliusroemer-agent/mosquito-id/issues/83) — the footer shifts
  layout while the per-step timing text changes width.
- [#81](https://github.com/corneliusroemer-agent/mosquito-id/issues/81) — cross-split
  near-duplicate leakage is unchecked.
- [#41](https://github.com/corneliusroemer-agent/mosquito-id/issues/41) — the default engine
  is unusable on Firefox (`writeBuffer` >2 GB, then `std::bad_alloc`).
- [#75](https://github.com/corneliusroemer-agent/mosquito-id/issues/75) — the detector's
  confidence collapses on sharper photographs, which no threshold change reaches.
- [#76](https://github.com/corneliusroemer-agent/mosquito-id/issues/76) — tier-1 e2e fails a
  different test on every run, including on unmodified `main`.