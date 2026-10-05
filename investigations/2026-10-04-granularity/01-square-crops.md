# Square manual crops: what the constraint has to be applied to, and where

Branch `fix/force-square-crops`. Square is now forced for manual crops. This
records the parts that were not obvious and that a later change would get wrong.

## A square is only square in the unit the crop is stored in

Crops are stored, cut and sent in **photo pixels**. They are *drawn* as
percentages of a panel. Those are not the same thing, and the two panels
disagree by construction: the full panel fits with `contain` (whole photo,
letterboxed on one axis) and the zoom panel with `cover` (frame cropped on one
axis). So a square in surface fractions is a **rectangle** in photo pixels
exactly whenever the photo's aspect differs from the panel's — which is the
normal case.

The constraint therefore runs in photo pixels, and the drag preview is the
committed box mapped back out through `boxInSurface`, rather than a second
square computed on the surface. The preview is the thing that gets committed,
so the two cannot drift. `main.js` used to have two panel-specific
`applyCropFrom*Surface` functions each re-deriving a rect from surface
fractions; they are now one `applySquareCrop` taking a pixel box, so there is no
step left at which the constraint can be undone.

## The map has a direction, and the wrong one compiles

`boxInSurface` maps image → surface as `(imageFraction - o) / k`. Its inverse is
therefore `k * surfaceFraction + o`. Writing `(pt - o) / k` in the inverse
function — the shape that reads like the forward one — compiles, type-checks,
and is wrong. It was wrong in the first draft of this change and was caught only
because the tests recompute the mapping independently and compare the two
directions against each other. A test that imports the function under test
agrees with every bug it has.

Same trap for hand-written mapping constants: a test's `contain`/`cover` values
must be derived from `fitMapping`'s convention, not reasoned about, or the test
asserts a wrong expectation and passes for the wrong reason.

## Pad and clamp BEFORE squaring, never after

Squaring a box that overhangs the photo's edge trims one side and leaves a
rectangle. So every path clamps first and squares second: the detector box is
padded by `CROP_PAD` and then squared (`main.js`, detector stage), and
`applySquareCrop` clamps to the photo and then squares. Squaring an
already-inside box is a no-op, which is what makes it safe to apply
unconditionally — including in `executeCrop`, the funnel every crop passes
through, so a programmatic caller handing over a non-square box gets it squared
rather than committing a rectangle.

`squareBox` floors the side rather than rounding up, so it never claims a pixel
the user did not drag over, and it is idempotent (which is what lets
`executeCrop` re-square unconditionally without trimming manual crops).

The old minimum-crop guard was a fraction **of the surface**. That cannot
survive: a square built in pixels and mapped onto a letterboxed panel can extend
past the surface edge, so its extent in surface fractions goes negative and the
guard compares the wrong quantity. It is now a pixel floor (`MIN_CROP_PX`), the
same 10px threshold that was already there, expressed in the unit the crop is
stored in.

## An existing non-square crop is left alone

Not reshaped on load. It was classified on exactly those pixels and the
displayed score describes them; re-fitting the box to a square on load would
move the outline away from the crop that was actually scored, change no pixels,
and give the user no way to see why. It keeps working as cut and becomes square
the next time it is edited. A detector-set or reprocessed crop *is* squared,
because there squaring happens at commit time — the same act that cuts its
pixels.

## Anchor: centre, not the drag-start corner

Centre-anchored (the box keeps the drag's midpoint fixed; side = the cursor's
larger separation, so the cursor sits on the leading edge). A corner-anchored
square sits in the quadrant the cursor started in, so as soon as the box is
squared the pointer runs away from the far edge and leaves the thing being
adjusted. Centre-anchoring keeps the cursor inside the crop for the whole
gesture.

## Test harness traps hit while testing this

- **The crop surface is below the fold** in Playwright's default 1280x720
  viewport. `boundingBox()` returns those off-screen coordinates happily, so a
  `mouse.move` to the middle of the surface is delivered to nothing: the
  pointerup never reaches the handler and the drag silently commits no crop,
  which looks exactly like a broken constraint. Diagnose it with
  `document.elementFromPoint(x, y)` returning nothing and comparing the
  surface's `y` against `window.innerHeight`.
- **Releasing a crop runs inference**, and tier 1 aborts the model fetch, so the
  commit takes the app's own failure path and logs — and a test asserting
  `errors(page)` is then asserting nothing. Install the same fake session
  `whole-frame-toggle.spec.ts` does.

Both are properties of driving this app, not of the square constraint, and both
cost real time to diagnose from the symptom.

## Assertion style, per issue #77

A past geometry suite passed 14 tests on entirely black thumbnails because every
assertion was "a box of some size came out". The e2e here paints the photo with
a pattern encoding each pixel's coordinates before dragging, so a crop taken
from the wrong place yields different bytes at the sampled points, and compares
the committed crop canvas against the source region pixel by pixel. Verified by
mutation: cutting the crop from the wrong origin leaves the box square and fails
only that assertion.
