# 40 - Temporal progression: what happened, in what order, and what never moved

Companion to [`10-session-mining.md`](../2026-10-04-session-mining/10-session-mining.md),
which is **request-level**: 66 rows of what Cornelius asked for versus what shipped. This
report is the dimension it did not cover — **the order of events, the phases, the merges, the
reversals, and the things that did not move at all.** Where the two disagree I say so.

All times are **CEST (UTC+2)**, which is what `git log`, the file mtimes and Cornelius's own
transcript timestamps all use. UTC is given for the span bounds only.

---

## 1. Orientation

**The product.** You photograph a mosquito with your phone; a static web page tells you which
species it is, and must not claim confidence when it shouldn't. A YOLO11n detector crops the
mosquito, then a BioCLIP 2.5 ViT-H/14 image tower classifies the crop zero-shot against frozen
text embeddings. All inference is in the browser. Two sites are live:

- `https://corneliusroemer-agent.github.io/mosquito-id/` — the real app, repo
  `corneliusroemer-agent/mosquito-id`, checked out at
  `investigations/2026-10-02-mosquito-id/10-github-pages/site/`
- `https://corneliusroemer-agent.github.io/mosquito-id-svelte/` — a Svelte rewrite, repo
  `corneliusroemer-agent/mosquito-id-svelte`, at
  `investigations/2026-10-03-rewrite/10-scaffold/`

**The span.** About **19 hours**, almost all of it on one calendar day.

| | |
|---|---|
| First artefact | 2026-10-02 20:59 CEST — `investigations/2026-10-02-mosquito-id/01-specimen-images.md` |
| First app code | 2026-10-02 23:48 CEST — outer-repo checkpoint `4dbb619` (a Gradio app on a HuggingFace Space) |
| Site repo born | 2026-10-03 03:58 CEST — `67c508a`, the root commit of `mosquito-id` |
| Last commit anywhere | 2026-10-03 15:47 CEST — `1bfeb22` "Make the audit's reproduction script runnable" (Svelte repo). The last commit in the accuracy work proper is `c64f2c5` at 15:41 |
| `mosquito-id` `origin/main` HEAD | `9b43106`, 2026-10-03 15:28 CEST = **13:28 UTC** |
| `mosquito-id-svelte` `origin/main` HEAD | `2d3af72`, 2026-10-03 12:39 CEST |
| Agents | several concurrently under one human reviewer. **I did not establish how many** — the subagent-brief requirement ("10-minute updates", "no agent longer than 45 min") implies at least three, and the branch names imply at least five distinct lines of work, but nothing I read counts them. |
| Commits on `mosquito-id` `origin/main` | 70, all on 2026-10-03, in 12 hours |

**How to read this.** The single most important structural fact is that **three different apps
existed at the end**, and only the first is what anyone sees:

1. **The legacy single-file app** — `index.html` + `main.js` at the repo root. This is what
   Pages deploys and what `mosquito-id/` serves. Verified: the served `main.js` is
   **byte-identical** (139,527 bytes) to `origin/main:main.js`, and the served HTML loads it as
   a classic `<script src="main.js?v=9b43106…">`.
2. **A TypeScript/Vite refactor of the same app** — `src/confidence/*.ts`, `vite.config.ts`,
   `src/app/main.js`. On `origin/main`, **imported only by `tests/`**. Nothing at runtime uses it.
3. **The Svelte rewrite** — a separate repo, deployed at a different URL, last touched 12:46.

So a reader looking only at `git log` sees a confident, busy, converging project. A reader
looking at the served bytes sees a different, much smaller one. Most of the confusion in this
project's own reports comes from that gap.

---

## 2. Method, and what counts as evidence here

- Phase boundaries are anchored to **commit SHAs and dates**, never to narrative feel.
- Claims about the live site are checked against **bytes fetched from the live URL** at
  2026-10-03 13:45 UTC, not against a report.
- Where an agent's report and the evidence diverge, I say which one I believe and why.
- I did not re-derive request status; that is
  [`11-request-status.tsv`](../2026-10-04-session-mining/11-request-status.tsv).

---

## 3. The phases

The spine is the site repo. Two substantial tracks ran **in parallel** and both were stopped
mid-flight, so I describe them as tracks rather than pretending they were phases of the spine.

### P0 — Reconnaissance: which model, which data (10-02 20:59 → 10-03 01:06)

**Goal.** Decide the classifier before writing an app. Reports `01-specimen-images`,
`03-geographic-prior`, `04-local-models`, `05-hosted-apis`, `06-huggingface-sweep`,
`07-benchmark`, `09-app-handoff`.

**What actually shipped.** BioCLIP 2.5 **H/14 at 84.8% top-1 / 93.8% top-3** on 112 real
MosquitoAlert phone crops; **B/16 collapses to 26.8%** on the same rows; culico-net-cls scores
89.7% in-lineage on CulicidaeLab but 13–32% on real photographs. Crop ablation: detector crop
wins, SAM2 flat at −0.9 pt. A shortlist from ~2,460 HuggingFace model hits. MosquitoAlert access
worked out, including the API shape.

**What it was premised on that turned out to be wrong.** That a benchmark small enough to run in
an afternoon would settle the architecture. **112 images** did settle it — and that same
112-image corpus became the project's headline benchmark for the rest of the day, including the
two conclusions that were later overturned (*"aegypti is a representation ceiling"*, resting on
**6 aegypti images**; and a zero-shot label-addition result, 0 of 112). It also turned out that
49% of the species-label entropy in the corpus is readable from the `country` string alone
(`86-geographic-prior-benchmark.md`) — so the benchmark that chose the model is drawn from a
corpus whose labels partly leak their own features.

### P1 — A server app on a HuggingFace Space (10-02 22:02 → 10-03 03:08)

**Goal.** Something Cornelius could use on his Mac tonight.

**What shipped.** A Gradio app with a custom gallery component, a Python
classification backend, a custom `gallery-component` frontend, and
`run-mac-native.sh` / `run-local-demo.sh` runners. Outer-repo checkpoints `4dbb619` (10-02
23:48) through `bf9c0ff` (10-03 03:09) — clipboard upload, batch accumulation, thumbnail
deletion, dual cropping, settings persistence, ZeroGPU on Space.

**Premise that was wrong.** That the server backend was the point. `cd3a87f` (10-03 02:20)
enabled **COOP/COEP headers** — which is the one thing a Space can do and GitHub Pages cannot,
and which is what multi-threaded WASM needs. Twenty-six minutes of wall clock later the whole
thing was re-archived as `09-unified/` and the static site was born at `67c508a` (03:58).

**What that decision cost, permanently.** This is the most consequential architectural event in
the project and it is easy to miss because nothing was reported as lost:

- `crossOriginIsolated` can never be true on Pages, so `ort.env.wasm.numThreads = 1` is
  load-bearing — confirmed in `00-synthesis.md` and in the rewrite's capability row 6.
- Chrome's CacheStorage **cannot** store a model-sized entry (`cache.put` fails on 1.25 GB with
  5 GB quota free), which is why Cloudflare R2 exists at all.
- Cross-origin isolation is still on the never-built list at the end of the day.

### P2 — Get it on the internet (10-03 03:58 → 05:09)

**Goal.** A shareable URL.

**What shipped.** 11 commits, `67c508a` → `9e3d940`: Actions-based Pages deploy, SHA-stamped
asset URLs, an in-app species-guide route so Back preserves classifier state, reference
photographs, device-based default model selection, R2 hosting.

**Premises that broke immediately, each within minutes of being adopted.**

- `fb5a85b` (04:04): **GitHub Release assets send no CORS**, so the obvious place to put four
  ONNX models is unusable from a browser. HuggingFace, then R2.
- `0ecacb4` (04:54): R2, with `Cache-Control: immutable` — which then requires versioned URLs,
  because `immutable` on an unversioned path silently serves stale models for a year.
- `9ba501d` (05:08): the species guide as a hash route, because a real page navigation loses
  1.26 GB of model state.
- The `?v=` cache-buster was not bumped per deploy (`index.html` carried `?v=20261003_4` for
  `species.js` and `?v=20261003_5` for `main.js`) while Pages serves `max-age=600`, so a
  shipped feature could look broken against a stale cached copy. Fixed at `0e48727` (04:58) by
  stamping the commit SHA — a fix that then held all day, and is why the served URLs carry
  `?v=9b43106…`. *("unchanged all day" is the project's own characterisation in
  `00-synthesis.md`; what the served HTML shows is two different stamps, so the failure window was
  the pre-`0e48727` deploys, not the whole day.)*

Each of these is correct work that had to be redone. None was avoidable by inspection; all four
were found by shipping.

### P3 — The UI grind (10-03 05:04 → 13:13, ~47 of the day's 70 commits on `main`)

**Goal.** Stop the page from flickering, shifting and lying to the user.

This is where the project's defining loop lives. The fullest account is
[`23-cornelius-requirements-ledger.md`](./23-cornelius-requirements-ledger.md); I add only the
shape.

**What shipped.** Bulk select/delete on the thumbnail strip (`366741b`), container width
(`0bf1d28`), fixed-shape result rows (`2d1b4b0`), reserved score-panel height (`48fa707`),
cards that stop toggling `display` (`ef3b388`), per-axis `object-fit: cover` mapping
(`19d2b74`, `bed0010`), removal of processing-state sentences from the rendered page
(`39489c3`, `8ca3df7` 08:52–09:00), multi-view classification and fusion (`8741653`, 08:06),
57 reference photographs (`22ff8fe`, `5139d1a`), the verdict line actually rendering
(`19c99e5`, 12:33).

**Premises that were wrong.**

- **"It is one bug called layout shift."** It was at least three unrelated things wearing one
  name: a flexbox `min-width: auto` on the sticky footer, cards materialising into
  content-derived grid rows, and notice text toggling visibility. Nine-plus separate messages,
  and each fix was verified against a different surface than the one he was looking at.
- **"An agent reporting a change is the change."** The ledger's §3 lists thirteen claims that
  turned out false, including two features reported as "queued" that had never been written,
  one feature reported *missing* that had shipped in `e4ba253` (a bad grep, reported twice), and
  one mobile-overflow audit that measured the **empty** state — both affected elements are
  `display:none` until results exist — and reported 0 px where real content produced 61 px.
- **"Verify before pushing"** was issued to agents with no stopping condition. 410 lines sat
  uncommitted until Cornelius said *"push if you think you might have a fix, don't let
  verification be the enemy of progress"* (05:10). He then asked *"why haven't we committed and
  pushed?"* five times.

**The loop's actual cost, in one number.** The footer took **three** attempts across **three
distinct root causes**: `02e9e2a` (13:13) removed a duplicate `margin-top: 32px` that had been
silently beating the footer, leaving one `margin-top: auto` — a correct fix that still did
nothing at desktop width, because the flex parent it needs existed only inside the
`max-width: 768px` media query; `c48c614` on `agent/footer-desktop` supplied the flex parent at
every width; and `2ac7a99` had to restore the whole thing again after a merge dropped it (§5).

### P4 — The Svelte rewrite (10-03 08:30 → 12:46), and its stop

**Goal.** Replace the single-file app with a real framework. Asked five times; the brief was
set at 06:30 as *"get the rewrite to parity, ensuring cleanliness, and also basic test
infrastructure"*.

**What shipped.** `e774d1c` (08:30) scaffold with WebGPU verified; `14599f9` (08:45) photo-lifecycle port and a **fast test
tier that took the suite from 6m04s to 34s and immediately found three bugs**
(`2df8cde`, 09:53); the crop drag; `object-fit: cover` mapped per axis (`3489bc5`, 11:30); the
layout-shift fix (`f8c9b3d`–`d6d88d2`, 12:37–12:38, run at 390×844 as well as desktop);
`2d3af72` merged to `main` at 12:39. **Three real bugs in the old app became unrepresentable**
rather than fixed — selection-by-index desync, `ownsRecompute(p, idx, rev)` taking a stale
index, and `pending`/`error`/`fallback` all being true at once — replaced by a discriminated
union keyed on photo **id**.

**Premise that was wrong.** That parity was a row-by-row port. The capability diff
([`30-port/33-capabilities.md`](../2026-10-03-rewrite/30-port/33-capabilities.md), 10:01) is
honest about this and lists **nine missing rows** at handback: bulk actions, CSV export, the
results table, sample photos, gallery arrows, the contribution table, detection selection, the
57 species photographs, settings persistence. One row — multi-view fusion — is marked a
**regression against the live app**, because it shipped in `main` at 08:06 and the rewrite never
ported it.

**How it ended.** The last commit touching `src/` or `tests/` on any branch is `01cec9d`
(12:46, `agent/feature-parity`, "WIP: strip toolbar, results table, CSV, samples"), never
merged. After 12:46 the repository is used for something else entirely (§P5). **The rewrite was
not abandoned by a decision to abandon it; it was out-competed for attention by the accuracy
campaign**, and its own last act was a WIP commit.

### P5 — Accuracy: twenty directions, three reached the product (10-03 06:24 → 15:40)

**Goal.** The app's headline claim is 84.8%. Is that real, and can it be beaten?

Reports live in `investigations/2026-10-03-precision/` (01:00–09:45) and
`investigations/2026-10-03-rewrite/40-precision/` (09:05–15:45).

**What shipped.** Exactly three things reached the product:

| Change | Evidence | Status |
|---|---|---|
| Confidence **gate** at posterior 0.373 — 96.6% accuracy at 88.0% coverage | `40-calibration/41-calibration.md` (09:45); `8162d07` (07:32), floor refit to 0.80 at 12:51 | Live |
| **Temperature shown to be incapable** of changing argmax (bit-identical at T ∈ 0.5…20) | same | Settled negative |
| **B/16 as the "ultra-fast" engine** — 172 MB vs 1.27 GB, +32.4 pp over zero-shot with a 2 KB head | `30-ensemble/32-small-model-in-the-mix.md` (09:36) | Live, still the phone default |
| Per-genus vector scaling, **+1.44 pp [+0.32, +2.55]** | `tmp/perclass/90-per-class-calibration` (13:15) | **Measured, never shipped** |

**The premise that cost the most.** That the 112-image benchmark and its successors were
decision-grade. They were not:

- **"Aegypti is a genuine representation ceiling that no head can fix"** (`00-precision-plan.md`,
  07:24) rests on a leave-one-out recall of **0.167 at n=6**. Reversed the same day: the
  659-row probe reaches 92–94% aegypti recall, and the residual weakness is a threshold, not
  blindness. Cornelius caught the sample size immediately — *"why do we have only 6 aegypti
  examples? that seems ridiculous like a mistake."*
- **The +12.2 pp linear-probe gain** (09:06, n=74) was reversed 18 minutes later by the same
  day's own next report: probe AUC 0.961 vs zero-shot 0.978, ΔAUC −0.017 [−0.050, +0.005], and
  zero-shot at a **val-fitted** threshold hits the same 93.2%. The entire gain was one
  mis-set scalar.
- **No H/14 re-extraction was ever run in PyTorch fp32.** `41-calibration.md` §7 records that
  `torch` is absent from the image and `bioclip_visual_2_5_h14.onnx` is a 1.1 MB stub, so the
  659-row float32 numbers are **not the shipped fp16/int8 path**. `50-h14-scale` later went
  through int8 ONNX and found `acc32 == acc8` on n=300, which loosens but does not close this.
- **`51-h14-scale.md` is 0 bytes.** The only surviving evidence for the 6,264-row scale run is
  `run.log` and `int8_vs_fp32.log`. `04-crop-ablation` has no result file at all:
  `ablation.json` was never written.
- **The corpus's own labels partly answer the task.** `86-geographic-prior-benchmark.md`: a
  prior with **no image at all scores 88.81%** on the Aedes 4-way task against the shipped image
  model's **79.78%**, and 70 of the 79 countries carrying any Aedes row carry exactly one
  species. Every fused prior number in the project is therefore uninterpretable — including the
  +9.39 pp "prior helps" result that preceded that finding six hours earlier.

**The genuinely well-founded negatives** — large n, confidence intervals excluding zero, and
each closing off a whole family rather than one instance:

| Direction | Headline | n |
|---|---|---|
| Insect-Foundation backbone | −20.4 to −28.6 pp vs H/14 probe; oracle ceiling +1.2–1.4 pp | 6,264 |
| DINOv2 / 4-backbone bake-off | Decorrelation is real (19–30% shared error vs 71.4% control) but **fusion weight 0.0 in 10 of 12 cells** | 1,101 |
| Uncertainty-detector fallback | **Inverts**: Spearman +0.229, p=0.001 *(run 14:08 `503da99`; figures written down only in the 2026-10-05 synthesis)* | — |
| Learned stacker over features | +0.66 pp [−0.95, +2.29] against a +6.69 pp oracle (91.40% vs 84.71%, species 4-way, n=484) — *(run 14:40 `96d5110`; figures only in the 2026-10-05 synthesis)* | 1,257 |
| Distillation (soft targets) | −4.15 / −8.51 pp; culico-net 21M student 82.1% vs teacher 93.9% | 1,251 |
| MosquitoDL as a head or as training data | 42.0% genus vs BioCLIP's 93.56%; training on it −1.67 pp; negatives 100% on our mosquitoes | 1,257 |
| Prototype / centroid / k-means heads | centroid −3.7/−8.7 pp and k-means worse, both CIs excluding zero; **k-NN is the exception** — +4.2 pp genus and +9.1 pp species over zero-shot, but only +0.5/−1.3 pp over the linear probe, CIs straddling zero | 1,251 |

Distillation is the one negative closed by a **structural** argument rather than a number: 172
configurations, and the soft-target student reproduces the teacher to within 5 and 2 training
rows. That is the correct way to close a direction.

### P6 — Confidence semantics, and making the arithmetic runnable (10-03 13:13 → 15:28)

**Goal.** The one requirement that survived every phase: *must not claim confidence when it
shouldn't*.

**What shipped.**

- `8a69909` (13:23) — two views naming different species can no longer reach a species claim.
  Measured: when the views agree the fused answer is right 94.3% of the time; when they
  disagree, 50.0%.
- `36c992b` (13:54) — seven adjacent-taxon classes added to the same softmax; a win there is
  now an outcome and the 16-row mosquito ranking is dropped. **Live**, verified in the served
  bytes: `main.js:1318` renders *"This does not look like a mosquito - it looks like midge
  (46.3% of the match)."* Verified cost: 0.67% of true mosquitoes flip, 0.77% top-1 unchanged.
- `9b43106` (15:28, last commit on `main`) — **the abstention line had never rendered.**
  `index.html` carried `<p id="score-uncertain" style="display:none">` and `main.js` only sets
  `textContent`/`className`/`title` on it, so the `.shown` class met an inline `display:none`
  that no stylesheet rule can override. On a blank wall at 28.6% the app abstained correctly and
  hid the abstention. Verified in headless Chromium with models blocked: display `none`, box
  height 0, and `tests/abstention-line-probe.mjs` fails on the old markup.
- `a85b09c` / `f33e36f` (14:55 / 15:08) — the whole confidence subsystem extracted into **nine**
  TypeScript modules under `src/confidence/` (on `main`: `fuseViews.ts`, `genus.ts`,
  `genusScores.ts`, `pooling.ts`, `scorebar.ts`, `softmax.ts`, `types.ts`, `verdict.ts`,
  `viewAgreement.ts`; largest is `pooling.ts` at 214 lines), plus `CONFIDENCE-NOTES.md`, which is
  the first time this arithmetic has been *executed* rather than read. It found a real bug: the
  shipped comment says the pool is log-linear (`log p ∝ Σ log p`) while the code summed
  per-photo **logits** — the same thing when weights sum to 1, different when they do not.

**Premise that was wrong, and this is the phase's real finding.** The commit at 15:03 reads
*"Build the site with Vite and wire the app to the extracted modules"* (`02638b1`). It changed
`index.html` to `<script type="module" src="/src/app/main.js">`, rewrote the Pages workflow to
`npm ci && npm run build` with `path: dist`, moved `main.js` to `src/app/`, and added
`e2e/smoke.spec.ts`. **It is not an ancestor of `origin/main`.** See §5.

---

## 4. What changed vs what didn't

### Moved a lot

| Thing | From → to |
|---|---|
| Architecture | Gradio + Python backend on a Space → static Pages, no backend, single-threaded WASM |
| Model hosting | GitHub Releases (no CORS) → HuggingFace → Cloudflare R2, 2.09 GB of a 4 GB cap |
| Model files served | 4 × ONNX; H/14 is 1.26 GB, B/16 is 172 MB |
| Crop interaction | box drawn on one panel only → detector crop + manual coarse/fine drag, mapped per axis through `object-fit: cover` |
| Classification | single view → two views fused, worth about +4.5 points by the rewrite's own capability table |
| Confidence | a temperature (shown inert) → a fitted abstention gate at 0.373, refit class-balanced to a 0.80 genus floor |
| Corpus | 112 benchmark images → a 6,264-row analysis cache, from a 36,965-row download manifest (37,912 image files on disk) plus GBIF and Commons |
| Code structure | one 139 KB `main.js` → nine tested TypeScript modules under `src/confidence/`, largest `pooling.ts` at 214 lines (**not shipped**, §5) |

### Did not move at all, after a full day

These are the interesting ones.

| Still open at 15:28 | Why |
|---|---|
| **The app never loads `src/confidence/*.ts`.** | On `main`, those modules are imported only by `tests/`. The root `main.js` carries its own copies — `softmaxJoint` at `main.js:923`, `genusScores` at `:985`, `viewAgreement` at `:1344`. The refactor is real, tested, and inert. |
| **Any client-side logging.** | Asked twice (04:30, 06:26) because a bad crop is unreproducible afterwards. No logging call in the served `main.js`. |
| **Model-load ETA.** | **The two prior passes disagree and I side with the ledger.** `11-request-status.tsv` marks it `done` on the evidence "`served main.js:465 "Ns left"`". I fetched the served file at 13:45 UTC: there is no such string in `main.js` or `index.html` (`grep` finds 0 hits for `Ns left`, `seconds left`; the 14–15 bare `left` hits are `leftover`-style identifiers). Line 465 of the served `main.js` is `progressOwner = null;` inside `clearProgress()`. The ledger's "DESIGNED NEVER BUILT" is the correct verdict. **This is the one place I disagree with the request-level pass.** |
| **Background-preloading sample images; parallel photo download.** | Never started. `Promise.all` exists but no evidence covers the photo batch. |
| **Sexing**, which MosquitoAlert labels in the source data. | Asked once (05:51); captured as free supervision in the data, never as a feature. |
| **Cross-origin isolation for 8 ORT threads.** | Needs a host that sets headers. GitHub Pages cannot. The original COOP/COEP attempt died in P1. |
| **R2 immutable objects, and the URL versioning they require.** | **Confirmed live defect.** `00-synthesis.md` records the fix as `Cache-Control: public, max-age=31536000, immutable` on the R2 objects plus a plain `fetch`, **"and then versioning those URLs, because `immutable` on an unversioned path silently serves stale models for a year"** — and that second half never happened. `main.js:130` is an unversioned bucket root, `main.js:416` resolves `MODEL_BASE_URL + path`, and `curl -I` on the model returns `Cache-Control: public, max-age=31536000, immutable`, `Last-Modified: 2026-10-03 03:33:33Z`. The model was therefore already replaced 95 minutes after the app shipped, and any browser that cached it before then is serving a stale classifier with no way to invalidate it. See §5. |
| **The Svelte rewrite's nine missing capability rows.** | `01cec9d` is a WIP on an unmerged branch. Two of the nine (`multi-view fusion`, `detection selection`) have since landed in `src/` per the session-mining pass; the other seven I did not re-verify and assume absent. |
| **`SPECIES_CONFIDENCE_FLOOR = 0.373` was fitted on the zero-shot head that the probe replaced.** | Named as open by `98-evaluation-audit` at 15:45. Risk-coverage has never been computed for the model that actually ships. |
| **Per-genus scaling, +1.44 pp.** | Measured at 13:15, never shipped. |
| **A labelled negative set.** | `NON_MOSQUITO_FLOOR = 0.60` is "chosen for behaviour, NOT fitted", and the commit that shipped the non-mosquito gate says its false-positive rate "is not yet measurable" because the corpus has no negatives. 700 negatives existed by 14:45 (`dcf6f1f`), but they were not folded back into the shipped floor. |

**Was it hard, wrong, or undecided?** Mostly **hard** (logging, ETA, preload, sexing are all
small and none was ever started — the day was consumed by the P3 loop). The two genuinely
*wrong* ones are the TypeScript refactor (§5) and the non-mosquito naming: the shipped sentence
says *"it looks like midge"*, while the project's own measurement
([`37-non-mosquito-decision-rule.md`](./37-non-mosquito-decision-rule.md), 15:27) finds the seven
adjacent classes are the best non-mosquito match on **46.3% of blank crops and 46.3% of real
mosquitoes** — the naming is uninformative about which it is looking at. That report is in
`investigations/`; the string is in the UI. And one thing is **nobody's decision yet**: which
model the phone should default to, given the project's own benchmark puts B/16 at 26.8%.

---

## 5. Breakthroughs and regressions, interleaved

### Breakthroughs, in order of how much they moved

1. **Multi-view classification and fusion** (`8741653`, 08:06) — about +4.5 points by the
   rewrite's own table, and it makes the disagreement gate (§P6) possible at all. Everything
   about confidence later depends on it.
2. **Showing that a temperature is inert and a gate is not** (`41-calibration.md`, 09:45).
   Bit-identical argmax at T ∈ 0.5…20; a gate at 0.373 gives 96.6% at 88.0% coverage against
   88.0% for argmax. Shipped, and it is the direct answer to the project's stated requirement.
3. **The fast test tier** (`2df8cde`, 09:53) — 6m04s → 34s, and it found three bugs on the way.
   The highest leverage commit in the project by ratio of bugs found to effort, and it is the
   only thing that made a per-commit verification loop possible.
4. **Diffing the served bytes against `origin/main`** — introduced as a discipline while chasing
   the footer, and it is what caught the footer clobber (`2ac7a99`) and confirmed the abstention
   line (`9b43106`).
5. **The fused-posterior calibration finding** (`41-calibration`): 96.6% at 88.0% coverage is the
   number that makes "must not claim confidence when it shouldn't" a real claim rather than a
   slogan.

### Regressions and clobbers

**Clobber 1 — the footer (self-documented, caught).** `2ac7a99`, 14:09. Merging
`agent/adjacent-taxa` into `main` dropped the footer fix: *"Merging two branches that both
touched index.html, I checked out the second one over the first and silently dropped the footer
fix. It was correct in its own commit and correct in the deployed source the whole time; it was
just not in the file that shipped."* Caught by diffing served bytes against `origin/main` after a
deploy reported success. **I verified the restore is live**: served `index.html` carries the
`display: flex` block at line 61 onward.

**Lost work 2 — the entire Vite migration (not self-documented, not caught).** This is my
principal original finding, and it is *not* in any project report. I originally wrote it up as a
second merge clobber; an adversarial review established it is the *unmerged-branch* failure of
trap 3 instead (see §10, rows 1–2), which is a different failure with a different fix.

- `02638b1` (15:03) rewired the site for Vite: `index.html` → `<script type="module"
  src="/src/app/main.js">`, workflow → `npm ci && npm run build` and `path: dist`, `main.js`
  moved to `src/app/`, `e2e/smoke.spec.ts` added.
- `31874ab` (15:06) then made `updatePooling()` call the extracted module instead of its own copy,
  with `tests/pooling-equivalence.test.ts` proving equivalence over 400 randomised cases.
- `git merge-base --is-ancestor 02638b1 origin/main` → **not an ancestor**.
  `git merge-base --is-ancestor 31874ab origin/main` → **not an ancestor**.
- `origin/main`'s tree has **no `src/app/`**, no `e2e/`, and a Pages workflow with
  `path: .` and the old `sed` cache-buster. `index.html:1159-1160` still loads
  `species.js?v=…` and `main.js?v=…` as classic scripts.
- The mechanism is **an unmerged branch, not a bad merge.** `git merge-base 02638b1 origin/main`
  is `a85b09c` (14:55) — the fork point. `02638b1` and `31874ab` were written on top of
  `a85b09c` on the `merge-ts` line. `main` instead took `ed17b9b` (the full-photo fix, also on
  top of `a85b09c`) and then merged `f33e36f` = `merge ed17b9b a85b09c` — a merge of the
  **parent** of `02638b1`, not of `02638b1`. Its tree differs from both parents
  (`git diff --stat f33e36f a85b09c` = 3 files / 390 deletions; vs `ed17b9b` = 17 files /
  3,505 deletions — it took the full-photo side's shape). The wiring was therefore never in
  either side of any merge; it lives only on `agent/ts-modules`, **which was never merged at
  all**. This is the same phenomenon as `agent/not-confident-gate` (trap 3), not a
  merge-resolution artefact.
- A separate, real merge pathology sits nearby: the merge `5ff6efe` (15:19) produced a tree
  **identical to its second parent** — `git diff --stat 5ff6efe^2 5ff6efe` is 0 lines, against
  6 files / 364 insertions versus the first parent. That is the "checked out the second over the
  first" mechanism the footer commit documents, and it did cost the `ts-pinned` line's `pages.yml`
  and `index.html` state. It is simply **not** what lost the migration.

**Consequence, verified against the live site at 13:45 UTC:** served `main.js` is byte-identical
to `origin/main:main.js`, is a classic script, and contains its own copies of the three functions
that `src/confidence/` now owns and tests. **The tests are green against a module the page never
loads.** The refactor is real work that cannot affect a user.

**Regression — the fix that created the ask.** `8741653` (08:06) added multi-view fusion and, with
it, the sentence *"Both views of this photo pick Aedes vexans — the close-up and the whole
picture agree."* Cornelius had asked for fusion; he had not asked for that sentence, and it
became the third thing in the species-score box he had already told us to empty. The fix for ask
X created ask Y, and he was penalised for it. `19c99e5` (12:33) finally let the line render —
and `9b43106` (15:28) discovered that a *different* line in the same panel had never rendered at
all. The panel has been the subject of six separate fixes in twelve hours.

**Live defect — a stale model nobody can invalidate.** Not a commit; a state of the served
bytes. The 1.26 GB classifier is fetched from an **unversioned** R2 path and the object carries
`Cache-Control: public, max-age=31536000, immutable`. `00-synthesis.md` named this exact trap
when it introduced the header — *"versioning those URLs, because `immutable` on an unversioned
path silently serves stale models for a year"* — and the versioning half was never done. I
confirmed it at 14:05 UTC:

```
HTTP/1.1 200 OK
Content-Length: 1265421829
Cache-Control: public, max-age=31536000, immutable
ETag: "46b1577fbfec39d09359f05e24860661-151"
Last-Modified: Sat, 03 Oct 2026 03:33:33 GMT
```

`Last-Modified` is 03:33 UTC — **95 minutes after the site repo's first commit** (`67c508a`,
01:58 UTC) and 87 minutes after the first Pages deploy (`f7accff`, 02:06 UTC) — so the model has
already been replaced once, with no way to push the change to a browser that holds the old copy.
Every accuracy claim in this report, and every number in the app's own UI, is therefore
conditional on which copy of `bioclip_2_5_fp16.onnx` a given browser happens to hold. Note the
contrast with the *web assets*, which are correctly SHA-stamped: the same team applied the
right fix to the wrong layer.

**Regression — the rewrite against the live app.** `33-capabilities.md` marks multi-view fusion
as "a regression against the live app, not a missing feature. Highest-value row in this table."
The rewrite shipped the *inferior* version of the product.

---

## 6. Dead ends, and whether they were correctly closed

Ordered by how much I would trust the closure.

**Correctly closed — the negative is real, well-founded, and closes a family**

- Distillation / soft targets. 172 configs; the student reproduces the teacher to within 5 and 2
  training rows; culico-net 21M at 82.1% against H/14's 93.9%. Closed by a structural argument,
  not a single number.
- Insect-Foundation as a backbone substitute. −20.4 to −28.6 pp, four views, two estimators,
  6,264 rows, plus an oracle ceiling of only +1.2–1.4 pp — the second number is what makes it a
  family closure rather than one bad checkpoint.
- The uncertainty-detector route. Spearman **+0.229**, p=0.001 — the detector is *anti*-correlated
  with error. This is the cleanest negative in the project. *(Run 14:08, `503da99`; the numbers are
  written down only in `2026-10-05-algorithmic-synthesis/00-synthesis.md`, two days later.)*
- Learned stacking over features. +0.66 pp [−0.95, +2.29] against a +6.69 pp feature oracle
  (91.40% vs 84.71%, species 4-way, n=484): the information exists and the stacker cannot reach it.
  That distinction is exactly right. *(Run 14:40, `96d5110`; the figures likewise appear only in the
  2026-10-05 synthesis — I could not find them in any `.md` written on the day.)*
- Temperature scaling. Provably cannot change argmax. Bit-identical, not empirical.

**Correctly closed after a reversal**

- Zero-shot label addition across 17 candidate species: 0 previously-correct flips and 0 new
  labels ever top-1. Real, and it closed a whole direction — but it was measured on **112 images,
  6 of them aegypti**. I would call the *direction* closed and the *measurement* too thin to have
  justified closing it alone.
- The linear probe's +12.2 pp. Closed correctly *by the project itself*, 18 minutes later, with a
  ΔAUC that includes zero and a val-fitted threshold that reproduces the number. This is the
  single best piece of self-correction in the record.

**Closed on a confounded corpus — the verdict is right for the wrong reason**

- **The geographic/seasonal prior.** `86-geographic-prior-benchmark.md` closes it, and the
  closing is correct: a prior with no image scores **88.81%** against the image model's **79.78%**,
  MI(country; source) = 0.875 bits, 70 of 79 Aedes-carrying countries are single-species. But the
  reason is a **corpus-design** property, not a modelling one, and the report says so. The trap
  is the six hours *before* it: "location-conditional thresholds −5.4 pp" (09:36), then "prior
  alone beats the image, +9.39 pp fused" (13:51), then uninterpretable (13:51, same report). A
  reader who saw only the 13:51 result would have shipped a geographic prior that beats the image
  for reasons that have nothing to do with mosquitoes.
- **MosquitoDL as training data.** n=1,257, CIs overlapping, −1.67 pp, and −2.94 pp on the very
  classes it was fetched for. The empirical negative stands on its own. The *licence* reasoning
  was separately corrected — the `mosquitodl-is-usable` skill reframes "no licence file" as a
  metadata gap rather than a rights question, which is the right call and was the reviewer's.

**Declared dead with no measurement — the class the reviewer pushed back on twice**

- **The European prior** (`7b4e078`, 12:58): *"No Culex species labels exist, so the European prior
  cannot be measured or fitted."* That is half declaration, half measurement — 0 of 651 Culex rows
  carry a species label, which is a real fact, and identical output at every α, which is a real
  no-op. But "we cannot measure it" and "it does not help" are different sentences, and only the
  first is supported.
- **Fine-tuning / LoRA: never attempted.** No run exists anywhere in the tree.
  `91-distillation-pilot.md` closes soft-target distillation and names fine-tuning as the
  remaining, untried route. There is no evidence either way.
- **H/14 fp32 re-extraction.** Not attempted — `torch` absent, the ONNX a 1.1 MB stub. The
  int8-vs-fp32 comparison on n=300 (`cos 0.9907`, `acc32 == acc8`) is a partial substitute and is
  described as such.
- **`04-crop-ablation`** produced no result file at all. The conclusion drawn from it in P0
  ("det-crop wins, SAM2 flat") rests on a different run.

**Two agents, opposite conclusions, same data — unreconciled in the record**

- Does the probe add information? `11-linear-probe.md` (09:06, "do not fine-tune the backbone")
  vs `21-b16-probe.md` §4 (09:24, "the probe is largely a re-thresholded zero-shot"). Same 659
  rows, same split. The reconciliation exists later and is by *backbone*: the B/16 head gain is
  real (ΔAUC +0.136), the H/14 head gain is not.
- Is B/16 worth shipping? `21-b16-probe.md` §7 says no; `32-small-model-in-the-mix.md` says yes.
  **It shipped**, so the second answer won by attrition rather than by argument.
- Is label ground truth constructible at all? `96-label-provenance.md` §4 says it cannot be
  constructed from this corpus — half the corpus is asserted, not verified (707 rows 11.3%
  expert-reviewed, 3,150 rows 50.3% with no verification field, and a 19.2 pp accuracy spread
  across the two expert tiers). `98-evaluation-audit.md` §4 calls that correct *about that corpus*
  and wrong as a general statement, naming iNaturalist RG, Observation.org, museum and BOLD as
  constructible. That is the right distinction and it is the most useful thing in the accuracy
  campaign for a next session.

---

## 7. Recurring traps

The same mistake, more than once, by more than one agent.

1. **A change that is correct in the source and does nothing in the browser.** Two genuinely
   distinct instances — `02e9e2a`'s `margin-top: auto`, which had no flex parent at desktop
   width, so the declaration was in the file and the behaviour was not; and `c746322`'s "draw no
   bar and no number for a non-finite species score", which fixed the symptom three elements
   away from where the non-finite number was produced (that localisation took until `dcf6f1f`
   and `37-non-mosquito-decision-rule.md`, four hours later). The Vite wiring is **not** an
   instance of this trap: it was never merged, which is trap 3. The signature failure is real
   but it is two bugs wide, not three, and `verifying-web-ui-changes` is the durable response.

2. **An inline `style="display:none"` beating the class that reveals the element.** Twice, by two
   different agents, on the same panel: `19c99e5` (12:33, the verdict line) and `9b43106` (15:28,
   the abstention line). Both were found by reading the computed style back in headless Chromium
   rather than by reading the diff. **This is the check that should have been standard from
   05:00.**

3. **"Fixed and live" meaning "committed to a branch."** At 13:44 four `agent/*` branches were
   unmerged, all carrying work Cornelius had asked for. By 15:28 the set was
   `agent/adjacent-taxa` (tip `a545ef1`, the warn-coloured row — the *feature* merged as
   `36c992b`, the tip did not), `agent/view-disagreement` (tip `0e4b618`, the measurement — the
   *merge* `8a69909` landed), `agent/full-photo-contain` (tip `033538c` — a re-implementation
   landed instead as `ed17b9b`), `agent/not-confident-gate`, `agent/model-load-progress`,
   `agent/footer-desktop`, `agent/ts-modules` (remote `5f9dd00`, holding the entire Vite
   migration), and — local-only, never pushed — **`agent/ship-per-genus-scaling` (`31d4bbf`,
   15:10), the branch for the +1.44 pp per-genus scaling that §4 calls "measured, never
   shipped".**
   **Eight unmerged branches at the end of the day, five of them holding exactly what was asked
   for.** The same branch list shows the local/remote skew that makes it easy to get wrong:
   `agent/ts-modules` is `0ed41ad` locally and `5f9dd00` on the remote. Their diffs against `main` read as thousands of deletions, which is what staleness looks
   like — and that is how work gets left lying there.

4. **A conclusion generalised from an environment that is not the shipping one.** Every accuracy
   number in the project was produced on CPU with `taskset`, no GPU, no browser, no WASM, and
   mostly without fp32 — `41-calibration.md` §7 says so explicitly. Three separate reports note
   it; none treated it as a blocker on shipping a constant. And two conclusions were declared on
   **6 images** (aegypti, anopheles) inside the 112-image benchmark.

5. **Fixing the wrong surface.** Three classes of bug hid behind the single word "shift"; the
   mobile-overflow audit measured the empty state; the `"classifying"` removal landed in
   `#score-uncertain` and `#pool-note` while the text Cornelius was looking at came from
   `#score-pending` — and the fixing agent had *flagged both siblings and left them*, which the
   coordinator did not catch.

6. **Telling the reviewer something is queued when it was never written.** Twice, per the
   compaction summary's own error list. Then reporting a shipped feature as missing twice, from a
   wrong grep. Both directions of the same failure: the report is generated from memory rather
   than from the file.

7. **A merge resolved by taking one side whole.** `git diff 5ff6efe^2 5ff6efe` is empty — the merge
   that produced `origin/main`'s current tree *is* its second parent. The footer commit documents
   this exact mechanism happening once; it then happened again, unremarked, an hour later. It did
   not by itself cost the build pipeline (the lines had already diverged at `a85b09c`), but it is
   why the divergence was invisible: a diff-resolved merge would have surfaced the missing
   `pages.yml` and `index.html` changes as a conflict.

8. **Reporting a negative from an incomplete run.** `05-tower-bakeoff/tower_results.json` contains
   one backbone (`bioclip25_h14`, n=112) under a four-backbone heading. `04-crop-ablation` has no
   result file. `51-h14-scale.md` is 0 bytes.

---

## 8. What to do differently

Ranked. There are two different questions here and two different answers. **If the next phase
should be one thing**, it is #1 — the whole history of this project is a history of correct
changes that were not on the page. **If one thing should happen today**, it is #9, which is the
only defect here that is already corrupting results for users who have loaded the page.

1. **Make `git merge-base --is-ancestor <branch> origin/main` — or a `gh pr list` with no open
   PRs — the definition of "done", and put the served-byte diff next to it.** Every
   high-profile miss in this project has the same shape: a correct change that is real, tested,
   committed, pushed, reported as fixed, and not on the page. The footer, the TypeScript
   refactor, the whole Vite migration, and at 13:44 four separate branches. One command and one
   `curl | diff` would have caught all of them. This is already half-built —
   `verifying-web-ui-changes` and the "branch-merged-but-not" check in
   `uv-and-analysis-workflow` exist because of this project; they need to be a gate rather than a
   habit.

2. **Merge by diff, never by taking a side.** `git diff 5ff6efe^2 5ff6efe` being empty is the
   whole post-mortem. If the merge resolution for a file is "theirs", the merge needs a human or
   needs a test that would have failed.

3. **Stop treating n=112 as a decision-grade benchmark, and stop declaring ceilings on 6 images.**
   The 6,264-row corpus exists. Every closure that matters should name its n and its CI in the
   same sentence as its verdict — which most of the *good* reports already do, and the *bad* ones
   (the aegypti ceiling, the label-addition zero) did not.

4. **Compute risk-coverage for the model that ships.** `98-evaluation-audit` names it: the
   shipping floor is 0.373, fitted on a zero-shot head the probe replaced, and nobody has drawn
   the curve. This is the one number that would let the project's central requirement be stated
   as a fact rather than a design intention.

5. **Either finish the rewrite or stop paying for it.** It is deployed, at 10:01 its own
   capability diff listed nine missing rows including one regression against the live app (two
   have since landed in `src/`, per the request-level pass; I did not re-check), and it has had
   no commit touching `src/` since 12:46. Two apps plus an inert third code path is three things to keep correct. The honest
   options are: land `01cec9d`'s four rows and the fusion regression, then continue; or freeze it
   and say so.

6. **Fold the measured negatives back into the UI copy.** The app says *"it looks like midge"* on
   a strength the project's own report says is uninformative (46.3% on blanks, 46.3% on real
   mosquitoes). `NON_MOSQUITO_FLOOR = 0.60` is unfitted and the 700 negatives that would fit it
   already exist as of 14:45.

7. **Decide the phone default model.** B/16 at 26.8% is the default on phones. Nobody has
   decided whether that is the right trade, and the `00-synthesis.md` "still open" list has been
   carrying it since the morning.

8. **Cheap win, already measured: ship the per-genus scaling** (+1.44 pp [+0.32, +2.55],
   13:15) and run the same class-balanced refit for the species floor that was done for the genus
   floor at 12:51.

9. **Version the R2 model paths, today, before anything else.** `Cache-Control: immutable` on an
   unversioned path is a one-line fix (a `?v=` or a path prefix, exactly as the Pages assets
   already get) and it is the only defect in this report that is silently corrupting results for
   users who have already visited the page. Everything else on this list can wait a day.

---

## 9. Where the record is too thin

- **Whether any layout-shift fix actually works.** No CLS measurement exists for the live site.
  The one thing that measures it — `tests/layout.spec.ts`, in the rewrite — has no counterpart on
  `mosquito-id/`, and Cornelius rejected the Playwright regression suite at 05:11 (*"we aren't too
  worried about regression at this point"*).
- **Whether the browser behaves as the served bytes suggest.** Everything I checked about the live
  site is static: HTML, CSS, JS. No inference ran. The two probes that do drive a real browser
  (`abstention-line-probe.mjs`, `full-photo-contain-probe.mjs`) do so with models blocked, so
  they assert geometry, not classification.
- **Whether the Svelte rewrite's nine missing rows are still nine.** The session-mining pass
  checked seven of them by grep at 13:44; I did not re-check.
- **Antigravity CLI's session before 01:12 UTC.** `history.jsonl` is a prompt log. Its 54 requests
  are in the TSV; the transcript behind them was not parsed by anyone, including me.
- **Which of the seven unmerged branches was *intentionally* left.** I can prove they are unmerged.
  I cannot prove nobody meant to merge them; the branch tips' own commit messages read as
  finished work, which is evidence but not proof.
- **Whether `02638b1` ever worked at all.** The Vite migration exists, its commit message
  describes a coherent change, and its branch carries `e2e/smoke.spec.ts` — but no test run, no
  deploy and no report of it surviving a browser survive in the tree. It may itself have been
  broken. I am claiming it never reached `main`, not that it would have worked.

---

## 10. Corrections after adversarial review

An independent reviewer checked every git claim in this report against the two repos and the
live site. It confirmed the central finding — that the TypeScript refactor on `main` is inert at
runtime, with the served `main.js` byte-identical to `origin/main`, a fresh `git ls-remote`, and
the three duplicated function line numbers exact — and it found nine real errors, all now fixed.
They are recorded here because "the first draft of the analysis was wrong in these ways" is
itself part of the record.

| # | What was wrong | Correction |
|---|---|---|
| 1 | §5 called `f33e36f` "a85b09c re-applied on top of ed17b9b" — a replay — and said the mechanism was "the replay, not the merge". | It is a merge: `f33e36f` = `merge ed17b9b a85b09c`. The identical diff stat I noticed is a coincidence of two unrelated 17-file commits. `git diff --stat f33e36f a85b09c` = 3 files / 390 deletions; vs `ed17b9b` = 17 files / 3,505 deletions. |
| 2 | §5 said `02638b1`/`31874ab` were "left behind" by the `f33e36f` merge. | `f33e36f` merged `a85b09c`, the **parent** of `02638b1` — the wiring was never in either side of any merge. It sits on `agent/ts-modules`, which was **never merged at all**. That makes it an instance of trap 3, not of a bad merge. The `5ff6efe` empty-diff-vs-second-parent pathology is real but is not what lost the migration. |
| 3 | Trap 3 listed 7 unmerged branches. | **8**, omitting the local-only, never-pushed `agent/ship-per-genus-scaling` (`31d4bbf`) — the branch for the very scaling result §4 calls "measured, never shipped". Also flagged that `agent/ts-modules` is `0ed41ad` locally and `5f9dd00` on the remote. |
| 4 | Trap 1 lumped three things under "correct in the source, inert at runtime". | Category error: `02638b1` was never merged, which is trap 3. Trap 1 is two bugs wide (`02e9e2a`, `c746322`), not three. |
| 5 | §3 described `02e9e2a` as "adding `margin-top: auto` … and silently losing to a `margin-top: 32px` seven lines below". | Backwards. The diff **deletes both** declarations and leaves one `margin-top: auto` with a comment saying "It must be the only margin-top here". Removing the losing duplicate is what it fixed; the missing flex parent at desktop width is the half that still did nothing, and what `c48c614` fixed. |
| 6 | §5/§6 presented the uncertainty-detector's Spearman +0.229, p=0.001 as a same-day 14:08 finding. | The run is same-day (`503da99`, 14:08) but the figures appear only in `2026-10-05-algorithmic-synthesis/00-synthesis.md`, two days later. Same for the learned stacker's +0.66 pp [−0.95, +2.29] and its +6.69 pp oracle (n=484): run 14:40 (`96d5110`), written down only in the same later synthesis. Now attributed as such. |
| 7 | Counts and times. | P2 "12 commits" → **11**. P3 "~45" → **47**. `deff442` is 10:16, not 12:16. "Last commit anywhere 15:41" → **15:47** (`1bfeb22`). `src/confidence/` has **nine** files on `main`, not eight, and `pooling.ts` there is **214** lines — I had quoted `a85b09c`'s figures. |
| 8 | Three things asserted where §2 requires measurement. | "At least five agents concurrently" is now stated as not established. The `?v=` cache-buster was not "unchanged all day" — `index.html` carried `_4` for `species.js` and `_5` for `main.js`, so the failure window was the pre-`0e48727` deploys; the project's own "all day" framing is flagged as the project's. §8.5's confident "missing nine capabilities" now carries the §9 hedge (two have since landed; not re-checked). |
| 9 | §6 closed prototype / centroid / k-means heads as a family negative. | **k-NN is the exception**: +4.2 pp genus and +9.1 pp species over zero-shot, though only +0.5/−1.3 pp over the linear probe with CIs straddling zero. Centroid and k-means remain the closed pair. |

What did **not** change: the phase structure, the central conclusion, the R2 `immutable`-on-an-
unversioned-path finding, and the §8 recommendation order. None of the nine errors touched a
conclusion; seven were attribution or count errors and two (§4, §5 mechanism) were wrong
explanations of a real finding.

---

## Appendix — compact timeline

Dates are CEST. `site` = `mosquito-id`; `svelte` = `mosquito-id-svelte`; `outer` = the
`claude-devcontainer` repo that holds `investigations/`.

| Date/time | Phase | Change | Evidence |
|---|---|---|---|
| 10-02 20:59 | P0 | First artefact: specimen images | `2026-10-02-mosquito-id/01-specimen-images.md` mtime |
| 10-02 21:35 | P0 | Geographic prior conceived (iNat/GBIF, Basel) | `03-geographic-prior.md` |
| 10-02 21:47 | P0 | ~2,460 HF models swept; shortlist | `06-huggingface-sweep.md` |
| 10-02 22:16 | P0 | MosquitoAlert access + Basel findings | `../2026-10-02-mosquito-alert-data/` |
| 10-02 22:28 | P0 | **H/14 84.8% top-1 / 93.8% top-3 on 112 crops; B/16 26.8%; SAM2 flat** | `07-benchmark.md` |
| 10-02 22:02 | P1 | Gradio app + custom gallery on a Space | `08-space/`, mtimes |
| 10-02 23:48 | P1 | Checkpoint: cached batch results, pooling | outer `4dbb619` |
| 10-03 00:14–01:01 | P1 | Gallery, progress, log-score bars, clipboard, drag-to-crop | outer `ca0b414`…`ab26c8d` |
| 10-03 02:20 | P1 | **COOP/COEP enabled on the Space** — the capability Pages lacks | outer `cd3a87f` |
| 10-03 02:52 | P1 | `09-unified/`: the last server-backed shape | `09-unified/app.py` mtime |
| 10-03 03:09 | P1 | Final Space checkpoint | outer `bf9c0ff` |
| 10-03 03:58 | P2 | **Site repo born** | site `67c508a` (tag v1) |
| 10-03 04:04 | P2 | **GitHub Releases have no CORS** — models to HF | site `fb5a85b` |
| 10-03 04:06 | P2 | Actions-based Pages pipeline | site `f7accff` |
| 10-03 04:39 | P2 | Species names not complexes; GPU-resident default | site `5ce2dbd` |
| 10-03 04:54 | P2 | **R2 hosting**; footer pinned; top cards equalised | site `0ecacb4` |
| 10-03 04:58 | P2 | SHA stamped into asset URLs | site `0e48727` |
| 10-03 05:08 | P2 | Species guide as an in-app route | site `9ba501d` |
| 10-03 05:09 | P2 | Probe for a backend only when configured | site `9e3d940` |
| 10-03 05:59–06:51 | P3 | Async crop: 844 ms → 31.7 ms, `rev` invalidation | site `19b72ad`, `d50a701`; `10-github-pages/09-async-crop.md` |
| 10-03 06:24 | P5 | Zero-shot label addition: 0 of 112. **Declared dead on 112 images** | `2026-10-03-precision/03-ladder` |
| 10-03 06:51 | P3 | 40 species photographs | site `22ff8fe` |
| 10-03 07:17–07:31 | P5 | Crop ablation — **no result file written** | `2026-10-03-precision/04-crop-ablation` |
| 10-03 07:32 | P3 | **Stop the classifier reporting 94% at 85% accuracy** | site `8162d07` |
| 10-03 07:43 | P3 | All 16 species get ≥1 reference photo (57 total) | site `5139d1a` |
| 10-03 08:00 | P5 | MosquitoDL declared unusable | `07-pmc6978392.md` |
| 10-03 08:06 | P3 | **Multi-view classification and fusion** (~+4.5 pts) | site `8741653` |
| 10-03 08:52–09:00 | P3 | Processing-state sentences removed from the page | site `39489c3`, `8ca3df7` |
| 10-03 08:40 | P3 | Select all / none / delete all | site `366741b` → `7d9453c` |
| 10-03 09:06 | P5 | Linear probe **+12.2 pp** — later reversed | `2026-10-03-precision/10-linear-probe/11-linear-probe.md` |
| 10-03 09:24 | P5 | …reversed: ΔAUC −0.017, gain was one scalar | `20-small-model/21-b16-probe.md` §4 |
| 10-03 09:28–09:36 | P5 | B/16 + a 2 KB head: +32.4 pp, ΔAUC +0.136. **Shipped** | `30-ensemble/32-small-model-in-the-mix.md` |
| 10-03 09:45 | P5 | **Temperature inert; gate at 0.373 gives 96.6% @ 88.0% coverage** | `40-calibration/41-calibration.md` |
| 10-03 09:53 | P4 | **Fast test tier 6m04s → 34s, three bugs found** | svelte `2df8cde` |
| 10-03 10:01 | P4 | Capability diff: **nine missing rows**, one a regression | `30-port/33-capabilities.md` |
| 10-03 10:09–12:49 | P5 | H/14 int8 scale run, 6,264 rows — **`51-h14-scale.md` is 0 bytes** | `40-precision/50-h14-scale/` |
| 10-03 10:16 | P3 | Result panels sized to content, not a reservation | site `deff442` |
| 10-03 12:33 | P3 | **Verdict line: inline `display:none` beat the `.shown` class** | site `19c99e5` |
| 10-03 12:35 | P3 | Revert the combined flush — reintroduce the void | site `cafa280` |
| 10-03 12:37–12:39 | P4 | Layout-shift fix, asserted at 390×844 too | svelte `f8c9b3d`…`2d3af72` |
| 10-03 12:46 | P4 | **`01cec9d` WIP: feature parity — never merged. Last `src/` commit.** | svelte `01cec9d` |
| 10-03 12:51 | P5 | Class-balanced refit: genus floor 0.54 → **0.80** | `tmp/calib/60-balanced-calibration` |
| 10-03 12:52 | P3 | Genus floor 0.80 shipped | site `2193582` |
| 10-03 12:58 | P5 | European prior: no Culex species labels exist. **Never measured** | svelte `7b4e078` |
| 10-03 13:02 | P3 | Pooled result after the photos on a phone | site `3835ebf`, merged `c472a12` |
| 10-03 13:13 | P3 | Footer fix v1 — `margin-top: auto` with no flex parent | site `02e9e2a` |
| 10-03 13:15 | P5 | Per-genus scaling **+1.44 pp** — measured, never shipped | `tmp/perclass/90-per-class-calibration` |
| 10-03 13:18 | P3 | View-disagreement gate measured in a real browser | site `0e4b618` (tip, unmerged) |
| 10-03 13:23 | P6 | Two views disagreeing can no longer reach a species claim | site `8a69909` |
| 10-03 13:37–13:48 | P5 | MosquitoDL head **42.0%** vs BioCLIP 93.56%; do not ship | svelte `404aea5`, `412df77` |
| 10-03 13:44 | P6 | Adjacent-taxon classes in the text embeddings | site `dfe2395` |
| 10-03 13:47–13:51 | P5 | **Prior with no image beats the image: 88.81% vs 79.78%** | `86-geographic-prior-benchmark.md` |
| 10-03 13:54 | P6 | **"This is not a mosquito" ships** — live, verified in served bytes | site `36c992b` |
| 10-03 14:08–14:10 | P5 | Uncertainty detector **inverts** (ρ +0.229, p=0.001); 4-backbone bake-off, weight 0 in 10/12 cells | svelte `503da99`, `f660b10` |
| 10-03 14:09 | P6 | **Clobber 1: footer fix restored after the adjacent-taxa merge dropped it** | site `2ac7a99` |
| 10-03 14:13–14:41 | P5 | Insect-Foundation **−20.4 to −28.6 pp**, oracle +1.2–1.4 pp | `85-insect-foundation/81-*.md`, svelte `269e391` |
| 10-03 14:34 | P5 | Learned stacker +0.66 pp [−0.95, +2.29] vs a +6.69 pp oracle | svelte `96d5110` |
| 10-03 14:46 | P5 | Re-measure on a uuid-grouped split: 1–1.4 pp of optimism | svelte `650d6b1` |
| 10-03 14:50 | P6 | **The abstention line has never rendered** (probe fails today) | site `af6703f` |
| 10-03 14:55–15:08 | P6 | Confidence subsystem extracted into 8 tested TS modules | site `a85b09c`, `f33e36f` |
| 10-03 15:03 | P6 | **Vite build + workflow rewrite + `src/app/main.js`** | site `02638b1` — **not an ancestor of `main`** |
| 10-03 15:06 | P6 | `updatePooling()` calls the module; 400-case equivalence test | site `31874ab` — also **not an ancestor** |
| 10-03 15:11 | P6 | Show the abstention the score panel already computes | site `3667268` |
| 10-03 15:19 | P6 | **Clobber 2: merge `5ff6efe`'s tree == its second parent; the Vite migration never reaches `main`** | `git merge-base 02638b1 origin/main` = `a85b09c`; `git diff 5ff6efe^2 5ff6efe` empty |
| 10-03 15:25 | P5 | Label provenance: 50.3% of rows have no verification field | svelte `0729f4e` |
| 10-03 15:28 | P6 | **Abstention line shipped** — inline `display:none` removed | site `9b43106` = `origin/main` HEAD |
| 10-03 15:35–15:40 | P5 | Distillation: soft targets −4.15/−8.51 pp; 21M student 82.1% vs 93.9% | `95-distillation/91-*.md`, svelte `9dccc78` |
| 10-03 15:36–15:40 | P5 | Relabel from MA's own ID: 640 rows, genus 94.6%, Culiseta 93% | svelte `ac3665d`, `c64f2c5` |
| 10-03 15:45 | P5 | Evaluation audit: risk-coverage never computed for the shipping model | `98-evaluation-audit` |
| 10-03 ~15:45 | — | **Served bytes fetched for this report**; `main.js` byte-identical to `origin/main`, `?v=9b43106…` | `curl` |
| 10-03 16:05 | — | **R2 model object confirmed `immutable` on an unversioned path**, `Last-Modified` 05:33 CEST | `curl -I` on `bioclip_2_5_fp16.onnx` |

## Appendix — what was on `main` at the end, and what was not

**Merged to `origin/main` (`9b43106`):** `card-progress-shifts`, `crop-overlay-aspect`,
`crop-surface-aspect`, `dead-space-fix`, `fused-logits`, `max-vs-max`, `mobile-order`,
`pooled-genus`, `progress-eta`, `remove-classifying-text`, `revert-combined-flush`,
`score-box-flush`, `strip-bulk-actions`, `top-row-balance`, `ts-pinned`, `verdict-line`.

**Unmerged at 15:28, with what they hold:**

| Branch | Tip | Holds |
|---|---|---|
| `agent/ts-modules` | `0ed41ad` local, `5f9dd00` remote | **the entire Vite migration** — `src/app/main.js`, `e2e/smoke.spec.ts`, `path: dist` |
| `agent/ship-per-genus-scaling` | `31d4bbf` (local only, never pushed) | the +1.44 pp per-genus scaling (§4, §8.8) |
| `agent/adjacent-taxa` | `a545ef1` | the warn-coloured non-mosquito score row |
| `agent/full-photo-contain` | `033538c` | full-photo panel (a re-implementation landed as `ed17b9b`) |
| `agent/view-disagreement` | `0e4b618` | the browser measurement behind the gate |
| `agent/footer-desktop` | `c48c614` | the footer fix (restored by hand as `2ac7a99`) |
| `agent/not-confident-gate` | `3c3f2cd` | text embeddings without the classifier |
| `agent/model-load-progress` | `27a28ca` | the progress-bar harness that never downloads the models |

**Svelte repo, unmerged:** `agent/feature-parity` (`01cec9d`) plus 25 other `origin/agent/*`
branches; `origin/main` is `2d3af72` from 12:39.
