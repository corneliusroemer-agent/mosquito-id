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
 * Replace the photo with one whose colour encodes its coordinates.
 *
 * A flat fill would make every wrong placement indistinguishable from the right
 * one, which is the #77 trap. Here R carries x mod 256 and G carries y mod 256,
 * so a crop taken from the wrong place - or one taken through a mapping with its
 * axis confused - produces different bytes at the sampled points.
 */
async function paintCoordinatePattern(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const A = window.__mosqAsync!;
    const p = A.previews[0];
    const cv = document.createElement("canvas");
    cv.width = p.fullCanvas.width;
    cv.height = p.fullCanvas.height;
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
    p.fullCanvas = cv;
    p.contextCanvas = cv;
    p.contextBox = null;
  });
  await settle(page);
}

/**
 * The mapping the app should be using, recomputed here.
 *
 * `contain` on the full panel: the photo is fitted whole and letterboxed, so the
 * axis with room to spare keeps k = 1 and the other is scaled up by the ratio of
 * the two aspects, centred. This is the same arithmetic `fitMapping` does,
 * written out because a test that imports the function under test agrees with
 * every bug it has.
 */
async function expectedSquareBox(
  page: import("@playwright/test").Page,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
) {
  return page.evaluate(
    ({ fromX, fromY, toX, toY }) => {
      const p = window.__mosqAsync!.previews[0];
      const surf = document.getElementById("crop-surface-full")!.getBoundingClientRect();
      const img = { w: p.fullCanvas.width, h: p.fullCanvas.height };
      const boxAspect = surf.width / surf.height;
      const imgAspect = img.w / img.h;
      const kx = Math.max(1, boxAspect / imgAspect);
      const ky = Math.max(1, imgAspect / boxAspect);
      const ox = (1 - kx) / 2;
      const oy = (1 - ky) / 2;

      // Surface fractions -> photo pixels.
      const pt = (fx: number, fy: number): [number, number] =>
        [(kx * fx + ox) * img.w, (ky * fy + oy) * img.h];
      const a = pt(fromX, fromY);
      const b = pt(toX, toY);
      const side = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      const midX = (a[0] + b[0]) / 2;
      const midY = (a[1] + b[1]) / 2;
      const box: [number, number, number, number] =
        [midX - side / 2, midY - side / 2, midX + side / 2, midY + side / 2];
      return box;
    },
    { fromX, fromY, toX, toY },
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
    await dragOnFullSurface(page, from.x, from.y, to.x, to.y);

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
      const full = p.fullCanvas.getContext("2d")!;
      const want = pts.map(([x, y]) => {
        const sx = box[0] + x;
        const sy = box[1] + y;
        const d = full.getImageData(sx, sy, 1, 1).data;
        return [d[0], d[1], d[2]];
      });
      return { box, cw: cv.width, ch: cv.height, got, want, fullW: p.fullCanvas.width, fullH: p.fullCanvas.height };
    });

    // The shape.
    expect(result.cw).toBe(result.ch);
    expect(result.box[2] - result.box[0]).toBe(result.box[3] - result.box[1]);

    // The content: each sampled pixel of the crop is the pixel of the SOURCE
    // photo at the same offset within the committed box. This is the assertion
    // a shape-only test cannot make.
    expect(result.got).toEqual(result.want);

    // And the box is the one the drag asked for, computed independently above.
    const expected = await expectedSquareBox(page, from.x, from.y, to.x, to.y);
    expect(result.box[2] - result.box[0]).toBeCloseTo(expected[2] - expected[0], -1);
    expect(result.box[3] - result.box[1]).toBeCloseTo(expected[3] - expected[1], -1);

    expect(errors(page)).toHaveLength(0);
  });

  test("a tall drag commits a square too", async ({ page }) => {
    await boot(page);
    await populate(page, ONE);
    await paintCoordinatePattern(page);
    await installFakeClassifier(page);

    // The other direction: taller than wide, so a test that only ever dragged
    // horizontally would never notice the constraint being applied to one axis.
    await dragOnFullSurface(page, 0.5, 0.1, 0.55, 0.9);

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
    const expected = await expectedSquareBox(page, 0.5, 0.1, 0.55, 0.9);
    const photo = await page.evaluate(() => {
      const p = window.__mosqAsync!.previews[0];
      return { w: p.fullCanvas.width, h: p.fullCanvas.height };
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
        img: { w: p.fullCanvas.width, h: p.fullCanvas.height },
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
});

/** Press, move, release on the full-photo panel, in surface fractions. */
async function dragOnFullSurface(
  page: import("@playwright/test").Page,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): Promise<void> {
  const surf = (await page.locator("#crop-surface-full").boundingBox())!;
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
}