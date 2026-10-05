import { boot, errors, expect, settle, test } from "../helpers/app";
import type { Page } from "@playwright/test";

/**
 * How many times a photograph is read whole.
 *
 * Not a timing assertion, and deliberately so: this box has no GPU, so a
 * wall-clock number taken here says more about the machine than about the code,
 * and the app's timing figures have been misled by that before. What this pins
 * is a COUNT - how many `drawImage` calls read at least a whole photo's worth of
 * source pixels - which is the same on every machine and is the thing that
 * silently regresses: two reads of a photograph produce the same pixels, so
 * nothing on screen changes when one is added.
 *
 * The probe is `perfCounters.ts`'s, armed only here. Nothing in the app arms it,
 * so a user's page carries no patched canvas method.
 */

/** Photographs big enough that a display copy is a distinct, smaller read. */
const PHOTO_W = 2400;
const PHOTO_H = 1800;

/**
 * The area one whole read of a photograph covers, in source pixels.
 *
 * Just under the photograph's own area: a read of the whole photograph counts,
 * and a read of a crop or of the 640 px detector input does not. The 2% margin
 * is there because the reads this pins are the whole photograph exactly, and a
 * threshold sitting on the boundary would depend on rounding.
 */
const WHOLE_PHOTO_AREA = PHOTO_W * PHOTO_H;

/**
 * A detector and a classifier that download nothing.
 *
 * The same seam `perf-counters.spec.ts` uses, for the same reason: the batch
 * path has to run for real - the decode, the letterbox, the crop, the fusion and
 * every render - and only the two `run()` calls are fake.
 *
 * The detector returns one centred box, so every photo is genuinely cropped.
 * An all-zero output would take the no-detection path, where a photo has one
 * view and no crop is cut, and the counts below would be measuring a different
 * path than the one the fixes change.
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

/** `n` photographs of the given size, dropped through the real intake. */
async function dropPhotos(page: Page, n: number, w: number, h: number): Promise<void> {
  await page.evaluate(async ([count, width, height]) => {
    const A = window.__mosqAsync!;
    const files: File[] = [];
    for (let i = 0; i < (count as number); i++) {
      const cv = document.createElement("canvas");
      cv.width = width as number;
      cv.height = height as number;
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = `hsl(${(i * 60) % 360}, 50%, 50%)`;
      ctx.fillRect(0, 0, cv.width, cv.height);
      const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/jpeg", 0.9));
      files.push(new File([blob!], `dropped_${i}.jpg`, { type: "image/jpeg" }));
    }
    await A.processFiles(files);
  }, [n, w, h] as const);
}

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !window.__mosqAsync!.previews.some((p: any) => p.pending),
    null,
    { timeout: 10_000 },
  );
  await settle(page);
}

test.describe("whole-image reads per photo", () => {
  test("a batch of three reads each photograph whole three times", async ({ page }) => {
    await boot(page);
    await installCountingSessions(page);

    await page.evaluate((area) => {
      const perf = window.__mosqAsync!.perf as any;
      perf.armWholeImageReads(area);
      perf.resetCounters();
    }, WHOLE_PHOTO_AREA);

    await dropPhotos(page, 3, PHOTO_W, PHOTO_H);
    await settled(page);

    const snap = (await page.evaluate(
      () => window.__mosqAsync!.perf.snapshot() as any,
    )) as { wholeImageReads: number; wholeImageReadsBySource: Record<string, number> };

    // The breakdown goes into the message, because a bare count of 12 against an
    // expected 9 says how many and not which, and "which" is the actionable half.
    expect(
      snap.wholeImageReads,
      `whole-image reads: ${JSON.stringify(snap.wholeImageReadsBySource)}`,
    ).toBe(9);
    expect(errors(page)).toHaveLength(0);

    await page.evaluate(() => (window.__mosqAsync!.perf as any).disarmWholeImageReads());
  });
});