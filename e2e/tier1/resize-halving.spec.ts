import { readFileSync } from "node:fs";
import { boot, errors, expect, test } from "../helpers/app";
import type { Page } from "@playwright/test";

/**
 * The classifier's resize, behind `?resize=halving`.
 *
 * Flag off must be exactly the single direct drawImage the app has always used.
 * Flag on halves stepwise and must land closer to the PIL-BICUBIC picture the
 * heads were fitted on. The reference is `tests/fixtures/pil-bicubic-whole-224.png`,
 * made by the generator below in Python (see tests/fixtures/README in the commit
 * message): the whole frame of a 4032x3024 synthetic photo, short side to 224,
 * centre 224 square, Pillow BICUBIC.
 */

const REF_PNG_B64 = readFileSync(new URL("../../tests/fixtures/pil-bicubic-whole-224.png", import.meta.url)).toString("base64");

/** In the page: the synthetic photo (same integer formulas as the Python reference). */
const MAKE_PHOTO = `
(() => {
  const W = 4032, H = 3024;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  const img = g.createImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    const gg = Math.floor(y * 255 / (H - 1));
    for (let x = 0; x < W; x++) {
      let r = Math.floor(x * 255 / (W - 1));
      if (x % 3 === 0) r = 255 - r;
      const b = (((x >> 2) + (y >> 2)) & 1) === 1 ? 220 : 40;
      const i = 4 * (y * W + x);
      d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return cv;
})()
`;

/** Tensor -> uint8 RGB, the exact inverse of clipTensor's normalisation. */
const TO_U8 = `
(t) => {
  const MEAN = [0.48145466, 0.4578275, 0.40821073], STD = [0.26862954, 0.26130258, 0.27577711];
  const n = 224 * 224, out = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[3 * i + c] = Math.round((t[c * n + i] * STD[c] + MEAN[c]) * 255);
  return out;
}
`;

async function pixels(page: Page, halving: boolean | undefined) {
  return page.evaluate(
    async ({ makeSrc, toU8, ref, halving }) => {
      const A = window.__mosqAsync!;
      const cv = (0, eval)(makeSrc) as HTMLCanvasElement;
      const toU8f = (0, eval)(toU8) as (t: Float32Array) => Uint8Array;
      const t = halving === undefined ? A.clipTensor(cv) : A.clipTensor(cv, halving);
      const mine = toU8f(t);
      const bmp = await createImageBitmap(await (await fetch("data:image/png;base64," + ref)).blob());
      const rc = document.createElement("canvas");
      rc.width = 224; rc.height = 224;
      const rg = rc.getContext("2d")!;
      rg.drawImage(bmp, 0, 0);
      const rd = rg.getImageData(0, 0, 224, 224).data;
      let abs = 0, dot = 0, na = 0, nb = 0;
      for (let i = 0; i < 224 * 224; i++) for (let c = 0; c < 3; c++) {
        const a = mine[3 * i + c]!, b = rd[4 * i + c]!;
        abs += Math.abs(a - b); dot += a * b; na += a * a; nb += b * b;
      }
      // The pre-flag implementation, verbatim: one drawImage, then the centre cut.
      const s = 224 / Math.min(cv.width, cv.height);
      const dw = Math.round(cv.width * s), dh = Math.round(cv.height * s);
      const c1 = document.createElement("canvas"); c1.width = dw; c1.height = dh;
      c1.getContext("2d", { willReadFrequently: true })!.drawImage(cv, 0, 0, cv.width, cv.height, 0, 0, dw, dh);
      const c2 = document.createElement("canvas"); c2.width = 224; c2.height = 224;
      c2.getContext("2d")!.drawImage(c1, (dw - 224) >> 1, (dh - 224) >> 1, 224, 224, 0, 0, 224, 224);
      const legacy = c2.getContext("2d")!.getImageData(0, 0, 224, 224).data;
      let legacyDiff = 0;
      for (let i = 0; i < 224 * 224; i++) for (let c = 0; c < 3; c++) legacyDiff += Math.abs(mine[3 * i + c]! - legacy[4 * i + c]!);
      return { mae: abs / (3 * 224 * 224), cos: dot / Math.sqrt(na * nb), legacyDiff };
    },
    { makeSrc: MAKE_PHOTO, toU8: TO_U8, ref: REF_PNG_B64, halving },
  );
}

test.describe("resize halving flag", () => {
  test("flag off is bit-identical to the single direct drawImage", async ({ page }) => {
    await boot(page);
    const r = await pixels(page, undefined);
    expect(r.legacyDiff).toBe(0);
    const explicitOff = await pixels(page, false);
    expect(explicitOff.legacyDiff).toBe(0);
    expect(errors(page)).toHaveLength(0);
  });

  test("the URL flag turns halving on, and halving matches PIL-bicubic far better", async ({ page }) => {
    await boot(page, "/?resize=halving");
    const on = await pixels(page, undefined);
    const off = await pixels(page, false);
    // Flag on is not the legacy picture...
    expect(on.legacyDiff).toBeGreaterThan(0);
    // ...and is much closer to the training preprocessing than the legacy picture is.
    expect(on.mae).toBeLessThan(off.mae / 2);
    expect(on.mae).toBeLessThan(6);
    expect(on.cos).toBeGreaterThan(0.99);
    expect(errors(page)).toHaveLength(0);
  });

  test("with the flag on the whole view is read from the photo, with it off from the detector canvas", async ({ page }) => {
    const wholeTensor = async (url: string) => {
      await boot(page, url);
      return page.evaluate(async () => {
        const A = window.__mosqAsync!;
        const w = window as any;
        w.__tensors = [];
        A.sessDet = {
          inputNames: ["images"],
          async run() { return { output0: { dims: [1, 5, 8400], data: new Float32Array(5 * 8400) } }; },
        };
        const emb = await fetch("text_embeds.json").then((x) => x.json());
        for (const k of ["species_emb", "nuisance_emb"]) emb[k] = Float32Array.from(emb[k]);
        A.embeds = emb;
        A.sessClip = {
          inputNames: ["pixel_values"],
          async run(feeds: any) {
            w.__tensors.push(Float32Array.from(feeds.pixel_values.data));
            const dim = A.embeds.dim as number;
            return { embedding: { dims: [1, dim], data: new Float32Array(dim).fill(1 / Math.sqrt(dim)) } };
          },
        };
        // 2400x1800 noisy-stripe JPEG: big enough that the two paths differ.
        const cv = document.createElement("canvas");
        cv.width = 2400; cv.height = 1800;
        const g = cv.getContext("2d")!;
        for (let x = 0; x < 2400; x += 2) { g.fillStyle = x % 8 < 4 ? "#e33" : "#33e"; g.fillRect(x, 0, 2, 1800); }
        for (let y = 0; y < 1800; y += 5) { g.fillStyle = "#fff"; g.fillRect(0, y, 2400, 1); }
        const blob = await new Promise<Blob>((r) => cv.toBlob((b) => r(b!), "image/jpeg", 0.95));
        await A.processFiles([new File([blob], "stripes.jpg", { type: "image/jpeg" })]);
        const p = A.previews[0] as any;
        const expected = Array.from(A.clipTensor(p.fullCanvas));
        const got = Array.from(w.__tensors[0] as Float32Array);
        let maxDiff = 0;
        for (let i = 0; i < got.length; i++) maxDiff = Math.max(maxDiff, Math.abs(got[i]! - expected[i]!));
        return { n: w.__tensors.length, maxDiff, err: p.error };
      });
    };
    const on = await wholeTensor("/?resize=halving");
    expect(on.err).toBeNull();
    expect(on.n).toBe(1);
    expect(on.maxDiff).toBe(0); // exactly clipTensor(photo)

    const off = await wholeTensor("/");
    expect(off.err).toBeNull();
    // Off: the 640 px detector canvas feeds the classifier, so it is NOT the photo's own tensor.
    expect(off.maxDiff).toBeGreaterThan(0);
  });
});
