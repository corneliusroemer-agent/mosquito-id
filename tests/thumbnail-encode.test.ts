import { describe, expect, it } from "vitest";
import { thumbnailSize, thumbnailSteps } from "../src/app/canvasCache";

/**
 * The geometry a thumbnail encode is sized by.
 *
 * The tile is an 84 px box at the widest breakpoint with `object-fit: cover`, so
 * the only two things that decide whether a downscaled thumbnail looks like the
 * full-resolution one are the edge that has to fill the box and the device-pixel
 * count left to fill it with. Both are pinned here; the pixel comparison that
 * justifies the constants is in `docs/THUMBNAIL-ENCODE.md`.
 */

/** The constants `thumbnailSize` defaults to, restated so a change is visible. */
const SHORT_EDGE = 252;
/** The long edge of the intermediate `thumbnailSteps` shrinks a large source through. */
const INTERMEDIATE = 1024;

/** The two photo resolutions in the 30-photo corpus, plus the edge cases around them. */
const SOURCES = [
  { label: "12.5 MP portrait", w: 3072, h: 4080 },
  { label: "50 MP portrait", w: 6144, h: 8160 },
  { label: "12 MP landscape", w: 4032, h: 3024 },
  { label: "square", w: 1024, h: 1024 },
  { label: "panorama", w: 16384, h: 600 },
  { label: "sub-intermediate", w: 1200, h: 900 },
];

describe("thumbnailSize", () => {
  it("scales a 12.5 MP photo down to a 252 px short edge", () => {
    expect(thumbnailSize(3072, 4080)).toEqual({ w: 252, h: 335 });
  });

  it("scales a 50 MP photo down to a 252 px short edge", () => {
    expect(thumbnailSize(6144, 8160)).toEqual({ w: 252, h: 335 });
  });

  it("preserves aspect ratio to within a pixel of rounding", () => {
    for (const { label, w, h } of SOURCES) {
      const s = thumbnailSize(w, h);
      const src = w / h;
      expect(Math.abs(src - s.w / s.h) / src, label).toBeLessThan(0.005);
    }
  });

  it("sizes on the short edge, so `object-fit: cover` fills the tile from the same edge as before", () => {
    // Cover scales by max(boxW/w, boxH/h), so for a square tile it is always the
    // short edge that fills it - whichever way the photo is oriented. Sizing on
    // the short edge is what makes the tile's crop identical either way.
    const wide = thumbnailSize(6144, 2000);
    const tall = thumbnailSize(2000, 6144);
    expect(Math.min(wide.w, wide.h)).toBe(SHORT_EDGE);
    expect(Math.min(tall.w, tall.h)).toBe(SHORT_EDGE);
  });

  it("never enlarges a source that is already small enough", () => {
    expect(thumbnailSize(252, 335)).toEqual({ w: 252, h: 335 });
    expect(thumbnailSize(64, 64)).toEqual({ w: 64, h: 64 });
    expect(thumbnailSize(100, 300)).toEqual({ w: 100, h: 300 });
  });

  it("leaves a degenerate-aspect source alone, because its short edge is already under the tile", () => {
    // Scaling on the short edge means the edge that lands on SHORT_EDGE is always
    // exactly SHORT_EDGE, so the other edge can never round away to zero and needs
    // no clamp. A 3 px-tall panorama is under the tile size already.
    expect(thumbnailSize(100000, 3)).toEqual({ w: 100000, h: 3 });
    expect(thumbnailSize(1000, 252)).toEqual({ w: 1000, h: 252 });
    expect(thumbnailSize(1000, 253)).toEqual({ w: 996, h: 252 });
  });

  it("passes a zero-sized canvas through unchanged, because it cannot be drawn", () => {
    expect(thumbnailSize(0, 0)).toEqual({ w: 0, h: 0 });
    expect(thumbnailSize(0, 4080)).toEqual({ w: 0, h: 4080 });
  });
});

describe("thumbnailSteps", () => {
  it("takes two steps for a 50 MP source, because one 50x reduction aliases", () => {
    const steps = thumbnailSteps(6144, 8160);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ w: 771, h: 1024 });
    // The intermediate is 771x1024, whose short edge (771) is what step two sizes on.
    expect(steps[1]).toEqual({ w: 252, h: 335 });
  });

  it("never shrinks by more than the intermediate allows, in any one step", () => {
    for (const { label, w, h } of SOURCES) {
      let prevLong = Math.max(w, h);
      for (const s of thumbnailSteps(w, h)) {
        expect(Math.max(s.w, s.h), label).toBeLessThanOrEqual(prevLong);
        prevLong = Math.max(s.w, s.h);
      }
    }
  });

  it("bounds a large source's first step at the intermediate, leaving the second step room", () => {
    for (const { label, w, h } of SOURCES) {
      const steps = thumbnailSteps(w, h);
      if (steps.length < 2 || Math.max(w, h) <= INTERMEDIATE) continue;
      const first = steps[0];
      if (!first) continue;
      expect(Math.max(first.w, first.h), label).toBeLessThanOrEqual(INTERMEDIATE);
      // If the intermediate already equalled the short edge there would be no
      // second step, and the aliasing the two steps exist to avoid would return.
      expect(Math.min(first.w, first.h), label).toBeGreaterThan(SHORT_EDGE);
    }
  });

  it("skips the intermediate for a panorama, whose short edge it would crush below the tile", () => {
    // 16384x600 at a 1024 long edge is 1024x38 - a 38 px short edge, under the
    // 252 the tile needs. Resampling once at the final size beats two steps whose
    // first has already thrown the detail away.
    const steps = thumbnailSteps(16384, 600);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ w: 6881, h: 252 });
  });

  it("ends on a short edge of exactly the thumbnail size", () => {
    for (const { label, w, h } of SOURCES) {
      const steps = thumbnailSteps(w, h);
      const last = steps[steps.length - 1];
      if (!last) continue;
      expect(Math.min(last.w, last.h), label).toBe(SHORT_EDGE);
    }
  });

  it("takes one step for a source already under the intermediate", () => {
    // 1000x800 is over the 252 px short edge but under the 1024 px long edge, so
    // it must not be put through an intermediate it does not need.
    expect(thumbnailSteps(1000, 800)).toHaveLength(1);
    expect(thumbnailSteps(1000, 800)[0]).toEqual({ w: 315, h: 252 });
  });

  it("takes no resample at all for a source already at or under thumbnail size", () => {
    expect(thumbnailSteps(252, 335)).toHaveLength(0);
    expect(thumbnailSteps(64, 64)).toHaveLength(0);
    expect(thumbnailSteps(0, 0)).toHaveLength(0);
  });
});
