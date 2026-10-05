# Issue #72 re-measured: the encode it names is no longer in the code

Issue [#72](https://github.com/corneliusroemer-agent/mosquito-id/issues/72) reports
"30 photos spend 16.8s in toDataURL and 12.9s in drawImage" and names
`HTMLCanvasElement.toDataURL` in `canvasUrl()` (`src/app/canvasCache.ts`) as the cause.

**Neither premise describes `main` any more.** This report is a re-measurement, and the
recommendation is to re-scope the issue rather than fix it as written.

## What changed underneath the issue

[#95](https://github.com/corneliusroemer-agent/mosquito-id/pull/95) replaced the encode with
a native resize: `thumbnailUrl` (`src/app/canvasCache.ts`) now downsamples to a 252px short
edge *before* encoding, and `prepareThumbnail` fills that memo from
`createImageBitmap(file, {resizeWidth})` — a decoder-side resize, no full-resolution canvas
read at all. [#107](https://github.com/corneliusroemer-agent/mosquito-id/pull/107) removed
full-resolution canvas retention from the photo record, so the tile source is now a
2048px-capped display canvas rather than the full frame.

The issue's own text flagged this risk — "the crop-miss case should never reach this path at
all" — and both changes landed since.

## Current numbers

30 real phone photographs (18 at 12.5 MP, 12 at 50 MP), `30picsload.zip`, same corpus the
issue used. Stubbed detector and classifier sessions (tier-1 style), so no model weights are
fetched and the numbers are the app's own canvas work, uncontaminated by inference.

| operation | #72 said | measured on `f19adc9` | |
|---|---:|---:|---|
| `toDataURL` | 16,779 ms | **49 ms** | −99.7 % |
| pixels JPEG-encoded | 1,231 MP | **7 MP** | 176× less |
| `drawImage` | 12,898 ms | **6,985 ms** | −46 % |
| tiles encoded | 60 | 79 | |
| tile data URL bytes | 33.2 MB | ~6 KB each | |
| wall clock (stubbed models) | 92.8 s | 11.5–17.2 s | |

Every one of the 79 encodes is at 252x335 or 335x252 — that is, thumbnail-sized. **No
full-resolution encode survives anywhere in the thumbnail path.** Two runs on a clean build
gave `toDataURL` 57–59 ms and `drawImage` 10.8–11.6 s; the run above is from the same
instrumentation with a lower-variance ordering. Wall clock varies with box load; the
`toDataURL` figure does not, and it is the one the issue is about.

`drawImage` is now the larger term and it is **not** thumbnail work. Its cost is dominated
by resamples that feed inference, at the destinations below:

| drawImage source → dest | calls | ms | what it is |
|---|---:|---:|---|
| 6144x8160 → 482x640 | 8 | 2,733 | detector letterbox |
| 3072x4080 → 482x640 | 18 | 1,564 | detector letterbox |
| 8160x6144 → 640x482 | 4 | 1,309 | detector letterbox |
| 6144x8160 → 6144x8160 | 8 | 293 | `classifyImage`'s full-frame copy |
| 3072x4080 → 1542x2048 | 54 | 268 | `displayCanvasFrom` |
| **1542x2048 → 771x1024** | **42** | **187** | **thumbnail, step 1 of 2** |
| **771x1024 → 252x335** | **42** | **84** | **thumbnail, step 2 of 2** |

The two bold rows are the whole thumbnail downscale cost: **271 ms over 30 photos**, against
the 16.8 s the issue attributes to this path. It is now ~4 % of `drawImage`.

## The one real finding: a second decode of every photograph

`prepareThumbnail` at the decode stage (`src/app/main.js`, in `decodeStage`) is called with
`slot.file`, so `createImageBitmap` decodes the JPEG **again** — the decode pool already
decoded it a few lines above into `slot.bitmap`. Measured on the same corpus:

| `createImageBitmap` call | count | total ms |
|---|---:|---:|
| from File, no resize (the decode pool) | 30 | 4,060 |
| from File, `resizeWidth` 252/335 (`prepareThumbnail`) | 30 | **7,095** |
| from File, `resizeWidth` 252 | 26 | 5,221 |
| from File, `resizeWidth` 335 | 4 | 1,874 |

So the native-resize memo costs **~7.1 s to re-decode 30 photographs**, which is more than
the synchronous fallback it exists to avoid (~271 ms of `drawImage`, plus a 49 ms encode).
`prepareThumbnail` is 26× the price of the work it defers.

Two things make that memo worth keeping anyway, and both are outside what I could settle:

- It is off the main thread's critical path where `thumbnailUrl`'s `drawImage` fallback is
  not, and it is what keeps the tile correct on a slow decoder.
- **Its memo appears to be unreachable in the batch path.** The memo is keyed on canvas
  identity (`thumbUrlCache`, a `WeakMap`), and `commitBatchSlot` (`src/app/main.js`) replaces
  `slot.displayCanvas` with a different canvas object via `displayCanvasFrom(fullCv)`. Of 79
  encodes, **0 came from the canvas the record ends up holding** — every tile went through
  `thumbnailUrl`'s own resample instead. That is consistent with the decode-stage memo being
  written for a canvas the commit throws away, and would make the 7.1 s pure waste.

### UNRESOLVED: does removing the decode-stage `prepareThumbnail` help?

I armed exactly that mutation — replacing the `await prepareThumbnail(...)` in `decodeStage`
with `await Promise.resolve()` and nothing else — and it **hung**: zero `drawImage` calls,
zero settled photos, on a clean rebuild, reproducibly, including with `WANT=3`. That is not a
speed result, it is a behavioural one I could not explain or debug within budget.

I am recording it as unresolved rather than guessing. Two plausible readings, neither
confirmed:

1. It is a real regression from removing the memo (the tile path depends on something the
   decode stage sets up).
2. It is a harness artifact — the stubbed-session bench, or the preview server, does not
   survive that particular edit.

A first attempt at this A/B produced a **stale-bundle** result (the preview server was
serving the pre-edit `dist/`, giving a meaningless 600 s wall with zero draws). The second
attempt, after `kill`, rebuild and a fresh server, still hung — so the hang is not the stale
server. It is unexplained.

**Do not treat "remove the decode-stage `prepareThumbnail`" as a proposed fix.** The
evidence that it is wasteful is solid (7.1 s of measured re-decode, 0 of 79 encodes reaching
the canvas the record holds). The evidence that removing it is safe is absent.

## What could not be checked

- **Headless CPU, not the Mac GPU.** No WebGPU adapter here, so the classifier runs WASM.
  The issue already notes its absolute non-inference milliseconds transfer but its
  *percentages* do not. That caveat applies unchanged to every ratio here, and in particular
  to `drawImage`: on a real GPU some of those resamples may be hardware-accelerated.
- **Stubbed sessions.** Inference contributes no time to these figures, which is deliberate
  — it isolates the canvas work — but it means the wall clock here is not comparable to the
  issue's 92.8 s, which was measured with real WASM inference.
- **One machine, one run per configuration** for the A/B arms (two runs for the clean
  baseline). Timing on this box varies several-fold with load; treat sub-100 ms differences
  as noise.
- **The crop-found path was not exercised at scale.** With the stub detector returning no
  boxes, all 30 photos take the crop-miss route, so `cropCanvas === displayCanvas` in every
  case. A corpus where the detector actually fires would cut crops from the full frame and
  change the `drawImage` mix.
- **`main` moved under this measurement**: the issue was filed against `2e167a7`, and these
  numbers are from `f19adc9`.

## Recommendation

Re-scope #72. Its premise (a full-resolution JPEG encode on the thumbnail path) is
implemented-away. The two live questions it points at, in order:

1. **Is the decode-stage `prepareThumbnail` memo reachable?** 7.1 s and 0/79 suggests no.
   The fix, if the suspicion holds, is to have the commit stage memoize the canvas it
   actually installs, not to delete the decode-stage call.
2. **`drawImage` is now dominated by the detector's letterbox** (5.6 s of 7.0 s, three
   rows above) — a separate question about resolution, not about thumbnails.

## Reproducing

`bench/thumb.mjs` in `scratch/2026-10-05-thumb-encode/`: builds `dist/`, copies
`30picsload.zip` into it, serves on port 4299 (a port on the model bucket's CORS allowlist),
then drives `processFiles` in headless chromium with tier-1 stub sessions and wraps
`toDataURL` / `drawImage` / `createImageBitmap` to attribute by source and destination size.
Corpus: `mosquito_dataset_ai_v1`-derived `30picsload.zip` (30 photos, 18 at 12.5 MP and 12 at
50 MP). No model weights are fetched — `*.onnx` and `*.r2.dev` are aborted.
