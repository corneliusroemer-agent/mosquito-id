# 27 — Model load progress bar is grey, no ETA

**Status: mechanism established for defect 2 (no ETA, no byte count). Defect 1 (bar does not move) NOT reproduced as a code bug — the fill-width path works. R2-specific step not closed. No fix landed.**

Branch: `agent/model-load-progress` (worktree `tmp/progressfix`, from `origin/main` @ `c4521e1`).
Harness: `tests/progress-repro.mjs`, committed at `27a28ca`. No production code changed.

## Summary

Two separate things, and they have different confidence:

| Defect | Mechanism | Confidence |
|---|---|---|
| No ETA, no byte count | `setProgress` discards its `text` argument unconditionally | **Certain** — read directly off the code |
| Bar does not move | **Not a bug in the fill-width path.** That path works. Suspect is a R2 response property I could not reproduce without a real download | **Open** |

The second row is the honest one. I set out to reproduce "the bar does not move" and could not make that happen in code. Every hypothesis offered in the brief (width never set, container has no width, callback not wired, CSS clipping) is **ruled out** — see below.

## Defect 2: the ETA is computed, formatted, and then thrown away — CERTAIN

This is the whole of the ETA bug, and it is one line.

`main.js:352-368`:

```js
// `text` is deliberately ignored. Progress is shown by the bar alone: a
// sentence describing what the app is currently doing is not information about
// the photo, and it was asked to go.
function setProgress(owner, text, pct) {
  ...
  if (msg) msg.textContent = "";        // <-- line 358: `text` never used
```

`makeTransferProgress` (`main.js:390-410`) does all the work of building an ETA and hands it to `setProgress`:

```js
let text = known ? `${label}: ${mb(got)} / ${mb(total)} MB` : label;
if (rate > 0) {
  text += ` · ${mb(rate)} MB/s`;
  if (known) {
    const secs = Math.round((total - got) / rate);
    text += secs > 0 ? ` · ${secs}s left` : " · done";
  }
}
setProgress("model", text, known ? (100 * got) / total : null);
```

So `"BioCLIP 2.5 H/14 FP16: 512 / 1201 MB · 38 MB/s · 19s left"` is built on every
throttled tick and then dropped on the floor at line 358. The rate window,
the byte counts and the ETA all work. They are written into a parameter that
is never read.

This lines up exactly with the deliberate removal: commit `39489c3` "Remove
processing-state sentences from the rendered page" removed the *sentences*
("Loading detector (YOLO11n)…", "Analyzing 3 of 12 photos…") by blanking the
writer line. But `makeTransferProgress`'s string is not a processing
sentence — it is the transfer measurement. The blunt `= ""` took that out
along with the sentences.

The fix is therefore small and does not re-add any processing text: keep
`msg.textContent = ""` as the default, and have the transfer path write its
numbers into a separate element that no other caller uses. A number and a
unit are not a status sentence.

## Defect 1: the bar does not move — mechanism NOT found; the obvious causes are ruled out

I built a Playwright harness that intercepts the R2 URLs and redirects them to
a local streaming server (HTTPS, self-signed, because `route.continue({url})`
requires matching protocol). The classifier is declared at its true
**1259593728** bytes so the percentage maths runs at real scale, while
nothing that large is ever allocated or sent over a network. Real chunks, real
`content-length`, real `reader.read()` loop, real byte counts.

Every candidate from the brief is **ruled out by direct measurement**:

| Hypothesis | Result |
|---|---|
| Fill width never set from byte count | **False.** `main.js:361` sets `fill.style.width` from `pct`; measured climbing `0% → 21.99% → 23.01% → … → 46.96%` |
| Container has no width | **False.** `.progress-bar-track` measured a stable **160 px** throughout (`flex: 0 0 160px`, `index.html:104`) |
| `onBytes` never wired to the bar | **False.** 2153 chunks / 608 MB observed crossing the reader loop for the classifier alone |
| Fill clipped to zero by CSS | **False.** **76 distinct rendered widths** observed, `0 → 75.1 px` of 160, monotonically increasing |

Two useful secondary results:

- The slot height is **19 px in every single sample** — the layout-shift
  reservation is intact and is not implicated.
- `content-length` **is** exposed cross-origin: R2 sends
  `Access-Control-Expose-Headers: Content-Length,Content-Type,ETag`. So
  `total` is known and the percentage is well-defined. This rules out the
  "unknown length → indeterminate sweep" theory.

### What I could not close

Passing the real R2 URLs through the harness fails at the **CORS preflight**,
not at the progress code. R2 is origin-restricted:

```
Origin: https://corneliusroemer-agent.github.io  -> 206, ACAO set, Expose-Headers set
Origin: https://127.0.0.1:8731                   -> TypeError: Failed to fetch
```

So I could not observe a real R2 response body reaching `fetchWithProgress`
from a browser. The gap is narrow and named: **the harness proves the app's
progress path works against a correct streaming response; it does not prove
R2's real response for the 1.26 GB object reaches it as one.** The
classifier download was never run for real, deliberately.

Ranked remaining hypotheses, none of them ruled out:

1. **The 1.26 GB object is served differently from the 10.6 MB one.** I only ever
   probed the detector's headers. A multi-hundred-MB R2 object may come back
   with chunked transfer or a content-encoding that changes the body length,
   and the app never checks `Content-Encoding`.
2. **A returning user's bar is grey for a different reason.** The classifier
   and detector are in CacheStorage, so `fetchWithCache` takes the HIT branch
   at `main.js:445-447`. On a HIT `onBytes(1, 1)` fires **exactly once**, and
   `makeTransferProgress`'s throttle (`if (now - lastAt < 500) return;`,
   `main.js:396`) **discards it** — the single sample arrives within the
   500 ms window and is dropped. The bar is then never written again until
   the next `setProgress` with an explicit `0`. This is the strongest
   candidate and it matches the symptom exactly: a bar that reads 0 % for the
   whole load, on a machine that already has the model. It also explains the
   report being *always* grey rather than intermittently.
3. `resp.body` being null (no `content-length` + no stream) on some R2 path,
   which would throw before any callback.

Hypothesis 2 is worth a five-line check against the live app and does not need
the 1.26 GB download: clear the CacheStorage entry and reload once, then
compare against a warm reload.

## Method notes, for whoever continues

- `route.fulfill()` **buffers** the whole body before delivering it, so a
  progress callback may fire once with the full size. It cannot demonstrate a
  moving bar. `route.continue({url})` to a local server is what makes chunks
  real — and that needs an **HTTPS** local server, since the scheme must
  match the intercepted `https://` URL.
- onnxruntime-web resolves its `.wasm`/`.mjs` from the jsdelivr origin at
  runtime. Serve them locally (≈43 MB) or the session never initialises.
- The stub classifier body must be a real ONNX tiled from the valid file, or
  `InferenceSession.create` fails on protobuf parse and the run stops before
  the interesting part.
- Playwright in this container: `npm i -D playwright`, and launch with
  `executablePath: ~/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome`.
  The bundled revision (1187) is not downloaded; the cached one is 1243.
- Chromium coalesces reader chunks (observed sizes 64 KB–1.9 MB, 2153 chunks
  for 608 MB), so per-chunk counts are not the network's packet boundaries.

## What is left to do

1. Fix the ETA: route `makeTransferProgress`'s string to its own element,
   leave `msg.textContent = ""` for every other caller.
2. Confirm or kill hypothesis 2 (CacheStorage HIT → single throttled sample →
   never written). If confirmed, `onBytes` on a HIT should report completion
   directly rather than going through the rate window.
3. Make the bar cover the whole load. Today `pct` is always per-file: the
   detector's 100 % and the classifier's 0 % both draw 0→100 %, so the bar
   restarts three times instead of advancing once. `text_embeds.json`
   (`main.js:559`) is fetched with a plain `fetch()` and reports nothing at
   all. Aggregate over the three declared sizes — `WEBGPU_MODELS[].size`
   already carries the real byte counts.
