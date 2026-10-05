/**
 * The zoomed panel's context region must CONTAIN the crop box.
 *
 * `extractContextCrop` centres a region on the box, inflates it to 75% border
 * fit, then clamps it into the photo. The clamp used to re-derive the other
 * axis from the panel aspect on each step, so a second clamp could shrink an
 * axis below the box: on a 16:9 photo with a 0.94-wide box the region came back
 * 0.59 of the image wide against a 0.94 box, and the box ran off the panel's
 * left and right edges. Tall boxes on portrait photos failed the same way along
 * the other axis.
 *
 * The requirement is the containment itself, so that is what is asserted: for
 * every photo shape and box shape, `contextBox` contains `cropBox` and lies
 * inside the photo. Nothing here reads the panel aspect from the DOM - vitest
 * runs in a node environment - so `targetAspect` is passed in, which is the
 * panel aspect the caller measured.
 *
 * A green suite before the fix would mean this file was not measuring the clamp,
 * so run it against `main` to see it go red first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractContextCrop } from "../src/app/cropGeometry";

/** A canvas stub: `extractContextCrop` reads width/height and calls drawImage. */
function fakeCanvas(w: number, h: number) {
  return {
    width: w,
    height: h,
    getContext: () => ({ drawImage: vi.fn() }),
  } as unknown as HTMLCanvasElement;
}

/** `document.createElement("canvas")` is the only DOM this function needs. */
beforeEach(() => {
  (globalThis as any).document = {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error(`unexpected createElement(${tag})`);
      // The crop sizes the canvas itself, so start at zero.
      return { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }) };
    },
  };
});

afterEach(() => {
  delete (globalThis as any).document;
});

/** Photo shapes: landscape, square, portrait, and the two phone ratios. */
const PHOTOS: [string, number, number][] = [
  ["4:3", 1600, 1200],
  ["3:2", 1800, 1200],
  ["16:9", 1920, 1080],
  ["1:1", 1200, 1200],
  ["3:4", 1200, 1600],
  ["9:16", 1080, 1920],
];

/** Boxes as fractions of the photo: wide, tall, small, and off-centre. */
const BOXES: [string, [number, number, number, number]][] = [
  ["wide 0.94x0.44", [0.03, 0.28, 0.97, 0.72]],
  ["wide 0.60x0.40", [0.2, 0.3, 0.8, 0.7]],
  ["small 0.30x0.30", [0.35, 0.35, 0.65, 0.65]],
  ["tall 0.40x0.94", [0.3, 0.03, 0.7, 0.97]],
  ["tall 0.50x0.94", [0.25, 0.03, 0.75, 0.97]],
  ["off-centre corner", [0.02, 0.02, 0.4, 0.36]],
];

/** Panel aspects: near-square (desktop and phone), wide and tall. */
const ASPECTS = [1.05, 1.25, 0.8];

function boxInPixels(f: [number, number, number, number], w: number, h: number) {
  return [
    Math.round(f[0] * w),
    Math.round(f[1] * h),
    Math.round(f[2] * w),
    Math.round(f[3] * h),
  ] as [number, number, number, number];
}

describe("extractContextCrop: the context region contains the crop box", () => {
  for (const [photoName, W, H] of PHOTOS) {
    for (const [boxName, frac] of BOXES) {
      for (const targetAspect of ASPECTS) {
        it(`${photoName} photo, ${boxName} box, panel aspect ${targetAspect}`, () => {
          const fullCv = fakeCanvas(W, H);
          const cropBox = boxInPixels(frac, W, H);
          const { contextBox, contextCanvas } = extractContextCrop(
            fullCv,
            cropBox,
            targetAspect,
          );
          const [x1, y1, x2, y2] = contextBox;

          // The region contains the box. This is the whole requirement, and it
          // is what the panel violates when the clamp re-derives an axis.
          expect(
            { x1: x1 <= cropBox[0], x2: x2 >= cropBox[2], y1: y1 <= cropBox[1], y2: y2 >= cropBox[3] },
            `contextBox ${JSON.stringify(contextBox)} vs cropBox ${JSON.stringify(cropBox)}`,
          ).toEqual({ x1: true, x2: true, y1: true, y2: true });

          // And it lies inside the photo, since it is cut from it.
          expect(x1).toBeGreaterThanOrEqual(0);
          expect(y1).toBeGreaterThanOrEqual(0);
          expect(x2).toBeLessThanOrEqual(W);
          expect(y2).toBeLessThanOrEqual(H);

          // The canvas is cut at the region's own size, so a caller that reads
          // its dimensions gets the region the box is placed against.
          expect([contextCanvas.width, contextCanvas.height]).toEqual([x2 - x1, y2 - y1]);
        });
      }
    }
  }
});

describe("extractContextCrop: no crop box", () => {
  it("returns the whole photo as the region", () => {
    const fullCv = fakeCanvas(1920, 1080);
    const { contextBox, contextCanvas } = extractContextCrop(fullCv, null, 1.05);
    expect(contextBox).toEqual([0, 0, 1920, 1080]);
    expect(contextCanvas).toBe(fullCv);
  });
});
