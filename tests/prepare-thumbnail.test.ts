/**
 * `prepareThumbnail` is the native-resize path the tiles use, and its whole
 * point is the blank guard: a decoder that fails to fill a resized bitmap hands
 * back a flat frame, and the tile then shows a flat square.
 *
 * `tests/thumbnail-blank.test.ts` covers `looksBlank` as a pure function, which
 * pins the arithmetic but not the call site - deleting the `looksBlank(...)`
 * return from `prepareThumbnail` leaves that file green, because nothing there
 * ever calls `prepareThumbnail`. These tests drive the function itself against
 * stub DOM globals, so removing the guard, or the `close()`, fails here.
 *
 * The observable is the canvas `prepareThumbnail` draws into and encodes: for a
 * flat frame it must never be encoded, for a real one it must be. That is the
 * guard, read straight off the code path. Each stub canvas's encode is recorded
 * globally with its own id, so which canvas produced a URL is also answerable -
 * which is what makes a `thumbnailUrl` cache hit distinguishable from its
 * fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let nextCanvasId = 0;
/** Every encode any stub canvas has performed, in order: `{ id, url }`. */
let encodes: { id: number; url: string }[] = [];

/** A canvas stub; `flat` reports one colour per pixel, else a gradient. */
function fakeCanvas(w: number, h: number, flat: boolean) {
  const id = nextCanvasId++;
  const data = Uint8ClampedArray.from({ length: 4 * w * h }, (_, i) => {
    const p = i % 4;
    // Alpha is constant either way; `looksBlank` compares colour only.
    if (p === 3) return 255;
    return flat ? 0 : (i / 4) % 251;
  });
  return {
    id,
    width: w,
    height: h,
    toDataURL: vi.fn((type?: string) => {
      const url = `data:${type ?? "image/png"};base64,canvas-${id}`;
      encodes.push({ id, url });
      return url;
    }),
    getContext: vi.fn(() => ({
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data })),
    })),
  };
}

type Fake = ReturnType<typeof fakeCanvas>;

describe("prepareThumbnail", () => {
  let src: Fake;
  /** Canvases the stub document hands out from now on. */
  let created: Fake[];
  let resizeW: number;
  let resizeH: number;
  let bmpClose: ReturnType<typeof vi.fn>;

  /** Install a document whose canvases are flat or not, per `flat`. */
  function stubDom(flat: boolean) {
    created = [];
    vi.stubGlobal("document", {
      createElement: vi.fn(() => {
        const c = fakeCanvas(192, 192, flat);
        created.push(c);
        return c;
      }),
    });
  }

  beforeEach(() => {
    // 4000x3000, so `prepareThumbnail` takes its resize path rather than
    // returning early on an already-thumbnail-sized canvas.
    src = fakeCanvas(4000, 3000, false);
    encodes = [];
    resizeW = 0;
    resizeH = 0;
    bmpClose = vi.fn();
    stubDom(false);
    vi.stubGlobal("createImageBitmap", vi.fn(
      async (_src: unknown, opts?: { resizeWidth?: number; resizeHeight?: number }) => {
        resizeW = opts?.resizeWidth ?? 0;
        resizeH = opts?.resizeHeight ?? 0;
        return { width: resizeW, height: resizeH, close: bmpClose };
      },
    ));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never encodes a flat frame", async () => {
    const { prepareThumbnail } = await import("../src/app/canvasCache");
    // The bitmap the decoder hands back is black: the failure this guards.
    stubDom(true);

    await prepareThumbnail(src as unknown as HTMLCanvasElement, 0.8);

    // It drew into a canvas, saw it was flat, and returned before encoding it.
    expect(created).toHaveLength(1);
    expect(created[0]!.toDataURL).not.toHaveBeenCalled();
    expect(encodes).toEqual([]);
    expect(bmpClose).toHaveBeenCalledTimes(1);
  });

  it("encodes a real frame, and thumbnailUrl then serves it without re-encoding", async () => {
    const { prepareThumbnail, thumbnailUrl } = await import("../src/app/canvasCache");

    await prepareThumbnail(src as unknown as HTMLCanvasElement, 0.8);

    // The resized bitmap was drawn and encoded - once - then released.
    expect(created).toHaveLength(1);
    expect(created[0]!.toDataURL).toHaveBeenCalledTimes(1);
    expect(encodes).toHaveLength(1);
    expect(bmpClose).toHaveBeenCalledTimes(1);

    // The memo now holds it, so the caller gets that encode and no work is done.
    const url = thumbnailUrl(src as unknown as HTMLCanvasElement, 0.8);
    expect(url).toBe(encodes[0]!.url);
    expect(encodes).toHaveLength(1);
    expect(src.toDataURL).not.toHaveBeenCalled();
  });

  it("leaves the caller to encode for itself when the frame was rejected", async () => {
    const { prepareThumbnail, thumbnailUrl } = await import("../src/app/canvasCache");
    stubDom(true);
    await prepareThumbnail(src as unknown as HTMLCanvasElement, 0.8);
    expect(encodes).toEqual([]);

    const url = thumbnailUrl(src as unknown as HTMLCanvasElement, 0.8);

    // The rejected bitmap's canvas is not what the caller ends up with.
    expect(url).toBeTruthy();
    expect(url).not.toBe(`data:image/jpeg;base64,canvas-${created[0]!.id}`);
    // And the fallback encodes the source canvas through its own path.
    expect(encodes.length).toBeGreaterThan(0);
  });

  it("closes the bitmap even when the frame is rejected", async () => {
    const { prepareThumbnail } = await import("../src/app/canvasCache");
    stubDom(true);

    await prepareThumbnail(src as unknown as HTMLCanvasElement, 0.8);

    expect(bmpClose).toHaveBeenCalledTimes(1);
  });

  it("closes the bitmap when the encode path gives up on a missing 2d context", async () => {
    const { prepareThumbnail } = await import("../src/app/canvasCache");
    // No 2d context: `prepareThumbnail` gives up before drawing or encoding.
    vi.stubGlobal("document", { createElement: vi.fn(() => ({ width: 1, height: 1, getContext: () => null })) });

    await prepareThumbnail(src as unknown as HTMLCanvasElement, 0.8);

    expect(bmpClose).toHaveBeenCalledTimes(1);
    expect(encodes).toEqual([]);
  });

  it("resizes to the thumbnail size, decoding from the File when it has one", async () => {
    const { prepareThumbnail, thumbnailSize } = await import("../src/app/canvasCache");
    const want = thumbnailSize(src.width, src.height);

    await prepareThumbnail(src as unknown as HTMLCanvasElement, 0.8, new Blob(["x"]));

    expect(resizeW).toBe(want.w);
    expect(resizeH).toBe(want.h);
    expect(want.w).toBeLessThan(src.width);
  });

  it("falls back quietly when the decoder throws", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => {
      throw new Error("decoder gave up");
    }));
    const { prepareThumbnail, thumbnailUrl } = await import("../src/app/canvasCache");

    await expect(prepareThumbnail(src as unknown as HTMLCanvasElement, 0.8)).resolves.toBeUndefined();

    // No bitmap arrived, so nothing was encoded from one; the caller is no
    // worse off than before.
    expect(encodes).toEqual([]);
    expect(thumbnailUrl(src as unknown as HTMLCanvasElement, 0.8)).toBeTruthy();
  });

  it("is a no-op for a canvas that is already thumbnail-sized", async () => {
    const { prepareThumbnail, thumbnailSize } = await import("../src/app/canvasCache");
    const small = thumbnailSize(src.width, src.height);
    const already = fakeCanvas(small.w, small.h, false);

    await prepareThumbnail(already as unknown as HTMLCanvasElement, 0.8);

    expect(resizeW).toBe(0);
    expect(bmpClose).not.toHaveBeenCalled();
  });

  it("leaves an already-memoised quality alone", async () => {
    const { prepareThumbnail, thumbnailUrl } = await import("../src/app/canvasCache");
    const first = thumbnailUrl(src as unknown as HTMLCanvasElement, 0.8);
    const encodesAfterFirst = encodes.length;

    await prepareThumbnail(src as unknown as HTMLCanvasElement, 0.8);

    // The cached encode stands, and no bitmap was decoded to replace it.
    expect(bmpClose).not.toHaveBeenCalled();
    expect(encodes).toHaveLength(encodesAfterFirst);
    expect(thumbnailUrl(src as unknown as HTMLCanvasElement, 0.8)).toBe(first);
  });
});