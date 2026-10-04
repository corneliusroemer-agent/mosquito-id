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

describe("thumbnailSize", () => {
  it("scales the 12.5 MP phone photo down to a 252 px short edge", () => {
    expect(thumbnailSize(3072, 4080)).toEqual({ w: 252, h: 335 });
  });

  it("scales the 50 MP phone photo down to a 252 px short edge", () => {
    expect(thumbnailSize(6144, 8160)).toEqual({ w: 252, h: 335 });
  });

  it("preserves aspect ratio to within a pixel of rounding", () => {
    for (const [w, h] of [[3072, 4080], [6144, 8160], [4032, 3024], [1024, 1024], [16384, 600]]) {
      const s = thumbnailSize(w, h);
      const src = w / h, dst = s.w / s.h;
      expect(Math.abs(src - dst) / src, `${w}x${h}`).toBeLessThan(0.005);
    }
  });

  it("sizes on the short edge, so `object-fit: cover` fills the tile from the same edge as before", () => {
    // A wide panorama and a tall portrait both end up with a 252 px short edge:
    // whichever edge cover scales to the tile is the one that fills it.
    expect(Math.min(...Object.values(thumbnailSize(6144, 2000)))).toBe(SHORT_EDGE);
    expect(Math.min(...Object.values(thumbnailSize(2000, 6144)))).toBe(SHORT_EDGE);
  });

  it("never enlarges a source that is already small enough", () => {
    expect(thumbnailSize(252, 335)).toEqual({ w: 252, h: 335 });
    expect(thumbnailSize(64, 64)).toEqual({ w: 64, h: 64 });
    expect(thumbnailSize(100, 300)).toEqual({ w: 100, h: 300 });
  });

  it("leaves a degenerate-aspect source alone, because its short edge is already under the tile", () => {
    // Scaling on the short edge means the edge that ends up at SHORT_EDGE is
    // always exactly SHORT_EDGE, so the long edge can never round away to zero
    // and needs no clamp. A 3 px-tall panorama is under the tile size already.
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
    // The intermediate is 771x1024; its short edge (771) is what step two sizes on.
    expect(steps[1]).toEqual({ w: 252, h: 335 });
  });

  it("caps no single step at more than the intermediate edge", () => {
    for (const [w, h] of [[3072, 4080], [6144, 8160], [12000, 9000], [16384, 600]]) {
      let prev = Math.max(w, h);
      for (const s of thumbnailSteps(w, h)) {
        expect(Math.max(s.w, s.h), `${w}x${h} -> ${s.w}x${s.h}`).toBeLessThanOrEqual(prev);
        prev = Math.max(s.w, s.h);
      }
      // The first step is the only one bounded by the intermediate, and it is
      // bounded below it so the second step still has room to run.
      if (Math.max(w, h) > 1024) {
        expect(Math.max(...Object.values(thumbnailSteps(w, h)[0]))).toBeLessThanOrEqual(1024);
      }
    }
  });

  it("ends on a short edge of exactly the thumbnail size", () => {
    for (const [w, h] of [[3072, 4080], [6144, 8160], [4000, 3000]]) {
      const steps = thumbnailSteps(w, h);
      expect(Math.min(...Object.values(steps[steps.length - 1]))).toBe(SHORT_EDGE);
    }
  });

  it("takes one step for a source under the intermediate, and none for one already at thumbnail size", () => {
    // 1000x800 is over the 252 px short edge but under the 1024 px long edge, so
    // it must not be put through an intermediate it does not need.
    expect(thumbnailSteps(1000, 800)).toHaveLength(1);
    expect(thumbnailSteps(1000, 800)[0]).toEqual({ w: 315, h: 252 });
    expect(thumbnailSteps(252, 335)).toHaveLength(0);
    expect(thumbnailSteps(64, 64)).toHaveLength(0);
  });

  it("is empty for a degenerate canvas, which is the caller's cue to encode the source", () => {
    expect(thumbnailSteps(0, 0)).toHaveLength(0);
  });
});
