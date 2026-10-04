/**
 * Fetching a model file, with the CacheStorage layer in front of it.
 *
 * Nothing here knows what a model is or which one is being fetched - it is a
 * streaming fetch that reports progress and a cache lookup in front of it. The
 * classifier is 1.26 GB, so the cache is not an optimisation here, it is what
 * makes a second visit usable at all.
 */

import { CACHE_NAME } from "./modelConfig";
import type { LogFn } from "./telemetry";

/** Reports bytes received so far, the total when the server sent one, and completion. */
export type OnBytes = (got: number, total: number, done?: boolean) => void;

/** The growth step for a response that arrived without a Content-Length. */
const FIRST_CHUNK = 1 << 16;

/**
 * The bytes as a stream, without copying them.
 *
 * `cache.put` needs a Response it can read to the end, and handing it the
 * ArrayBuffer means copying the whole model a second time - which for a 1.2 GB
 * download is a 1.2 GB allocation that exists only so the cache can have it.
 * A ReadableStream of subarrays is the same bytes: `subarray` is a view onto
 * the original buffer, so the cache consumes the buffer we already have and the
 * peak stays at one copy of the file.
 */
function bytesAsStream(buf: ArrayBuffer): ReadableStream<Uint8Array> {
  const view = new Uint8Array(buf);
  const step = 1 << 20;
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= view.length) {
        controller.close();
        return;
      }
      controller.enqueue(view.subarray(offset, Math.min(offset + step, view.length)));
      offset += step;
    },
  });
}

export async function fetchWithProgress(url: string, onBytes?: OnBytes): Promise<ArrayBuffer> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  const total = Number(resp.headers.get("content-length")) || 0;
  if (!resp.body) throw new Error(`${url}: response has no body`);
  const reader = resp.body.getReader();

  // One buffer for the whole response, grown as needed. The R2 bucket exposes
  // Content-Length (the progress bar already depends on it), so the download
  // arrives into a buffer allocated once at the right size and every chunk is a
  // transient. The doubling path is for a response without one: it copies once,
  // on growth, and the slack is trimmed on the way out.
  let out = total > 0 ? new Uint8Array(total) : new Uint8Array(FIRST_CHUNK);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > out.length) {
      let len = Math.max(out.length, FIRST_CHUNK);
      while (len < got + value.length) len *= 2;
      const grown = new Uint8Array(len);
      grown.set(out.subarray(0, got));
      out = grown;
    }
    out.set(value, got);
    got += value.length;
    onBytes?.(got, total);
  }
  onBytes?.(got, total || got, true);   // final sample: the bar reaches 100%
  return got === out.length ? out.buffer : out.slice(0, got).buffer;
}

/**
 * Fetch a model file, from CacheStorage if it is already there.
 *
 * The cache is what makes a second visit bearable: the classifier is 1.26 GB,
 * and re-downloading it on every load would make the app unusable after the
 * first. A CacheStorage failure of any kind - a private-mode browser with no
 * caches, a quota error, a corrupted entry - falls through to the network
 * rather than failing the load, so the worst case is a slow first run.
 */
export async function fetchWithCache(url: string, onBytes?: OnBytes, log?: LogFn): Promise<ArrayBuffer> {
  if ("caches" in window) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url);
      if (cached) {
        console.log(`[CacheStorage] HIT for ${url}`);
        log?.("cache_hit", { url });
        const size = Number(cached.headers.get("content-length")) || 0;
        onBytes?.(size || 1, size || 1, true);
        return await cached.arrayBuffer();
      }
      console.log(`[CacheStorage] MISS for ${url}, fetching from network...`);
      log?.("cache_miss", { url });
      const buf = await fetchWithProgress(url, onBytes);
      const toStore = new Response(bytesAsStream(buf), {
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(buf.byteLength) }
      });
      await cache.put(url, toStore);
      return buf;
    } catch (err) {
      console.warn("CacheStorage read/write warning:", err);
    }
  }
  return await fetchWithProgress(url, onBytes);
}
