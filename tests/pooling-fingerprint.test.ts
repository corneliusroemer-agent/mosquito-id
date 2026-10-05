import { describe, expect, it } from "vitest";
import { poolingWeights } from "../src/confidence/pooling";
import type { PoolablePhoto } from "../src/confidence/pooling";
import { contentFingerprint } from "../src/app/contentHash";

/** Three photos in the pool, differing only in the fingerprint they carry. */
const withFingerprints = (fps: (string | null | undefined)[]): PoolablePhoto[] =>
  fps.map((fingerprint, i) => ({ name: `p${i}.jpg`, fingerprint: fingerprint as string | undefined }));

describe("Dependent evidence de-duplicates on a real fingerprint only", () => {
  it("two photos with a null fingerprint are two photos, not one duplicated", () => {
    const w = poolingWeights(withFingerprints([null, null]), "Dependent evidence", 0.5);
    // Two distinct photos at r = 0.5: 1 / (1 + 1 * 0.5) each. A null that
    // collided with the next null would give [2/3, 0].
    expect(w).toEqual([2 / 3, 2 / 3]);
  });

  it("an absent fingerprint never de-duplicates either", () => {
    expect(poolingWeights(withFingerprints([undefined, undefined]), "Dependent evidence", 0.5)).toEqual([2 / 3, 2 / 3]);
  });

  it("an empty-string fingerprint is treated as no fingerprint", () => {
    expect(poolingWeights(withFingerprints(["", ""]), "Dependent evidence", 0.5)).toEqual([2 / 3, 2 / 3]);
  });

  it("identical fingerprints still collapse to one, and null photos count as distinct beside them", () => {
    // a, a-again, null: two distinct observations (a, null) -> denom 1.5; the repeat gets 0.
    const w = poolingWeights(withFingerprints(["a", "a", null]), "Dependent evidence", 0.5);
    expect(w).toEqual([2 / 3, 0, 2 / 3]);
  });

  it("all-distinct fingerprints are unchanged", () => {
    expect(poolingWeights(withFingerprints(["a", "b", "c"]), "Dependent evidence", 0.5)).toEqual([0.5, 0.5, 0.5]);
  });
});

describe("contentFingerprint is a hash of the bytes, not of the dimensions", () => {
  const blob = (bytes: number[]) => new Blob([new Uint8Array(bytes)]);

  it("equal bytes give equal fingerprints", async () => {
    expect(await contentFingerprint(blob([1, 2, 3, 4]))).toBe(await contentFingerprint(blob([1, 2, 3, 4])));
  });

  it("different bytes of the same length give different fingerprints", async () => {
    // Two photographs with the same width and height used to share a fingerprint.
    expect(await contentFingerprint(blob([1, 2, 3, 4]))).not.toBe(await contentFingerprint(blob([1, 2, 3, 5])));
  });

  it("is the SHA-256 hex digest", async () => {
    // sha256("abc")
    expect(await contentFingerprint(new Blob(["abc"]))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is null, never a shared constant, when hashing is unavailable", async () => {
    const broken = { arrayBuffer: () => Promise.reject(new Error("boom")) } as unknown as Blob;
    expect(await contentFingerprint(broken)).toBeNull();
    expect(await contentFingerprint(null)).toBeNull();
  });
});
