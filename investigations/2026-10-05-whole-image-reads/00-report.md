# Whole-image reads in the per-photo path

Branch `perf/whole-image-reads`, base `origin/main` at `f19adc9`. Two commits:
Fix 1 (done) and the EXIF orientation guard Fix 2 must pass (done, Fix 2 itself
is **not** implemented — see *State* below).

## The measurement, and why it is a count

No elapsed time is measured anywhere in this work, and none of the numbers here
is a duration. This container has no GPU (`navigator.gpu` is undefined), so a
wall-clock figure taken here describes the machine rather than the code, and
this project has been misled by exactly that twice — once by the "6,985 ms
drawImage" figure, which turned out to be a cold-rebuild artefact (10.8–11.6 s
on clean runs), and once by report 57's "decode: 1 ms/photo", which times
`createImageBitmap` synchronously and is an artefact of the same kind. Do not
convert any count below into a speedup claim.

What is measured instead is **whole-image reads**: `drawImage` calls whose
*source* area is at least one photograph's worth of pixels. Source area rather
than destination area, because the destination is what the caller asked for and
the source is what costs — the detector's 640 px letterbox and a crop cut are
both `drawImage`, and only the source area tells them apart. Count rather than
time, because a count is the same on every machine and a duration on a shared
box is not.

The probe is `armWholeImageReads(minSourceArea)` in `src/app/perfCounters.ts`.
It patches `CanvasRenderingContext2D.prototype.drawImage` **only while armed**,
and nothing in the app arms it — the same bargain `armLayoutCounters` already
makes, so a page a user loads carries no patched canvas method. It is idempotent
(arming twice only moves the threshold), because a second patch would double
every count.

### Conditions the numbers were taken under

Read this before quoting any of them.

- Photographs are **2400x1800** synthetic JPEGs (flat colour, generated in-page),
  dropped through the real `processFiles` intake. They are past `DISPLAY_MAX_EDGE`
  (2048), so a display copy is a distinct, smaller read.
- The detector and classifier are **fakes** installed through the
  `__mosqAsync.sessDet` / `sessClip` seam. The fake detector returns one centred
  box, so every photo is genuinely cropped and the crop cut and context region
  both run. An all-zero output would take the no-detection path, where a photo
  has one view and no crop is cut — the counts would then be measuring a
  different path than the one the fixes change.
- Tier 1: every ONNX and R2 model request is aborted, so no weights download.
- Chromium headless, `--no-sandbox`, served from a fresh `vite build`.
- **No GPU.** This is a CPU rasterisation path. The counts are structural and
  machine-independent; anything derived from them by timing is not.

## What the counts were

A batch of three photographs, `e2e/tier1/whole-image-reads.spec.ts`:

| state | total | per photograph |
|---|---|---|
| `origin/main` | **12** | **4** |
| after Fix 1 | **9** | **3** |

Per-photo breakdown on `main`, which is what names the four reads:

```
ImageBitmap 2400x1800                              x2
HTMLCanvasElement 2400x1800 sub 2400x1800          x1   <- the letterbox
HTMLCanvasElement 2400x1800                        x1   <- the rebuilt display copy
```

- The two `ImageBitmap` reads are `decodeStage`'s `displayCanvasFrom(slot.bitmap)`
  and `classifyImage`'s copy into `fullCv`.
- The letterbox read is necessary: the detector does have to see the photograph.
- The fourth is Fix 1's — `classifyImage` rebuilding a display copy
  `decodeStage` had already built from the same bitmap.

## Fix 1

`decodeStage` sets `slot.displayCanvas = displayCanvasFrom(slot.bitmap)` before
inference starts. `classifyImage` then recomputed `displayCanvasFrom(fullCv)`
from the same pixels. It is now handed the canvas:

```js
const display = prebuiltDisplay ?? displayCanvasFrom(fullCv);
```

The `??` arm is for a caller with nothing to hand; the whole-image-read counter
is what pins that a batch takes the first arm.

The record's `displayCanvas`, `cropCanvas` and `contextCanvas` all follow. The
aliasing that comment describes is preserved: a photo the detector found nothing
in still has one canvas under three names, because the identity test
`cropCv === fullCv` is unchanged.

**12 → 9. Three per photograph.**

### The guard, and the mutation that fails it

`e2e/tier1/whole-image-reads.spec.ts`, one test.

The mutation is one line, **inside `classifyImage`** in `src/app/main.js` — at
the `const display = ...` line, immediately after the `extractContextCrop` call
that produces `contextCanvas`:

```js
//   MUTATION (makes the test fail):
const display = displayCanvasFrom(fullCv);      // instead of prebuiltDisplay ?? ...
```

**Inside the function, not at module scope.** That placement is load-bearing and
was verified: a module-scope mutation fires at import, before the test's setup
resets the counter the assertion reads, so the test never observes it and passes
against unfixed code.

Observed RED with that line reverted (this is the real output, not a
reconstruction):

```
WHOLE-IMAGE READS {"ImageBitmap 2400x1800":6,
                   "HTMLCanvasElement 2400x1800 sub 2400x1800":3,
                   "HTMLCanvasElement 2400x1800":3} total 12
    Expected: 9
    Received: 12
  1 failed
```

The `HTMLCanvasElement 2400x1800:3` entry — the rebuilt display copy, absent
after the fix — is the read the mutation puts back. The breakdown is in the
assertion message on purpose: a bare "12 against 9" says how many and not which,
and "which" is the half a reader can act on.

## EXIF orientation

**This is the thing to read before touching the pixel source.** `photoUrl.ts`
already documents that `createImageBitmap` and an `<img>` decode can disagree
about EXIF orientation and that this app relies on the two agreeing
(`image-orientation: from-image` on both paths).

That reliance is exactly what decides whether drawing from `slot.bitmap` instead
of from a freshly allocated full-resolution canvas is a refactor or a **pixel
change on the path every classification goes through**. A draw from a bitmap is
that bitmap's own orientation; a draw from a copy is whatever the copy was made
from. Nothing reports a disagreement — a misoriented crop box simply lands in
the wrong place, and the classifier scores the wrong pixels without any error
anywhere.

### The probe

`e2e/tier1/exif-orientation.spec.ts`, six tests, **green against `origin/main`
as it stands**. Four copies of one 2400x1800 image differing only in EXIF tag
274, so any difference between their decoded output comes from orientation
handling and from nothing else. The image is four flat quadrants (red / green /
blue / yellow) plus a white diagonal in the stored top-left and a black block in
the stored bottom-right; both markers move under any rotation or flip, so an
ignored tag and an applied one cannot produce the same pixels.

What Chromium actually produces — measured, not derived from the EXIF spec:

| orientation | decoded quadrants (TL, TR, BL, BR) | dimensions |
|---|---|---|
| 1 | red, green, blue, yellow | 2400 x 1800 |
| 3 | yellow, blue, green, red | 2400 x 1800 |
| 6 | blue, red, yellow, green | 1800 x 2400 |
| 8 | green, yellow, red, blue | 1800 x 2400 |

**My first table was wrong and the probe caught it.** I reasoned the quadrant
arrangement out from the EXIF spec and got orientations 3, 6 and 8 backwards; the
table above is what the browser actually returns. That is the reason the spec
asserts on measured behaviour rather than on the spec's arithmetic: a table
derived from what the decoder *should* do pins something it was never asked to
do, and it fails on correct code.

The six tests:

1. Four tests, one per orientation, asserting decoded dimensions **and** quadrant
   colours — so orientation 3 (a half-turn, no transpose) is distinguished from
   6 and 8 (quarter turns, transposed), and a decoder that transposed without
   rotating fails.
2. **The guard for the guard**: every orientation differs from orientation 1, and
   6 differs from 8. Four fixtures that all decoded identically would pass tests
   1–4 for the wrong reason.
3. **The end-to-end half**: the record the batch actually commits. Drops the
   EXIF-6 and EXIF-8 photographs through the real intake with the fake sessions
   and reads the display copy the record kept. Asserts `fullW`/`fullH` are the
   *oriented* dimensions, the display copy's long edge is 2048 (so the cap
   resample ran), its quadrant colours are the oriented ones, and the photo was
   genuinely cropped.

**Orientation is applied correctly today.** That is the baseline Fix 2 must not
move. 2400x1800 is deliberate: past the display cap, so the resample that an
orientation change could disagree about is part of every path these exercise. A
fixture under the cap returns the source canvas and skips it.

## Fix 2 — not implemented

`classifyImage` copies the whole photograph from `imgBitmap` into a freshly
allocated full-resolution `fullCv` (`src/app/main.js`, immediately after
`const engine = currentEngine`). The bitmap is the same pixels and is still held
as `slot.bitmap`; all four consumers — `letterbox`, the crop cut,
`extractContextCrop`, `displayCanvasFrom` — only `drawImage` it, and
`fullResSource.ts:46` already declares a `Drawable = … | ImageBitmap` type for
exactly this.

**This was not started.** It is a pixel change on the classification path, it is
the half of this work that cannot be undone by reverting a line, and the session
was winding down. The guard it needs is committed and green; the change itself
should be made deliberately, with the probe run before and after.

If it is done, the count to expect is **9 → 6** (three per photograph to two):
removing the `fullCv` copy takes out one `ImageBitmap` read per photo, leaving
the `decodeStage` display copy and the letterbox.

The shape, for whoever picks it up:

- `letterbox(imgCv: HTMLCanvasElement)` in `src/app/detector.ts` takes an
  `HTMLCanvasElement` and reads `.width`/`.height` and `drawImage`s it. An
  `ImageBitmap` satisfies all three; the parameter type has to widen to the
  existing `Drawable`.
- `clipTensor` / `halveToward` in `src/app/embedding.ts` take an
  `HTMLCanvasElement`. `halveToward` does `cur.width = 0` to release
  intermediates, so it must never receive the bitmap itself.
- `extractContextCrop(source, frame, cropBox)` in `src/app/cropGeometry.ts`
  takes an `HTMLCanvasElement` source and a `PhotoFrame`. The `Drawable` widens
  the first; `slot.bitmap` satisfies `PhotoFrame` structurally already.
- `sourceCanvas: file ? null : fullCv` on the record — an `ImageBitmap` is not
  `HTMLCanvasElement`, so a no-File photo needs a canvas kept for it.
- The crop cut becomes `cropCv.getContext("2d").drawImage(imgBitmap, …)`, which
  is fine: `drawImage` already takes an `ImageBitmap`.

## Found, deliberately not fixed

- **`tests/prepare-thumbnail.test.ts` fails on unmodified `main`** (5 of 14
  cases, verified by stashing every change and re-running). Not caused by this
  work and not touched. Worth a separate look — a suite that is red on `main`
  cannot tell you whether your change is red.
- **The full tier-1 suite is red on unmodified `main`** in the run taken here:
  `gpu-release`, `idle-release` and `shell` each failed once, on a run that also
  failed a test this branch added. `docs/TESTING.md` records that tier 1 can
  fail a different unrelated spec per run and that this has been proven on
  untouched `main`; that is the known flake #76, not this change. The
  `whole-image-reads` and `exif-orientation` specs were each run in isolation
  and are green.
- **`classifyImage` may not contain the word `fallback`.**
  `tests/whole-frame-classification.test.ts` greps the function's source for
  `/\bfallback\b/` and fails if it appears, because a field named for the old
  crop/fallback conflation coming back is the same defect wearing a new name.
  The first draft of Fix 1's comment used the word and turned the test red. If
  Fix 2 needs a comment in that function, avoid it.
- **`tests/main-js-imports.test.ts` parses `main.js` as text**, so the word
  `import` in any comment is read as a real import statement. Same hazard, same
  file.
- **The `decodeStage` display copy is built before the fingerprint resolves
  ordering**, so a photo whose decode fails after the bitmap is set keeps
  `slot.displayCanvas`. `classifyImage` is only reached when `slot.bitmap`
  exists, so this is unreachable today; the `??` arm covers it rather than
  leaving it to be rediscovered.

## Future work

- **Fix 2**, as described above — the `fullCv` copy is still made, and it is a
  45.8 MiB allocation per photograph that nothing needs. The guard for it is
  already committed and green.
- **`tests/prepare-thumbnail.test.ts` on `main`.** Five failures on untouched
  `main` means the suite cannot currently vouch for anything; worth a look
  before the next change relies on a green run.
- **The whole-image-read counter has no unit test of its own.**
  `tests/perf-counters.test.ts` covers the other counters' arithmetic, and the
  probe's three-argument vs nine-argument `drawImage` source-area arithmetic is
  only exercised from Playwright, where a bug in it looks like a plausible
  count. Vitest runs `environment: "node"`, so the probe itself cannot be
  installed there — but `sourceAreaOf` could be extracted and tested directly.
