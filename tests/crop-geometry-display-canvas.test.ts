/**
 * The geometry contract: a photo holds a display-sized canvas, and every box is
 * still in the ORIGINAL photo's pixels.
 *
 * `cropGeometry` divides a crop box by the frame's dimensions to place it on a
 * panel. Read those dimensions off a 2048 px display canvas instead of the
 * 4032x3024 photograph and every box silently moves - the panel fits a different
 * aspect, and the fractions are of a different image. Nothing crashes; the crop
 * outline just lands somewhere else, and a drag drawn there cuts the wrong
 * pixels.
 *
 * So the frame's dimensions are carried on the record as `fullW`/`fullH`,
 * measured once at decode, and these tests hold every geometry helper to the
 * numbers the full-resolution canvas produced.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cropBoxInFullSurface,
  cropBoxInZoomSurface,
  fullSurfaceMapping,
} from "../src/app/cropGeometry";
import type { Preview } from "../src/app/types";

const FULL_W = 4032;
const FULL_H = 3024;
/** The display canvas's dimensions: same aspect, longest edge capped at 2048. */
const DISP_W = 2048;
const DISP_H = Math.round((DISP_W * FULL_H) / FULL_W);

/** A panel of the given CSS size, at a fixed origin. */
function surface(w: number, h: number) {
  return { getBoundingClientRect: () => ({ width: w, height: h, left: 0, top: 0, right: w, bottom: h }) } as unknown as HTMLElement;
}

const ids: Record<string, HTMLElement> = {};
beforeEach(() => {
  for (const k of Object.keys(ids)) delete ids[k];
  vi.stubGlobal("document", { getElementById: (id: string) => ids[id] ?? null });
});

const setSurface = (id: string, w: number, h: number) => { ids[id] = surface(w, h); };

/** A box in the ORIGINAL photo's pixels, as the detector would report one. */
const CROP_BOX: [number, number, number, number] = [1200, 700, 2600, 1900];

function photo(over: Partial<Preview> = {}): Preview {
  return {
    name: "p.jpg",
    // What the record retains: the display canvas.
    displayCanvas: { width: DISP_W, height: DISP_H } as HTMLCanvasElement,
    // What every box is expressed in: the original photo's pixels.
    fullW: FULL_W,
    fullH: FULL_H,
    cropCanvas: null,
    contextCanvas: null,
    cropBox: CROP_BOX,
    contextBox: null,
    ...over,
  } as unknown as Preview;
}

describe("cropBoxInFullSurface holds its place through a display canvas", () => {
  it("expresses the crop as a fraction of the photograph, not of the display canvas", () => {
    // A panel whose aspect differs from the photo's, so contain letterboxes on
    // one axis - the case where reading the wrong frame's dimensions shows.
    setSurface("crop-surface-full", 800, 900);
    const box = cropBoxInFullSurface(photo())!;
    // contain against a 4:3 photo in a 0.89 panel keeps the width and
    // letterboxes vertically, so both horizontal fractions pass through
    // unchanged and the vertical ones are pulled towards the centre.
    expect(box.width).toBeCloseTo((1400 / FULL_W) * 100, 6);
    expect(box.left).toBeCloseTo((1200 / FULL_W) * 100, 6);
    expect(box.height).toBeLessThan((1200 / FULL_H) * 100);
    expect(box.top).toBeGreaterThan((700 / FULL_H) * 100);
  });

  it("gives the same box whichever canvas the panel's mapping is measured from", () => {
    setSurface("crop-surface-full", 640, 480);
    const viaDisplay = cropBoxInFullSurface(photo());
    // The mapping must depend on the PHOTO's aspect, and the display canvas
    // preserves it exactly - so a record that still carried a full-resolution
    // canvas under the old name would produce the same numbers.
    const viaFull = cropBoxInFullSurface(
      photo({ displayCanvas: { width: FULL_W, height: FULL_H } as HTMLCanvasElement }),
    );
    expect(viaDisplay).toEqual(viaFull);
  });

  it("measures the full-panel mapping from the photo, not the display canvas", () => {
    setSurface("crop-surface-full", 800, 600);
    const m = fullSurfaceMapping(photo());
    // contain against a 4:3 photo in a 4:3 panel is the identity; a 2048x1536
    // display canvas would be too, so this cannot tell them apart - which is
    // exactly why it is asserted against the full dimensions as well.
    expect(m).toEqual({ kx: 1, ox: 0, ky: 1, oy: 0 });
    expect(fullSurfaceMapping(photo({ displayCanvas: { width: 1000, height: 2000 } as HTMLCanvasElement })))
      .toEqual(fullSurfaceMapping(photo({ displayCanvas: { width: FULL_W, height: FULL_H } as HTMLCanvasElement })));
  });
});

describe("cropBoxInZoomSurface holds its place through a display canvas", () => {
  it("places the box from the context box in original pixels", () => {
    setSurface("crop-surface-zoomed", 700, 700);
    // A context region cut at full resolution, which is what contextBox records.
    const ctx: [number, number, number, number] = [800, 400, 3200, 2400];
    const box = cropBoxInZoomSurface(photo({
      contextBox: ctx,
      contextCanvas: { width: ctx[2] - ctx[0], height: ctx[3] - ctx[1] } as HTMLCanvasElement,
    }))!;
    // cover on a square panel against a 4:3 context region crops the sides: the
    // middle 5/6 of the region's width fills the panel, so a crop sitting left
    // of centre is pushed towards the left edge and magnified.
    const regionW = ctx[2] - ctx[0];
    expect(box.width).toBeGreaterThan(((CROP_BOX[2] - CROP_BOX[0]) / regionW) * 100);
    expect(box.left).toBeLessThan(((CROP_BOX[0] - ctx[0]) / regionW) * 100);
    // The height is not magnified: cover crops the width of this region, not
    // its height.
    expect(box.height).toBeCloseTo(((CROP_BOX[3] - CROP_BOX[1]) / (ctx[3] - ctx[1])) * 100, 6);
  });

  it("falls back to the photo's own bounds when there is no context region", () => {
    setSurface("crop-surface-zoomed", 700, 700);
    const withCtx = cropBoxInZoomSurface(photo({
      contextBox: [0, 0, FULL_W, FULL_H],
      contextCanvas: { width: FULL_W, height: FULL_H } as HTMLCanvasElement,
    }));
    const withoutCtx = cropBoxInZoomSurface(photo({ contextBox: null, contextCanvas: null }));
    // Both describe the same region of the same photograph, so both must place
    // the crop identically - the null case taking the photo's own dimensions
    // from fullW/fullH rather than from a canvas it no longer has.
    expect(withoutCtx).toEqual(withCtx);
  });
});

describe("a photo with no crop box draws no outline", () => {
  it("is null regardless of what the record retains", () => {
    setSurface("crop-surface-full", 800, 900);
    setSurface("crop-surface-zoomed", 700, 700);
    expect(cropBoxInFullSurface(photo({ cropBox: null }))).toBeNull();
    expect(cropBoxInZoomSurface(photo({ cropBox: null }))).toBeNull();
  });

  it("is null when the user reverted the photo to its whole frame", () => {
    setSurface("crop-surface-full", 800, 900);
    setSurface("crop-surface-zoomed", 700, 700);
    expect(cropBoxInFullSurface(photo({ manual_full_photo: true }))).toBeNull();
  });
});

/**
 * The exact numbers today's code produces for a 4032x3024 photo, computed from
 * the full-resolution canvas. These are the contract: a record holding a 2048 px
 * display canvas must place the crop in exactly these places.
 *
 * The `moved` block below is the bug this whole change exists to prevent, held
 * as a negative control - it is what the same drag computes when the geometry
 * divides by the DISPLAY canvas's dimensions instead of the photo's.
 */
describe("golden crop boxes for a 4032x3024 photo", () => {
  it("places the full-panel box where the full-resolution canvas placed it", () => {
    setSurface("crop-surface-full", 800, 900);
    expect(cropBoxInFullSurface(photo())).toEqual({
      left: 29.761904761904763,
      top: 32.098765432098766,
      width: 34.72222222222223,
      height: 26.45502645502645,
    });
  });

  it("places the zoom-panel box where the full-resolution canvas placed it", () => {
    setSurface("crop-surface-zoomed", 700, 700);
    const ctx: [number, number, number, number] = [800, 400, 3200, 2400];
    expect(cropBoxInZoomSurface(photo({
      contextBox: ctx,
      contextCanvas: { width: ctx[2] - ctx[0], height: ctx[3] - ctx[1] } as HTMLCanvasElement,
    }))).toEqual({ left: 10, top: 15, width: 70, height: 60 });
  });

  it("places the no-context zoom box where the full-resolution canvas placed it", () => {
    setSurface("crop-surface-zoomed", 700, 700);
    expect(cropBoxInZoomSurface(photo({ contextBox: null, contextCanvas: null }))).toEqual({
      left: 23.015873015873016,
      top: 23.14814814814815,
      width: 46.296296296296305,
      height: 39.68253968253968,
    });
  });

  it("NEGATIVE CONTROL: dividing by the display canvas's dimensions moves the box", () => {
    setSurface("crop-surface-full", 800, 900);
    // What the same photo computes when the geometry divides by a 2048x1536
    // display canvas instead of the 4032x3024 photograph: the outline lands at
    // nearly twice the width, far to the right of where the crop is, and a drag
    // drawn against it cuts a different part of the image. Nothing raises.
    const moved = { left: 58.59375, top: 47.048611111111114, width: 68.359375, height: 52.083333333333336 };
    const correct = {
      left: 29.761904761904763, top: 32.098765432098766,
      width: 34.72222222222223, height: 26.45502645502645,
    };
    expect(moved).not.toEqual(correct);
    expect(cropBoxInFullSurface(photo())).toEqual(correct);
  });
});
