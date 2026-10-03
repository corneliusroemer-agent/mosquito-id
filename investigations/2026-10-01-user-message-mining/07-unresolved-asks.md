# Unresolved asks, joined against the request-status ground truth

**Ground truth.** [`11-request-status.tsv`](../2026-10-04-session-mining.md)
(66 rows) says what was asked versus what shipped, each row carrying `git log` or served-bytes
evidence. **"Unresolved" here means not marked `done` in that table** — not "I could not find it".
Where I re-checked the repos this afternoon I say so and give the evidence; where I did not, the
table's status stands unchallenged.

**Scope.** Everything Cornelius asked on 2026-10-03 that is still open at 16:26 CEST. Requests from
the Antigravity hours (00:00–03:20 UTC) are included; they are the same day's work.

---

## A. Asked, never started. Six items.

None of these has a branch, a commit, a report, or a line in a served file. This is the largest and
worst category: work that consumed conversation time and produced nothing.

| # | Ask | When | Evidence it never started |
|---|---|---|---|
| A1 | **Client-side logging.** *"we should add logging of sorts so we can see what actually happens on client"*; Antigravity 00:50 *"you should log user interactions so you can reconstruct what went wrong in cases like bad cropping"* | 03:24, Antigravity 00:50 | Asked twice, ~3 h apart, by two different agents. No logging call of any kind in the served `main.js`. |
| A2 | **Background-preload the sample images.** *"we should pull the sample images in background once page has loaded so they are ready when people click the button"* | 03:25 | No preload or warm path in the served `main.js`. |
| A3 | **A dedicated agent to scrape more MosquitoAlert data** — sign up if needed, solve captchas, find the API with Playwright, hit the endpoints, go beyond Europe, aim for tens of thousands. Specified across **four consecutive messages** at 05:37, 05:38, 05:38, 05:40. | 05:37–05:40 | No such agent ran. `36-negatives/` was built instead. He had already asked for data three separate times by 05:42 (*"just get an agent on pulling more pictures!"*). |
| A4 | **Sexing.** *"ma has sexing inbuilt i think it could be nice to add as it might help distinguish and add more"* | 05:51 | No sex/sexing token anywhere in the served app. |
| A5 | **R2 objects immutable**, so the browser stops re-fetching. | 06:59 | No `Cache-Control`/`immutable` configuration in the site repo or `.github/workflows/pages.yml`. |
| A6 | **Cross-origin isolation**, so ORT gets 8 WASM threads. | 07:01 | GitHub Pages cannot serve COOP/COEP, so this needs a different answer rather than a header. The rewrite worked around it (`6da51e3` "Request one WASM thread"). **Correctly deprioritised, not dropped by neglect** — but no one said so to him. |

**A1, A3 and A4 are the ones that matter.** A3 in particular: he specified it four times and had to
repeat himself three times about how much data exists. See `06-session-2026-10-03.md` §4.

---

## B. Done, pushed, never merged. Five items, all carrying work he asked for.

This is the category the temporal-progression report named as the project's dominant failure. Their
diffs against `main` read as thousands of deletions — what a stale branch looks like — so they are
easy to mistake for abandoned work and leave lying there.

| # | Ask | When | Branch | State |
|---|---|---|---|---|
| B1 | **"This is not a mosquito."** *"just plain paper still ends up classified as a mosquito which doesn't make sense"* | 11:11 | `agent/adjacent-taxa` (`a545ef1`) | 4 commits: seven adjacent-taxon classes, warn-coloured row, *"this is not a mosquito" instead of ranking sixteen that it is not*. The only occurrence of that string in the served `main.js` is a code comment about something else. |
| B2 | **Confidence that can say "I can't tell what this is."** *"i have something that has something but one can't tell what - it still shows culex pipiens, albopictus etc depending on the crop"* | 10:58 | `agent/not-confident-gate` (`3c3f2cd`) | What landed on `main` (`8162d07` stops claiming 94%, `2193582` genus floor 0.80) is adjacent to what he asked for, not the thing itself. |
| B3 | **Two views disagreeing must not reach a species claim.** | 08:01 | `agent/view-disagreement` (`0e4b618`) | The main-branch half (`8a69909`) is merged; the measured gate is not. |
| B4 | **One thin, always-present progress container** for model load and analysis. | 06:13, 06:14, 06:14 | `agent/model-load-progress` (`27a28ca`) | Unverified — the table flags it because nothing confirms it renders. |
| B5 | **Footer pinned to the bottom of a short page.** He complained three times; reported fixed at 11:12, found dead again at 11:47. | 03:56, 11:12, 11:47, 11:53 | `agent/footer-desktop` (`c48c614`) | The fix that works (`display: flex` on `.app-container` at every width) **was sitting uncommitted in the working tree**. `served index.html:64` still has `.app-container` as a plain block. |

**Two of these (B1, B5) he explicitly asked for again after being told they were done**, which makes
them worse than untouched work: he spent a turn on a question that had an answer.

---

## C. Partial, and he said so. Four items.

- **Layout shift on row expansion.** Eleven commits on `main` address it. His last word, 06:38:
  *"clasifying still there vertical layout shifts still there i'm disappointed"*. The one thing that
  actually measures CLS — `tests/layout.spec.ts` in the **rewrite**, CLS 0.066 → 0 — has no
  counterpart on the live site; `git ls-tree origin/main tests/` returns six `.mjs` probes and no
  layout spec.
- **Aggregate score flickering in and out on zoom change.** *"there is absolutely horrible layout
  shift when one changes zoom because the aggregate score disappears (it should never)"* (05:54).
  `ef3b388`, `c4521e1`; his 13:01 screenshot still shows the pooled card absent/present.
- **Layout shift when deleting the leftmost or last photo.** *"deleting the leftmost picture in
  particular causes crazy layout shift"* (04:52). `e4ba253`, `0bf1d28`; **never re-reported to him as
  verified.**
- **Svelte parity.** *"the svelte port is still really horrible not at all parity"* (07:12). At
  handback `33-capabilities.md` listed nine missing rows. **Now moot** — the rewrite is parked
  (15:18), and `investigations/2026-10-03-rewrite/00-ON-HOLD.md` carries that.

---

## D. Asked before the table closed, still open. Verified this afternoon.

These postdate or straddle the TSV and I re-checked the repos rather than carry the table's status.

| # | Ask | Evidence at 16:26 |
|---|---|---|
| D1 | **Blank paper must not be classified as a mosquito.** *"i added another screenshot bogusresults that shows that even if you take 3 non-mosquito background pictures we still don't get a non-mosquito result"* (12:30) | **In flight, and the live complaint the whole adjacent-taxa push was meant to answer.** `36-negatives/score_photos.py` written 13:44 with an empty `photos/`. At 16:21 the coordinator reported a background head at **AUROC 0.9995** — which would mean the ceiling on this is lower than assumed, but no result on disk yet. |
| D2 | **Non-mosquito rejection for the small model.** Culico structurally cannot do it: its `Head` needs `nuisance_emb` and `adjacent_emb` and it has neither. Documented in `41-second-model-blocked.md`. | **A way around it was found at 15:44 and not yet acted on**: `text_embeds_b16.json` is already deployed, is 512-dim, and already carries eight nuisance prompts including *"a photograph of an empty background"*, *"a wall"*, *"a hand"*. **The gate can fire on B/16.** Nobody has said this to him. |
| D3 | **Ship the H/14 calibration.** *"and we should also ship h/14 calibration"* (16:06) | **Done.** `71681b9` "Add the fitted per-genus cosine calibration to the joint softmax" and `3b1dd74` are both on `origin/main`. 90.37% → 91.81%, CI [+0.32, +2.55]. |
| D4 | **Park the Svelte rewrite with a visible warning.** *"put a clear warning into the svelte investigation and repo that it is on hold"* (16:04) | **Done.** `investigations/2026-10-03-rewrite/00-ON-HOLD.md` exists on `origin/main` and is listed in `investigations/README.md`. |
| D5 | **Put every report in `investigations/`.** *"make sure that all reports are definitely in the investigations dir … as that's our groun truth place always"* (16:00) | **Done for this repo.** `40-temporal-progression.md`, `41-second-model-blocked.md` and the index are on `origin/main`. The Svelte repo's reports are not, and per 16:04 they should not be. |
| D6 | **Commit to `corneliusroemer-agent/*`, not `corneliusroemer/*`.** (15:51) | **Done.** This document and `06-session-2026-10-03.md` are the first artefacts written under that rule. |
| D7 | **Hover tooltip** — common name, geographic spread, activity, host range, vector. | **Unverified and probably dropped.** No tooltip in the served `index.html` or `main.js`. Asked once, in the Antigravity hours (01:14), never mentioned again. |
| D8 | **Verdict sentence should lead with the most confident species.** *"it should definitely aedes - most likely albopictus, possibly aegypti or koreicus"* (15:23) | **Done and merged.** `fix-verdict-sentence` (`68fb8cb`) is an ancestor of `origin/main`. |

---

## E. Waiting on him. Two.

- **224 "Is there anything for me to decide?"** at 10:31 went unanswered for the better part of an
  hour while the coordinator worked through a list without surfacing one. The rule he restated at
  05:22 — *"you decide whether it's worth going or not"* — cuts both ways: he wants to be asked.
- **Which framework, if not Svelte.** 05:15: *"the question is more _which_ framework and tooling to
  use not whether to"*. The `/goal` at 15:18 kept the gradual TypeScript/Vite rewrite of `main.js`
  and parked the framework decision without settling it, so this is genuinely open.

---

## What this list is thin on

- **No request was refused or denied.** Every correction today was about *how* to do the work, not
  whether. The nearest thing is A6, cross-origin isolation, where the blocker was GitHub Pages
  rather than him.
- **No scope was cut** except Svelte and the species-page polish, both his calls and both recorded
  above with his reasoning.
- **The record cannot distinguish "he forgot" from "he deprioritised".** A1, A2 and A5 were each
  mentioned once and never again, which is consistent with either. Only A3 — mentioned four times,
  then again at 05:42 — is clearly a priority he held and the session did not serve.
- **Everything here is verified against `git log` and served bytes, not against an agent's report.**
  Where I did not re-check, the TSV's status stands and I have not upgraded it.
