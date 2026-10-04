/**
 * The detector's geometry: preprocessing, decoding, NMS and box selection.
 *
 * Pure functions over a tensor and a canvas - none of them reads app state or
 * touches a session, so the whole detection stage can be read without knowing
 * how a session is built. clipEmbed stays in main.js because it runs the
 * classifier session.
 *
 * `ort` is the onnxruntime-web UMD bundle loaded from a CDN by index.html, so
 * it is a global here rather than an import. Only the tensor constructor and
 * the two fields the decoder reads are described, in ./ort.ts.
 */

import { DET_CONF, DET_SIZE, NMS_IOU } from "./modelConfig";
import type { Box, Detection, Letterboxed, OrtTensor } from "./types";
import "./ort";

// ---- Client-Side Inference Helpers ----
/**
 * Read one element of a dense tensor.
 *
 * noUncheckedIndexedAccess types every index into an array-like as possibly
 * undefined, and the decoder below indexes by computed offsets thousands of
 * times. Those offsets are derived from the tensor's own dims and are in range
 * by construction, so the check would be dead code - claiming it once here, as a
 * NaN, is both honest and cheaper than a guard at every access.
 */
function at(data: ArrayLike<number>, i: number): number {
  const v = data[i];
  return v === undefined ? NaN : v;
}

export function chwFromCanvas(cv: HTMLCanvasElement): Float32Array {
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not get a 2d context to read the canvas back");
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const n = cv.width * cv.height;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = at(d, 4 * i) / 255;
    out[n + i] = at(d, 4 * i + 1) / 255;
    out[2 * n + i] = at(d, 4 * i + 2) / 255;
  }
  return out;
}

export function letterbox(imgCv: HTMLCanvasElement): Letterboxed {
  const w = imgCv.width;
  const h = imgCv.height;
  const r = Math.min(DET_SIZE / w, DET_SIZE / h);
  const dw = Math.round(w * r);
  const dh = Math.round(h * r);
  const dx = (DET_SIZE - dw) / 2;
  const dy = (DET_SIZE - dh) / 2;

  // The photo is resampled into `content` at the detector's scale, and
  // `content` - not the photograph - is what lands in the padded input. The
  // blit is 1:1, so the tensor is the same one the direct draw produced, and in
  // exchange `content` is a ~0.3 MP copy of the photograph that the classifier's
  // whole-frame view can be scaled from too: one read of a 12-50 MP source for
  // both views instead of one each.
  const content = document.createElement("canvas");
  content.width = dw;
  content.height = dh;
  const contentCtx = content.getContext("2d");
  if (!contentCtx) throw new Error("Could not get a 2d context for the detector input");
  contentCtx.drawImage(imgCv, 0, 0, w, h, 0, 0, dw, dh);

  const cv = document.createElement("canvas");
  cv.width = DET_SIZE;
  cv.height = DET_SIZE;
  const cx = cv.getContext("2d");
  if (!cx) throw new Error("Could not get a 2d context for the detector input");
  cx.fillStyle = "#727272";
  cx.fillRect(0, 0, DET_SIZE, DET_SIZE);
  cx.drawImage(content, 0, 0, dw, dh, Math.round(dx), Math.round(dy), dw, dh);

  return { tensor: new ort.Tensor("float32", chwFromCanvas(cv), [1, 3, DET_SIZE, DET_SIZE]), r, dx, dy, content };
}

export function decodeDets(outTensor: OrtTensor, r: number, dx: number, dy: number): Detection[] {
  const data = outTensor.data;
  const dims = outTensor.dims;
  const nc = dims[1]! - 4;
  const N = dims[2]!;
  const cand: Detection[] = [];

  for (let i = 0; i < N; i++) {
    let best = -1;
    let bc = 0;
    for (let c = 0; c < nc; c++) {
      const s = at(data, (4 + c) * N + i);
      if (s > bc) { bc = s; best = c; }
    }
    if (bc < DET_CONF) continue;
    const cx = at(data, i);
    const cy = at(data, N + i);
    const w = at(data, 2 * N + i);
    const h = at(data, 3 * N + i);
    cand.push({
      cls: best,
      conf: bc,
      box: [(cx - w / 2 - dx) / r, (cy - h / 2 - dy) / r, (cx + w / 2 - dx) / r, (cy + h / 2 - dy) / r] as Box
    });
  }
  cand.sort((a, b) => b.conf - a.conf);
  const kept: Detection[] = [];
  for (const c of cand) {
    if (kept.length >= 300) break;
    if (kept.every((k) => k.cls !== c.cls || iou(k.box, c.box) <= NMS_IOU)) kept.push(c);
  }
  return kept;
}

export function iou(a: Box, b: Box): number {
  const ix1 = Math.max(a[0], b[0]), iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]), iy2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const aa = (a[2] - a[0]) * (a[3] - a[1]);
  const bb = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (aa + bb - inter);
}

export function selectDetection(dets: Detection[]): Detection | null {
  if (!dets || !dets.length) return null;
  // Non-empty above, so this read is in range.
  const best = dets[0]!;
  const [x1, y1, x2, y2] = best.box;
  const area = Math.max(1, (x2 - x1) * (y2 - y1));
  const surrounding: Detection[] = [];
  for (const candidate of dets) {
    const [a, b, c, d] = candidate.box;
    const overlap = Math.max(0, Math.min(x2, c) - Math.max(x1, a)) * Math.max(0, Math.min(y2, d) - Math.max(y1, b));
    if (overlap / area >= 0.9 && (c - a) * (d - b) >= 2 * area) {
      surrounding.push(candidate);
    }
  }
  if (!surrounding.length) return best;
  // Non-empty above, so the seed and the accumulator are both in range.
  return surrounding.reduce((m, c) => (c.conf > m.conf ? c : m), surrounding[0]!);
}
