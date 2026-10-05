/**
 * The classifier's input pipeline: canvas -> normalised CHW tensor -> embedding.
 *
 * Two of this project's shipped bugs live at the two ends of it.
 *
 * At the output end, a model's outputs were read POSITIONALLY, so culico's graph
 * - which declares `1747` and `culico_embedding` - handed the 18-element probe
 * logits to a softmax whose rows are 1153 wide. Every product past index 17
 * became `undefined * number` = NaN, and the non-finite guard in `verdictFrom`
 * returned "not confident" for every photo. Nothing threw: the app was working
 * perfectly on a number that meant nothing. `pickEmbedding` selects by width
 * and then by name, never by position.
 *
 * At the input end, normalising the WHOLE vector divided the probe's appended
 * constant `1.0` by the feature norm, shrinking it ~40x and throwing away most
 * of the bias. `l2NormaliseFeatures` normalises only the feature coordinates.
 *
 * `clipEmbed` stays out of this module's core because it runs a session; the
 * session is a parameter (`runClassifier`), so everything here is checkable
 * without the 1.26 GB model.
 */
import { CLIP_MEAN, CLIP_SIZE, CLIP_STD } from "./modelConfig";
import type { OrtTensor } from "./types";
import type { Head } from "../confidence/types";
import { halvingEnabled } from "./resizeMode";

/** A classifier session, as much of one as this module uses. */
export interface ClassifierSession {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * `src` halved in each axis, repeatedly, until one more halving would take it
 * below `dw` x `dh`; returns `src` itself when it is already within 2x.
 *
 * Each step is a 2:1 bilinear read, which averages exactly the 2x2 block it
 * covers, so the chain is a box filter and the final non-integer step to
 * `dw` x `dh` never skips more than 2x.
 */
export function halveToward(src: HTMLCanvasElement, dw: number, dh: number): HTMLCanvasElement {
  let cur = src;
  while (cur.width >= 2 * dw && cur.height >= 2 * dh) {
    const next = document.createElement("canvas");
    next.width = Math.max(dw, cur.width >> 1);
    next.height = Math.max(dh, cur.height >> 1);
    const nx = next.getContext("2d", { willReadFrequently: true });
    if (!nx) throw new Error("Could not get a 2d context for a resize step");
    nx.drawImage(cur, 0, 0, cur.width, cur.height, 0, 0, next.width, next.height);
    // Release the pixels of an intermediate as soon as it has been read.
    if (cur !== src) { cur.width = 0; cur.height = 0; }
    cur = next;
  }
  return cur;
}

/**
 * The classifier's input tensor: CLIP_SIZE square, normalised per channel.
 *
 * The shorter side is scaled to CLIP_SIZE and the longer side overflows; the
 * centre CLIP_SIZE square is then cut out of it. So the whole frame is visible
 * with the crop's subject centred, which is what keeps a tight detector box from
 * being re-cropped into nothing here.
 */
export function clipTensor(sourceCanvas: HTMLCanvasElement, halving: boolean = halvingEnabled()): Float32Array {
  const cw = sourceCanvas.width;
  const ch = sourceCanvas.height;
  const s = CLIP_SIZE / Math.min(cw, ch);
  const dw = Math.round(cw * s);
  const dh = Math.round(ch * s);

  const cv = document.createElement("canvas");
  cv.width = dw;
  cv.height = dh;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  if (!cx) throw new Error("Could not get a 2d context to read the source canvas");
  // Flag off: the one direct read, exactly as it always was.
  const from = halving ? halveToward(sourceCanvas, dw, dh) : sourceCanvas;
  cx.drawImage(from, 0, 0, from.width, from.height, 0, 0, dw, dh);
  if (from !== sourceCanvas) { from.width = 0; from.height = 0; }

  const l = (dw - CLIP_SIZE) >> 1;
  const t = (dh - CLIP_SIZE) >> 1;
  const cc = document.createElement("canvas");
  cc.width = CLIP_SIZE;
  cc.height = CLIP_SIZE;
  const ccx = cc.getContext("2d");
  if (!ccx) throw new Error("Could not get a 2d context for the classifier input");
  ccx.drawImage(cv, l, t, CLIP_SIZE, CLIP_SIZE, 0, 0, CLIP_SIZE, CLIP_SIZE);

  const d = ccx.getImageData(0, 0, CLIP_SIZE, CLIP_SIZE).data;
  const n = CLIP_SIZE * CLIP_SIZE;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      out[c * n + i] = (d[4 * i + c]! / 255 - CLIP_MEAN[c]!) / CLIP_STD[c]!;
    }
  }
  return out;
}

/**
 * Which of a model's outputs is the embedding.
 *
 * Selected by width, checked against the head's dimension, then by name - never
 * by position. `Object.keys()` sorts integer-like keys ahead of string keys, so
 * a graph whose outputs are `1747` and `culico_embedding` yields `1747` first
 * regardless of the order the graph declares them in. Reading positionally would
 * hand the probe-logit vector to a softmax and produce NaN everywhere, which the
 * verdict's non-finite guard reports as "not confident" for every photo.
 *
 * `want` is the head's `dim`, or null when no head is loaded yet - in which case
 * the name is the only evidence available, and a graph with neither throws
 * rather than returning a number of the wrong width.
 *
 * The name fallback matches `embedding`/`embed` and nothing else, so a graph
 * naming its output `features` is NOT matched by it. That is deliberate in one
 * direction and a trap in the other: with no head loaded, a `features` output
 * throws rather than being used, and every registered engine loads a head before
 * the first inference, so the width check is the one that runs.
 */
export function pickEmbedding(
  res: Record<string, unknown>,
  want: number | null,
): OrtTensor {
  const keys = Object.keys(res);
  if (want) {
    for (const k of keys) {
      const t = res[k] as OrtTensor | undefined;
      if (t && t.dims && t.dims.length === 2 && t.dims[1] === want) return t;
    }
  }
  for (const k of keys) {
    const t = res[k] as OrtTensor | undefined;
    if (/embedding|embed/i.test(k) && t?.data) return t;
  }
  throw new Error(
    `No embedding among the model's outputs (${keys.join(", ")}); none is ${want} wide. ` +
      `The app reads features, not classifier logits.`,
  );
}

/**
 * L2-normalise the FEATURE coordinates only, in place.
 *
 * The last coordinate is a constant `1.0` appended to the model's output to
 * carry the probe's bias term, and dividing it by the feature norm shrinks it by
 * that same factor (~40x here), which throws away most of the bias. So the
 * normalisation runs to `head.dim` and stops there.
 *
 * `features` is `head.dim`, or the vector's own length when no head is loaded.
 * A zero vector is left alone rather than divided by zero: `|| 1` is the whole
 * guard, and a zero norm means the model produced nothing worth normalising.
 */
export function l2NormaliseFeatures(e: Float32Array, features: number): Float32Array {
  const n = Math.min(features, e.length);
  let norm = 0;
  for (let i = 0; i < n; i++) norm += e[i]! * e[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < n; i++) e[i] = e[i]! / norm;
  return e;
}

/**
 * Cut a canvas down to one CLIP_SIZE embedding, running `session` to get it.
 *
 * `makeTensor` is injected because `ort` is a UMD global loaded by index.html,
 * not a package this project depends on (see ./ort.ts).
 */
export async function embedCanvas(
  sourceCanvas: HTMLCanvasElement,
  session: ClassifierSession,
  head: Head | null,
  makeTensor: (data: Float32Array, dims: readonly number[]) => unknown,
): Promise<Float32Array> {
  const inName = session.inputNames[0];
  if (!inName) throw new Error("The classifier session reports no input name");
  const tensor = clipTensor(sourceCanvas);
  const res = await session.run({
    [inName]: makeTensor(tensor, [1, 3, CLIP_SIZE, CLIP_SIZE]),
  });
  const e = pickEmbedding(res, head ? head.dim : null).data as Float32Array;
  return l2NormaliseFeatures(e, head ? head.dim : e.length);
}
