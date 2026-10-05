import { test, expect, boot, populate, settle, errors } from "../helpers/app";
import type { PhotoSpec } from "../helpers/app";

/**
 * A manual crop is square, and it is the square of the pixels the cursor was on.
 *
 * Two assertions, and the second is the one that matters. Issue #77 records a
 * geometry suite that passed 14 tests on entirely black thumbnails, because
 * every assertion was of the form "a box of some size came out". A square box
 * in the wrong place is exactly as wrong as a rectangle and passes that kind of
 * test, so this spec paints the photo with a pattern that encodes WHERE each
 * pixel is, drags a crop, and then reads the committed crop canvas back and
 * compares it against the source region pixel by pixel.
 *
 * The expectation is computed here, in the test, from the surface's own box and
 * the photo's dimensions - not read back out of the app - so a change to the
 * mapping shows up as a failure rather than being agreed with by both sides.
 */

const ONE: PhotoSpec[] = [{ name: "square_01.jpg", state: "species", species: "Aedes aegypti" }];

// The crop surface sits well below the fold in Playwright's default 1280x720
// viewport. `boundingBox()` happily returns coordinates that are off-screen, so
// a `mouse.move` to the middle of the surface is delivered to nothing at all -
// the pointerup never reaches the handler and the drag silently commits nothing,
// which looks exactly like a broken constraint. A viewport tall enough to hold
// the surface makes the coordinates real.
const VIEWPORT = { width: 1280, height: 1600 };

/**
 * Replace the photo's pixels with an image whose colour encodes its coordinates.
 *
 * A flat fill would make every wrong placement indistinguishable from the right
 * one, which is the #77 trap. Here R carries x mod 256 and G carries y mod 256,
 * so a crop taken from the wrong place - or one taken through a mapping with its
 * axis confused - produces different bytes at the sampled points.
 *
 * The size comes from `fullW`/`fullH` - the photograph's own dimensions, which is
 * what `photoFrame` reads and what every crop box is expressed in. It used to
 * come from a `fullCanvas` the record retained; #107 removed that field, so the
 * frame is now the only record of the box's unit, and a fixture that measured
 * anything else would be measuring a different picture from the one the box names.
 *
 * The pattern is installed as `sourceCanvas`, which is where `fullCanvasFor`
 * finds a record's pixels when it has no File to decode them from - and so is
 * exactly the canvas `executeCrop` cuts the crop out of.
 */
async function paintCoordinatePattern(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const A = window.__mosqAsync!;
    const p = A.previews[0];
    const w = p.fullW as number;
    const h = p.fullH as number;
    if (!(w > 0) || !(h > 0)) {
      throw new Error("fixture photo carries no frame dimensions (fullW/fullH)");
    }
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d")!;
    const img = ctx.createImageData(cv.width, cv.height);
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        const i = (y * cv.width + x) * 4;
        img.data[i] = x % 256;
        img.data[i + 1] = y % 256;
        img.data[i + 2] = 128;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    p.sourceCanvas = cv;
    p.contextCanvas = cv;
    p.contextBox = null;
  });
  await settle(page);
}

/**
 * The centre-anchored square a drag commits, and the mapping it goes through.
 *
 * Both helpers below floor the side and round the near corner, mirroring the two
 * lines in `squareBox` that make a stored box integral, so the expectation is
 * whole and can be asserted at precision 0. That is a deliberate 1px echo of the
 * function under test, and it is safe to echo because what these helpers are
 * pinning is the SURFACE -> PIXEL map, not the rounding: the constraint's own
 * arithmetic is pinned exactly, and exhaustively, in
 * `tests/square-crop-constraint.test.ts`. The slack it introduces is one pixel,
 * not the forty a shifted box needs.
 *
 * `contain` on the full panel: the photo is fitted whole and letterboxed, so the
 * axis with room to spare keeps k = 1 and the other is scaled up by the ratio of
 * the two aspects, centred. This is the same arithmetic `fitMapping` does,
 * written out because a test that imports the function under test agrees with
 * every bug it has.
 *
 * The drag's two CLIENT points are taken, not nominal surface fractions, and are
 * pushed through `Math.fround` first. Chromium delivers `PointerEvent.clientX` as
 * a float32, so a drag to `x = 328.175` is seen by the handler as 328.17498779296875
 * - which makes the surface fraction a hair under 0.8, and `squareBox` then
 * floors a side of 1439 where the exact arithmetic gives 1440. That pixel is a
 * property of the float, not of the mapping, so the expectation consumes the same
 * number the handler does; without the fround this assertion would be red on a
 * correct implementation.
 */
async function expectedSquareBox(
  page: import("@playwright/test").Page,
  a: { x: number; y: number },
  b: { x: number; y: number },
): Promise<[number, number, number, number]> {
  return page.evaluate(
    ({ a, b }) => {
      const p = window.__mosqAsync!.previews[0];
      const surf = document.getElementById("crop-surface-full")!.getBoundingClientRect();
      const img = { w: p.fullW as number, h: p.fullH as number };
      const boxAspect = surf.width / surf.height;
      const imgAspect = img.w / img.h;
      const kx = Math.max(1, boxAspect / imgAspect);
      const ky = Math.max(1, imgAspect / boxAspect);
      const ox = (1 - kx) / 2;
      const oy = (1 - ky) / 2;

      // Client coordinates -> surface fractions -> photo pixels, the two steps the
      // drag handler's own `getSurfacePoint` and the panel's map make. fround is
      // the float32 the browser delivers; see the note above.
      const frac = (v: number, origin: number, size: number): number =>
        Math.max(0, Math.min(1, (Math.fround(v) - origin) / size));
      const pt = (cx: number, cy: number): [number, number] => [
        (kx * frac(cx, surf.left, surf.width) + ox) * img.w,
        (ky * frac(cy, surf.top, surf.height) + oy) * img.h,
      ];
      const pa = pt(a.x, a.y);
      const pb = pt(b.x, b.y);
      const side = Math.floor(Math.max(Math.abs(pb[0] - pa[0]), Math.abs(pb[1] - pa[1])));
      const x1 = Math.round((pa[0] + pb[0]) / 2 - side / 2);
      const y1 = Math.round((pa[1] + pb[1]) / 2 - side / 2);
      const box: [number, number, number, number] = [x1, y1, x1 + side, y1 + side];
      return box;
    },
    { a, b },
  );
}

/**
 * The box a drag on the ZOOM panel should commit, in the FULL photo's pixels.
 *
 * The zoom panel is the branch a full-panel test cannot reach, so its map is
 * written out separately here rather than derived from the full-panel one:
 *
 *  - the frame is the CONTEXT region, so the surface map runs against the
 *    context canvas's own dimensions;
 *  - the fit is `contain`, so the axis where the frame OVERFLOWS the surface is
 *    pinned at 1 and the other is magnified, with a negative offset
 *    letterboxing the frame. #104 moved the zoom panel to `contain` because
 *    `cover` cropped the context region, and took the box with it when the box
 *    sat near a region edge;
 *  - the result carries the region's own offset back into the photo, and is then
 *    clamped to the photo and squared, which is the order `applySquareCrop`
 *    commits in.
 *
 * None of that is read back out of the app. A helper that took the committed box
 * as its reference would agree with every mapping bug there is, because the box
 * the app commits IS the answer its own mapping produced - which is what made the
 * zoom spec's pixel comparison unable to see a wrong mapping at all.
 *
 * As in `expectedSquareBox`, the drag's client points are consumed rather than
 * nominal fractions, so a whole pixel of float noise is not read as a mapping
 * error.
 */
async function expectedZoomBox(
  page: import("@playwright/test").Page,
  region: { x1: number; y1: number; w: number; h: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): Promise<[number, number, number, number]> {
  return page.evaluate(
    ({ region, a, b }) => {
      const p = window.__mosqAsync!.previews[0];
      const surf = document.getElementById("crop-surface-zoomed")!.getBoundingClientRect();
      const img = { w: region.w, h: region.h };
      const boxAspect = surf.width / surf.height;
      const imgAspect = img.w / img.h;
      // contain: max, matching `zoomedSurfaceMapping` and #104. Under `cover`
      // this would be min, and every box below would come out at a different
      // place in the photo - still square, still carrying the region offset,
      // just not the one a drag actually commits.
      const kx = Math.max(1, boxAspect / imgAspect);
      const ky = Math.max(1, imgAspect / boxAspect);
      const ox = (1 - kx) / 2;
      const oy = (1 - ky) / 2;

      const frac = (v: number, origin: number, size: number): number =>
        Math.max(0, Math.min(1, (Math.fround(v) - origin) / size));
      const pt = (cx: number, cy: number): [number, number] => [
        (kx * frac(cx, surf.left, surf.width) + ox) * img.w,
        (ky * frac(cy, surf.top, surf.height) + oy) * img.h,
      ];
      const pa = pt(a.x, a.y);
      const pb = pt(b.x, b.y);
      const side = Math.floor(Math.max(Math.abs(pb[0] - pa[0]), Math.abs(pb[1] - pa[1])));
      const x1 = Math.round((pa[0] + pb[0]) / 2 - side / 2);
      const y1 = Math.round((pa[1] + pb[1]) / 2 - side / 2);
      // Context-canvas pixels -> photo pixels.
      const W = p.fullW as number;
      const H = p.fullH as number;
      const box: [number, number, number, number] = [
        x1 + region.x1, y1 + region.y1, x1 + side + region.x1, y1 + side + region.y1,
      ];
      // ...then what applySquareCrop does to it: clamp to the photo, THEN square.
      const c: [number, number, number, number] = [
        Math.max(0, Math.min(W, box[0])), Math.max(0, Math.min(H, box[1])),
        Math.max(0, Math.min(W, box[2])), Math.max(0, Math.min(H, box[3])),
      ];
      const cw = c[2] - c[0];
      const ch = c[3] - c[1];
      const cside = Math.floor(Math.min(cw, ch));
      const cx = Math.round(c[0] + (cw - cside) / 2);
      const cy = Math.round(c[1] + (ch - cside) / 2);
      return [cx, cy, cx + cside, cy + cside];
    },
    { region, a, b },
  );
}

/**
 * A stand-in classifier session.
 *
 * Releasing a crop runs inference, and tier 1 aborts the model fetch, so without
 * this the commit takes the app's own failure path and logs a console error -
 * which `errors(page)` then reports. The geometry under test is set before that
 * point, but a test that asserts "no errors" while expecting one is asserting
 * nothing. This makes the crop take the real classification path off a real
 * embedding, so the run is clean and `errors()` means what it says.
 *
 * The direction is fixed and L2-normalises to itself, so the softmax is real
 * arithmetic and the photo gets a real verdict rather than a stubbed one.
 */
async function installFakeClassifier(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const A = window.__mosqAsync!;
    const emb = A.embeds as { dim: number };
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run() {
        const data = new Float32Array(emb.dim);
        data.fill(1 / Math.sqrt(emb.dim));
        return { embedding: { dims: [1, emb.dim], data } };
      },
    };
  });
}

test.describe("a manual crop is square", () => {
  test.use({ viewport: VIEWPORT });

  test("a wide drag commits a square and cuts the pixels under the cursor", async ({ page }) => {
    await boot(page);
    await populate(page, ONE);
    await paintCoordinatePattern(page);
    await installFakeClassifier(page);

    // Deliberately wider than tall in surface terms, so the constraint has to do
    // something: an unconstrained implementation would commit a rectangle here.
    const from = { x: 0.2, y: 0.4 };
    const to = { x: 0.8, y: 0.5 };
    const drag = await dragOnFullSurface(page, from.x, from.y, to.x, to.y);

    const result = await page.evaluate(() => {
      const p = window.__mosqAsync!.previews[0];
      const box = p.cropBox!;
      const cv = p.cropCanvas;
      // Sample the crop's corners and centre. If the box were right but the
      // pixels came from elsewhere, these would not match the source.
      const pts = [
        [0, 0],
        [cv.width - 1, 0],
        [0, cv.height - 1],
        [cv.width - 1, cv.height - 1],
        [Math.floor(cv.width / 2), Math.floor(cv.height / 2)],
      ];
      const ctx = cv.getContext("2d")!;
      const got = pts.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)));
      // Read the source through the app's own accessor rather than off the
      // record. The record no longer retains the frame (#107), so this is the
      // function that hands the pixels back - and using it means the comparison
      // is against the very canvas `executeCrop` cut from, decoded or not.
      return window.__mosqAsync!.fullCanvasFor(p).then((fullCv: HTMLCanvasElement | null) => {
        const full = fullCv!.getContext("2d")!;
        const want = pts.map(([x, y]) => {
          const sx = box[0] + x;
          const sy = box[1] + y;
          const d = full.getImageData(sx, sy, 1, 1).data;
          return [d[0], d[1], d[2]];
        });
        return { box, cw: cv.width, ch: cv.height, got, want, fullW: p.fullW, fullH: p.fullH };
      });
    });

    // The shape.
    expect(result.cw).toBe(result.ch);
    expect(result.box[2] - result.box[0]).toBe(result.box[3] - result.box[1]);

    // The content: each sampled pixel of the crop is the pixel of the SOURCE
    // photo at the same offset within the committed box. This is the assertion
    // a shape-only test cannot make.
    expect(result.got).toEqual(result.want);

    // And the box is the one the drag asked for, computed independently above.
    //
    // All FOUR edges, not the side length. A box translated 40px along x is still
    // square, still inside the photo and still cuts exactly the pixels it names,
    // so a side-length assertion - at precision -1 it was satisfied by ±5 units of
    // slack - passed for a crop that was nowhere near where the cursor was. The
    // origin is the assertion that says WHERE, and it is the only one that does.
    const expected = await expectedSquareBox(page, drag.a, drag.b);
    expect(result.box[2] - result.box[0]).toBeCloseTo(expected[2] - expected[0], 0);
    expect(result.box[3] - result.box[1]).toBeCloseTo(expected[3] - expected[1], 0);
    expect(result.box[0]).toBeCloseTo(expected[0], 0);
    expect(result.box[1]).toBeCloseTo(expected[1], 0);
    expect(result.box[2]).toBeCloseTo(expected[2], 0);
    expect(result.box[3]).toBeCloseTo(expected[3], 0);

    expect(errors(page)).toHaveLength(0);
  });

  test("a tall drag commits a square too", async ({ page }) => {
    await boot(page);
    await populate(page, ONE);
    await paintCoordinatePattern(page);
    await installFakeClassifier(page);

    // The other direction: taller than wide, so a test that only ever dragged
    // horizontally would never notice the constraint being applied to one axis.
    const tallDrag = await dragOnFullSurface(page, 0.5, 0.1, 0.55, 0.9);

    const r = await page.evaluate(() => {
      const p = window.__mosqAsync!.previews[0];
      return { box: p.cropBox!, cw: p.cropCanvas.width, ch: p.cropCanvas.height };
    });
    expect(r.cw).toBe(r.ch);
    expect(r.box[2] - r.box[0]).toBe(r.box[3] - r.box[1]);

    // This drag asks for more than the photo has - the side the cursor's
    // separation implies is taller than the 1800px image - so the committed box
    // is CLAMPED to the photo before being squared, and comes out at the photo's
    // full height. The clamp is expected behaviour, not a lost constraint: the
    // box is still square and still cut from the pixels under the cursor, just
    // not as far out as the pointer asked.
    expect(r.box[2] - r.box[0]).toBe(r.box[3] - r.box[1]);
    const expected = await expectedSquareBox(page, tallDrag.a, tallDrag.b);
    const photo = await page.evaluate(() => {
      const p = window.__mosqAsync!.previews[0];
      return { w: p.fullW as number, h: p.fullH as number };
    });
    const wanted = expected[2] - expected[0];
    const clamped = Math.min(wanted, photo.w, photo.h);
    expect(r.box[2] - r.box[0]).toBe(clamped);

    expect(errors(page)).toHaveLength(0);
  });

  test("a click that never moves commits nothing", async ({ page }) => {
    await boot(page);
    await populate(page, ONE);
    await paintCoordinatePattern(page);
    await installFakeClassifier(page);

    const before = await page.evaluate(() => window.__mosqAsync!.previews[0].cropBox);

    // A press and release with no movement between: the degenerate box squaring
    // must not turn into a 1x1 crop that re-runs inference over the batch.
    const surf = await page.locator("#crop-surface-full").boundingBox();
    const px = surf!.x + surf!.width * 0.5;
    const py = surf!.y + surf!.height * 0.5;
    await page.mouse.move(px, py);
    await page.mouse.down();
    await page.mouse.up();

    const after = await page.evaluate(() => window.__mosqAsync!.previews[0].cropBox);
    expect(after).toEqual(before);
    expect(errors(page)).toHaveLength(0);
  });

  test("the crop outline is square on screen too, not only in pixels", async ({ page }) => {
    await boot(page);
    await populate(page, ONE);
    await paintCoordinatePattern(page);
    await installFakeClassifier(page);

    await dragOnFullSurface(page, 0.2, 0.3, 0.7, 0.45);

    // The outline is drawn as a percentage of the panel, so its on-screen
    // proportions depend on the fit. On a letterboxed panel a square in photo
    // pixels is NOT a square on screen - which is correct, and is why the
    // constraint had to be applied in pixels. What must hold is that the outline
    // is drawn exactly where the committed box is, so this compares the drawn
    // rect against the box rather than against a square.
    const drawn = await page.evaluate(() => {
      const p = window.__mosqAsync!.previews[0];
      const el = document.getElementById("full-active-crop-box") as HTMLElement | null;
      return {
        style: el ? { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height } : null,
        box: p.cropBox!,
        img: { w: p.fullW as number, h: p.fullH as number },
        surf: (() => {
          const r = document.getElementById("crop-surface-full")!.getBoundingClientRect();
          return { w: r.width, h: r.height };
        })(),
      };
    });

    expect(drawn.style).not.toBeNull();
    const boxAspect = drawn.surf.w / drawn.surf.h;
    const imgAspect = drawn.img.w / drawn.img.h;
    const kx = Math.max(1, boxAspect / imgAspect);
    const ky = Math.max(1, imgAspect / boxAspect);
    const ox = (1 - kx) / 2;
    const oy = (1 - ky) / 2;
    const left = (drawn.box[0] / drawn.img.w - ox) / kx * 100;
    const top = (drawn.box[1] / drawn.img.h - oy) / ky * 100;
    const width = ((drawn.box[2] / drawn.img.w - ox) / kx - left / 100) * 100;
    const height = ((drawn.box[3] / drawn.img.h - oy) / ky - top / 100) * 100;

    expect(Number.parseFloat(drawn.style!.left)).toBeCloseTo(left, 3);
    expect(Number.parseFloat(drawn.style!.top)).toBeCloseTo(top, 3);
    expect(Number.parseFloat(drawn.style!.width)).toBeCloseTo(width, 3);
    expect(Number.parseFloat(drawn.style!.height)).toBeCloseTo(height, 3);

    expect(errors(page)).toHaveLength(0);
  });

  test("a drag on the zoom panel squares the crop and adds the context offset", async ({ page }) => {
    // The zoom panel is the branch a full-panel-only test never reaches: its
    // frame is the CONTEXT region, not the whole photo, so the box it produces
    // is in context-canvas coordinates and has to have the region's offset added
    // before it is a box in photo pixels. Forget the offset and the crop is
    // still perfectly square - just of entirely the wrong part of the photo,
    // which is the failure a shape assertion cannot see.
    await boot(page);
    await populate(page, ONE);
    await paintCoordinatePattern(page);
    await installFakeClassifier(page);

    // A context region genuinely offset from the photo's origin, so a missing
    // ox/oy would show. Cut it 1:1 from the pattern, as extractContextCrop does -
    // and read the pattern through the app's accessor, which is where the pixels
    // live now that the record retains no frame (#107).
    const region = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      const p = A.previews[0];
      const full = (await A.fullCanvasFor(p))!;
      const [x1, y1, x2, y2] = [300, 220, 2100, 1500];
      const cv = document.createElement("canvas");
      cv.width = x2 - x1;
      cv.height = y2 - y1;
      cv.getContext("2d")!.drawImage(full, x1, y1, cv.width, cv.height, 0, 0, cv.width, cv.height);
      p.contextCanvas = cv;
      p.contextBox = [x1, y1, x2, y2];
      return { x1, y1, w: cv.width, h: cv.height };
    });
    await settle(page);

    const from = { x: 0.25, y: 0.3 };
    const to = { x: 0.75, y: 0.55 };
    const drag = await dragOnSurface(page, "#crop-surface-zoomed", from.x, from.y, to.x, to.y);

    // The box the drag should have committed, worked out HERE from the surface's
    // own rect, the context region's dimensions and the drag's two points - not
    // read back out of the app.
    const expected = await expectedZoomBox(page, region, drag.a, drag.b);

    // The crop's pixels are read against THAT box. Reading them against the app's
    // own committed box - which is what this did - is circular: the crop is cut
    // with the box the app's mapping produced, so the comparison succeeds for any
    // mapping at all, including one that is wrong. A mapping bug has to move the
    // box somewhere else before the pixels can disagree.
    const r = await page.evaluate(async (exp: [number, number, number, number]) => {
      const A = window.__mosqAsync!;
      const p = A.previews[0];
      const box = p.cropBox!;
      const cv = p.cropCanvas;
      // Sample the crop against the FULL photo at box-offset coordinates: that is
      // where the pixels have to have come from once the context offset is added.
      const pts: [number, number][] =
        [[0, 0], [cv.width - 1, 0], [0, cv.height - 1], [cv.width - 1, cv.height - 1]];
      const ctx = cv.getContext("2d")!;
      const got = pts.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)));
      const full = (await A.fullCanvasFor(p))!.getContext("2d")!;
      const want = pts.map(([x, y]) => {
        const d = full.getImageData(exp[0] + x, exp[1] + y, 1, 1).data;
        return [d[0], d[1], d[2]];
      });
      return { box, cw: cv.width, ch: cv.height, got, want };
    }, expected);

    // Square...
    expect(r.cw).toBe(r.ch);
    expect(r.box[2] - r.box[0]).toBe(r.box[3] - r.box[1]);
    // ...and the right pixels, which requires the offset to have been added.
    expect(r.got).toEqual(r.want);

    // The box itself, all four edges, at precision 0. This is the assertion the
    // round trip cannot make for itself: `zoomedSurfaceMapping` fixes `fit` to
    // `contain` and multiplies k by 1.08, and the letterbox offset's sign in
    // `fitMapping`, and before these four lines every one of those mutations
    // passed this spec.
    expect(r.box[0]).toBeCloseTo(expected[0], 0);
    expect(r.box[1]).toBeCloseTo(expected[1], 0);
    expect(r.box[2]).toBeCloseTo(expected[2], 0);
    expect(r.box[3]).toBeCloseTo(expected[3], 0);

    // The box must land INSIDE the context region, which is offset from the
    // origin. A box that ignored the offset would sit around (0,0) rather than
    // around the region's own (300,220).
    expect(r.box[0]).toBeGreaterThanOrEqual(region.x1 - 1);
    expect(r.box[1]).toBeGreaterThanOrEqual(region.y1 - 1);
    expect(r.box[2]).toBeLessThanOrEqual(region.x1 + region.w + 1);
    expect(r.box[3]).toBeLessThanOrEqual(region.y1 + region.h + 1);

    expect(errors(page)).toHaveLength(0);
  });

});

/**
 * The two client points a drag was performed at.
 *
 * Returned rather than recomputed by the caller, because the expectation has to
 * be built from the exact coordinates the pointer was driven to. See
 * `expectedSquareBox` for why the nominal surface fractions do not invert back.
 */
interface DragPoints {
  a: { x: number; y: number };
  b: { x: number; y: number };
}

/** Press, move, release on the full-photo panel, in surface fractions. */
async function dragOnFullSurface(
  page: import("@playwright/test").Page,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Promise<DragPoints> {
  return dragOnSurface(page, "#crop-surface-full", fromX, fromY, toX, toY);
}

/** The same gesture on either panel; the two differ only in which panel. */
async function dragOnSurface(
  page: import("@playwright/test").Page,
  selector: string,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Promise<DragPoints> {
  const surf = (await page.locator(selector).boundingBox())!;
  const pt = (fx: number, fy: number) => ({
    x: surf.x + surf.width * fx,
    y: surf.y + surf.height * fy,
  });
  const a = pt(fromX, fromY);
  const b = pt(toX, toY);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  // Several moves, so the handler runs the way it does under a real pointer.
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(a.x + ((b.x - a.x) * i) / 4, a.y + ((b.y - a.y) * i) / 4);
  }
  await page.mouse.up();
  await settle(page);
  return { a, b };
}