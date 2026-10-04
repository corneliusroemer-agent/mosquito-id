/**
 * A photo reaches the classifier whole.
 *
 * `clipEmbed` scaled the short side to 224 and took the centre 224x224 out of the
 * result, so every non-square photo lost the overflow on one axis before the model
 * saw it: half the width of a 400x200 detector box, a quarter of the width of a 4:3
 * phone photo, with nothing logged and no way to see it in the metrics, because
 * the offline feature pipeline cropped the same way and so agreed with it.
 *
 * The geometry therefore lives in `src/app/clipInput.ts` rather than inline in
 * main.js - `main.js` is a `.js` file that `tsc --noEmit` does not read, so a
 * defect there is invisible to the type checker, and the numbers are worth testing
 * directly rather than by reading the source back as text.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CLIP_PAD, clipCHW, clipFit, clipScale } from "../src/app/clipInput";
import { CLIP_MEAN, CLIP_SIZE, CLIP_STD } from "../src/app/modelConfig";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/**
 * The body of `clipEmbed`, taken up to the next top-level function.
 *
 * Slice to the next line-start `}` and one nested block added to the function
 * truncates it, at which point the assertions below pass vacuously.
 */
function clipEmbedBody(src: string): string {
  const start = src.indexOf("async function clipEmbed");
  expect(start, "clipEmbed not found in main.js").toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", start);
  expect(end, "the end of clipEmbed not found in main.js").toBeGreaterThan(start);
  return src.slice(start, end);
}

/** A square RGBA buffer in which pixel (x, y) is a colour that encodes (x, y). */
function encoded(size: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = 4 * (y * size + x);
      buf[i] = x;
      buf[i + 1] = y;
      buf[i + 2] = 7;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

describe("fitting a photo into the classifier's square", () => {
  it("keeps all of a photo that is not square", () => {
    // A 400x200 detector box, the shape that used to lose half its width.
    const fit = clipFit(400, 200);
    // The LONG side fills the square; the short side is what is left over.
    expect(fit.dw).toBe(CLIP_SIZE);
    expect(fit.dh).toBe(112);
    expect(fit.dw / fit.dh).toBeCloseTo(400 / 200, 2);
  });

  it("keeps all of a 4:3 phone photo", () => {
    const fit = clipFit(4000, 3000);
    expect(fit.dw).toBe(CLIP_SIZE);
    expect(fit.dh).toBe(168);

  });

  it("maps the photo at one uniform scale", () => {
    const fit = clipFit(512, 512);
    expect(fit.dw / fit.dh).toBeCloseTo(1, 6);
    // The scale is the long side onto the square, and it is what the offline
    // feature pipeline has to reproduce.
    expect(clipScale(512, 512)).toBe(CLIP_SIZE / 512);
    expect(clipScale(400, 200)).toBe(CLIP_SIZE / 400);
    expect(clipScale(200, 400)).toBe(CLIP_SIZE / 400);
  });

  it("distorts nothing and drops nothing, for every aspect ratio", () => {
    // The claim is structural - the whole source rect is mapped onto dw x dh, so
    // there is no sub-rect of the photo that could have been left out - and the
    // only way it could fail is a fit that stretches it or lands outside.
    for (let w = 1; w <= 4000; w = w < 40 ? w + 1 : Math.round(w * 1.37)) {
      for (const h of [1, 7, 224, 1000, 3000]) {
        const fit = clipFit(w, h);
        expect(fit.dw).toBeGreaterThan(0);
        expect(fit.dh).toBeGreaterThan(0);
        expect(fit.ox).toBeGreaterThanOrEqual(0);
        expect(fit.oy).toBeGreaterThanOrEqual(0);
        expect(fit.ox + fit.dw).toBeLessThanOrEqual(CLIP_SIZE);
        expect(fit.oy + fit.dh).toBeLessThanOrEqual(CLIP_SIZE);
        // One uniform scale, to within the rounding of a pixel - the direct
        // statement that the whole source rect is mapped, undistorted.
        // Half a pixel of rounding, except on an axis that scales to under one
        // pixel - there the fit clamps to 1 rather than drawing nothing, which is
        // the only deviation from the exact scale and is bounded by 1.
        const k = clipScale(w, h);
        const slack = Math.max(0.5, 1 - Math.min(w, h) * k);
        expect(Math.abs(fit.dw - w * k)).toBeLessThanOrEqual(slack);
        expect(Math.abs(fit.dh - h * k)).toBeLessThanOrEqual(slack);
      }
    }
  });

  it("reports the fraction the old centre crop kept, so the loss is on the record", () => {
    // What the short-side scheme discarded, per shape. Not a bound on the old
    // code's behaviour - a statement of what was being thrown away.
    const discarded = (cw: number, ch: number) => 1 - Math.min(cw, ch) / Math.max(cw, ch);
    expect(discarded(400, 200)).toBeCloseTo(0.5, 6);
    expect(discarded(4000, 3000)).toBeCloseTo(0.25, 6);
  });

  it("always lands the resized photo inside the square", () => {
    for (const [cw, ch] of [[1, 4000], [4000, 1], [3, 7], [224, 224], [225, 224]] as [number, number][]) {
      const fit = clipFit(cw, ch);
      expect(fit.dw).toBeGreaterThan(0);
      expect(fit.dh).toBeGreaterThan(0);
      expect(fit.ox).toBeGreaterThanOrEqual(0);
      expect(fit.oy).toBeGreaterThanOrEqual(0);
      expect(fit.ox + fit.dw).toBeLessThanOrEqual(CLIP_SIZE);
      expect(fit.oy + fit.dh).toBeLessThanOrEqual(CLIP_SIZE);
    }
  });

  it("is the identity on a square, so a square photo's features do not move", () => {
    const fit = clipFit(512, 512);
    expect(fit).toEqual({ dw: CLIP_SIZE, dh: CLIP_SIZE, ox: 0, oy: 0 });
  });
});

describe("the tensor handed to the classifier", () => {
  it("has the shape and dtype the heads consume", () => {
    const size = CLIP_SIZE;
    const out = clipCHW(encoded(size), clipFit(size, size), size);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(3 * size * size);
    // CHW, not HWC: each plane is contiguous, so the green of pixel (1, 2) sits
    // at n + 2*size + 1 rather than 4 * (2 * size + 1) + 1.
    const n = size * size;
    const chan = (c: number, x: number, y: number) => out[c * n + y * size + x];
    const rgba = encoded(size);
    const norm = (c: number, v: number) =>
      (v / 255 - (CLIP_MEAN[c] as number)) / (CLIP_STD[c] as number);
    for (const [c, x, y] of [[0, 1, 2], [1, 1, 2], [2, 1, 2], [1, 200, 60]] as const) {
      expect(chan(c, x, y)).toBeCloseTo(norm(c, rgba[4 * (y * size + x) + c] as number), 6);
    }
  });

  it("normalises a square photo exactly as before the change", () => {
    const size = CLIP_SIZE;
    const rgba = encoded(size);
    const out = clipCHW(rgba, clipFit(size, size), size);
    for (const c of [0, 1, 2]) {
      for (const i of [0, 1, 517, size * size - 1]) {
        const want = ((rgba[4 * i + c] as number) / 255 - (CLIP_MEAN[c] as number)) /
          (CLIP_STD[c] as number);
        expect(out[c * size * size + i]).toBeCloseTo(want, 6);
      }
    }
  });

  it("carries every pixel of a wide photo into the tensor", () => {
    // A 4:3 photo's square buffer carries its content in a 224x168 band, and the
    // margin is padding. The test the change exists for: nothing is cropped.
    const size = CLIP_SIZE;
    const fit = clipFit(400, 300);
    const rgba = encoded(size);
    const out = clipCHW(rgba, fit, size);
    const n = size * size;
    const inPad = (x: number, y: number) => y < fit.oy || y >= fit.oy + fit.dh ||
      x < fit.ox || x >= fit.ox + fit.dw;
    let content = 0;
    let pad = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (inPad(x, y)) {
          pad++;
          // Padding is one constant on all three channels, so it carries nothing
          // from the photo.
          for (let c = 0; c < 3; c++) {
            const back = (out[c * n + i] as number) * (CLIP_STD[c] as number) +
              (CLIP_MEAN[c] as number);
            expect(back * 255).toBeCloseTo(CLIP_PAD, 4);
          }
        } else {
          content++;
          expect(out[i]).toBeCloseTo(
            ((rgba[4 * i] as number) / 255 - (CLIP_MEAN[0] as number)) /
              (CLIP_STD[0] as number), 6);
        }
      }
    }
    expect(content).toBe(fit.dw * fit.dh);
    expect(content / (n + pad)).toBeGreaterThan(0);
    // 224*168 of 224*224: the margin is the cost of seeing the whole photo.
    expect(content).toBe(224 * 168);
  });

  it("fills the margin of a transparent buffer rather than reading it as black", () => {
    const size = CLIP_SIZE;
    const blank = new Uint8ClampedArray(size * size * 4); // what getImageData returns
    const out = clipCHW(blank, clipFit(400, 200), size);
    // The corner is margin. A black margin would normalise to (0 - mean) / std;
    // the grey the detector already pads with does not, and the difference is
    // large enough that the model would read one as a hard edge and the other as
    // background.
    const black = (0 - (CLIP_MEAN[0] as number)) / (CLIP_STD[0] as number);
    const grey = (CLIP_PAD / 255 - (CLIP_MEAN[0] as number)) / (CLIP_STD[0] as number);
    expect(out[0] as number).toBeCloseTo(grey, 6);
    expect(Math.abs((out[0] as number) - black)).toBeGreaterThan(1);
  });

  it("takes its mean and std from the classifier unless told otherwise", () => {
    const size = CLIP_SIZE;
    const rgba = encoded(size);
    const fit = clipFit(size, size);
    const def = clipCHW(rgba, fit, size);
    const given = clipCHW(rgba, fit, size, [0, 0, 0], [1, 1, 1]);
    expect(def[0] as number).not.toBeCloseTo(given[0] as number, 3);
    expect(given[0]).toBeCloseTo((rgba[0] as number) / 255, 6);
  });
});

describe("the classifier and the detector pad alike", () => {
  it("uses the detector's own margin colour", () => {
    // Nothing in the type system connects CLIP_PAD to detector.ts's fillStyle, so
    // changing one and not the other would leave two border colours in one
    // pipeline with every test still green.
    const det = readFileSync(join(root, "src", "app", "detector.ts"), "utf8");
    const m = /fillStyle\s*=\s*"#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})"/.exec(det);
    expect(m, "no fillStyle in detector.ts").not.toBeNull();
    expect(Number.parseInt(m![1] as string, 16)).toBe(CLIP_PAD);
  });

  it("fills the classifier's canvas before drawing, so the anti-aliased edge blends into the margin", () => {
    // drawImage onto a transparent canvas anti-aliases against transparent
    // black, and clipCHW reads RGB without looking at alpha, so the ring would
    // survive as a dark edge on every non-square photo.
    const src = readFileSync(join(root, "src", "app", "main.js"), "utf8");
    const body = clipEmbedBody(src);
    expect(body).toMatch(/fillStyle\s*=\s*"#727272"/);
    // Qualified, so the prose in the comment above the code cannot satisfy it.
    expect(body.indexOf("cx.fillRect")).toBeLessThan(body.indexOf("cx.drawImage"));
  });
});

describe("clipEmbed", () => {
  it("takes its geometry from clipInput rather than doing its own", () => {
    // main.js is plain JS and no test imports it, so the wiring between the
    // module and the call site is pinned here by reading the source.
    const src = readFileSync(join(root, "src", "app", "main.js"), "utf8");
    const body = clipEmbedBody(src);
    expect(body).toMatch(/clipFit\(cw, ch\)/);
    expect(body).toMatch(/clipCHW\(d, fit\)/);
    // The old scheme, gone: short side up, overflow cropped off.
    expect(body).not.toMatch(/Math\.min\(cw, ch\)/);
    expect(body).not.toMatch(/\(\(dw - CLIP_SIZE\) >> 1\)/);
  });
});
