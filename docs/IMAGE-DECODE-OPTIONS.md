# What `createImageBitmap` options actually do here

Measured on this box (2026-10-05) in chromium, firefox and webkit, not read off a
spec. Probe: a 400x200 1px checkerboard and a 1200x900 photo-like gradient,
decoded with each option set and read back with `getImageData`.

## Resize options are honoured, but "high" means three different things

`resizeWidth`/`resizeHeight` reliably produce the requested dimensions in all
three browsers. `resizeQuality` is accepted everywhere but is **not** a shared
definition of "high":

| options | chromium | firefox | webkit |
| --- | --- | --- | --- |
| `{resizeWidth: 100}` | flat 128 | flat 128 | flat 127 |
| `+ resizeQuality:"high"` | flat 127 | **gradient** (117/130/138) | flat 128 |
| `+ resizeQuality:"pixelated"` | flat 255 | flat 255 | **flat 0** |

On a checkerboard, "correct" downsampling collapses to the mean (~127) and only
nearest-neighbour keeps a hard edge. So chromium and webkit ignore
`resizeQuality` for a smooth downscale — both return the same flat mean for
`"high"` and for no quality at all — while firefox applies a real filter and
returns a gradient. And `"pixelated"` does not agree on *which* pixel it picks:
chromium and firefox return 255, webkit returns 0.

So the same `resizeWidth/resizeQuality: "high"` call yields three different
images depending on the browser. That is the reason not to build inference on
these options.

## Drawing into an already-sized canvas is the portable equivalent

Decoding at full size and then `drawImage`-ing into a canvas already sized to
the target is within a few LSBs of the decode-time resize, and it is the path
the app should use:

| comparison (mean / max abs diff per channel, 0-255) | chromium | firefox | webkit |
| --- | --- | --- | --- |
| `drawImage` vs `resizeWidth`+`high` | 0.00 / 0 | 0.59 / 4 | 0.06 / 1 |
| stepwise halving vs `resizeWidth`+`high` | 0.18 / 2 | 1.41 / 6 | 0.80 / 4 |

Chromium is bit-identical; firefox is the loosest but still under 2/255 mean.
Note the halving column: the stepwise halving `embedding.ts` already uses is
*further* from the decode-time resize than a single `drawImage` is. If a future
change compares against browser-resized output, it is comparing against
something no browser agrees on.

`imageSmoothingQuality = "high"` is the one knob worth setting on the canvas
path, and it is at least consistently accepted.

## `imageOrientation`: `"from-image"` is the default everywhere, and `"none"` is ignored everywhere

The EXIF orientation tag does change pixel content, so it is worth pinning. On
an orientation-6 JPEG (stored 400x200 landscape, must display as 200x400
portrait with the stored-left half on top):

| options | chromium | firefox | webkit |
| --- | --- | --- | --- |
| omitted (the default) | rotated | rotated | rotated |
| `imageOrientation: "from-image"` | rotated | rotated | rotated |
| `imageOrientation: "none"` | **rotated** | **rotated** | **rotated** |
| `imageOrientation: "flipY"` | flipped | flipped | flipped |

Two consequences, and the second is the useful one:

1. **The default already is `"from-image"`.** Passing it explicitly changes
   nothing today. It is still worth passing: it pins the behaviour against a
   browser changing its default, and it makes the one behaviour we depend on
   visible at the call site instead of implied.

2. **`"none"` does not work.** All three browsers ignore it and rotate anyway.
   `"flipY"` is the only value that does anything. So there is no option-level
   way to get an un-oriented decode — nothing to be gained by reaching for one,
   and a comment or a test that suggests otherwise would be wrong.

Orientation is therefore *not* a cross-browser divergence to design out. The app
can rely on `"from-image"` uniformly across all three; there is no browser that
ignores it in one direction and honours it in the other. What does need pinning
is the end-to-end property — that the pixels the classifier receives are upright
— which is what `e2e/tier1/exif-orientation.spec.ts` does. Note that mutating
the call to `"none"` does **not** make that test fail (see below), so the test
pins the behaviour rather than the option string.

## A test that cannot fail is worse than no test

Two mutations were tried against the orientation spec, and they do not behave the
way the diff suggests:

- Changing the call site from `imageOrientation: "from-image"` to `"none"` —
  **still passes**, because every browser ignores `"none"` (table above).
- Rotating the decode 90 deg the wrong way in `main.js` — **still passes**,
  because the batch path reassigns `slot.fullCanvas` after `decodeStage` draws
  it, so the mutation is overwritten before inference reads it.

What does make it fail is removing the orientation information itself: stripping
the APP1/Exif block from the JPEG before `createImageBitmap` produces an
unoriented decode, and the red-on-top assertion fails as intended.

So the spec is a genuine regression test for the *behaviour*, and specifically
not for the option spelling. Anyone changing `imageOrientation` to `"none"` and
seeing green has been told nothing by this suite.
