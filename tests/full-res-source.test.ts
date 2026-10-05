import { beforeEach, describe, expect, it } from "vitest";

/**
 * The full-resolution source: one photo's full-resolution pixels, re-decoded
 * from its File on demand, decoded at most once and held at most one at a time.
 *
 * The record keeps a display canvas and the File, not the full-resolution frame,
 * because holding the frame for every photo is what made a hundred photos cost
 * ten gigabytes. The two paths that genuinely read full-resolution pixels - a
 * crop release and a re-run - get them back from here, so this module is where
 * "decoding twice" and "decoding ten times at once" would happen.
 */
import {
  FULL_RES_CACHE_FRAMES,
  fullCanvasFor,
  releaseFullCanvas,
  retainedFullCanvasCount,
  retainedFullCanvasFor,
  resetFullCanvasCache,
} from "../src/app/fullResSource";

/** A decode counter standing in for `createImageBitmap`, which node has not. */
function stubDecoder(): { calls: number } {
  const state = { calls: 0 };
  (globalThis as any).createImageBitmap = async (_file: File, _opts?: unknown) => {
    state.calls++;
    await new Promise((r) => setTimeout(r, 5));
    return { width: 4032, height: 3024, close() {} };
  };
  (globalThis as any).document = {
    createElement: () => {
      const cv: any = { width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
      return cv;
    },
  };
  return state;
}

const photo = (name: string, file: File | null = new File(["x"], name)) =>
  ({ name, file, fullW: 4032, fullH: 3024 }) as any;

beforeEach(() => {
  resetFullCanvasCache();
  delete (globalThis as any).createImageBitmap;
});

describe("fullCanvasFor", () => {
  it("decodes a photo's full-resolution frame from its File", async () => {
    const d = stubDecoder();
    const cv = await fullCanvasFor(photo("a.jpg"));
    expect(cv).not.toBeNull();
    expect(d.calls).toBe(1);
    expect(cv!.width).toBe(4032);
    expect(cv!.height).toBe(3024);
  });

  it("decodes once for a burst of callers, not once per caller", async () => {
    const d = stubDecoder();
    const p = photo("a.jpg");
    const all = await Promise.all([
      fullCanvasFor(p), fullCanvasFor(p), fullCanvasFor(p),
      fullCanvasFor(p), fullCanvasFor(p),
    ]);
    expect(d.calls).toBe(1);
    // One decode, one canvas: they must also be the same object, so a caller
    // that mutates what it got back does not strand the others.
    expect(new Set(all).size).toBe(1);
  });

  it("does not decode again for a second call on the same photo", async () => {
    const d = stubDecoder();
    const p = photo("a.jpg");
    await fullCanvasFor(p);
    await fullCanvasFor(p);
    await fullCanvasFor(p);
    expect(d.calls).toBe(1);
  });

  it("holds at most FULL_RES_CACHE_FRAMES however many photos ask", async () => {
    const d = stubDecoder();
    for (const n of ["a.jpg", "b.jpg", "c.jpg"]) await fullCanvasFor(photo(n));
    expect(d.calls).toBe(3);
    // Three decodes, but the bound that matters is retention: without this the
    // cache is just a slower leak. A single slot here would be enough to hold
    // one, so the assertion has to be against the named bound - a bound of one
    // and a bound of two are both `>= 1`.
    expect(retainedFullCanvasCount()).toBe(FULL_RES_CACHE_FRAMES);
  });

  it("rotates: the photo in the slot is not the only one that stays resident", async () => {
    const d = stubDecoder();
    const a = photo("a.jpg");
    const b = photo("b.jpg");
    await fullCanvasFor(a);
    await fullCanvasFor(b);
    // Both are held, which a write-once single slot could never do: a.jpg
    // decoded first would own it forever and every other photo re-decoded on
    // every call.
    expect(retainedFullCanvasFor(a)).not.toBeNull();
    expect(retainedFullCanvasFor(b)).not.toBeNull();
    expect(d.calls).toBe(2);
    // Neither decodes again while both are resident.
    await fullCanvasFor(a);
    await fullCanvasFor(b);
    expect(d.calls).toBe(2);
  });

  it("does not re-decode on a revisit when two photos alternate", async () => {
    // The alternating pattern is the one that exposes a single-slot cache: A is
    // in the slot forever, so every B re-decodes. With two slots, A -> B -> A
    // -> B costs two decodes however many times it runs.
    const d = stubDecoder();
    const a = photo("a.jpg");
    const b = photo("b.jpg");
    for (let i = 0; i < 4; i++) {
      await fullCanvasFor(a);
      await fullCanvasFor(b);
    }
    expect(d.calls).toBe(2);
    expect(retainedFullCanvasCount()).toBe(FULL_RES_CACHE_FRAMES);
  });

  it("evicts the least recently used frame past the bound", async () => {
    const d = stubDecoder();
    const a = photo("a.jpg");
    const b = photo("b.jpg");
    const c = photo("c.jpg");
    await fullCanvasFor(a);
    await fullCanvasFor(b);
    // Touch A, so B is the least recently used when C arrives.
    await fullCanvasFor(a);
    await fullCanvasFor(c);
    expect(retainedFullCanvasCount()).toBe(FULL_RES_CACHE_FRAMES);
    expect(retainedFullCanvasFor(b)).toBeNull();
    // A survived the eviction, because it was the more recent of the two.
    expect(retainedFullCanvasFor(a)).not.toBeNull();
    // And B is decoded again rather than answered from a dropped frame.
    const before = d.calls;
    await fullCanvasFor(b);
    expect(d.calls).toBe(before + 1);
  });

  it("releases one photo's frame out of a full cache, dropping only that one", async () => {
    stubDecoder();
    const a = photo("a.jpg");
    const b = photo("b.jpg");
    await fullCanvasFor(a);
    await fullCanvasFor(b);
    releaseFullCanvas(a);
    expect(retainedFullCanvasCount()).toBe(1);
    expect(retainedFullCanvasFor(a)).toBeNull();
    expect(retainedFullCanvasFor(b)).not.toBeNull();
  });

  it("gives a photo with no File its retained source canvas, decoding nothing", async () => {
    const d = stubDecoder();
    const kept = { width: 800, height: 600 } as unknown as HTMLCanvasElement;
    const p = { name: "zip.jpg", file: null, sourceCanvas: kept, fullW: 800, fullH: 600 } as any;
    const cv = await fullCanvasFor(p);
    expect(cv).toBe(kept);
    expect(d.calls).toBe(0);
  });

  it("returns null for a photo with neither a File nor retained pixels", async () => {
    const d = stubDecoder();
    expect(await fullCanvasFor({ name: "gone.jpg", file: null } as any)).toBeNull();
    expect(d.calls).toBe(0);
  });

  it("drops the cached frame for a deleted photo", async () => {
    stubDecoder();
    const p = photo("a.jpg");
    await fullCanvasFor(p);
    expect(retainedFullCanvasCount()).toBe(1);
    releaseFullCanvas(p);
    expect(retainedFullCanvasCount()).toBe(0);
  });

  it("re-decodes after the photo's frame was released", async () => {
    const d = stubDecoder();
    const p = photo("a.jpg");
    await fullCanvasFor(p);
    releaseFullCanvas(p);
    await fullCanvasFor(p);
    expect(d.calls).toBe(2);
  });

  it("returns null rather than throwing when the decode fails", async () => {
    (globalThis as any).createImageBitmap = async () => {
      throw new Error("decode blew up");
    };
    expect(await fullCanvasFor(photo("bad.jpg"))).toBeNull();
    // A failed decode must not poison the cache: the next attempt tries again.
    expect(retainedFullCanvasCount()).toBe(0);
  });
});
