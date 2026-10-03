# 32 — Equal-height top row on the mosquito ID app

Branch `agent/top-row-balance` (worktree `/workspaces/claude-devcontainer/tmp/toprow`), one CSS
declaration changed in `index.html:162`.

## The change

`.top-grid` had `align-items: start`, so each card was only as tall as its own content. Changed to
`align-items: stretch`. That is the whole fix — no JS, no HTML, no other rule touched.

`.upload-card` is already `display:flex; flex-direction:column` and `.dropzone` already has
`flex:1`, so the extra height goes into the dropzone rather than into a gap under the two buttons.
Verified visually: the dropzone grew from 160px to 249px and its text stayed centred, nothing
floated or stretched oddly.

## Measured card heights

`index.html` served from a scratch port, `**/*.onnx` and `**/*.r2.dev` aborted, photos fabricated
into `__mosqAsync.previews` with `EMB` set from the served `text_embeds.json`, and checked in
through the app's own `#thumbnail-strip .thumb-optin` checkbox handler so `updatePooling()` runs
the real path. `pooledRows: 10` in every case, i.e. the pooled card really did render.

Heights are `getBoundingClientRect().height` of `.upload-card` / `.combined-card`.

| viewport | state | `.upload-card` before | `.combined-card` before | `.upload-card` after | `.combined-card` after |
|---|---|---|---|---|---|
| 1440x900 | empty | 280 | 369 | **369** | 369 |
| 1440x900 | 2 checked | 280 | 369 | **369** | 369 |
| 1440x900 | options `<details>` open | 280 | 652.5 | **652.5** | 652.5 |
| 390x844 | empty | 280 | 361 | 280 | 361 |
| 390x844 | 2 checked | 280 | 361 | 280 | 361 |
| 390x844 | options `<details>` open | 280 | 656.5 | 280 | 656.5 |

Desktop row is balanced in all three states. At 390x844 the grid collapses to one column
(`grid-template-columns: 351px`, single value) where `stretch` is a no-op — the cards keep their own
heights and stack as before, with no gap between them and no dropzone forced to a desktop height.
Confirmed on a screenshot, not just in the numbers.

## Layout shift

`PerformanceObserver` on `layout-shift`, `buffered: true`, `hadRecentInput` entries excluded, summed
across load → seeding 4 photos → checking 2 of them.

| viewport | CLS before | CLS after | CLS after opening the options `<details>` |
|---|---|---|---|
| 1440x900 | 0.0164 (1 entry) | 0.0164 (1 entry) | 0.0164 before, 0.0164 after |
| 390x844 | 0 | 0 | 0 before, 0 after |

No new shift. The one desktop entry is present identically before and after, and it is not from the
top row — the right card's `.combined-scores` keeps its fixed 240px, so pooling never resized it,
confirmed by the identical 369px in the empty and pooled rows above. Phone shift stays at zero.

The case that could have regressed is opening the right card's own **Aggregation options**
`<details>`, which is the only thing still able to grow that card (240px of scores + the options
body). Before, it grew 369 → 652.5 with the left card pinned at 280; after, both go to 652.5. So the
left card now moves when the options panel opens, where it did not before. It costs no measurable
CLS (opening a `<details>` is a user-initiated layout change on an element below the fold of the
measured viewport, and the observer records 0 either way), and it is the same trade `stretch` makes
everywhere else: the row stays balanced instead of the left card hanging 370px short. The pooled
path — the one that fires constantly, on every photo check — is untouched.

Reserving a matching fixed height on the left card instead would avoid the options-panel case
entirely, at the cost of the left card no longer tracking a genuinely taller right card, and of
duplicating a number that has to be kept in step with `.combined-scores`. Not worth it for a shift
the observer does not record.

## Checks

- `node --check main.js` — passes.
- `node --test tests/gate.test.mjs` — 1/1 passing.

Screenshots and raw measurement JSON: `/workspaces/claude-devcontainer/tmp/probe/`
(`before*.png`, `after*.png`, `before.json`, `after.json`; scripts `toprow.mjs`, `shot.mjs`,
`shot390.mjs`).
