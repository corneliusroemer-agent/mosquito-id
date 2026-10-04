// Fetching the model: one copy of the bytes, a populated cache, an honest bar.
//
// `fetchWithProgress` used to accumulate the stream into `chunks[]`, allocate a
// contiguous `Uint8Array` to join them, and then hand `cache.put` a
// `buf.slice(0)` - the full 1.26 GB three times over at the moment the cache
// write started, and once retained per live tab after it. Measured on a cache
// miss, peak was 3x the file; at rest, 1x per tab, held by a session that was
// only there because the boot path asked for it.
//
// The fix keeps the bytes in one buffer and gives the cache a stream of views
// onto it. What must not move: the cache still gets populated (it is what makes
// the second tab free) and progress is still reported per chunk against
// Content-Length (it is what the bar reads).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fetchWithProgress, fetchWithCache } from "../src/app/modelFetch";

/** Anything at or above this is a whole-model allocation, not a stream chunk. */
const LARGE = 512 * 1024;
const CHUNK = 64 * 1024;
const SIZE = 4 * 1024 * 1024;

/**
 * Counts Uint8Array allocations of at least `LARGE` bytes, which is the shape of
 * the waste: the download should allocate the buffer once, and every chunk it
 * reads is orders of magnitude below the threshold.
 *
 * A Proxy rather than a subclass, so the values handed out are still genuine
 * Uint8Arrays and everything downstream (`Response`, `Buffer`, instanceof) is
 * unaffected - and only allocations this module's own source makes go through
 * the global, since the intrinsics a runtime uses internally never do.
 */
function countLargeAllocations() {
  const real = Uint8Array;
  const state = { count: 0, on: false };
  globalThis.Uint8Array = new Proxy(real, {
    construct(target, args: unknown[]) {
      const length = Number(args[0]);
      if (state.on && Number.isFinite(length) && length >= LARGE) state.count++;
      return Reflect.construct(target, args) as object;
    },
  }) as unknown as Uint8ArrayConstructor;
  return state;
}

/**
 * Counts whole-payload `ArrayBuffer.prototype.slice` calls.
 *
 * The copy this test exists to catch is invisible to the Uint8Array proxy: it
 * is `buf.slice(0)` on an ArrayBuffer, so it goes through an intrinsic that
 * never consults the global constructor. Counting the prototype call is how the
 * test sees it - and a copy of the model is a copy of the model whatever
 * intrinsics issued it.
 */
function countLargeCopies() {
  const real = ArrayBuffer.prototype.slice;
  const state = { count: 0, bytes: 0, on: false };
  ArrayBuffer.prototype.slice = function patched(this: ArrayBuffer) {
    const out = real.apply(this, arguments as unknown as [number?, number?]) as ArrayBuffer;
    if (state.on && out.byteLength >= LARGE) {
      state.count++;
      state.bytes += out.byteLength;
    }
    return out;
  } as typeof real;
  return state;
}

/** A response of `size` bytes arriving in CHUNK-sized pieces, with or without Content-Length. */
function streamedResponse(size: number, withLength: boolean) {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
      const left = size - sent;
      if (left <= 0) {
        controller.close();
        return;
      }
      const n = Math.min(CHUNK, left);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(7));
    },
  });
  var sent = 0;
  const headers = new Headers({ "content-type": "application/octet-stream" });
  if (withLength) headers.set("content-length", String(size));
  return { ok: true, status: 200, headers, body };
}

const realFetch = globalThis.fetch;
const realCaches = (globalThis as Record<string, unknown>).caches;
const realWindow = (globalThis as Record<string, unknown>).window;
const realU8 = globalThis.Uint8Array;
const realSlice = ArrayBuffer.prototype.slice;

describe("fetchWithProgress", () => {
  let alloc: ReturnType<typeof countLargeAllocations>;
  let copies: ReturnType<typeof countLargeCopies>;

  beforeEach(() => {
    alloc = countLargeAllocations();
    copies = countLargeCopies();
  });
  afterEach(() => {
    globalThis.Uint8Array = realU8;
    ArrayBuffer.prototype.slice = realSlice;
    globalThis.fetch = realFetch;
  });

  it("reports progress against Content-Length and completes at 100%", async () => {
    globalThis.fetch = async () => streamedResponse(SIZE, true) as unknown as Response;
    const samples: Array<[number, number, boolean | undefined]> = [];
    const buf = await fetchWithProgress("model.onnx", (got, total, done) => samples.push([got, total, done]));

    expect(buf.byteLength).toBe(SIZE);
    expect(samples.length).toBeGreaterThan(1);
    for (const [got, total] of samples.slice(0, -1)) {
      expect(total).toBe(SIZE);           // the bar's denominator, from the header
      expect(got % CHUNK).toBe(0);        // one sample per streamed chunk
    }
    // One sample per chunk, monotonic, and the last chunk's sample is the same
    // figure the closing sample carries - which is what makes the bar read 100%
    // rather than stopping a bar's width short.
    expect(samples.map((s) => s[0])).toEqual([...samples.map((s) => s[0])].sort((a, b) => a - b));
    expect(samples.filter(([got]) => got === SIZE)).toHaveLength(2);
    expect(samples.at(-1)).toEqual([SIZE, SIZE, true]);
  });

  it("allocates the payload once and never copies it", async () => {
    globalThis.fetch = async () => streamedResponse(SIZE, true) as unknown as Response;
    alloc.on = true;
    copies.on = true;
    const buf = await fetchWithProgress("model.onnx");
    alloc.on = false;
    copies.on = false;

    expect(buf.byteLength).toBe(SIZE);
    // One whole-model allocation: the buffer the chunks are read into, sized
    // from Content-Length. A second one is a second copy of the model.
    expect(alloc.count).toBe(1);
    // The old path assembled `out` and then copied it again, which is the 3x
    // peak the tab-memory measurement charged to this function.
    expect(copies.count).toBe(0);
    expect(copies.bytes).toBe(0);
  });

  it("still assembles a response that arrives without Content-Length", async () => {
    globalThis.fetch = async () => streamedResponse(SIZE + 12345, false) as unknown as Response;
    const samples: Array<[number, number, boolean | undefined]> = [];
    const buf = await fetchWithProgress("model.onnx", (got, total, done) => samples.push([got, total, done]));

    expect(buf.byteLength).toBe(SIZE + 12345);
    expect(new Uint8Array(buf).every((b) => b === 7)).toBe(true);
    // No denominator to report, so the final sample supplies one.
    expect(samples.at(-1)).toEqual([SIZE + 12345, SIZE + 12345, true]);
  });
});

describe("fetchWithCache", () => {
  let stored: ArrayBuffer | undefined;
  let storedHeaders: Headers | undefined;
  let puts: number;
  let putKeys: string[];
  let alloc: ReturnType<typeof countLargeAllocations>;
  let copies: ReturnType<typeof countLargeCopies>;

  beforeEach(() => {
    copies = countLargeCopies();
    stored = undefined;
    storedHeaders = undefined;
    puts = 0;
    putKeys = [];
    alloc = countLargeAllocations();
    // `fetchWithCache` gates on `"caches" in window`, and the browser's window
    // IS the global object - a stub window of its own would report the feature
    // absent and quietly take the no-cache path.
    (globalThis as Record<string, unknown>).window = globalThis;
    (globalThis as Record<string, unknown>).caches = {
      open: async () => ({
        match: async () => undefined,   // a miss: the network path
        put: async (req: RequestInfo | URL, res: Response) => {
          puts++;
          putKeys.push(String(req));
          storedHeaders = res.headers;
          stored = await res.arrayBuffer();
        },
        // The prune after the put runs against a real Cache, so the stub has to
        // answer `keys()`. It reports only what this run stored, which is the
        // common case: one entry, already the current build's, so nothing is
        // deleted.
        keys: async () =>
          putKeys.length ? [new Request(new URL(putKeys[putKeys.length - 1]!, "https://app.test/"))] : [],
        delete: async () => true,
      }),
    };
  });
  afterEach(() => {
    globalThis.Uint8Array = realU8;
    globalThis.fetch = realFetch;
    (globalThis as Record<string, unknown>).caches = realCaches;
    (globalThis as Record<string, unknown>).window = realWindow;
    ArrayBuffer.prototype.slice = realSlice;
  });

  it("populates CacheStorage on a miss and returns the same bytes", async () => {
    globalThis.fetch = async () => streamedResponse(SIZE, true) as unknown as Response;
    const buf = await fetchWithCache("model.onnx");

    expect(puts).toBe(1);
    expect(stored!.byteLength).toBe(SIZE);
    expect(storedHeaders!.get("content-length")).toBe(String(SIZE));
    expect(new Uint8Array(buf).every((b) => b === 7)).toBe(true);
  });

  it("fills the cache without ever copying the payload", async () => {
    globalThis.fetch = async () => streamedResponse(SIZE, true) as unknown as Response;
    alloc.on = true;
    copies.on = true;
    await fetchWithCache("model.onnx");
    alloc.on = false;
    copies.on = false;

    // The cache write is what made peak 3x: `buf.slice(0)` is a second copy of
    // 1.26 GB that exists only so the cache can have the bytes. A ReadableStream
    // of subarrays is the same bytes - subarray is a view - so the cache is
    // still filled (asserted above) and the copy is gone.
    expect(alloc.count).toBe(1);
    expect(copies.count).toBe(0);
    expect(copies.bytes).toBe(0);
  });

  it("still reports progress on the miss path", async () => {
    globalThis.fetch = async () => streamedResponse(SIZE, true) as unknown as Response;
    const samples: Array<[number, number]> = [];
    await fetchWithCache("model.onnx", (got, total) => samples.push([got, total]));

    expect(samples.length).toBeGreaterThan(1);
    expect(samples.at(-1)).toEqual([SIZE, SIZE]);
  });
});
