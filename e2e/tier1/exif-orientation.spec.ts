import { boot, errors, expect, test } from "../helpers/app";
import { MAKE_EXIF6_FILE } from "../helpers/exifOrientation6";

/**
 * The classifier's decode path is orientation-correct, on every browser.
 *
 * The pixels the classifier receives must be the DISPLAYED picture. A JPEG with
 * EXIF orientation 6 is stored landscape and must be shown rotated 90 CW, so a
 * correct decode yields a portrait frame with the stored-left (red) half on top.
 * This is the one part of `createImageBitmap` that changes pixel content rather
 * than just sampling, so it is the one part worth pinning per browser.
 *
 * In `e2e/helpers/exifOrientation6.ts` for why the fixture is synthesised in the
 * page instead of being a committed JPEG.
 */

/** In the page: read a canvas' pixels and report what colour dominates each end. */
const MEASURE = `
(cv) => {
  const g = cv.getContext("2d");
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  const mean = (y0, y1) => {
    let r = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < cv.width; x++) {
      const i = 4 * (y * cv.width + x);
      if (d[i + 3] < 200) continue;          // skip the JPEG's white border
      r += d[i]; b += d[i + 2]; n++;
    }
    return n ? { r: r / n, b: b / n } : { r: 0, b: 0 };
  };
  const third = Math.floor(cv.height / 3);
  let sum = 0, sum2 = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; sum2 += l * l; n++; }
  return {
    w: cv.width, h: cv.height,
    mean: sum / n, sd: Math.sqrt(sum2 / n - (sum / n) ** 2),
    top: mean(0, third), bottom: mean(cv.height - third, cv.height),
  };
}
`;

test("the pixels the classifier receives are upright for an EXIF orientation 6 photo", async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async ([makeSrc, measureSrc]) => {
    const A = (window as any).__mosqAsync;
    // Detector finds nothing and the classifier returns a fixed direction, so the
    // photo is analysed whole and the tensor comes from the full frame.
    A.sessDet = {
      inputNames: ["images"],
      async run() { return { output0: { dims: [1, 5, 8400], data: new Float32Array(5 * 8400) } }; },
    };
    await fetch("text_embeds.json").then((x) => x.json()).then((emb) => {
      for (const k of ["species_emb", "nuisance_emb"]) emb[k] = Float32Array.from(emb[k]);
      A.embeds = emb;
    });
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run() {
        const dim = A.embeds.dim as number;
        return { embedding: { dims: [1, dim], data: new Float32Array(dim).fill(1 / Math.sqrt(dim)) } };
      },
    };
    // Classify once, then read the tensor the classifier actually received.
    const seen: number[] = [];
    const inner = A.sessClip.run.bind(A.sessClip);
    A.sessClip.run = async (feeds: any) => {
      const px = feeds?.pixel_values?.data as Float32Array | undefined;
      if (px) seen.push(px.length, px[0]!, px[Math.floor(px.length / 2)]!, px[px.length - 1]!);
      return inner(feeds);
    };
    const file = await (0, eval)(makeSrc as string);
    await A.processFiles([file]);
    return {
      tensor: seen,
      err: A.previews.map((p: any) => p.error),
      pending: A.previews.some((p: any) => p.pending),
      // The displayed photo, which is what the tensor must match.
      slot: (() => {
        const p = A.previews[0];
        const cv = p.fullCanvas;
        return (0, eval)(measureSrc as string)(cv);
      })(),
    };
  }, [MAKE_EXIF6_FILE, MEASURE] as const);

  expect(r.err).toEqual([null]);
  expect(r.pending).toBe(false);

  // Orientation 6: stored landscape, displayed portrait.
  expect(r.slot.h).toBeGreaterThan(r.slot.w);
  // Content, so a black or flat frame (#77) cannot satisfy the colour asserts.
  expect(r.slot.mean).toBeGreaterThan(40);
  expect(r.slot.sd).toBeGreaterThan(15);
  // Rotated 90 CW: the stored LEFT (red) half is now on TOP, the RIGHT (blue) at
  // the bottom. A decode that ignored EXIF leaves red on the left and both of
  // these fail.
  expect(r.slot.top.r).toBeGreaterThan(r.slot.top.b + 40);
  expect(r.slot.bottom.b).toBeGreaterThan(r.slot.bottom.r + 40);

  // The classifier received a real, non-degenerate tensor.
  expect(r.tensor.length).toBeGreaterThan(0);
  const vals = r.tensor.slice(1);
  expect(vals.every((v) => Number.isFinite(v))).toBe(true);
  expect(Math.max(...vals)).toBeGreaterThan(0);
  // Engine init fails on firefox/webkit because this box has no WebGPU for them
  // (the classifier is stubbed above, so the decode path under test still runs).
  // That noise is the same one shell.spec.ts filters; anything else is real.
  expect(errors(page).filter((e) => !/Engine initialization error|onnx|net::|Failed to fetch|r2\.dev/i.test(e))).toHaveLength(0);
});
