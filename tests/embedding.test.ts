// Which output of the model is the embedding, and what is normalised.
//
// Two shipped bugs of this project are pinned here, both invisible at the call
// site because neither threw:
//
//   - 91029e3 read the model's outputs POSITIONALLY. culico's graph declares
//     `1747` and `culico_embedding`; `Object.keys()` sorts the integer-like key
//     first regardless of declaration order, so the 18-element probe logits were
//     handed to a softmax whose rows are 1153 wide. Every product past index 17
//     became NaN, and verdictFrom's non-finite guard returned "not confident"
//     for every photo.
//   - L2-normalising the WHOLE vector divided the probe's appended constant
//     `1.0` by the feature norm, shrinking it ~40x and throwing away most of
//     the bias.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { pickEmbedding, l2NormaliseFeatures, embedCanvas, type ClassifierSession } from "../src/app/embedding";
import { CLIP_SIZE } from "../src/app/modelConfig";
import type { OrtTensor } from "../src/app/types";
import type { Head as ConfidenceHead } from "../src/confidence/types";

const tensor = (data: Float32Array, dims: number[]): OrtTensor => ({ data, dims });

/** A head whose dim is 8, so the fixtures below are short enough to read. */
const head = (dim: number): ConfidenceHead => ({
  species: ["Aedes aegypti", "Culex pipiens"],
  dim,
  logit_scale: 100,
});

describe("pickEmbedding", () => {
  it("picks by WIDTH, not position, when keys sort ahead of the real one", () => {
    // Object.keys() puts the integer-like key first. This is the shape that made
    // every culico photo read "unsure".
    const wide = tensor(new Float32Array(8).fill(0.5), [1, 8]);
    const logits = tensor(new Float32Array(2).fill(99), [1, 2]);
    const res = { 1747: logits, culico_embedding: wide };
    expect(Object.keys(res)[0]).toBe("1747"); // the trap, stated
    expect(pickEmbedding(res, 8)).toBe(wide);
  });

  it("picks the wide output even when the narrow one is declared first", () => {
    const logits = tensor(new Float32Array(2).fill(1), [1, 2]);
    const wide = tensor(new Float32Array(8).fill(0), [1, 8]);
    expect(pickEmbedding({ output_0: logits, features: wide }, 8)).toBe(wide);
  });

  it("falls back to the NAME when no output is the head's width", () => {
    // Better than nothing: a graph whose embedding is not head.dim still works,
    // as long as it says what it is.
    const named = tensor(new Float32Array(8).fill(0), [1, 8]);
    expect(pickEmbedding({ text_embedding: named }, 1153)).toBe(named);
  });

  it("prefers width over name", () => {
    const wrongWidthButNamed = tensor(new Float32Array(4).fill(0), [1, 4]);
    const rightWidth = tensor(new Float32Array(8).fill(0), [1, 8]);
    const res = { embedding_output: wrongWidthButNamed, other: rightWidth };
    expect(pickEmbedding(res, 8)).toBe(rightWidth);
  });

  it("throws when no output is the embedding", () => {
    // The failure this prevents silently is NaN per species, which the verdict
    // reports as "not confident" rather than as an error.
    const logits = tensor(new Float32Array(2).fill(1), [1, 2]);
    expect(() => pickEmbedding({ 1747: logits }, 1153)).toThrow(/No embedding among/);
  });

  it("says what it looked at when it throws", () => {
    const logits = tensor(new Float32Array(2).fill(1), [1, 2]);
    expect(() => pickEmbedding({ 1747: logits }, 1153)).toThrow(/1747/);
  });

  it("skips a non-tensor output rather than dereferencing it", () => {
    const wide = tensor(new Float32Array(8).fill(0), [1, 8]);
    expect(pickEmbedding({ meta: { note: "not a tensor" }, features: wide }, 8)).toBe(wide);
  });

  it("uses the name alone when no head is loaded", () => {
    const named = tensor(new Float32Array(8).fill(0), [1, 8]);
    expect(pickEmbedding({ culico_embedding: named }, null)).toBe(named);
  });
});

describe("l2NormaliseFeatures", () => {
  it("normalises to unit length over the FEATURE coordinates", () => {
    const e = Float32Array.from([3, 4, 1]); // norm 5 over the first two
    l2NormaliseFeatures(e, 2);
    expect(e[0]).toBeCloseTo(0.6, 6);
    expect(e[1]).toBeCloseTo(0.8, 6);
  });

  it("LEAVES the appended bias coordinate alone", () => {
    // The last coordinate is a constant 1.0 carrying the probe's intercept.
    // Dividing it by the feature norm shrinks it by that factor (~40x here) and
    // throws away most of the bias.
    const e = Float32Array.from([3, 4, 1]);
    l2NormaliseFeatures(e, 2);
    expect(e[2]).toBe(1);
  });

  it("leaves a zero vector alone rather than dividing by zero", () => {
    const e = Float32Array.from([0, 0, 1]);
    l2NormaliseFeatures(e, 2);
    expect(Array.from(e)).toEqual([0, 0, 1]);
  });

  it("stops at the vector's own length when asked for more", () => {
    const e = Float32Array.from([3, 4]);
    l2NormaliseFeatures(e, 8);
    expect(e[0]).toBeCloseTo(0.6, 6);
    expect(e[1]).toBeCloseTo(0.8, 6);
  });

  it("normalises to unit length when the whole vector is features", () => {
    const e = Float32Array.from([3, 4]);
    l2NormaliseFeatures(e, 2);
    expect(Math.hypot(e[0]!, e[1]!)).toBeCloseTo(1, 6);
  });
});

describe("embedCanvas", () => {
  // clipTensor is the one part that needs a real DOM: it draws into two
  // canvases and reads the pixels back. Everything else here is the wiring -
  // which feed name, which output, which normaliser - so `document` is stubbed
  // rather than the function reshaped to take an allocator. jsdom is not a
  // dependency of this project; the e2e tier covers the real canvas path.
  const RGBA = [255, 128, 64, 255];

  beforeAll(() => {
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({
          drawImage: () => {},
          getImageData: () => ({ data: Uint8ClampedArray.from(RGBA) }),
        }),
      }),
    });
  });
  afterAll(() => vi.unstubAllGlobals());

  const stubCanvas = (w = 10, h = 10) => ({ width: w, height: h }) as HTMLCanvasElement;

  const sessionReturning = (res: Record<string, unknown>): ClassifierSession => ({
    inputNames: ["pixel_values"],
    run: async () => res,
  });

  it("feeds the session under its FIRST input name", async () => {
    let fed: Record<string, unknown> | null = null;
    const session: ClassifierSession = {
      inputNames: ["pixel_values", "unused_second"],
      run: async (f) => { fed = f; return { image_embedding: tensor(new Float32Array(4).fill(1), [1, 4]) }; },
    };
    await embedCanvas(stubCanvas(), session, null, () => "TENSOR");
    expect(Object.keys(fed!)).toEqual(["pixel_values"]);
  });

  it("throws rather than feeding a session with no input name", async () => {
    const session: ClassifierSession = { inputNames: [], run: async () => ({}) };
    await expect(embedCanvas(stubCanvas(), session, null, () => "T")).rejects.toThrow(/no input name/);
  });

  it("builds a [1, 3, CLIP_SIZE, CLIP_SIZE] tensor from the canvas", async () => {
    let dims: readonly number[] | null = null;
    let data: Float32Array | null = null;
    const session = sessionReturning({ image_embedding: tensor(new Float32Array(4).fill(1), [1, 4]) });
    await embedCanvas(stubCanvas(), session, null, (d, dm) => {
      data = d; dims = dm; return "TENSOR";
    });
    expect(dims).toEqual([1, 3, CLIP_SIZE, CLIP_SIZE]);
    expect(data!.length).toBe(3 * CLIP_SIZE * CLIP_SIZE);
  });

  it("normalises to the head's dim when a head is loaded", async () => {
    const e = Float32Array.from([3, 4, 1, 1]);
    const session = sessionReturning({ image_embedding: tensor(e, [1, 4]) });
    const out = await embedCanvas(stubCanvas(), session, head(2), () => "T");
    expect(Math.hypot(out[0]!, out[1]!)).toBeCloseTo(1, 5);
    expect(out[2]).toBe(1); // the bias coordinate survives
  });

  it("normalises the whole vector when no head is loaded", async () => {
    const e = Float32Array.from([3, 4, 0, 0]);
    const session = sessionReturning({ image_embedding: tensor(e, [1, 4]) });
    const out = await embedCanvas(stubCanvas(), session, null, () => "T");
    expect(Math.hypot(out[0]!, out[1]!, out[2]!, out[3]!)).toBeCloseTo(1, 5);
  });

  it("propagates a missing embedding as a throw, not as a NaN posterior", async () => {
    const session = sessionReturning({ 1747: tensor(new Float32Array(2).fill(1), [1, 2]) });
    await expect(embedCanvas(stubCanvas(), session, head(1153), () => "T"))
      .rejects.toThrow(/No embedding among/);
  });
});
