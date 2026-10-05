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
 * A path ending in `.onnx`: the weights, which must keep their cache.
 *
 * Matched on the pathname alone, never on the whole URL - a head fetched as
 * `text_embeds.json?src=weights.onnx` is still a head, and reading a `.onnx` out
 * of its query would leave it un-versioned, which is the bug this exists to fix.
 *
 * This one predicate decides two things, because they are the same decision: a
 * URL it matches is neither versioned nor pruned. So anything large that is NOT
 * named `.onnx` - a runtime `.wasm`, an extension-less download URL - would be
 * re-downloaded in full on every deploy. Adding such a file means adding it here
 * first.
 */
const WEIGHTS = /\.onnx$/i;

/** The URL's path, with any query and fragment removed. */
function pathOf(url: string): string {
  return new URL(url, documentBase()).pathname;
}

/**
 * What a relative model URL resolves against.
 *
 * `document.baseURI` rather than `location.href` because that is what Cache and
 * fetch resolve against - they agree while the page has no `<base>` tag, and
 * using the real one means a page that adds one does not make the prune quietly
 * compare the wrong URLs.
 */
function documentBase(): string {
  const doc = (globalThis as { document?: { baseURI?: string } }).document;
  return doc?.baseURI ?? globalThis.location?.href ?? "http://localhost/";
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
  // Split on the fragment first. Appending to a URL that carries one puts the
  // query INSIDE the fragment, where it is not a query at all - the request
  // would be for the un-versioned file and the head would go on being served
  // stale, which is the bug this exists to fix.
  const hash = url.indexOf("#");
  const base = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? "" : url.slice(hash);
  // Already versioned: leave it. A second `?build=` would make the key depend on
  // how many times this ran, and `a.json?build=X&build=X` is not a URL anything
  // else in the app would ask for.
  if (new URL(base, documentBase()).searchParams.has(BUILD_PARAM)) return url;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${BUILD_PARAM}=${encodeURIComponent(trimmed)}${fragment}`;
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

export async function fetchWithProgress(url: string, onBytes?: OnBytes, signal?: AbortSignal): Promise<ArrayBuffer> {
  const resp = await fetch(url, signal ? { signal } : undefined);
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
 * first. Every CacheStorage failure - a private-mode browser with no caches, a
 * quota error, a corrupted entry - costs the cache and not the load, so the
 * worst case is a slow first run and never a second download of bytes already
 * in hand.
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
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const versioned = versionedModelUrl(url, sha);
  if ("caches" in window) {
    let cache: Cache | null = null;
    let cached: Response | undefined;
    try {
      cache = await caches.open(CACHE_NAME);
      cached = await cache.match(versioned);
    } catch (err) {
      // Only the lookup is guarded. A cache we cannot open or read is a cache we
      // do not have, and the network below is the whole answer.
      console.warn("CacheStorage read warning:", err);
      cache = null;
    }
    if (cached) {
      console.log(`[CacheStorage] HIT for ${versioned}`);
      log?.("cache_hit", { url: versioned });
      const size = Number(cached.headers.get("content-length")) || 0;
      onBytes?.(size || 1, size || 1, true);
      return await cached.arrayBuffer();
    }
    if (cache) console.log(`[CacheStorage] MISS for ${versioned}, fetching from network...`);
    log?.("cache_miss", { url: versioned });
    const buf = await fetchWithProgress(versioned, onBytes, signal);
    // Written after the bytes are in hand and outside the path that can fall
    // through to a second fetch. A quota error on the put used to be caught by
    // the same catch as a network failure, which threw away a finished download
    // and started it again - 1.26 GB twice for the classifier, every load, since
    // the put keeps failing. Failing to cache is the worst case here, not
    // failing to load, so it is reported and the bytes are returned.
    if (cache) {
      try {
        const toStore = new Response(bytesAsStream(buf), {
          headers: { "Content-Type": "application/octet-stream", "Content-Length": String(buf.byteLength) }
        });
        await cache.put(versioned, toStore);
        await dropSuperseded(cache, versioned, log);
      } catch (err) {
        console.warn("CacheStorage write warning:", err);
        log?.("cache_write_failed", { url: versioned, error: String(err) });
      }
    }
    return buf;
  }
  return await fetchWithProgress(versioned, onBytes, signal);
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

/**
 * What identifies an artefact for the prune: origin, path, and any query that is
 * not the build. The origin is part of it because two hosts may serve the same
 * path - a head on Pages and a mirror on R2 are two artefacts, and deleting one
 * because the other was refitted would be its own silent breakage.
 */
function stripBuildParam(href: string): string {
  const u = new URL(href, documentBase());
  u.searchParams.delete(BUILD_PARAM);
  return `${u.origin}${u.pathname}${u.search}`;
}
