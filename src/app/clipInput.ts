/**
 * How a photo of any shape becomes the classifier's square input.
 *
 * `clipEmbed` in main.js used to scale the SHORT side to `CLIP_SIZE` and take the
 * centre 224x224 out of the result, which silently deletes the overflow on one
 * axis: a 400x200 crop lost half its width and a 4:3 phone photo lost a quarter
 * of it, with nothing logged. The detector letterboxes instead (`letterbox` in
 * detector.ts), so the two stages of one pipeline disagreed about the same photo
 * and only one of them saw all of it.
 *
 * This module is the geometry both the browser path and the offline feature
 * pipeline have to agree on, kept free of the DOM so it can be tested: the caller
 * draws the resized photo into a `CLIP_SIZE` square at `(ox, oy)` and hands the
 * pixels back here, and `clipCHW` normalises them, filling the margin with
 * `CLIP_PAD`. A square input is the identity, which is what keeps an already
 * square photo's features unchanged.
 */

import { CLIP_MEAN, CLIP_SIZE, CLIP_STD } from "./modelConfig";

/**
 * The grey the margin is filled with, as a 0-255 channel value.
 *
 * The same value `letterbox` pads the detector with, so one photo has one
 * neutral border colour in the pipeline rather than two, and it is not black:
 * black is a value the model has never been shown and reads as a hard edge,
 * whereas mid grey sits at the middle of the distribution.
 */
export const CLIP_PAD = 0x72;

/** Where the resized photo goes inside the classifier's square. */
export interface ClipFit {
  /** Resized photo width, in pixels. */
  dw: number;
  /** Resized photo height, in pixels. */
  dh: number;
  /** Left margin, in pixels. */
  ox: number;
  /** Top margin, in pixels. */
  oy: number;
}

/**
 * Fit a `cw`x`ch` photo into a `size` square, whole.
 *
 * The LONG side is scaled to `size` and the remainder of the square is margin, so
 * the whole source rect is mapped and no part of the photo is dropped. The price
 * is resolution on the short axis - a 4:3 photo arrives as 224x168 with a quarter
 * of the tensor as margin - which is the trade this scheme makes deliberately,
 * and the reason it is stated here rather than left implicit in the call site.
 *
 * The exception is an axis that scales to under a pixel: a 4000x1 sliver clamps
 * to 1 rather than to 0, because a zero-extent drawImage destination draws
 * nothing at all. Such an input is stretched to fit, so nothing is lost but the
 * aspect is not preserved, and the caller cannot tell from the result alone. A
 * degenerate detector box is the case that produces one.
 */
export function clipFit(cw: number, ch: number, size: number = CLIP_SIZE): ClipFit {
  const s = clipScale(cw, ch, size);
  // At least one pixel: a 4000x1 sliver rounds to a height of 0 at this scale,
  // and a drawImage with a zero-extent destination draws nothing at all.
  const dw = Math.max(1, Math.round(cw * s));
  const dh = Math.max(1, Math.round(ch * s));
  // `size - dw` is never negative and never above `size`, so the margin is
  // non-negative and the resized photo always lands inside the square.
  return { dw, dh, ox: Math.floor((size - dw) / 2), oy: Math.floor((size - dh) / 2) };
}

/**
 * The scale factor the photo is resized by: `CLIP_SIZE / long side`.
 *
 * Exposed because it is the number the offline feature pipeline has to agree
 * with, and because it is the one thing about this fit a caller can check: an
 * axis whose `size * cw / (cw + ch)` falls below a pixel is being stretched, and
 * that is the input shape this scheme cannot represent.
 */
export function clipScale(cw: number, ch: number, size: number = CLIP_SIZE): number {
  return size / Math.max(cw, ch);
}

/**
 * Normalise a `size`x`size` RGBA buffer into the classifier's CHW float32
 * input, writing `CLIP_PAD` into any pixel the resized photo did not cover.
 *
 * `rgba` is the whole square - the margin reads back as transparent, which is
 * exactly the set of pixels this fills. Mean and std default to the classifier's
 * own, and are parameters only so a caller can test the arithmetic against
 * numbers it chose.
 */
export function clipCHW(
  rgba: ArrayLike<number>,
  fit: ClipFit,
  size: number = CLIP_SIZE,
  mean: readonly number[] = CLIP_MEAN,
  std: readonly number[] = CLIP_STD,
): Float32Array {
  const n = size * size;
  const out = new Float32Array(3 * n);
  const right = fit.ox + fit.dw;
  const bottom = fit.oy + fit.dh;
  for (let y = 0; y < size; y++) {
    const inPhoto = y >= fit.oy && y < bottom;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const p = inPhoto && x >= fit.ox && x < right ? 4 * i : -1;
      for (let c = 0; c < 3; c++) {
        const raw = p < 0 ? CLIP_PAD : (rgba[p + c] as number);
        out[c * n + i] = (raw / 255 - (mean[c] as number)) / (std[c] as number);
      }
    }
  }
  return out;
}
