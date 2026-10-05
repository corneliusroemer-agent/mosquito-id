/**
 * The fused species, nuisance and adjacent blocks partition one probability.
 *
 * `softmaxJoint` produces ONE softmax and slices it (`softmax.ts:138-140`), so a
 * single view's `spP + nuP + adP` already sums to 1. `fuseViews` then re-derived
 * that structure for the species/nuisance pair and normalised the adjacent block
 * separately against a denominator that DID include species and nuisance. The two
 * blocks were therefore normalised over different sets, and species came out
 * inflated by exactly `1/(1 - adjacentMass)` - unbounded as adjacent mass -> 1.
 *
 * That inflation crossed floors. At true adjacent mass 0.50 the fused top species
 * reads 0.80 where the truth is 0.30, and the band where the non-mosquito gate
 * (floor 0.60) stays silent while the inflated posterior crosses the genus floor
 * is non-empty. Every downstream consumer inherits it: `detail` to the score
 * panel and CSV, `labels` to the genus column, and the recovered `logits` to
 * `pooledVerdict`.
 *
 * `softmax.ts:59` documents the contract this pins: "Species posteriors, summing
 * with nuP and adP to 1."
 */
import { describe, it, expect, beforeAll } from "vitest";
import { fuseViews } from "../src/confidence/fuseViews";
import { realHead } from "./fixtures";
import type { Head, ViewResult } from "../src/confidence/types";

let head: Head;
beforeAll(() => {
  head = realHead();
});

const S = () => head.species.length;
const NU = () => head.nuisance?.length ?? 0;
const A = () => head.adjacent?.length ?? 0;

/** One view: species mass `(1 - adjacentMass)`, adjacent mass spread flat over its classes. */
function view(speciesTop: number, adjacentMass: number, nuTotal = 0): ViewResult {
  const spP = new Array<number>(S()).fill(0);
  spP[0] = speciesTop;
  const rest = ((1 - speciesTop) / (S() - 1)) * (1 - adjacentMass);
  for (let i = 1; i < S(); i++) spP[i] = rest;
  spP[0] = speciesTop * (1 - adjacentMass);
  const nuP = new Array<number>(NU()).fill(nuTotal / Math.max(NU(), 1));
  const adP = new Array<number>(A()).fill(adjacentMass / Math.max(A(), 1));
  return { spP, nuP, nuTotal, adP, scale: head.logit_scale / 2.5 };
}

const total = (r: { spP: number[]; nuP: number[]; adP: number[] }) =>
  r.spP.reduce((a, b) => a + b, 0) + r.nuP.reduce((a, b) => a + b, 0) + r.adP.reduce((a, b) => a + b, 0);

describe("the fused blocks share one denominator", () => {
  it("sum to 1 whatever the adjacent mass", () => {
    for (const ad of [0, 0.05, 0.1, 0.3, 0.5, 0.8, 0.9, 0.99]) {
      const r = fuseViews(head, [view(0.3, ad)])!;
      expect(
        total(r),
        `adjacent mass ${ad}: the fused blocks sum to ${total(r)}, so species is ` +
          `inflated by 1/(1-${ad}) and every downstream floor reads a larger number than it should`,
      ).toBeCloseTo(1, 6);
    }
  });

  it("sum to 1 with nuisance mass present too", () => {
    for (const ad of [0, 0.2, 0.5]) {
      const r = fuseViews(head, [view(0.3, ad, 0.1)])!;
      expect(total(r), `adjacent ${ad}, nuisance 0.10`).toBeCloseTo(1, 6);
    }
  });

  it("do not inflate the species posterior as adjacent mass rises", () => {
    // The species posterior of the named species must fall toward zero as adjacent
    // mass takes the rest of the picture, never rise. The bug made it RISE,
    // because adjacent mass was silently redistributed into the species block.
    const lo = fuseViews(head, [view(0.3, 0.0)])!;
    const hi = fuseViews(head, [view(0.3, 0.9)])!;
    expect(hi.spP[0]!).toBeLessThan(lo.spP[0]!);
    // 0.30 of the species mass, with 0.90 taken by adjacent.
    expect(hi.spP[0]!).toBeCloseTo(0.3 * 0.1, 6);
  });

  it("keeps the species posterior equal to the view's own at zero adjacent mass", () => {
    const r = fuseViews(head, [view(0.3, 0.0, 0.0)])!;
    expect(r.spP[0]!).toBeCloseTo(0.3, 6);
  });

  it("still sums to 1 across two pooled views", () => {
    const r = fuseViews(head, [view(0.3, 0.2), view(0.7, 0.6)])!;
    expect(total(r)).toBeCloseTo(1, 6);
  });

  it("sums to 1 when the head carries no adjacent classes", () => {
    // An older embeds file: `adP` is empty, and the contract is still a partition.
    const bare: Head = { ...head, adjacent: [], adjacent_emb: undefined, adjacent_common: [] };
    const v = view(0.3, 0);
    const r = fuseViews(bare, [v])!;
    expect(r.spP.reduce((a, b) => a + b, 0) + r.nuP.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
});
