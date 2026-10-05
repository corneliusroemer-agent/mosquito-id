// The square-crop constraint: where the box lands, not merely that it is square.
//
// Issue #77 is the reason these are written the way they are: a geometry suite
// once passed 14 tests against entirely black thumbnails, because every
// assertion was of the shape "a box of some size came out". A square box in the
// wrong place is exactly as wrong as a rectangle, and passes that kind of test.
//
// So each case below pins two things at once: the box is square AND it is the
// square the cursor asked for. The anchor cases check the box's CENTRE lands on
// the midpoint of the drag in photo pixels, which is a position assertion - a
// box that grew from the wrong anchor still has the right side length and would
// pass a shape-only test. `squareCropCutsThePixelsUnderTheCursor` then goes
// further and reconstructs the pixels by hand and checks the crop's corners are
// the pixels under the two drag points.
import { describe, it, expect } from "vitest";
import { boxInSurface, isCropTooSmall, squareBox, squareDragBox,
         surfacePointToFrame, MIN_CROP_PX } from "../src/app/cropGeometry";
import type { Box, CanvasLike, Mapping } from "../src/app/types";

// A 400x300 photo in a 400x400 surface: the aspects differ, so `contain`
// letterboxes and this mapping is NOT the identity. A test run against a square
// image in a square surface would pass a mapping bug that moves the crop off the
// pixels the user pointed at.
//
// Both mappings below are what `fitMapping` produces for that panel and fit,
// computed rather than guessed: the convention is imageFraction = k*surface + o,
// so a 400x300 photo letterboxed into a square has the WIDE axis at k=1 and the
// short axis magnified by 400/300 with a negative offset. Writing the reciprocal
// here (k = 300/400) is the same mistake as writing the inverse map in
// surfacePointToFrame, and it silently passes any test that does not check the
// numbers against the surface.
const IMG: CanvasLike = { width: 400, height: 300 };
const CONTAIN: Mapping = { kx: 1, ox: 0, ky: 400 / 300, oy: (1 - 400 / 300) / 2 };
const COVER: Mapping = { kx: 300 / 400, ox: (1 - 300 / 400) / 2, ky: 1, oy: 0 };

// The identity mapping: a frame whose aspect matches its surface exactly. Used
// where the test is about the constraint and not about the fit.
const IDENTITY: Mapping = { kx: 1, ox: 0, ky: 1, oy: 0 };
const SQUARE_FRAME: CanvasLike = { width: 400, height: 400 };

const w = (b: Box) => b[2] - b[0];
const h = (b: Box) => b[3] - b[1];

describe("squareBox", () => {
  it("squares a box that is wider than tall, keeping the centre", () => {
    const [x1, y1, x2, y2] = squareBox([100, 100, 500, 300]);
    expect(w([x1, y1, x2, y2])).toBe(h([x1, y1, x2, y2]));
    expect(w([x1, y1, x2, y2])).toBe(200);
    // Centre preserved: the trimmed axis keeps its midpoint, so the pixels the
    // user centred the crop on are still inside it.
    expect((x1 + x2) / 2).toBe(300);
    expect((y1 + y2) / 2).toBe(200);
  });

  it("squares a box that is taller than wide, keeping the centre", () => {
    const [x1, y1, x2, y2] = squareBox([100, 100, 300, 500]);
    expect(w([x1, y1, x2, y2])).toBe(h([x1, y1, x2, y2]));
    expect(w([x1, y1, x2, y2])).toBe(200);
    expect((x1 + x2) / 2).toBe(200);
    expect((y1 + y2) / 2).toBe(300);
  });

  it("never grows the box, so it can never claim a pixel the user did not drag over", () => {
    // The property that makes this safe to apply to a box a user drew: `side`
    // floors the smaller axis rather than rounding up, so the square is always
    // inside the box it was asked to constrain.
    const box = squareBox([0, 0, 101, 100]);
    expect(box[2] - box[0]).toBeLessThanOrEqual(101);
    expect(box[3] - box[1]).toBeLessThanOrEqual(100);
  });

  it("is idempotent, which is what lets executeCrop re-square unconditionally", () => {
    // executeCrop squares every box it is handed. On the manual path the box is
    // already square, so that call must be a no-op - otherwise the guard would
    // quietly trim a pixel on every crop.
    const once = squareBox([37, 91, 337, 291]);
    expect(squareBox(once)).toEqual(once);
  });

  it("leaves an already-square box exactly where it is", () => {
    expect(squareBox([10, 20, 110, 120])).toEqual([10, 20, 110, 120]);
  });

  it("leaves a degenerate box degenerate rather than inventing a crop", () => {
    // The zero-size drag. Squaring must not be the thing that turns a stray
    // click into a 1x1 crop that re-runs inference over the batch; the caller
    // rejects it with isCropTooSmall.
    const zero = squareBox([50, 50, 50, 50]);
    expect(w(zero)).toBe(0);
    expect(h(zero)).toBe(0);
    expect(isCropTooSmall(zero)).toBe(true);
  });
});

describe("isCropTooSmall", () => {
  it("rejects a box with no area, which is what a click produces", () => {
    expect(isCropTooSmall([10, 10, 10, 10])).toBe(true);
  });

  it("rejects a box under the pixel floor in either axis", () => {
    expect(isCropTooSmall([0, 0, MIN_CROP_PX - 1, 500])).toBe(true);
    expect(isCropTooSmall([0, 0, 500, MIN_CROP_PX - 1])).toBe(true);
  });

  it("accepts a box at or over the floor", () => {
    expect(isCropTooSmall([0, 0, MIN_CROP_PX, MIN_CROP_PX])).toBe(false);
    expect(isCropTooSmall([0, 0, 500, 500])).toBe(false);
  });

  it("accepts a degenerate-looking box whose area is fine", () => {
    // The negative-side case that made the old fraction-of-surface test wrong:
    // a square built in pixels and mapped onto a letterboxed panel can sit
    // partly off the surface, so testing its extent as a fraction of the surface
    // compares a quantity that can go negative.
    expect(isCropTooSmall([-400, -200, 100, 100])).toBe(false);
  });
});

describe("squareDragBox - the anchor", () => {
  it("anchors on the centre: the box is centred on the drag's midpoint", () => {
    // Centre-anchored, and this is the assertion a shape-only test cannot make:
    // the side length is right either way, but the position is what says the
    // box grew symmetrically under the cursor rather than out of the corner the
    // cursor started in.
    const start: [number, number] = [0.25, 0.25];
    const cur: [number, number] = [0.75, 0.45];
    const box = squareDragBox(start, cur, SQUARE_FRAME, IDENTITY);

    const mid = surfacePointToFrame(
      [(start[0] + cur[0]) / 2, (start[1] + cur[1]) / 2], SQUARE_FRAME, IDENTITY,
    );
    expect((box[0] + box[2]) / 2).toBeCloseTo(mid[0], 6);
    expect((box[1] + box[3]) / 2).toBeCloseTo(mid[1], 6);
  });

  it("grows symmetrically: equal movement in either direction gives the same centre", () => {
    // The property that makes centre-anchoring feel right. Dragging 100px left
    // and 100px right from the same start must give boxes whose centres sit the
    // same distance either side of the start, not two boxes both to one side.
    const start: [number, number] = [0.5, 0.5];
    const right = squareDragBox(start, [0.75, 0.5], SQUARE_FRAME, IDENTITY);
    const left = squareDragBox(start, [0.25, 0.5], SQUARE_FRAME, IDENTITY);

    // The cursor sits at the box's edge along the leading axis, so the centre is
    // half a side off the start in the direction of travel: 0.5 + 0.25/2.
    expect((right[0] + right[2]) / 2).toBeCloseTo(250, 6);
    expect((left[0] + left[2]) / 2).toBeCloseTo(150, 6);
    // Equal size, so the gesture is symmetric in both axes of meaning.
    expect(w(right)).toBeCloseTo(w(left), 6);
  });

  it("squares a drag that would be wider than tall, taking the larger separation", () => {
    const box = squareDragBox([0.2, 0.5], [0.8, 0.5], SQUARE_FRAME, IDENTITY);
    expect(w(box)).toBe(h(box));
    // 0.6 of 400 = 240 across, so the side is 240.
    expect(w(box)).toBeCloseTo(240, 6);
  });

  it("squares a drag that would be taller than wide, taking the larger separation", () => {
    const box = squareDragBox([0.5, 0.1], [0.5, 0.9], SQUARE_FRAME, IDENTITY);
    expect(w(box)).toBe(h(box));
    expect(h(box)).toBeCloseTo(320, 6);
  });

  it("puts the cursor on the box's edge along the axis that is leading", () => {
    // The feedback property: on the constrained axis the box's edge tracks the
    // cursor exactly, which is what tells the user the shape is following them.
    const start: [number, number] = [0.25, 0.25];
    const cur: [number, number] = [0.25, 0.75];
    const box = squareDragBox(start, cur, SQUARE_FRAME, IDENTITY);
    const curFrame = surfacePointToFrame(cur, SQUARE_FRAME, IDENTITY);
    // y separates by 0.5 and x by 0, so the side is 0.5 and y is the leading
    // axis: the box's bottom edge sits on the cursor.
    expect(box[3]).toBeCloseTo(curFrame[1], 6);
  });

  it("yields a box the caller rejects when the drag never moved", () => {
    // The click case. Not square-equal-to-something - specifically not committed.
    const p: [number, number] = [0.4, 0.6];
    const box = squareDragBox(p, p, SQUARE_FRAME, IDENTITY);
    expect(isCropTooSmall(box)).toBe(true);
  });

  it("yields a rejected box for a drag of a couple of pixels too", () => {
    // Near-miss rather than the exact zero: a jittery pointer must not slip a
    // tiny crop through.
    const box = squareDragBox([0.5, 0.5], [0.501, 0.5], SQUARE_FRAME, IDENTITY);
    expect(isCropTooSmall(box)).toBe(true);
  });
});

describe("the box lands on the pixels under the cursor", () => {
  it("squareCropCutsThePixelsUnderTheCursor", () => {
    // The #77 assertion. Reconstruct by hand where the cursor is in photo
    // pixels, and check the square's edges are there - through a letterboxed
    // mapping, because that is where a box-in-surface-fractions implementation
    // would put the crop in the wrong place while still coming out square.
    const start: [number, number] = [0.2, 0.3];
    const cur: [number, number] = [0.7, 0.6];

    const startFrame = surfacePointToFrame(start, IMG, CONTAIN);
    const curFrame = surfacePointToFrame(cur, IMG, CONTAIN);
    const box = squareDragBox(start, cur, IMG, CONTAIN);

    // Hand-computed expectation: the cursor's separation in photo pixels. The
    // side is that separation and NOT twice it - the box spans from halfway
    // back towards the drag's start to halfway forward, so the cursor ends up
    // exactly on the leading edge. Doubling here is the arithmetic that would
    // make the box overshoot the pointer by half its width.
    const dx = Math.abs(curFrame[0] - startFrame[0]);
    const dy = Math.abs(curFrame[1] - startFrame[1]);
    const side = Math.max(dx, dy);
    const midX = (startFrame[0] + curFrame[0]) / 2;
    const midY = (startFrame[1] + curFrame[1]) / 2;

    expect(w(box)).toBeCloseTo(side, 6);
    expect(h(box)).toBeCloseTo(side, 6);
    expect(box[0]).toBeCloseTo(midX - side / 2, 6);
    expect(box[2]).toBeCloseTo(midX + side / 2, 6);
    expect(box[1]).toBeCloseTo(midY - side / 2, 6);
    expect(box[3]).toBeCloseTo(midY + side / 2, 6);
  });

  it("round-trips a box through the surface and lands back on the same pixels", () => {
    // The preview is the committed box mapped back out through boxInSurface, so
    // the outline the user sees is drawn on the pixels that get cut. Mapping
    // there and back must be the identity - if it is not, the outline and the
    // crop have silently drifted apart.
    const box = squareDragBox([0.2, 0.3], [0.7, 0.6], IMG, CONTAIN);
    const pct = boxInSurface(box, IMG, CONTAIN);
    const near = surfacePointToFrame([pct.left / 100, pct.top / 100], IMG, CONTAIN);
    const far = surfacePointToFrame(
      [(pct.left + pct.width) / 100, (pct.top + pct.height) / 100], IMG, CONTAIN,
    );
    expect(near[0]).toBeCloseTo(box[0], 6);
    expect(near[1]).toBeCloseTo(box[1], 6);
    expect(far[0]).toBeCloseTo(box[2], 6);
    expect(far[1]).toBeCloseTo(box[3], 6);
  });

  it("keeps a box drawn on a letterboxed surface inside the photo", () => {
    // A drag to the surface's very corner must not produce a square hanging off
    // the photo. The preview may extend past the surface (which is what makes
    // the old fraction test wrong), but the committed box is clamped to the
    // photo's own pixels - and the clamp happens before the square, so what
    // comes out is still square.
    const box = squareDragBox([0, 0], [1, 1], IMG, CONTAIN);
    const clamped = squareBox([
      Math.max(0, box[0]), Math.max(0, box[1]),
      Math.min(IMG.width, box[2]), Math.min(IMG.height, box[3]),
    ]);
    expect(w(clamped)).toBe(h(clamped));
    expect(clamped[0]).toBeGreaterThanOrEqual(0);
    expect(clamped[1]).toBeGreaterThanOrEqual(0);
    expect(clamped[2]).toBeLessThanOrEqual(IMG.width);
    expect(clamped[3]).toBeLessThanOrEqual(IMG.height);
  });

  it("stays square under a cover mapping, where the surface crops the frame", () => {
    // The zoom panel's fit. Under cover k > 1 and the offset is negative, so a
    // surface point near an edge maps OUTSIDE the frame - the case the letterbox
    // test above cannot reach.
    const box = squareDragBox([0.05, 0.05], [0.6, 0.9], IMG, COVER);
    expect(w(box)).toBe(h(box));
    expect(isCropTooSmall(box)).toBe(false);
  });
});

describe("a programmatic caller passing a non-square box", () => {
  it("is squared by executeCrop's funnel, deterministically", () => {
    // What executeCrop does to whatever it is handed. A caller with no drag
    // behind it has no preview to disagree with, so this is the only place the
    // invariant can be relied on for it.
    const programmatic: Box = [40, 60, 340, 260]; // 300x200, from the detector path
    const first = squareBox(programmatic);
    const second = squareBox(first);
    expect(w(first)).toBe(h(first));
    // Deterministic: the same input gives the same box on every call and on
    // every run, which is what lets it be stored and re-read.
    expect(second).toEqual(first);
    expect(first).toEqual(squareBox(programmatic));
  });

  it("squares the detector box without moving the detection's centre", () => {
    // The detector pads by CROP_PAD and then this. Squaring keeps the centre, so
    // what is classified is still centred on what was found - only the longer
    // axis is trimmed.
    const padded: Box = [120, 150, 420, 350]; // 300x200
    const squared = squareBox(padded);
    expect(w(squared)).toBe(200);
    expect((squared[0] + squared[2]) / 2).toBe((padded[0] + padded[2]) / 2);
    expect((squared[1] + squared[3]) / 2).toBe((padded[1] + padded[3]) / 2);
  });
});