import { boot, errors, expect, test } from "../helpers/app";

/**
 * Tile thumbnails are resized by the browser's decoder, from the File, and are
 * checked for content (issue #77: a black or uniform thumbnail used to pass).
 */

/** In the page: a 3000x2000 JPEG, red/blue halves with a white mark, EXIF orientation 6. */
const MAKE_ROTATED_FILE = `
(async () => {
  const cv = document.createElement("canvas");
  cv.width = 3000; cv.height = 2000;
  const g = cv.getContext("2d");
  g.fillStyle = "#d22"; g.fillRect(0, 0, 1500, 2000);
  g.fillStyle = "#22d"; g.fillRect(1500, 0, 1500, 2000);
  g.fillStyle = "#fff"; g.fillRect(100, 100, 600, 300);
  const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.9));
  const jpg = new Uint8Array(await blob.arrayBuffer());
  const exif = [0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0,
    0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0,
    0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
  const bytes = new Uint8Array(jpg.length + exif.length);
  bytes.set(jpg.subarray(0, 2), 0); bytes.set(exif, 2); bytes.set(jpg.subarray(2), 2 + exif.length);
  return new File([bytes], "rot.jpg", { type: "image/jpeg" });
})()
`;

test("a File's tile thumbnail is resized by createImageBitmap, oriented, and not blank", async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async (makeSrc) => {
    const A = window.__mosqAsync!;
    const w = window as any;
    // Detector finds nothing, classifier is a fixed direction: the photo is analysed whole.
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
        const data = new Float32Array(dim).fill(1 / Math.sqrt(dim));
        return { embedding: { dims: [1, dim], data } };
      },
    };
    w.__cib = [] as any[];
    const orig = window.createImageBitmap;
    (window as any).createImageBitmap = function (src: any, ...rest: any[]) {
      const opts = rest.find((x) => x && typeof x === "object");
      w.__cib.push({ file: src instanceof Blob, resizeWidth: opts?.resizeWidth ?? null });
      return (orig as any).call(window, src, ...rest);
    };
    const file = await (0, eval)(makeSrc);
    await A.processFiles([file]);

    const img = document.querySelector<HTMLImageElement>("#thumbnail-strip img")!;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const g = cv.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, cv.width, cv.height).data;
    // Mean colour of a band of rows, and overall spread.
    const mean = (y0: number, y1: number) => {
      let r = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = 0; x < cv.width; x++) { const i = 4 * (y * cv.width + x); r += px[i]!; b += px[i + 2]!; n++; }
      return { r: r / n, b: b / n };
    };
    let sum = 0, sum2 = 0;
    for (let i = 0; i < px.length; i += 4) { const l = (px[i]! + px[i + 1]! + px[i + 2]!) / 3; sum += l; sum2 += l * l; }
    const n = px.length / 4;
    const sd = Math.sqrt(sum2 / n - (sum / n) ** 2);
    const third = Math.floor(cv.height / 3);
    return {
      cib: w.__cib, w: cv.width, h: cv.height, mean: sum / n, sd,
      top: mean(0, third), bottom: mean(cv.height - third, cv.height),
      src: img.getAttribute("src")!.slice(0, 10),
      pending: A.previews.some((p: any) => p.pending), err: A.previews.map((p: any) => p.error),
    };
  }, MAKE_ROTATED_FILE);

  expect(r.err).toEqual([null]);
  // Resized by the decoder, from the File, with a target width.
  expect(r.cib.some((c: any) => c.file && c.resizeWidth)).toBe(true);
  // Orientation 6: the stored landscape frame is shown portrait.
  expect(r.h).toBeGreaterThan(r.w);
  expect(r.w).toBeLessThanOrEqual(252 + 1);
  // Content: neither black nor flat (#77).
  expect(r.mean).toBeGreaterThan(40);
  expect(r.sd).toBeGreaterThan(15);
  // Rotated 90 degrees clockwise, the stored left (red) half is on top and the
  // right (blue) half at the bottom.
  expect(r.top.r).toBeGreaterThan(r.top.b + 40);
  expect(r.bottom.b).toBeGreaterThan(r.bottom.r + 40);
  expect(errors(page)).toHaveLength(0);
});
