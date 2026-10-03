# 29 — The transfer measurement gets its own element; a cache hit finishes the bar

Branch: `agent/progress-eta` (worktree `tmp/progressfix2`, from `origin/main` @ `c746322`).
One commit, `e670ebe`. No PR opened.

## The cache-HIT hypothesis: confirmed on the live app

Measured against `https://corneliusroemer-agent.github.io/mosquito-id/` with the
10.6 MB YOLO detector — the 1.26 GB classifier was never requested. Harness:
`tests/live-cache-hit-probe.mjs`, which calls the app's own `fetchWithCache` /
`makeTransferProgress` from the page and samples the bar every 25 ms.

| Pass | Duration | Distinct rendered bar states | Meter |
|---|---|---|---|
| MISS (cold, 10 607 017 B) | 375 ms | `0%` (and pre-first-write) | *(element did not exist)* |
| HIT (warm) | < 25 ms | **none — the interval never fired** | — |

Both are the same defect seen from two sides. The MISS finished inside one 500 ms
rate window, so every sample was throttled away and the bar sat at `0%` for the
entire transfer. The HIT produces exactly one sample, which the throttle discards,
so nothing is written at all.

That is the grey bar: for an asset that is already local, and for any asset that
arrives faster than 500 ms, the app renders `0%` and then hides the slot. The
`HIT` row also explains why it is reported as *always* grey rather than
intermittently: a returning user is on the one path where no sample can survive.

## The fix

`setProgress(owner, text, pct, meter)` — `text` is still discarded and
`#progress-msg` is still cleared on every call. The new fourth argument goes to a
new `#progress-meter` element, which only `makeTransferProgress` writes. A byte
count and a countdown are a measurement, not a processing sentence, and the two
now have separate elements so no caller can put a sentence back there.

Completion is reported as a final sample rather than a rate sample:

- `fetchWithProgress` calls `onBytes(got, total || got, true)` after the last chunk,
  so the bar always reaches 100 % even when the whole transfer fit in one window.
- `fetchWithCache` on a HIT reads the stored `content-length` and calls
  `onBytes(size, size, true)`.
- `makeTransferProgress`'s callback takes a third `done` argument that bypasses the
  500 ms throttle and renders `· ready` instead of a rate that never got a window.

`clearProgress` clears the meter too, so nothing is left behind when a slot is
hidden.

## Measured after, locally, with the fix

Harness: `tests/local-progress-probe.mjs` — serves the app plus a slow 3 MB body
from `127.0.0.1`, so no R2, no CORS, no classifier.

MISS, streaming at ~2 MB/s:

```
31.25%  msg=""  meter="Detector (YOLO11n): 1 / 3 MB · 2 MB/s · 1s left"
59.375% msg=""  meter="Detector (YOLO11n): 2 / 3 MB · 2 MB/s · 1s left"
87.5%   msg=""  meter="Detector (YOLO11n): 3 / 3 MB · 2 MB/s · done"
100%    msg=""  meter="Detector (YOLO11n): 3 / 3 MB · ready"
```

HIT, 4 MB from CacheStorage — one sample, at t = 122 ms:

```
100%  msg=""  meter="Detector (YOLO11n): 4 / 4 MB · ready"
```

`#progress-msg` was empty in every sampled state. `#progress-slot` measured **19 px**
in every sample, in both passes, so the layout-shift reservation is unchanged.

## Verified

`node --check main.js` and `node --test tests/gate.test.mjs` (13 assertions, all
passing) both green at `e670ebe`. The non-finite score-bar guard from `c746322` is
untouched — no file it depends on was modified.

## Left undone

The bar is still **per-file**: the detector's 100 % and the classifier's 0 % each
draw the same bar, so it restarts rather than advancing once across the load, and
`text_embeds.json` (`main.js:559`, a plain `fetch()`) reports nothing. Both were
item 3 of the previous report and are out of scope here — a full-load bar needs
the three declared sizes aggregated (`WEBGPU_MODELS[].size`) and is a larger change
than a progress-slot fix.

## Harness notes

- `node_modules` is a symlink to `tmp/progressfix/node_modules` (Playwright only,
  untracked and removed before the commit). Chromium is
  `~/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome`.
- Neither probe uploads a photo or touches the classifier. Both call the app's own
  progress functions directly, which is what makes the measurement attributable to
  the app rather than to the UI path.
