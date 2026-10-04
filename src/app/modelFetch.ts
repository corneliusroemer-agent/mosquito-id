/**
 * Fetching a model file, with the CacheStorage layer in front of it.
 *
 * Nothing here knows what a model is or which one is being fetched - it is a
 * streaming fetch that reports progress and a cache lookup in front of it. The
 * classifier is 1.26 GB, so the cache is not an optimisation here, it is what
 * makes a second visit usable at all.
 */

import { CACHE_NAME } from "./modelConfig";
import { BUILD_PARAM, COMMIT_SHA } from "./buildSha";
import type { LogFn } from "./telemetry";

/** Reports bytes received so far, the total when the server sent one, and completion. */
export type OnBytes = (got: number, total: number, done?: boolean) => void;

/**
 * A path ending in `.onnx`. Matched on the pathname alone, never on the whole
 * URL: a head fetched as `text_embeds.json?src=weights.onnx` is still a head,
 * and reading a `.onnx` out of its query would leave it un-versioned - the
 * original bug, one URL shape away.
 */
const WEIGHTS = /\.onnx$/i;

/** The URL's path, with any query and fragment removed. */
function pathOf(url: string): string {
  return new URL(url, documentBase()).pathname;
}

/** What a relative model URL resolves against. */
function documentBase(): string {
  return globalThis.location?.href ?? "http://localhost/";
}

/**
 * The URL to fetch a model artefact from, carrying the build SHA for anything
 * that is not a set of weights.
 *
 * The head JSONs are a few hundred KB and are rewritten whenever a head is
 * refitted, which is often. They are served from one stable URL, so a browser
 * that fetched `text_embeds_b16.json` before a refit keeps being served the
 * bytes it already has - the app runs the old `logit_scale` against the new
 * page and a deployed fix looks like it did not land. The host sends them with
 * a ten-minute `max-age`, so the window is bounded but real, and a tab open
 * across the deploy sits inside it. Naming the build in the query makes the URL
 * itself change when the build does, which is what both caches key on.
 *
 * `.onnx` is excluded, and it is the exclusion that matters: the weights are
 * 81 MB to 1.2 GB, and re-downloading one on every deploy is the difference
 * between a second visit and a second visit that costs a gigabyte. Nothing
 * about the weights' bytes depends on the build SHA, so versioning them buys
 * nothing and costs everything.
 *
 * A build with no SHA (a local `npm run build`) leaves the URL exactly as it
 * was, which is today's behaviour.
 */
export function versionedModelUrl(url: string, sha: string | undefined = COMMIT_SHA): string {
  if (WEIGHTS.test(pathOf(url))) return url;
  const trimmed = sha?.trim();
  if (!trimmed) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${BUILD_PARAM}=${encodeURIComponent(trimmed)}`;
}

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
 *
 * The versioned URL is used for the cache key AND the request, from one
 * variable. Keying the entry on the bare URL while requesting the versioned one
 * is the failure that a cache-busting change invites: the put lands under a key
 * nothing ever reads, and the match finds an entry from before the version
 * parameter existed and serves it forever.
 */
export async function fetchWithCache(
  url: string,
  onBytes?: OnBytes,
  log?: LogFn,
  sha: string | undefined = COMMIT_SHA,
): Promise<ArrayBuffer> {
  const versioned = versionedModelUrl(url, sha);
  if ("caches" in window) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(versioned);
      if (cached) {
        console.log(`[CacheStorage] HIT for ${versioned}`);
        log?.("cache_hit", { url: versioned });
        const size = Number(cached.headers.get("content-length")) || 0;
        onBytes?.(size || 1, size || 1, true);
        return await cached.arrayBuffer();
      }
      console.log(`[CacheStorage] MISS for ${versioned}, fetching from network...`);
      log?.("cache_miss", { url: versioned });
      const buf = await fetchWithProgress(versioned, onBytes);
      const toStore = new Response(bytesAsStream(buf), {
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(buf.byteLength) }
      });
      await cache.put(versioned, toStore);
      await dropSuperseded(cache, versioned, log);
      return buf;
    } catch (err) {
      console.warn("CacheStorage read/write warning:", err);
    }
  }
  return await fetchWithProgress(versioned, onBytes);
}

/**
 * Delete the other builds' copies of the artefact just stored.
 *
 * A per-build key means every deploy adds an entry that nothing will ever ask
 * for again, and the cache is persistent and already holding a gigabyte of
 * weights - the head entries would pile up until a quota error evicted
 * something worth keeping. Only the same path is touched, so dropping a stale
 * head never costs the classifier.
 *
 * `cache.keys()` hands back absolute URLs, while the artefact was named
 * relative to the document, so both sides are resolved against the document
 * before they are compared. Comparing the strings as given would match nothing
 * and the prune would be a silent no-op on exactly the cache it exists to keep
 * tidy.
 *
 * Best-effort by design: this runs after the bytes are in the caller's hands,
 * so a failure here is logged and otherwise ignored rather than allowed to fail
 * a load.
 */
async function dropSuperseded(
  cache: Cache,
  stored: string,
  log?: LogFn,
): Promise<void> {
  try {
    const storedUrl = new URL(stored, documentBase());
    const path = stripBuildParam(storedUrl.href);
    for (const key of await cache.keys()) {
      if (key.url === storedUrl.href) continue;
      if (stripBuildParam(key.url) === path) await cache.delete(key);
    }
  } catch (err) {
    console.warn("CacheStorage prune warning:", err);
    log?.("cache_prune_failed", { url: stored, error: String(err) });
  }
}

/** A URL with any `?build=` removed, which is what identifies the artefact. */
function stripBuildParam(href: string): string {
  const u = new URL(href, documentBase());
  u.searchParams.delete(BUILD_PARAM);
  return `${u.pathname}${u.search}`;
}
