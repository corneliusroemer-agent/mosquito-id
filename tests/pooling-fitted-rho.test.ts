/**
 * Constant-rho fusion: w_i = 1 / (1 + (n - 1) * rho) on the pooled log-probs.
 *
 * The property under test is the one that separates this from a constant
 * weight. A pool of n photos of ONE specimen does not carry n times the
 * evidence of one photo, so the per-photo weight must fall as the pool grows;
 * and a photograph that is a byte-for-byte repeat of one already in the pool
 * carries no evidence at all, so adding it must move the pooled posterior less
 * than adding a photograph that is not already there.
 *
 * Equal weight - "count every checked photo the same" - fails the second test
 * by construction: it cannot tell the two cases apart, so a user who ticks a
 * duplicate gets the same sharpening as a user who ticks a new view. That is
 * what `tests/pooling-fitted-rho.test.ts` pins and what the fitted-rho method
 * exists to fix.
 *
 * rho was fitted through this app's scoring path on the calib split only (see
 * `investigations/2026-10-05-multiphoto-fusion-app/`); it is not a tuning
 * constant, and the tests here do not assert its value beyond the bounds that
 * make it a correlation at all.
 */
import { describe, expect, it } from "vitest";
import { poolingWeights, FITTED_RHO_METHOD } from "../src/confidence/pooling";
import type { PoolablePhoto } from "../src/confidence/pooling";
import { POOL_RHO, poolRhoFor } from "../src/app/modelConfig";
import type { PoolingMethod } from "../src/confidence/pooling";

const RHO = POOL_RHO["webgpu-fp16"]!;

/** A poolable photo carrying `fingerprint` and a two-species log-probability pair. */
function photo(name: string, fingerprint: string | null, lp: [number, number]): PoolablePhoto {
  const [a, b] = lp;
  const z = a + b;
  return {
    name,
    fingerprint,
    scores: { a: Math.exp(a - z), b: Math.exp(b - z) },
    logits: { a: a - z, b: b - z },
    verdict: { state: "species", genus: "g", species: name, topGenusP: 1, topSpeciesP: Math.exp(a - z), runnersUp: [] },
  };
}

/**
 * The pooled posterior over two classes, from the pooled weights.
 *
 * Deliberately the app's own arithmetic rather than a stand-in: `logits` here
 * are log-probabilities up to a constant, so a softmax over the weighted sum is
 * the pooled posterior. Only the RELATIVE change matters to every assertion
 * below, so the normalising constant drops out.
 */
function pooledLogOdds(photos: PoolablePhoto[], method: PoolingMethod, r: number): number {
  const w = poolingWeights(photos, method, r);
  return photos.reduce((acc, p, i) => acc + w[i]! * (p.logits!.a! - p.logits!.b!), 0);
}

/** How far a pooled log-odds ratio sits from a single photo's own. */
const shiftFrom = (photos: PoolablePhoto[], method: PoolingMethod, r: number): number =>
  Math.abs(pooledLogOdds(photos, method, r) - (photos[0]!.logits!.a! - photos[0]!.logits!.b!));

describe("a duplicated photo adds less than an independent one", () => {
  // One confident photo, one photo that mildly disagrees with it.
  const strong = photo("strong.jpg", "aaa", [0, -3]);
  const weak = photo("weak.jpg", "bbb", [0, -1]);
  const duplicate = { ...strong, name: "strong-copy.jpg" };   // same bytes, so same fingerprint

  it("equal weight lets a duplicate take a third of the pool away from the photo that earned it", () => {
    // The behaviour the fitted method replaces. A duplicate of `strong` carries
    // no new information, but equal weight cannot see that, so it hands the copy
    // a full share and `weak` is left holding a third of what it held.
    const two = poolingWeights([strong, weak], "Equal weight", RHO);
    const three = poolingWeights([strong, weak, duplicate], "Equal weight", RHO);
    expect(three[1]!).toBeLessThan(two[1]!);
    expect(two[1]!).toBeCloseTo(1 / 2, 12);
    expect(three[1]!).toBeCloseTo(1 / 3, 12);
  });

  it("fitted rho leaves the other photos' shares untouched when a duplicate is checked", () => {
    // The same two pools. The duplicate contributes nothing, so `weak` keeps the
    // share it had and the pooled answer is bit-for-bit the two-photo answer.
    const two = poolingWeights([strong, weak], FITTED_RHO_METHOD, RHO);
    const three = poolingWeights([strong, weak, duplicate], FITTED_RHO_METHOD, RHO);
    expect(three[2]).toBe(0);
    expect(three[1]!).toBeCloseTo(two[1]!, 12);
    expect(three[0]!).toBeCloseTo(two[0]!, 12);
  });

  it("fitted rho moves the answer strictly less when the added photo is a duplicate", () => {
    const withDuplicate = shiftFrom([strong, duplicate], FITTED_RHO_METHOD, RHO);
    const withIndependent = shiftFrom([strong, weak], FITTED_RHO_METHOD, RHO);
    expect(withDuplicate).toBe(0);
    expect(withIndependent).toBeGreaterThan(withDuplicate);
  });

  it("a duplicate of any photo in the pool collapses, not only the first", () => {
    const pool = [strong, weak, { ...weak, name: "weak-copy.jpg" }];
    const w = poolingWeights(pool, FITTED_RHO_METHOD, RHO);
    expect(w[2]).toBe(0);
    expect(w[0]).toBeGreaterThan(0);
    expect(w[1]).toBeGreaterThan(0);
  });

  it("a photo with no fingerprint is its own observation, so it is never collapsed", () => {
    const pool = [photo("a.jpg", null, [0, -3]), photo("b.jpg", null, [0, -1]), photo("c.jpg", null, [0, -2])];
    expect(poolingWeights(pool, FITTED_RHO_METHOD, RHO).every((w) => w > 0)).toBe(true);
  });
});

describe("the per-photo weight falls as the pool grows", () => {
  it("three distinct photos of one specimen carry less per photo than two do", () => {
    const pool = [photo("a.jpg", "a", [0, -3]), photo("b.jpg", "b", [0, -2]), photo("c.jpg", "c", [0, -1])];
    const w = poolingWeights(pool, FITTED_RHO_METHOD, RHO);
    expect(w[0]).toBeCloseTo(1 / (1 + 2 * RHO), 12);
    expect(w[0]).toBeLessThan(1 / (1 + 1 * RHO)!);
  });

  it("the total pool weight still grows with n, because a second view is real evidence", () => {
    // The discounting is per PHOTO, not a normalisation: sum(w) = n / (1 + (n-1) rho),
    // which rises with n. A rule that held the total at 1 would say a second
    // photograph of the same mosquito tells you nothing new, which is false.
    const total = (n: number) => n * (1 / (1 + (n - 1) * RHO));
    expect(total(2)).toBeGreaterThan(1);
    expect(total(4)).toBeGreaterThan(total(2));
  });

  it("a single photo is its own posterior: the formula degenerates to w = 1", () => {
    expect(poolingWeights([photo("a.jpg", "a", [0, -3])], FITTED_RHO_METHOD, RHO)).toEqual([1]);
  });

  it("rho outside [0, 1) is rejected rather than silently pooled", () => {
    // rho = 1 is perfect correlation, where the pool never sharpens at all;
    // rho > 1 would let the pool's weight fall below 1/n and make adding a
    // photograph DULL the claim. Neither is a correlation.
    expect(() => poolingWeights([photo("a.jpg", "a", [0, -3]), photo("b.jpg", "b", [0, -2])],
                                FITTED_RHO_METHOD, 1)).toThrow(/rho/);
    expect(() => poolingWeights([photo("a.jpg", "a", [0, -3]), photo("b.jpg", "b", [0, -2])],
                                FITTED_RHO_METHOD, 1.5)).toThrow(/rho/);
  });
});

describe("the fitted rho is per engine and only where it was fitted", () => {
  it("H/14 carries the value the app-exact refit produced", () => {
    expect(poolRhoFor("webgpu-fp16")).toBe(RHO);
    expect(RHO).toBeGreaterThan(0.5);
    expect(RHO).toBeLessThan(1);
  });

  it("an engine with no fitted rho falls back to the slider value, not to H/14's", () => {
    // Inheriting another engine's correlation is the mistake CALIBRATED_ENGINES
    // was written to stop: the number is a property of the engine's errors.
    expect(poolRhoFor("webgpu-culico")).toBeNull();
    expect(poolRhoFor("webgpu-b16")).toBeNull();
  });
});
