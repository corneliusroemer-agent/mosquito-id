import { describe, expect, it } from "vitest";
import { looksBlank } from "../src/app/canvasCache";

const rgba = (n: number, px: [number, number, number, number]) =>
  Uint8ClampedArray.from({ length: 4 * n }, (_, i) => px[i % 4]!);

describe("looksBlank (issue #77: a black thumbnail must not pass)", () => {
  it("flags an all-black frame, with or without alpha", () => {
    expect(looksBlank(rgba(4096, [0, 0, 0, 255]))).toBe(true);
    expect(looksBlank(rgba(4096, [0, 0, 0, 0]))).toBe(true);
  });
  it("flags a flat white or grey frame too", () => {
    expect(looksBlank(rgba(4096, [255, 255, 255, 255]))).toBe(true);
    expect(looksBlank(rgba(4096, [120, 90, 60, 255]))).toBe(true);
  });
  it("accepts a frame with one lit pixel", () => {
    const d = rgba(1000, [0, 0, 0, 255]);
    d[0] = 200; // pixel 0 is always sampled
    expect(looksBlank(d)).toBe(false);
  });
});
