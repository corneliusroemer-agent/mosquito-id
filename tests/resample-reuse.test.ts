import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isUsableIntermediate } from "../src/app/downscale";
import { letterbox } from "../src/app/detector";
import { CLIP_SIZE, DET_SIZE } from "../src/app/modelConfig";

/**
 * The detector's intermediate and the classifier's whole-frame view, over a fake
 * canvas that reproduces the one behaviour of a real one that size assertions
 * cannot see: **assigning `width`/`height` clears it.**
 *
 * The previous resample regression in this app shipped entirely black
 * thumbnails through fourteen passing geometry tests, so these assert on the
 * pixels that come out, not on the sizes asked for. A `letterbox` that builds
 * `content` but never draws the photograph into it - or draws it and then
 * resizes it - blits a blank canvas into the padded input, and the detector
 * then scores a uniform grey frame on every photograph in the batch. That is
 * the same shape of failure, one stage earlier, and it fails the same way:
 * correct dimensions, no error, no test catching it.
 */

/** A canvas whose contents survive a draw and are destroyed by a resize. */
interface Fake {
  width: number;
  height: number;
  /** Non-zero when this canvas holds a drawn image; 0 when blank. */
  ink: number;
  getContext(t?: string): FakeCtx | null;
}

interface FakeCtx {
  drawImage(src: Fake, ...rest: number[]): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
  fillStyle: string;
}

/** What `fillRect` leaves behind, so a padding-only canvas is not mistaken for a drawn one. */
const PAD_INK = 0x72;

/**
 * What a canvas reads back as.
 *
 * A canvas that has been drawn into reads a gradient, so "the tensor is not
 * degenerate" is a real assertion: a uniform fill produces a flat array
 * whatever the canvases were asked for. A canvas holding only the padding fill
 * reads a constant, which is the exact shape of the regression this file exists
 * to catch - a resample that never ran leaves the 0x72 pad, and the detector
 * then scores the same grey frame on every photograph in the batch.
 */
function pixelsFor(w: number, h: number, ink: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  const flat = ink === PAD_INK || ink === 0;
  for (let i = 0; i < w * h; i++) {
    d[4 * i] = flat ? PAD_INK : (i * 7) % 251;
    d[4 * i + 1] = flat ? PAD_INK : (i * 13) % 239;
    d[4 * i + 2] = flat ? PAD_INK : (i * 29) % 223;
    d[4 * i + 3] = 255;
  }
  return d;
}

function makeCanvas(w = 0, h = 0): Fake {
  let width = w;
  let height = h;
  let ink = 0;
  const c = {
    get width() { return width; },
    set width(v: number) { width = v; ink = 0; },
    get height() { return height; },
    set height(v: number) { height = v; ink = 0; },
    get ink() { return ink; },
    set ink(v: number) { ink = v; },
    getContext(): FakeCtx | null {
      return {
        drawImage(src: Fake) { c.ink = src.ink; },
        fillRect() { c.ink = PAD_INK; },
        getImageData(_x: number, _y: number, w: number, h: number) {
          return { data: pixelsFor(w, h, c.ink) };
        },
        fillStyle: "",
      };
    },
  } as unknown as Fake;
  return c;
}

/** A source canvas holding `ink` - any non-zero number stands in for "a photo". */
function photo(w: number, h: number, ink = 1): Fake {
  const c = makeCanvas(w, h);
  c.ink = ink;
  return c;
}

const made: Fake[] = [];
const realDocument = globalThis.document;
const realOrt = globalThis.ort;

/** Every tensor built during one test, with the data it was built from. */
const tensors: { data: Float32Array }[] = [];

beforeEach(() => {
  made.length = 0;
  tensors.length = 0;
  globalThis.document = {
    createElement() {
      const c = makeCanvas();
      made.push(c);
      return c;
    },
  } as unknown as Document;
  globalThis.ort = {
    Tensor: class {
      constructor(_type: string, data: Float32Array, _dims: readonly number[]) {
        tensors.push({ data });
      }
    },
  } as never;
});

afterEach(() => {
  globalThis.document = realDocument;
  globalThis.ort = realOrt;
});

/** The variance of a tensor's channels - zero exactly when the frame was flat. */
function spread(data: Float32Array): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i]! < lo) lo = data[i]!;
    if (data[i]! > hi) hi = data[i]!;
  }
  return hi - lo;
}

describe("letterbox", () => {
  it("puts the photograph's pixels in the tensor, not a uniform fill", () => {
    // 8160x6144 is a real 50 MP frame from the corpus.
    letterbox(photo(8160, 6144, 7) as never);
    expect(tensors).toHaveLength(1);
    const { data } = tensors[0]!;
    expect(data.length).toBe(3 * DET_SIZE * DET_SIZE);
    expect(spread(data)).toBeGreaterThan(0);
  });

  it("hands back a content canvas that actually holds the photograph", () => {
    // The regression this guards: `content` allocated and sized, never drawn
    // into. The blit then copies a blank canvas and the padded input is the
    // 0x72 pad everywhere.
    const lb = letterbox(photo(4000, 3000, 42) as never);
    expect(lb.content.width).toBe(640);
    expect(lb.content.height).toBe(480);
    expect(lb.content.ink).toBe(42);
  });

  it("keeps the letterbox's own geometry - scale and padding - unchanged", () => {
    const lb = letterbox(photo(8160, 6144, 1) as never);
    expect(lb.r).toBeCloseTo(DET_SIZE / 8160, 12);
    expect(lb.dx).toBeCloseTo(0, 12);
    expect(lb.dy).toBeCloseTo((DET_SIZE - 482) / 2, 12);
  });

  it("keeps the content canvas at the aspect ratio it will be asked about", () => {
    const lb = letterbox(photo(6144, 8160, 1) as never);
    expect(lb.content.width).toBe(482);
    expect(lb.content.height).toBe(640);
    expect(isUsableIntermediate(lb.content, photo(6144, 8160), CLIP_SIZE)).toBe(true);
  });
});

describe("isUsableIntermediate", () => {
  it("accepts the detector's content canvas for a normal photograph", () => {
    // A 4:3 photo: content 640x480, short edge 480 >= 224.
    expect(isUsableIntermediate({ width: 640, height: 480 }, { width: 8160, height: 6144 }, CLIP_SIZE)).toBe(true);
  });

  it("refuses a panorama whose short edge would have to be enlarged", () => {
    // An 8:1 frame lands with a 78 px short edge at 640. Scaling that to 224
    // is a 2.9x enlargement, so the photograph is read instead.
    expect(isUsableIntermediate({ width: 640, height: 78 }, { width: 8000, height: 1000 }, CLIP_SIZE)).toBe(false);
  });

  it("refuses a different aspect ratio rather than stretch the embedding", () => {
    expect(isUsableIntermediate({ width: 640, height: 480 }, { width: 480, height: 640 }, CLIP_SIZE)).toBe(false);
  });

  it("tolerates the rounding that two independent roundings leave behind", () => {
    // 482/640 vs 6144/8160 differ by one part in ~10^4 from whole-pixel rounding.
    expect(isUsableIntermediate({ width: 640, height: 482 }, { width: 8160, height: 6144 }, CLIP_SIZE)).toBe(true);
  });

  it("refuses nothing usable: absent, empty or zero-sized is a refusal", () => {
    const full = { width: 8160, height: 6144 };
    expect(isUsableIntermediate(null, full, CLIP_SIZE)).toBe(false);
    expect(isUsableIntermediate(undefined, full, CLIP_SIZE)).toBe(false);
    expect(isUsableIntermediate({ width: 0, height: 0 }, full, CLIP_SIZE)).toBe(false);
    expect(isUsableIntermediate({ width: 640, height: 480 }, { width: 0, height: 0 }, CLIP_SIZE)).toBe(false);
  });
});