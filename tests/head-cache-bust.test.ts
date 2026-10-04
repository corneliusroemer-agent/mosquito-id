/**
 * A refitted head must reach the browser that deploys it.
 *
 * The head JSONs are served from a URL that does not change, so a browser keeps
 * serving the bytes it fetched before the refit: the app scores against the old
 * `logit_scale` and the new page, and a deployed fix looks like it did not land.
 * This has happened - B/16's refit was live on the bucket and two people were
 * still looking at the pre-fix behaviour. The fix is to name the build in the
 * query, which both the HTTP cache and CacheStorage key on.
 *
 * The other half is the `.onnx`: 81 MB to 1.2 GB, and that cache is what makes a
 * second visit bearable. Every case below that touches the weights is a case
 * asserting they keep the key they have.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fetchWithCache, versionedModelUrl } from "../src/app/modelFetch";

const SHA_A = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const SHA_B = "fedcba9876543210fedcba9876543210fedcba98";

const HEAD = "text_embeds_b16.json";
const ONNX = "https://pub.example.r2.dev/bioclip_2_5_fp16.onnx";

const ORIGIN = "https://app.test/mosquito-id/";

/** The JSON every fetch in this file returns, so a body can be told from another. */
function jsonResponse(body: unknown): Response {
  const buf = new TextEncoder().encode(JSON.stringify(body));
  return new Response(buf, {
    headers: { "content-type": "application/json", "content-length": String(buf.byteLength) },
  });
}

/**
 * A Cache key, absolute. A real Cache resolves a relative request against the
 * document, so `text_embeds.json?build=X` and `https://host/text_embeds.json`
 * are the same entry; a stub that compared the strings literally would pass a
 * cache-bust change that had in fact changed nothing, which is the failure this
 * file exists to catch.
 */
function cacheKey(url: RequestInfo | URL): string {
  // `cache.delete` is handed a Request, not a string, and `String(request)` is
  // "[object Request]" - so read `.url` off it first.
  const raw = typeof url === "object" && "url" in url ? (url as Request).url : String(url);
  return new URL(raw, ORIGIN).href;
}

/**
 * The document the relative model URLs resolve against, as a browser has one.
 * `modelFetch` resolves against `location.href` when pruning, so a test that
 * does not set this exercises a different base than the app does.
 */
function useDocumentOrigin(): void {
  (globalThis as Record<string, unknown>).location = { href: `${ORIGIN}index.html` };
}

/**
 * A CacheStorage that remembers what it was given, keyed exactly as a real one
 * is - on the full URL, query string included.
 */
function fakeCache() {
  const entries = new Map<string, Response>();
  const requested: string[] = [];
  return {
    entries,
    requested,
    cache: {
      match: async (req: RequestInfo | URL) => entries.get(cacheKey(req))?.clone(),
      put: async (req: RequestInfo | URL, res: Response) => {
        entries.set(cacheKey(req), res.clone());
      },
      keys: async () => [...entries.keys()].map((u) => new Request(u)),
      delete: async (req: RequestInfo | URL) => entries.delete(cacheKey(req)),
    },
  };
}

describe("versionedModelUrl", () => {
  it("gives the head a different URL per build", () => {
    expect(versionedModelUrl(HEAD, SHA_A)).toBe(`${HEAD}?build=${SHA_A}`);
    expect(versionedModelUrl(HEAD, SHA_B)).toBe(`${HEAD}?build=${SHA_B}`);
    expect(versionedModelUrl(HEAD, SHA_A)).not.toBe(versionedModelUrl(HEAD, SHA_B));
  });

  it("leaves the weights on one URL across every build", () => {
    // The load-bearing exclusion. Versioning the `.onnx` would re-download a
    // gigabyte on every deploy.
    expect(versionedModelUrl(ONNX, SHA_A)).toBe(ONNX);
    expect(versionedModelUrl(ONNX, SHA_B)).toBe(ONNX);
    expect(versionedModelUrl(ONNX, SHA_A)).toBe(versionedModelUrl(ONNX, SHA_B));
  });

  it("adds to a URL that already has a query, rather than replacing it", () => {
    expect(versionedModelUrl(`${HEAD}?v=2`, SHA_A)).toBe(`${HEAD}?v=2&build=${SHA_A}`);
  });

  it("returns the URL untouched when the build carries no SHA", () => {
    // A local `npm run build` has no VITE_COMMIT_SHA. Absent, empty and blank
    // must all degrade to today's behaviour rather than write `?build=`.
    for (const sha of [undefined, "", "   "]) {
      expect(versionedModelUrl(HEAD, sha)).toBe(HEAD);
      expect(versionedModelUrl(ONNX, sha)).toBe(ONNX);
    }
  });

  it("recognises a versioned weights URL as weights, not as a head", () => {
    // The check is on the path, so a URL that already carries a query - which
    // is what this function itself produces - is still recognised.
    expect(versionedModelUrl(`${ONNX}?a=1`, SHA_A)).toBe(`${ONNX}?a=1`);
  });
});

describe("fetchWithCache cache keys", () => {
  const realFetch = globalThis.fetch;
  const realCaches = (globalThis as Record<string, unknown>).caches;
  const realWindow = (globalThis as Record<string, unknown>).window;
  const realLocation = (globalThis as Record<string, unknown>).location;
  let store: ReturnType<typeof fakeCache>;

  beforeEach(() => {
    store = fakeCache();
    useDocumentOrigin();
    (globalThis as Record<string, unknown>).window = globalThis;
    (globalThis as Record<string, unknown>).caches = { open: async () => store.cache };
    globalThis.fetch = (async (req: RequestInfo | URL) => {
      store.requested.push(String(req));
      return jsonResponse({ version: String(req) });
    }) as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as Record<string, unknown>).caches = realCaches;
    (globalThis as Record<string, unknown>).window = realWindow;
    (globalThis as Record<string, unknown>).location = realLocation;
  });

  it("does not return an entry cached under the pre-versioning URL", async () => {
    // The regression, stated as a test: the browser already holds the old head
    // under `text_embeds_b16.json`, the app deploys with a SHA, and the app must
    // not be handed the old bytes.
    store.entries.set(cacheKey(HEAD), jsonResponse({ logit_scale: 2.5, stale: true }));

    const buf = await fetchWithCache(HEAD, undefined, undefined, SHA_A);
    const body = JSON.parse(new TextDecoder().decode(buf));

    expect(body.stale).toBeUndefined();
    expect(body.version).toBe(`${HEAD}?build=${SHA_A}`);
    expect(store.requested).toEqual([`${HEAD}?build=${SHA_A}`]);
  });

  it("stores the entry under the versioned key, so the next load is a hit", async () => {
    await fetchWithCache(HEAD, undefined, undefined, SHA_A);
    expect([...store.entries.keys()]).toEqual([cacheKey(`${HEAD}?build=${SHA_A}`)]);

    store.requested.length = 0;
    await fetchWithCache(HEAD, undefined, undefined, SHA_A);
    expect(store.requested).toEqual([]);   // served from the cache, no network
  });

  it("keys the weights identically on both builds, and keeps them cached", async () => {
    await fetchWithCache(ONNX, undefined, undefined, SHA_A);
    expect([...store.entries.keys()]).toEqual([ONNX]);

    store.requested.length = 0;
    const buf = await fetchWithCache(ONNX, undefined, undefined, SHA_B);
    expect(store.requested).toEqual([]);   // the gigabyte is still there
    expect(new TextDecoder().decode(buf)).toContain(ONNX);
  });

  it("drops the previous build's head rather than accumulating one per deploy", async () => {
    await fetchWithCache(HEAD, undefined, undefined, SHA_A);
    await fetchWithCache(HEAD, undefined, undefined, SHA_B);

    expect([...store.entries.keys()]).toEqual([cacheKey(`${HEAD}?build=${SHA_B}`)]);
  });

  it("does not delete the weights when it prunes a head", async () => {
    // The cache holds both artefacts. Pruning a superseded head must be scoped
    // to the head's path, or a deploy would cost the user the classifier.
    await fetchWithCache(ONNX, undefined, undefined, SHA_A);
    await fetchWithCache(HEAD, undefined, undefined, SHA_A);
    await fetchWithCache(HEAD, undefined, undefined, SHA_B);

    expect([...store.entries.keys()].sort()).toEqual([cacheKey(`${HEAD}?build=${SHA_B}`), ONNX].sort());
  });

  it("behaves as it did before, when the build carries no SHA", async () => {
    store.entries.set(cacheKey(HEAD), jsonResponse({ logit_scale: 2.5 }));
    await fetchWithCache(HEAD, undefined, undefined, undefined);

    expect(store.requested).toEqual([]);   // the pre-existing entry is still served
    expect([...store.entries.keys()]).toEqual([cacheKey(HEAD)]);
  });

  it("falls back to the network when CacheStorage is unavailable", async () => {
    // The documented worst case - private mode, no `caches` - must still load,
    // and must still bust, or an offline-capable browser would serve a stale
    // head with no way to recover.
    delete (globalThis as Record<string, unknown>).caches;

    const buf = await fetchWithCache(HEAD, undefined, undefined, SHA_A);
    expect(store.requested).toEqual([`${HEAD}?build=${SHA_A}`]);
    expect(JSON.parse(new TextDecoder().decode(buf)).version).toBe(`${HEAD}?build=${SHA_A}`);
  });
});

describe("versionedModelUrl and the weights rule", () => {
  it("reads the extension from the path, not from the query", () => {
    // A head fetched as `?src=weights.onnx` is a head. Testing the whole URL for
    // `.onnx` would leave it un-versioned, which is the original bug.
    expect(versionedModelUrl(`${HEAD}?src=weights.onnx`, SHA_A)).toBe(
      `${HEAD}?src=weights.onnx&build=${SHA_A}`,
    );
  });

  it("does not mistake a .onnx.json for weights", () => {
    expect(versionedModelUrl("model.onnx.json", SHA_A)).toBe(`model.onnx.json?build=${SHA_A}`);
  });

  it("matches the extension case-insensitively, as the host serves it", () => {
    expect(versionedModelUrl("Weights.ONNX", SHA_A)).toBe("Weights.ONNX");
  });
});
