import { readFileSync } from "node:fs";
import { boot, errors, expect, settle, test } from "../helpers/app";
import type { Page } from "@playwright/test";

/**
 * EXIF orientation, as pixels rather than as a dimension.
 *
 * `createImageBitmap` and an `<img>` decode can disagree about orientation, and
 * `photoUrl.ts` already notes that this app relies on the two agreeing. That
 * reliance is load-bearing for anything that draws from a bitmap instead of from
 * a canvas the bitmap was copied into: a draw from the bitmap is the bitmap's
 * own orientation, while a draw from a copy is whatever the copy was made from,
 * and a difference of one degree of rotation is a difference every crop box,
 * every context region and every posterior is then measured against.
 *
 * So this asserts on the pixels a photograph of each orientation actually
 * arrives as. The fixtures differ only in EXIF tag 274 (see
 * `tests/fixtures/exif-orientation/README.md`), which means a difference
 * between two of their outputs can only come from the orientation handling.
 *
 * The stored image is four flat quadrants - red top-left, green top-right, blue
 * bottom-left, yellow bottom-right - plus a white diagonal in the stored
 * top-left and a black block in the stored bottom-right. Reading the four
 * quadrant colours off the decoded frame names the orientation without anyone
 * having to hold a rotated JPEG in their head:
 *
 * | orientation | decoded quadrants (TL, TR, BL, BR) | dimensions |
 * |---|---|---|
 * | 1 | red, green, blue, yellow | 2400 x 1800 |
 * | 3 | yellow, blue, green, red | 2400 x 1800 |
 * | 6 | blue, red, yellow, green | 1800 x 2400 |
 * | 8 | green, yellow, red, blue | 1800 x 2400 |
 *
 * (6 is 90 degrees clockwise and 8 is 90 degrees counter-clockwise, so both
 * transpose width and height; 3 is a half-turn, which does not. The table was
 * read off Chromium rather than reasoned out - the quadrant names and the
 * dimensions together are what "orientation applied correctly" means here, and
 * deriving them from the EXIF spec is how a fixture ends up asserting something
 * the decoder was never asked to do.)
 */

const FIXTURES = {
  1: "exif1.jpg",
  3: "exif3.jpg",
  6: "exif6.jpg",
  8: "exif8.jpg",
} as const;

type Orientation = keyof typeof FIXTURES;

/** Which quadrant colour each corner must be, in (top-left, top-right, bottom-left, bottom-right) order. */
const QUADRANTS: Record<Orientation, [string, string, string, string]> = {
  1: ["red", "green", "blue", "yellow"],
  3: ["yellow", "blue", "green", "red"],
  6: ["blue", "red", "yellow", "green"],
  8: ["green", "yellow", "red", "blue"],
};

/** The dimensions each orientation decodes to. 6 and 8 transpose; 1 and 3 do not. */
const DIMENSIONS: Record<Orientation, [number, number]> = {
  1: [2400, 1800],
  3: [2400, 1800],
  6: [1800, 2400],
  8: [1800, 2400],
};

/**
 * The fixture as a data URL, read off disk.
 *
 * The suite serves `dist/`, so a fixture under `tests/` is not fetchable by the
 * page; handing the bytes over as a data URL is what puts them in front of it.
 */
function fixtureDataUrl(name: string): string {
  const b64 = readFileSync(
    new URL(`../../tests/fixtures/exif-orientation/${name}`, import.meta.url),
  ).toString("base64");
  return `data:image/jpeg;base64,${b64}`;
}

/**
 * A detector and a classifier that download nothing, and a crop they produce.
 *
 * Same seam as `perf-counters.spec.ts`. The detector returns one centred box so
 * the crop, the context region and the display copy are all exercised: a photo
 * the detector finds nothing in takes the no-crop path, which never cuts
 * anything and would leave most of this spec measuring nothing.
 */
async function installCountingSessions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const A = window.__mosqAsync!;
    const w = window as any;
    if (!w.ort) {
      w.ort = {
        Tensor: class {
          data: Float32Array;
          dims: number[];
          constructor(_t: string, d: Float32Array, dm: number[]) {
            this.data = d;
            this.dims = dm;
          }
        },
      };
    }
    const N = 8400;
    const det = new Float32Array(5 * N);
    det[0] = 320; det[N] = 320; det[2 * N] = 160; det[3 * N] = 160;
    det[4 * N] = 0.9;
    A.sessDet = {
      inputNames: ["images"],
      async run() {
        return { output0: { dims: [1, 5, N], data: det } };
      },
    } as any;
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run() {
        const dim = (A.embeds as { dim: number }).dim;
        const d = new Float32Array(dim);
        d.fill(1 / Math.sqrt(dim));
        return { embedding: { dims: [1, dim], data: d } };
      },
    } as any;
    await fetch("text_embeds.json")
      .then((x) => x.json())
      .then((emb) => {
        for (const k of ["species_emb", "nuisance_emb"]) emb[k] = Float32Array.from(emb[k]);
        A.embeds = emb;
      });
    A.modelsReady = true;
  });
}

/**
 * Decode a data URL into a canvas and read one pixel per quadrant, plus the two
 * markers.
 *
 * The sample points are well inside their quadrant rather than near a boundary:
 * a JPEG of a hard colour edge rings for a few pixels, and a sample close to one
 * would report a colour no orientation put there.
 */
async function readQuadrants(page: Page, dataUrl: string) {
  return page.evaluate(async (url) => {
    const res = await fetch(url);
    const blob = await res.blob();
    // The same decode the intake does, and the one whose orientation this spec
    // exists to pin.
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const cv = document.createElement("canvas");
    cv.width = bitmap.width;
    cv.height = bitmap.height;
    cv.getContext("2d")!.drawImage(bitmap, 0, 0);
    const ctx = cv.getContext("2d")!;
    const w = cv.width;
    const h = cv.height;
    const at = (x: number, y: number) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const out = {
      width: w,
      height: h,
      quadrants: [
        at(Math.round(w * 0.25), Math.round(h * 0.25)),
        at(Math.round(w * 0.75), Math.round(h * 0.25)),
        at(Math.round(w * 0.25), Math.round(h * 0.75)),
        at(Math.round(w * 0.75), Math.round(h * 0.75)),
      ],
    };
    bitmap.close();
    return out;
  }, dataUrl);
}

/** Name a colour so a failure says which quadrant was wrong, not what number. */
function nameColour(rgb: ArrayLike<number | undefined>): string {
  const [r, g, b] = [Number(rgb[0]), Number(rgb[1]), Number(rgb[2])];
  if (r > 200 && g < 60 && b < 60) return "red";
  if (g > 200 && r < 60 && b < 60) return "green";
  if (b > 200 && r < 60 && g < 60) return "blue";
  if (r > 200 && g > 200 && b < 60) return "yellow";
  if (r > 200 && g > 200 && b > 200) return "white";
  return `rgb(${r},${g},${b})`;
}

test.describe("EXIF orientation is applied to the decoded pixels", () => {
  for (const orientation of [1, 3, 6, 8] as Orientation[]) {
    test(`orientation ${orientation} decodes to its own quadrants`, async ({ page }) => {
      await boot(page);
      const seen = await readQuadrants(page, fixtureDataUrl(FIXTURES[orientation]));

      expect(
        [seen.width, seen.height],
        `orientation ${orientation} decoded to the wrong dimensions`,
      ).toEqual(DIMENSIONS[orientation]);

      const named = seen.quadrants.map(nameColour);
      expect(
        named,
        `orientation ${orientation}: stored image is red/green/blue/yellow, so this decode did not rotate it correctly`,
      ).toEqual(QUADRANTS[orientation]);
    });
  }

  test("every orientation differs from the unrotated one", async ({ page }) => {
    // The guard for the guard above. Four fixtures whose decoded pixels were
    // all identical would pass the four tests above for the wrong reason - an
    // ignored EXIF tag and a correctly applied one look the same when the
    // fixture cannot tell them apart.
    await boot(page);
    const seen = new Map<Orientation, number[]>();
    for (const orientation of [1, 3, 6, 8] as Orientation[]) {
      const r = await readQuadrants(page, fixtureDataUrl(FIXTURES[orientation]));
      seen.set(orientation, r.quadrants.flat().map(Number));
    }
    const control = seen.get(1)!;
    for (const orientation of [3, 6, 8] as Orientation[]) {
      expect(
        seen.get(orientation),
        `orientation ${orientation} decoded to the same pixels as orientation 1`,
      ).not.toEqual(control);
    }
    // 6 and 8 are both quarter turns, in opposite directions, so they must also
    // differ from each other - a decoder that transposed without rotating, or
    // rotated every tag the same way, would fail here and pass the dimensions.
    expect(seen.get(6)).not.toEqual(seen.get(8));
  });
});

test.describe("the classified record keeps the oriented pixels", () => {
  test("a transposed photograph is classified and recorded transposed", async ({ page }) => {
    // The end-to-end half: the record the batch commits, not a decode done in
    // the test. This is the path a change to where the pixels come from would
    // break, and the one every crop box and every posterior is cut against.
    await boot(page);
    await installCountingSessions(page);

    for (const orientation of [6, 8] as Orientation[]) {
      const url = fixtureDataUrl(FIXTURES[orientation]);
      const record = await page.evaluate(async ([dataUrl, label]) => {
        const A = window.__mosqAsync!;
        const blob = await (await fetch(dataUrl)).blob();
        const file = new File([blob], label, { type: "image/jpeg" });
        A.previews.length = 0;
        A.includedIndices.clear();
        await A.processFiles([file]);
        const p = A.previews[0];
        if (!p) return null;
        // One pixel from each quadrant of the display copy the record kept.
        const cv = p.displayCanvas;
        const ctx = cv.getContext("2d")!;
        const at = (fx: number, fy: number) => {
          const x = Math.min(cv.width - 1, Math.max(0, Math.round(cv.width * fx)));
          const y = Math.min(cv.height - 1, Math.max(0, Math.round(cv.height * fy)));
          const d = ctx.getImageData(x, y, 1, 1).data;
          return [d[0], d[1], d[2]];
        };
        return {
          fullW: p.fullW,
          fullH: p.fullH,
          is_cropped: p.is_cropped,
          displayW: cv.width,
          displayH: cv.height,
          quadrants: [at(0.25, 0.25), at(0.75, 0.25), at(0.25, 0.75), at(0.75, 0.75)],
        };
      }, [url, `exif${orientation}.jpg`] as const);

      expect(record, `orientation ${orientation} produced no record`).not.toBeNull();
      const r = record!;
      // The record's own dimensions are the photograph's, in the orientation
      // every box on it is expressed in. A record that kept the stored
      // dimensions would put every crop box in the wrong coordinates, and
      // nothing reports that: the outline simply lands in the wrong place.
      expect(
        [r.fullW, r.fullH],
        `orientation ${orientation}: the record kept the stored dimensions, not the oriented ones`,
      ).toEqual(DIMENSIONS[orientation]);
      // Past the 2048 display cap on the long edge, whatever that edge is.
      expect(Math.max(r.displayW, r.displayH)).toBe(2048);
      expect(
        r.quadrants.map(nameColour),
        `orientation ${orientation}: the record's display copy carries the wrong quadrants`,
      ).toEqual(QUADRANTS[orientation]);
      // And the photo was genuinely cropped, so the crop cut and the context
      // region ran over oriented pixels rather than being skipped.
      expect(r.is_cropped, `orientation ${orientation} was not cropped`).toBe(true);
    }
    expect(errors(page)).toHaveLength(0);
    await settle(page);
  });
});