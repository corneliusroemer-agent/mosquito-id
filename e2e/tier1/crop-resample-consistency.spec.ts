import { test, expect, boot, populate, settle, errors } from "../helpers/app";
import type { Page } from "@playwright/test";

/**
 * One crop box must be ONE set of pixels, whichever path cut it (#114).
 *
 * Two paths put a crop in front of the encoder. The batch path
 * (`classifyImage`) blits the box out of the full-resolution frame 1:1, at the
 * box's NATIVE size. The crop-release path (`cutCrop`, via `executeCrop` and
 * `classifyViews`) scales the same box down to `DISPLAY_MAX_EDGE` = 2048 first.
 * Both then resize it to the classifier's input, and for any box over 2048 px
 * those are two different resampling chains into the same tensor.
 *
 * The consequence is not a slightly softer crop. It is that re-releasing a crop
 * the user did not change can move the verdict, and the movement is charged to
 * the box rather than to the sampling.
 *
 * What is compared here is the classifier INPUT TENSOR, not the verdict. A
 * verdict comparison would be a weaker test of the same claim and a flakier one:
 * it can agree by luck when two differently-sampled images score the same class.
 * The tensor is what the encoder is actually handed, so equality of tensors is
 * equality of the thing the bug is about.
 *
 * The photograph is painted with a coordinate pattern rather than a flat fill,
 * for the reason issue #77 gives: a flat fill makes every wrong resampling look
 * identical to the right one. Here R carries `x mod 256` and G carries `y mod
 * 256`, so a tensor read at a different scale carries different bytes.
 */

const PHOTO_W = 4000;
const PHOTO_H = 3000;

/**
 * The detection the fake detector reports, in the letterboxed 640 px input.
 *
 * `letterbox` scales the photograph by `r = min(640/W, 640/H) = 0.16` and
 * centres it, so a 4000x3000 frame is drawn at 640x480 with `dx = 0` and
 * `dy = 80`. `decodeDets` inverts that with
 * `box = (c - half - d) / r`, so these four numbers name a detection of
 * `[400, 100, 3200, 2900]` in the photograph's own pixels.
 *
 * One candidate is emitted (`dims = [1, 5, 1]`: four box coordinates and one
 * class score, `nc = 5 - 4 = 1`) with a confidence well over `DET_CONF`, which
 * is what `selectDetection` needs before it returns anything at all.
 *
 * After the 10% `CROP_PAD` and the squaring in `classifyImage`, the box that
 * reaches the encoder is a 3000 px square - comfortably over the cap, so the two
 * paths disagree. The spec asserts that rather than assuming it.
 */
const DET_LB = { cx: 288, cy: 320, w: 448, h: 448, conf: 0.9 };

/** The classifier input for each view it is asked about, as plain arrays. */
type Captured = { n: number; tensors: number[][] };

async function paintPhoto(page: Page): Promise<void> {
  await page.evaluate(async ({ w, h }) => {
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d")!;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        img.data[i] = x % 256;
        img.data[i + 1] = y % 256;
        img.data[i + 2] = 128;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/png"));
    // PNG, not JPEG: this comparison is between two resamplings of the same
    // pixels, and JPEG would put its own loss between the batch's decode and
    // the release's.
    const file = new File([blob!], "pattern.png", { type: "image/png" });
    (window as any).__patternFile = file;
  }, { w: PHOTO_W, h: PHOTO_H });
}

/**
 * A detector and a classifier that need no download.
 *
 * `processFiles` refuses a batch while either session is missing, so a fake
 * classifier alone leaves every photo queued. Both are installed through the
 * seam, which is the app's own replace-`sessDet`/`sessClip` hook.
 *
 * The classifier returns the head's own embedding row for one species. That is
 * what makes the crop pass the nuisance gate in `classifyImage` - a photo whose
 * crop loses the gate is thrown back to the whole frame and never carries a crop
 * box, so a fake that answered "equal to every class" would silently test
 * nothing.
 */
async function installFakeModels(page: Page, det: typeof DET_LB): Promise<void> {
  await page.evaluate((d) => {
    const A = window.__mosqAsync!;
    const w = window as any;
    const head = A.embeds as any;
    const dim = head.dim as number;
    const sidx = head.species.indexOf("Aedes aegypti");
    const row = Array.from(head.species_emb.subarray(sidx * dim, (sidx + 1) * dim)) as number[];
    let norm = 0;
    for (const v of row) norm += v * v;
    norm = Math.sqrt(norm) || 1;

    w.__captured = { n: 0, tensors: [] };
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run(feeds: Record<string, any>) {
        const t = feeds["pixel_values"].data as Float32Array;
        w.__captured.n++;
        w.__captured.tensors.push(Array.from(t));
        return { embedding: { dims: [1, dim], data: Float32Array.from(row, (v) => v / norm) } };
      },
    };

    // `decodeDets` reads this tensor positionally: `data[i]` = cx, `data[N+i]` =
    // cy, `data[2N+i]` = w, `data[3N+i]` = h, `data[(4+c)N+i]` = class score.
    A.sessDet = {
      inputNames: ["images"],
      async run() {
        return {
          output0: {
            dims: [1, 5, 1],
            data: Float32Array.from([d.cx, d.cy, d.w, d.h, d.conf]),
          },
        };
      },
    };
  }, det);
}

/** Read and clear what the fake classifier has been handed. */
async function takeCaptured(page: Page): Promise<Captured> {
  return page.evaluate(() => {
    const c = (window as any).__captured as Captured;
    const out = { n: c.n, tensors: c.tensors };
    c.n = 0;
    c.tensors = [];
    return out;
  });
}

test.describe("one crop box, one set of encoder pixels (#114)", () => {
  test("re-releasing an unchanged crop re-embeds byte-identical pixels", async ({ page }) => {
    await boot(page);
    // Binds the shipped head onto the module the softmax reads. The crop-only
    // default (#102) is what this relies on for there to be exactly one view per
    // pass, so the tensor compared is the CROP's on both sides.
    await populate(page, []);
    await paintPhoto(page);
    await installFakeModels(page, DET_LB);

    await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      await A.processFiles([(window as any).__patternFile]);
    });
    await page.waitForFunction(() => !window.__mosqAsync!.previews.some((p: any) => p.pending), null, {
      timeout: 30_000,
    });

    const box = await page.evaluate(() => {
      const p = window.__mosqAsync!.previews[0] as any;
      return { cropBox: p.cropBox, is_cropped: p.is_cropped, w: p.fullW, h: p.fullH };
    });
    // The scenario only exists above the cap. Asserted rather than assumed: a
    // smaller box makes both paths a 1:1 blit and the test passes for the wrong
    // reason.
    expect(box.is_cropped, "the detector box was rejected, so there is no crop to re-release").toBe(true);
    const side = Math.max(box.cropBox[2] - box.cropBox[0], box.cropBox[3] - box.cropBox[1]);
    expect(side, "this box must exceed the display cap for the two paths to differ").toBeGreaterThan(2048);

    const fromBatch = await takeCaptured(page);
    expect(fromBatch.n, "the batch classified no view, so nothing was compared").toBe(1);

    // The same box, released the way a drag releases it. This re-decodes the
    // photograph from its File and re-cuts through `cutCrop`.
    await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      const p = A.previews[0] as any;
      await A.applyCropBox(0, p.cropBox);
    });
    await page.waitForFunction(() => !window.__mosqAsync!.previews.some((p: any) => p.pending), null, {
      timeout: 30_000,
    });

    const fromRelease = await takeCaptured(page);
    expect(fromRelease.n, "the re-release reused a cached view, so it re-embedded nothing").toBe(1);

    const a = fromBatch.tensors[0]!;
    const b = fromRelease.tensors[0]!;
    expect(a.length, "the classifier input tensor has an unexpected shape").toBe(b.length);
    const firstDiff = a.findIndex((v, i) => v !== b[i]);
    expect(
      firstDiff,
      `the batch and the crop release handed the encoder different pixels for the same box ` +
        `(first differing coordinate ${firstDiff} of ${a.length})`,
    ).toBe(-1);

    expect(errors(page)).toHaveLength(0);
    await settle(page);
  });
});
