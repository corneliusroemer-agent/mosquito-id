/**
 * The build SHA reaches the page as ?build=<sha>, and an existing ?build= is
 * left alone so a shared link keeps naming the deploy it was shared from.
 *
 * Every case here is a case that broke or would have broken silently: a stale
 * ?build= is invisible until someone re-checks a link months later, and a
 * missing SHA must not take the page down at load.
 */
import { describe, it, expect } from "vitest";
import { BUILD_PARAM, buildUrl, stampBuildSha } from "../src/app/buildSha";

const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

function fakePage(href: string) {
  const loc = { href } as Location;
  const calls: string[] = [];
  const hist = {
    state: { keep: true },
    replaceState(_d: unknown, _u: string, url?: string | null) {
      if (url != null) calls.push(url);
    },
  };
  return { loc, hist, calls };
}

describe("buildUrl", () => {
  it("adds ?build= to a URL that has none", () => {
    expect(buildUrl("https://example.org/mosquito-id/", SHA)).toBe(
      `/mosquito-id/?${BUILD_PARAM}=${SHA}`,
    );
  });

  it("keeps the hash and other query parameters", () => {
    expect(buildUrl("https://example.org/mosquito-id/?a=1#species/aedes", SHA)).toBe(
      `/mosquito-id/?a=1&${BUILD_PARAM}=${SHA}#species/aedes`,
    );
  });

  it("leaves an existing ?build= alone so a shared link stays stable", () => {
    expect(buildUrl("https://example.org/mosquito-id/?build=old", SHA)).toBeNull();
  });

  it("writes nothing when the SHA is absent, empty or blank", () => {
    for (const sha of [undefined, "", "   "]) {
      expect(buildUrl("https://example.org/mosquito-id/", sha)).toBeNull();
    }
  });
});

describe("stampBuildSha", () => {
  it("rewrites the current URL with replaceState, not pushState", () => {
    const { loc, hist, calls } = fakePage("https://example.org/mosquito-id/");
    expect(stampBuildSha(SHA, loc, hist)).toBe(true);
    expect(calls).toEqual([`/mosquito-id/?${BUILD_PARAM}=${SHA}`]);
  });

  it("does not touch the URL when a ?build= is already present", () => {
    const { loc, hist, calls } = fakePage(
      `https://example.org/mosquito-id/?${BUILD_PARAM}=already-there`,
    );
    expect(stampBuildSha(SHA, loc, hist)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("is idempotent across reloads: the second load rewrites nothing", () => {
    const first = fakePage("https://example.org/mosquito-id/");
    stampBuildSha(SHA, first.loc, first.hist);
    const stamped = `https://example.org${first.calls[0]}`;
    const second = fakePage(stamped);
    expect(stampBuildSha(SHA, second.loc, second.hist)).toBe(false);
    expect(second.calls).toEqual([]);
  });

  it("does not throw when no SHA was injected into the build", () => {
    const { loc, hist, calls } = fakePage("https://example.org/mosquito-id/");
    expect(() => stampBuildSha(undefined, loc, hist)).not.toThrow();
    expect(calls).toEqual([]);
  });
});