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

export async function fetchWithProgress(url: string, onBytes?: OnBytes): Promise<ArrayBuffer> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  const total = Number(resp.headers.get("content-length")) || 0;
  if (!resp.body) throw new Error(`${url}: response has no body`);
  const reader = resp.body.getReader();
  const chunks = [];
  let got = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onBytes?.(got, total);
  }
  const out = new Uint8Array(got);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  onBytes?.(got, total || got, true);   // final sample: the bar reaches 100%
  return out.buffer;
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
      const toStore = new Response(buf.slice(0), {
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
