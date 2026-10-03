# The two crop panels framed the photo differently — but the cause was not the CSS

Branch `agent/crop-surface-aspect` on `mosquito-id`, one commit, `main.js` only.
Compare: https://github.com/corneliusroemer-agent/mosquito-id/compare/main...agent/crop-surface-aspect

## The diagnosis I was given was wrong

The brief predicted the two `.crop-surface` elements get different heights, so
`object-fit: cover` crops a differently-shaped window in each. Measured, they are
**identical**, before and after — the CSS was never the problem:

| viewport | `#crop-surface-full` | `#crop-surface-zoomed` |
|---|---|---|
| desktop 1440×900 | **334.59 × 320.00** (1.0456) | **334.59 × 320.00** (1.0456) |
| phone 390×844 | **338.00 × 320.00** (1.0562) | **338.00 × 320.00** (1.0562) |

Three reasons the brief's reasoning didn't hold up:

- The two photo columns are both `0.9fr` (`index.html:421`), so they are the same width.
- `fitSurface()` (`main.js:1707`) already pins each surface to inline
  `width: 100%; height: 100%` of a `.crop-container` that is `height: 320px`. The
  surface takes its box from the container, never from the photo — that was a
  deliberate earlier fix, with a comment saying so, precisely to stop the photo
  resizing the page.
- So `aspect-ratio` has nothing to correct. Adding it would have changed the
  layout for no gain, and `max-height: 320px` would indeed have fought it.

The brief also said `applyCropFromFullSurface` "was fixed to do this" and not to
regress it. It had **not** been fixed — see below.

## What was actually different: the crop rectangles

Identical surfaces, but the crop drawn on them had visibly different shapes:

| viewport | full panel box | zoom panel box |
|---|---|---|
| desktop | 149.33 × 150.97 (0.9891) | 251.11 × 199.16 (1.2609) |
| phone | 149.33 × 149.45 (0.9992) | 253.78 × 201.05 (1.2623) |

One is square, the other rectangular. That is Cornelius's report, and it is the
rectangle, not the panel.

`coverMapping()` (`main.js:1027`) collapsed the cover window to a **single scalar
`k` applied to both axes**. But `object-fit: cover` crops on exactly one axis and
shows the other whole. Applying one `k` to both therefore stretched the
un-cropped axis by `1/k`. Worked through for the desktop case (4000×3000 photo in
a 334.59×320 surface, true `kx=0.7842`, `ky=1`):

```
true     149.33 × 118.40 px
current  149.33 × 150.98 px    vertical inflated by 1/k = 1.2752
measured 149.33 × 150.97 px
```

The prediction matches the browser to 0.01px, so this is the mechanism. The two
panels disagreed because each one's crop was distorted by a *different* factor —
each depends on its own image's aspect against the shared box.

## The fix

Per-axis scales, because cover really is per-axis:

```js
const kx = Math.min(1, boxAspect / imgAspect);
const ky = Math.min(1, imgAspect / boxAspect);
return { kx, ox: (1 - kx) / 2, ky, oy: (1 - ky) / 2 };
```

All three call sites updated to the new shape. No CSS changed. No markup changed.

**A second bug, found on the way.** `applyCropFromFullSurface` (`main.js:1972`)
mapped the drag's surface fractions straight onto the photo:

```js
rect[0] * fullCv.width      // identity — ignores the cover window
```

so a drag on the left panel landed on the same *fraction* of a wider photo rather
than on the pixels under the pointer. It now goes through `coverMapping()`, the
same map `cropBoxInFullSurface()` draws with, so the drag and the outline agree by
construction. This is the regression the brief warned about; it was already there.

`cachedViewerAspect` was also never invalidated — no `resize` listener existed at
all. Added, dropping the cache on `resize` and `orientationchange`. It is only
read while `#gallery-section` is `display:none`, so this affects the context region
chosen for the *first* photo after a rotate.

## After

Both rectangles now carry the true crop's aspect, at both viewports and for
landscape, portrait and square sources:

| image | viewport | full panel | zoom panel |
|---|---|---|---|
| 4000×3000 | desktop | 149.33 × 118.39 (**1.2613**) | 251.11 × 199.09 (**1.2613**) |
| 4000×3000 | phone | 149.33 × 118.39 (**1.2613**) | 253.58 × 201.05 (**1.2613**) |
| 3000×4000 | desktop | 117.09 × 165.06 (**0.7094**) | 170.20 × 239.91 (**0.7095**) |
| 4000×4000 | desktop | 117.09 × 123.80 (**0.9459**) | 226.94 × 239.91 (**0.9459**) |

The two panels differ in size, which is correct — the zoom is a magnification —
but their *shapes* now agree to four decimals, and match the 1400×1110 crop they
both depict.

## Drag round-trip, in image pixels

Drawn rectangle read off the DOM *during* the drag, compared against
`p.cropBox` after release, across four source aspects × two viewports:

```
desktop 4000x3000  drawn [0.30,0.28,0.62,0.70] -> stored [1373,840,2376,2100]   err 0.04px
desktop 3000x4000  drawn [0.30,0.28,0.62,0.70] -> stored [ 900,1369,1860,2574]  err 0.02px
desktop 4000x4000  drawn [0.30,0.28,0.62,0.70] -> stored [1200,1158,2480,2765]  err 0.03px
desktop 3000x2250  drawn [0.30,0.28,0.62,0.70] -> stored [1029,630,1782,1575]   err 0.07px
phone   4000x3000  ...                                                            err 0.03px
phone   3000x4000  ...                                                            err 0.02px
phone   4000x4000  ...                                                            err 0.04px
phone   3000x2250  ...                                                            err 0.04px
```

All within 0.07px of a 334–338px surface. Before the fix the identity-map drag was
wrong by up to 300px on a 4000px-wide photo.

## Not regressed

- `hasCropBox()` (`main.js:953`) — untouched; zero lines in the diff mention it.
- Both panels still map through `coverMapping()`, never the identity
  (`main.js:964`, `main.js:992`).
- Identity preserved when aspects match, when there is no image, and when there is
  no surface: all four return `{kx:1, ox:0, ky:1, oy:0}`.
- No pixel values written into any grid track; no `fitSurface` change, so the
  page-resize feedback loop is untouched.
- `node --check main.js` passes.

## Screenshots

`24-shots/` — `before-desktop.png`, `before-phone.png`, `after-desktop.png`,
`after-phone.png`. Both panels visible with a crop rectangle drawn. In the
"before" images the left rectangle is square and the right one rectangular; in the
"after" images they match.

## How this was measured

The classifier is 1.26 GB and is not needed for crop geometry, so Playwright
aborts `.onnx` and `.r2.dev`. Photos are fabricated as canvases (landscape,
portrait, square) and injected through the app's own `renderActivePhoto()`, so the
layout exercised is the real one. Server on port 8137; harness in
`/tmp/cropsite` (a copy of `site/` with a `__probe.js` appended) and
`/workspace/tmp/qe-audit/{measure-crop,roundtrip-crop,identity-case}.mjs`.

One caveat worth stating: the score panel shows "Classification failed" in every
screenshot, because the model never loads. That is the abort working. The crop
geometry it sits next to is real.

## For whoever reviews this

The symptom Cornelius describes — "always different shapes left and right" — is
fixed, and the screenshots show it. What I could not test end-to-end is a photo
that has been through the real detector, so the *default* context region a real
classification picks is unverified. That path only affects where the zoom panel
starts, not the shape agreement, which is arithmetic and is verified.
