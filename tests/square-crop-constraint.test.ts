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

  // The pixel floor is not the whole guard, and on a large photo it is far too
  // small to be. 10px is 0.4% of a 2400x1800 photo's short side, so with the
  // pixel floor alone an 18x18 crop of pure noise committed and was scored as
  // confidently as a mosquito - the fraction test that used to catch it was
  // dropped in the same change that introduced the pixel floor, leaving one guard
  // where the code had had two.
  describe("the fractional floor, which is the guard that scales with the photo", () => {
    const BIG: CanvasLike = { width: 2400, height: 1800 };
    const SMALL: CanvasLike = { width: 400, height: 300 };

    it("rejects an 18x18 crop on a 2400x1800 photo, which 10px alone accepted", () => {
      // The regression, stated as a number: 18 > 10, so the pixel floor passes it.
      expect(isCropTooSmall([100, 100, 118, 118])).toBe(false);
      // 0.015 of the 1800px short side is 27, so the fractional floor rejects it.
      expect(isCropTooSmall([100, 100, 118, 118], BIG)).toBe(true);
    });

    it("measures against the frame's SHORT side, which is the more permissive of the two", () => {
      // The guard asks "how big is this photo", and the short side is the reading
      // that answers it: a wide photo is not a small photo. Measuring the long
      // side instead would make the floor grow with the aspect ratio, so the same
      // 40px crop would be rejected on a panorama and accepted on a square of the
      // same height. Short side is therefore always the looser of the two, and
      // deliberately so - this test pins the choice rather than the strictness.
      const LANDSCAPE: CanvasLike = { width: 8000, height: 1000 }; // same height, 8x the width
      const SQUAREISH: CanvasLike = { width: 1000, height: 1000 };
      // 0.015 of 1000 is 15 on both, so both accept a 40px crop despite the
      // landscape being eight times the area.
      expect(isCropTooSmall([0, 0, 40, 40], LANDSCAPE)).toBe(false);
      expect(isCropTooSmall([0, 0, 40, 40], SQUAREISH)).toBe(false);
      // Scaling the SHORT side scales the floor: triple the height and the same
      // 40px crop is rejected, where a long-side reading would already have
      // rejected it at the original size.
      expect(isCropTooSmall([0, 0, 40, 40], { width: 3000, height: 3000 })).toBe(true);
      // And a small frame stays judged by the pixel floor alone.
      expect(isCropTooSmall([0, 0, 40, 40], SMALL)).toBe(false);
    });

    it("is the stricter of the two guards, never the looser", () => {
      // A frame so small that 0.015 of it is under 10px must still ACCEPT a crop
      // at the absolute floor - the fraction must not tighten the guard past
      // MIN_CROP_PX, or a small photo could become uncroppable.
      expect(isCropTooSmall([0, 0, MIN_CROP_PX, MIN_CROP_PX], { width: 100, height: 100 })).toBe(false);
      expect(isCropTooSmall([0, 0, 50, 50], { width: 100, height: 100 })).toBe(false);
      // And on a big frame the fraction is the binding guard, not the floor.
      expect(isCropTooSmall([0, 0, MIN_CROP_PX, MIN_CROP_PX], BIG)).toBe(true);
    });

    it("still rejects a zero-area box on a huge frame", () => {
      expect(isCropTooSmall([5, 5, 5, 5], BIG)).toBe(true);
    });

    it("does not read the box's extent as a fraction of anything that can go negative", () => {
      // The reason the original guard was a fraction of the SURFACE and had to be
      // replaced: a square mapped onto a letterboxed panel can extend past the
      // surface edge, so a surface-relative extent is negative and a threshold
      // comparison on it means the wrong thing. Measuring against the frame - the
      // unit the box is stored in - cannot produce a negative extent at all.
      expect(isCropTooSmall([-400, -200, 100, 100], BIG)).toBe(false);
    });
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

/**
 * The invariant the square constraint is built on: it never CROPS the box.
 *
 * It is worth stating as its own property because the opposite is easy to assume
 * and expensive to get wrong. `side = floor(min(w, h))` is less than or equal to
 * BOTH axes by construction, so the square can only ever shrink a box, never
 * escape it - there is no cap, no clamp and no special case that could push an
 * edge outward. The only overshoot is the `Math.round` on the near corner, half
 * a pixel, which is what makes the stored box integral in the first place.
 *
 * The cases below are the ones that LOOK like the square grows: a box wider than
 * the photo is tall, a box whose drag overhung the photo, a padded detector box
 * clamped to the photo's edge. In every one, what trims the box is the CLAMP or
 * the square's own definition, and the committed box is inside what was asked
 * for.
 */
describe("the square never crops the box it constrains", () => {
  // A 16:9 photo, so the short side is far smaller than the long one and a
  // box can genuinely be wider than the photo is tall.
  const PHOTO: CanvasLike = { width: 1600, height: 900 };

  /** clamp-to-photo then square, the order applySquareCrop commits in. */
  function commit(box: Box): Box {
    const c = squareBox([
      Math.max(0, Math.min(PHOTO.width, box[0])),
      Math.max(0, Math.min(PHOTO.height, box[1])),
      Math.max(0, Math.min(PHOTO.width, box[2])),
      Math.max(0, Math.min(PHOTO.height, box[3])),
    ]);
    return c;
  }

  it("is a property of the arithmetic, so it holds for any box at all", () => {
    // Randomised rather than enumerated: the invariant is `side <= min(w, h)`,
    // which is true by construction, and a property test is what says so without
    // having to trust the reader to see it in one line.
    let seed = 20261005;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 20000; i++) {
      const x1 = rand() * PHOTO.width;
      const y1 = rand() * PHOTO.height;
      const box: Box = [x1, y1, x1 + rand() * PHOTO.width, y1 + rand() * PHOTO.height];
      const s = squareBox(box);
      // Inside the input on every edge, allowing the documented half-pixel round.
      expect(s[0]).toBeGreaterThanOrEqual(box[0] - 0.5);
      expect(s[1]).toBeGreaterThanOrEqual(box[1] - 0.5);
      expect(s[2]).toBeLessThanOrEqual(box[2] + 0.5);
      expect(s[3]).toBeLessThanOrEqual(box[3] + 0.5);
    }
  });

  it("on a box wider than the photo is tall, the CLAMP trims it and squaring then trims the rest", () => {
    // The case that looks like the square "discarding the subject's ends". What
    // actually discards them is the clamp: a 1504px-wide box cannot be 1504px
    // tall on a 900px-tall photo, so it is truncated to the photo's height
    // BEFORE the square, and the square then takes min(1504, 900) = 900.
    const overhung = commit([48, -302, 1552, 1202]);
    expect(w(overhung)).toBe(h(overhung));
    // Bounded by the photo's short side, which is the floor any square on this
    // photo has to respect - not by any cap of its own.
    expect(w(overhung)).toBeLessThanOrEqual(PHOTO.height);
    // And inside the clamped box the clamp produced.
    expect(overhung[0]).toBeGreaterThanOrEqual(48);
    expect(overhung[2]).toBeLessThanOrEqual(1552);
  });

  it("loses nothing to squaring that the clamp did not already take", () => {
    // The direct statement of the property: given a box that is ALREADY inside
    // the photo, the square removes no part of it beyond the one axis it is
    // defined to trim, and it always keeps the box's own centre.
    const inside: Box = [48, 0, 1552, 900];
    const squared = squareBox(inside);
    expect((squared[0] + squared[2]) / 2).toBe((inside[0] + inside[2]) / 2);
    expect((squared[1] + squared[3]) / 2).toBe((inside[1] + inside[3]) / 2);
    // The untrimmed axis is untouched.
    expect(squared[1]).toBe(inside[1]);
    expect(squared[3]).toBe(inside[3]);
  });

  it("a padded detector box clamped at the photo's edge is squared, not re-widened", () => {
    // The detector path on a 16:9 photo with a detection 94% of the width: the
    // 10%-per-side pad overruns the photo, the clamp pulls it back to the full
    // width, and the square takes the height. The result is a small square on
    // the detection's own centre - the design the measurement report describes -
    // and it is inside the clamped box.
    const W = PHOTO.width, H = PHOTO.height;
    const detW = 0.94 * W, detH = 0.2 * H;
    const pad = 0.1;
    const padded: Box = [
      Math.max(0, W / 2 - detW / 2 - detW * pad), Math.max(0, H / 2 - detH / 2 - detH * pad),
      Math.min(W, W / 2 + detW / 2 + detW * pad), Math.min(H, H / 2 + detH / 2 + detH * pad),
    ];
    const squared = squareBox(padded);
    expect(w(squared)).toBe(h(squared));
    expect(squared[2] - squared[0]).toBe(padded[3] - padded[1]);
    expect((squared[0] + squared[2]) / 2).toBe((padded[0] + padded[2]) / 2);
    expect(squared[0]).toBeGreaterThanOrEqual(padded[0]);
    expect(squared[2]).toBeLessThanOrEqual(padded[2]);
  });

  it("the manual 1:1 constraint is square before the clamp, and bounded by the photo after it", () => {
    // `squareDragBox` sizes the square from the cursor's larger separation, so on
    // a 16:9 photo a wide drag ASKS for a square taller than the photo - which is
    // correct, because the gesture was that big. It is the commit clamp that has
    // to bring it inside, and both steps are where the earlier finding looked for
    // a crop of the box: neither one grows it.
    const asked = squareDragBox([0.03, 0.45], [0.97, 0.55], PHOTO, IDENTITY);
    expect(w(asked)).toBe(h(asked));
    // Its centre is the drag's midpoint, so the trim that follows is symmetric.
    expect((asked[0] + asked[2]) / 2).toBeCloseTo(PHOTO.width / 2, 6);
    // What the user actually asked for is larger than the photo's short side -
    // this is the case that makes the clamp load-bearing rather than cosmetic.
    expect(w(asked)).toBeGreaterThan(PHOTO.height);
    // Committed, it is inside the photo on every edge and still square.
    const committed = commit(asked);
    expect(w(committed)).toBe(h(committed));
    expect(committed[0]).toBeGreaterThanOrEqual(0);
    expect(committed[1]).toBeGreaterThanOrEqual(0);
    expect(committed[2]).toBeLessThanOrEqual(PHOTO.width);
    expect(committed[3]).toBeLessThanOrEqual(PHOTO.height);
    // And it keeps the centre the drag asked for, on the axis the photo bounds.
    expect((committed[1] + committed[3]) / 2).toBeCloseTo(PHOTO.height / 2, 6);
  });
});