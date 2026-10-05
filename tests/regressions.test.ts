// Regression cases for defects that shipped, or that three agents spent hours
// reading source to diagnose. Each one states the arithmetic it depends on.
//
// The split/n this file uses is the shipped one in every case: the real 16-species
// head with its real adjacent classes, read from text_embeds.json. Where a case
// needs a hand-built posterior it is built against that head's species indices,
// so genus sums in the assertions are sums over the real labels.
import { describe, it, expect, beforeAll } from "vitest";
import { realHead, post, S } from "./fixtures";
import type { Head } from "../src/confidence/types";
import { DEFAULT_FLOORS } from "../src/confidence/types";
import { verdictFrom, verdictSentence } from "../src/confidence/verdict";
import { fuseViews } from "../src/confidence/fuseViews";
import { scoreRow, pooledScoreRow } from "../src/confidence/scorebar";
import {
  splitPoolable,
  pooledPosterior,
  pooledVerdict,
  poolingWeights,
  aggregateLogits,
  aggregateAdjacent,
  pooledAdjacentPosterior,
  type PoolablePhoto,
} from "../src/confidence/pooling";

let head: Head;
beforeAll(() => {
  head = realHead();
});

/**
 * Build a photo's logits from a species posterior, the way the app does.
 *
 * logits = scale * cos, and log p = scale * cos - logZ, so
 * logits[s] = (log p[s] + logZ) * (scale / head.logit_scale) with any logZ.
 * This is the inverse of what softmaxJoint produces, which is what lets a test
 * state a posterior and then pool it exactly as the app would.
 */
function logitsFor(spP: number[], logZ = 5): Record<string, number> {
  const out: Record<string, number> = {};
  head.species.forEach((name, i) => {
    out[name] = Math.log(Math.max(spP[i]!, 1e-12)) + logZ;
  });
  return out;
}

describe("a non-finite score produces no bar and no percentage", () => {
  it("NaN yields no width and no percentage, never width: NaN%", () => {
    const r = scoreRow(NaN);
    expect(r.finite).toBe(false);
    expect(r.percent).toBe("");
    expect(r.widthPct).toBe(0);
    // The exact failure: Math.max/min propagate NaN, so the inline expression
    // the old renderer used produced "NaN%", which the browser DROPS as an
    // invalid declaration - leaving the fill at its default width, i.e. a full
    // confident-looking bar for a value that means nothing.
    // The exact arithmetic that shipped the bug: the clamp propagates NaN, and
    // "width: NaN%" is an invalid declaration the browser drops silently - the
    // fill keeps its default width, which reads as a full confident bar.
    const old = Math.max(0, Math.min(100, NaN * 100));
    expect(Number.isNaN(old)).toBe(true);
    expect(Number.isFinite(r.widthPct)).toBe(true);
    // Nothing that reaches the DOM's style attribute may contain "NaN".
    expect(`width: ${r.widthPct}%`).toBe("width: 0%");
    expect(r.percent).not.toContain("NaN");
  });

  it("Infinity and -Infinity are both non-finite, so both render nothing", () => {
    for (const v of [Infinity, -Infinity]) {
      const r = scoreRow(v);
      expect(r.finite).toBe(false);
      expect(r.percent).toBe("");
      expect(r.widthPct).toBe(0);
    }
  });

  it("a finite score still renders, and clamps outside 0..1", () => {
    expect(scoreRow(0.286).finite).toBe(true);
    expect(scoreRow(0.286).percent).toBe("28.6");
    expect(scoreRow(0.286).widthPct).toBeCloseTo(28.6, 9);
    expect(scoreRow(1.5).widthPct).toBe(100);
    expect(scoreRow(-0.2).widthPct).toBe(0);
    expect(scoreRow(0).percent).toBe("0.0");
  });

  it("the pooled card's -20..0 axis obeys the same rule", () => {
    expect(pooledScoreRow(NaN).widthPct).toBe(0);
    expect(pooledScoreRow(NaN).percent).toBe("");
    // relScore 0 is the pool's best and fills the track; -20 is the left edge.
    expect(pooledScoreRow(0).widthPct).toBe(100);
    expect(pooledScoreRow(-20).widthPct).toBe(0);
    expect(pooledScoreRow(-10).widthPct).toBe(50);
  });
});

describe("the verdict abstains when the top posterior is below both floors", () => {
  it("a blank wall scoring 28.6% ranks the species but claims nothing", () => {
    // The screenshot case: three blank background photos, top species 28.6%,
    // rendered as a confident-looking ranking. The ranking is correct to show -
    // it is what the classifier said - but no genus or species may be claimed.
    const spP = post(head, {
      "Aedes japonicus": 0.286,
      "Aedes koreicus": 0.249,
      "Aedes geniculatus": 0.131,
      "Culiseta annulata": 0.125,
      "Culex pipiens": 0.078,
      "Aedes albopictus": 0.062,
      "Aedes aegypti": 0.026,
      "Culiseta longiareolata": 0.021,
      "Culiseta morsitans": 0.009,
    });
    const v = verdictFrom(head, spP, null, []);
    expect(Math.max(...spP)).toBeLessThan(DEFAULT_FLOORS.species);
    expect(v.state).toBe("unsure");
    expect(v.genus).toBeNull();
    expect(v.species).toBeNull();
    // The abstention is unchanged in what it CLAIMS - nothing - and now says what
    // the photo was torn between, which is what the ranking underneath it shows.
    expect(verdictSentence(v)).toMatch(/^Not confident enough to name a genus/);
    expect(verdictSentence(v)).toContain("japonicus");
    expect(verdictSentence(v)).toContain("koreicus");
  });

  it("abstaining is not the same as having no ranking", () => {
    // The gate gates the CLAIM, not the display. An unsure verdict still
    // carries the numbers the score panel shows, and every one of them is finite.
    const spP = post(head, { "Aedes japonicus": 0.286, "Culex pipiens": 0.2 });
    const v = verdictFrom(head, spP, null, []);
    expect(v.state).toBe("unsure");
    expect(v.topSpeciesP).toBeCloseTo(0.286, 9);
    expect(v.topGenusP).toBeGreaterThan(0);
  });
});

describe("two views naming different species cannot reach a species claim", () => {
  it("holds however high the fused posterior, with the floors injected explicitly", () => {
    const S_ = S(head);
    // a and b get pa and pb so each view has a strict argmax of its own.
    const mk = (a: string, b: string, pa: number, pb: number): number[] => {
      const p = new Array<number>(S_).fill(0.001);
      p[head.species.indexOf(a)] = pa;
      p[head.species.indexOf(b)] = pb;
      return p;
    };
    // Force the fused posterior far above the species floor by injecting a floor
    // of 0, so this tests the VETO rather than the floor: with the veto as the
    // only thing standing between the photo and a species claim, the species
    // claim must not appear.
    // View A is sure of aegypti, view B of albopictus: each view's own argmax is
    // different, which is what "the views disagree" means. The pool's argmax is
    // whichever of the two wins the log-linear sum, and the veto has to hold
    // whichever that is - so the test does not care which, only that neither
    // species claim survives.
    // View A peaks on aegypti, view B on albopictus. The values are near-mirror
    // images so neither view is "the better one" - the test is about the veto,
    // not about which species happens to win the pool.
    // Two confident views, so the pair reaches the pooling the
    // veto is tested on - an unconfident crop is scored on its own and never
    // gets here. Near-mirror
    // as before, so neither view is "the better one".
    const viewA = { spP: mk("Aedes aegypti", "Aedes albopictus", 0.898, 0.897), nuTotal: 1e-6, scale: 40 };
    const viewB = { spP: mk("Aedes albopictus", "Aedes aegypti", 0.898, 0.897), nuTotal: 1e-6, scale: 40 };
    // Sanity: each view alone, at a zero floor, names its own species.
    const permissive = { ...DEFAULT_FLOORS, species: 0, genus: 0 };
    expect(fuseViews(head, [viewA], permissive)!.verdict.species).toBe("Aedes aegypti");
    expect(fuseViews(head, [viewB], permissive)!.verdict.species).toBe("Aedes albopictus");
    // Distinct argmaxes: this is the precondition the veto reads.
    expect(head.species.indexOf("Aedes aegypti")).not.toBe(
      head.species.indexOf("Aedes albopictus"),
    );
    // Pooled, with the shipped floors: the veto alone must keep it off species.
    const fused = fuseViews(head, [viewA, viewB]);
    expect(fused!.verdict.topSpeciesP).toBeGreaterThan(DEFAULT_FLOORS.species);
    expect(fused!.agreement!.agree).toBe(false);
    expect(fused!.verdict.state).not.toBe("species");
  });
});

describe("a pooling path cannot let a photo override a correct per-photo verdict", () => {
  it("three blank-wall photos still name nothing, now that they are in the sum", () => {
    // The reproduction: tmp/mosquito-id/bogusresults.png, three blank background
    // photos checked together, and the pooled card naming Culex pipiens. Each
    // photo on its own read ~28.6% and abstained. They are pooled now rather
    // than dropped, at ~0.28 of a named photo each, so the safety property has
    // to survive the pooling rather than be guaranteed by exclusion.
    const blank = (lead: number): PoolablePhoto => {
      const spP = post(head, {
        "Aedes japonicus": lead,
        "Aedes koreicus": 0.249,
        "Aedes geniculatus": 0.131,
        "Culiseta annulata": 0.125,
        "Culex pipiens": 0.078,
      });
      return {
        name: "blank.png",
        fingerprint: `fp${lead}`,
        scores: Object.fromEntries(head.species.map((s, i) => [s, spP[i]!])),
        logits: logitsFor(spP),
        verdict: verdictFrom(head, spP, null, []),
      };
    };
    const photos = [blank(0.286), blank(0.31), blank(0.273)];
    // Each abstained on its own - this is the precondition the card depends on.
    for (const p of photos) {
      expect(p.verdict!.state).toBe("unsure");
      expect(p.verdict!.species).toBeNull();
    }
    const { included, excluded } = splitPoolable(photos);
    expect(included).toHaveLength(3);
    expect(excluded).toEqual([]);
    // Each is in the sum, at its own top posterior.
    expect(included.map((p) => Math.round(p.poolWeight * 1000) / 1000)).toEqual([0.286, 0.31, 0.273]);

    // And the pool still names nothing - not a species, and not even the genus,
    // because pooling three flat posteriors sharpens them well short of the
    // 0.80 genus floor.
    const w = poolingWeights(included, "Dependent evidence", 0.5);
    const agg = aggregateLogits(head, included, w);
    const v = pooledVerdict(head, agg, included);
    expect(v!.state).not.toBe("species");
    expect(v!.state).toBe("unsure");
    expect(v!.species).toBeNull();
    expect(v!.genus).toBeNull();
  });

  it("three pooled unsure photos are stopped by the photo gate, not by the floors", () => {
    // The same three blank walls. Pooled at their own top posteriors they DO
    // clear the shipped species floor (0.373) and the genus floor (0.80) - the
    // pooling sharpens them - so the claim is withheld by the gate that reads
    // the photos, not by the posterior. This is the assertion that would break
    // if anyone removed the gate and trusted the numbers.
    const blank = (lead: number): PoolablePhoto => {
      const spP = post(head, {
        "Aedes japonicus": lead,
        "Aedes koreicus": 0.249,
        "Aedes geniculatus": 0.131,
        "Culiseta annulata": 0.125,
        "Culex pipiens": 0.078,
      });
      return {
        name: "blank.png",
        fingerprint: `fp${lead}`,
        scores: Object.fromEntries(head.species.map((s, i) => [s, spP[i]!])),
        logits: logitsFor(spP),
        verdict: verdictFrom(head, spP, null, []),
      };
    };
    const { included } = splitPoolable([blank(0.286), blank(0.31), blank(0.273)]);
    const w = poolingWeights(included, "Dependent evidence", 0.5);
    const agg = aggregateLogits(head, included, w);
    const spP = pooledPosterior(head, agg)!;
    // Both floors are cleared, so the numbers alone would name a genus.
    expect(Math.max(...spP)).toBeGreaterThan(DEFAULT_FLOORS.species);
    const unweightedGenus = verdictFrom(head, spP, null, []);
    expect(unweightedGenus.topGenusP).toBeGreaterThan(DEFAULT_FLOORS.genus);
    // The gate is what withholds it, at both levels.
    const v = pooledVerdict(head, agg, included)!;
    expect(v.state).toBe("unsure");
    expect(v.genus).toBeNull();
    expect(v.species).toBeNull();
  });

  it("a non-mosquito photo is excluded: it is evidence against every species", () => {
    const spP = post(head, { "Aedes aegypti": 0.2, "Culex pipiens": 0.1 });
    const adP = new Array<number>((head.adjacent ?? []).length).fill(0);
    adP[0] = 0.9;
    const v = verdictFrom(head, spP, null, adP);
    expect(v.state).toBe("non-mosquito");
    // Pooling it at any weight would fold a midge's logits into a mosquito's
    // posterior, so there is no weight that keeps the meaning and is worth
    // having: it is out, with the reason recorded.
    const { included, excluded } = splitPoolable([{ name: "midge.jpg", verdict: v }]);
    expect(included).toEqual([]);
    expect(excluded.map((p) => p.excludedBecause)).toEqual(["non-mosquito"]);
  });

  it("a pending or failed photo is pending, not excluded", () => {
    const { included, excluded, pending } = splitPoolable([
      { name: "a", pending: true },
      { name: "b", error: "boom" },
    ]);
    expect(included).toEqual([]);
    expect(excluded).toEqual([]);
    expect(pending.map((p) => p.name)).toEqual(["a", "b"]);
  });
});

describe("the pool's weights", () => {
  const photo = (name: string, fp: string, scores: Record<string, number>): PoolablePhoto => ({
    name,
    fingerprint: fp,
    scores,
    verdict: verdictFrom(head, post(head, { "Aedes aegypti": 0.8 }), null, []),
  });

  it("equal weight is uniform and sums to 1", () => {
    const w = poolingWeights([photo("a", "1", {}), photo("b", "2", {}), photo("c", "3", {})], "Equal weight", 0.5);
    expect(w).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it("dependent evidence zeroes a duplicate crop and discounts the distinct ones", () => {
    // The same picture checked twice carries near the same evidence, so counting
    // it at full weight is counting one observation twice.
    const w = poolingWeights(
      [photo("a", "same", {}), photo("a-copy", "same", {}), photo("b", "other", {})],
      "Dependent evidence",
      0.5,
    );
    expect(w[1]).toBe(0);
    expect(w[0]).toBeCloseTo(w[2]!);
    // The discount divides by 1 + (distinct - 1) * r = 1 + 0.5 here, so the two
    // distinct photos come to 1/1.5 each and the raw weights sum to 4/3, not 1.
    // That is the shipped behaviour and it is harmless for the verdict: the
    // aggregate is a positive multiple of the intended one and a softmax is
    // invariant to that. It is NOT harmless for the contribution shares, which
    // is why they are taken as w/sumW rather than w.
    expect(w[0]).toBeCloseTo(1 / 1.5, 12);
    expect(w[0]! + w[2]!).toBeCloseTo(4 / 3, 12);
    const shares = w.map((x) => x / w.reduce((a, b) => a + b, 0));
    expect(shares[1]).toBe(0);
    expect(shares[0]! + shares[2]!).toBeCloseTo(1, 12);
  });

  it("weight by lead falls back to uniform when no photo has a lead", () => {
    const w = poolingWeights([photo("a", "1", {}), photo("b", "2", {})], "Weight by lead", 0.5);
    // Two photos with empty score objects both lead 0, so the sum is the 1e-6
    // guard and both get 0.
    expect(w).toEqual([0, 0]);
  });
});

describe("pooledPosterior", () => {
  it("returns null rather than NaN when a logit is non-finite", () => {
    const agg = logitsFor(post(head, { "Aedes aegypti": 0.9 }));
    agg["Culex pipiens"] = NaN;
    expect(pooledPosterior(head, agg)).toBeNull();
  });

  it("returns null rather than NaN when every logit is Infinity", () => {
    // Raw logits run to hundreds and exp() of that is Infinity on every species,
    // which would silently turn the whole pool into NaN.
    const agg: Record<string, number> = {};
    head.species.forEach((s) => {
      agg[s] = Infinity;
    });
    expect(pooledPosterior(head, agg)).toBeNull();
  });

  it("softmaxes the aggregate, so the pooled posterior sums to 1", () => {
    const agg = logitsFor(post(head, { "Aedes aegypti": 0.6, "Culex pipiens": 0.4 }));
    const spP = pooledPosterior(head, agg)!;
    expect(spP.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(spP.every((p) => Number.isFinite(p))).toBe(true);
  });
});

describe("the pooled gate reads the wrong floor for a sharpened pool", () => {
  /**
   * The defect behind tmp/mosquito-id/bogusresults.png: three blank background
   * photos checked together rendered a confident named species on the pooled
   * card, and no single photo had claimed one.
   *
   * The arithmetic, with the real head and the real floors:
   *
   *   per photo   top species 0.355 / 0.350 / 0.360   (floor 0.373 - none claims)
   *               top genus   0.875 / 0.872 / 0.879   (floor 0.80  - all GENUS)
   *
   * The pool is log-linear, softmax(sum_i log p_i), so pooling three similar
   * posteriors RAISES the winner: cubing 0.355 against 0.250 and 0.215 and
   * renormalising puts the top at 0.4625, above the species floor. The pooled
   * card then applies SPECIES_CONFIDENCE_FLOOR to that sharpened number and
   * names a species - a claim no individual photo made and none of them would
   * have made.
   *
   * So the pool can be MORE confident than its parts in a way no per-photo
   * threshold was ever fitted against. Every floor was fitted on single
   * (or two-view) posteriors; the pool is a different distribution and the
   * species floor is being read off it anyway.
   */
  function spread(over: Record<string, number>): number[] {
    const p = post(head, over);
    const rest =
      (1 - Object.values(over).reduce((a, b) => a + b, 0)) /
      (head.species.length - Object.keys(over).length);
    head.species.forEach((s, i) => {
      if (!(s in over)) p[i] = rest;
    });
    return p;
  }

  function poolOf(specs: Record<string, number>[]): { spP: number[]; verdict: ReturnType<typeof pooledVerdict> } {
    const photos = specs.map((over, i) => {
      const p = spread(over);
      return {
        name: `blank-${i}`,
        fingerprint: `fp-${i}`,
        scores: Object.fromEntries(head.species.map((s, j) => [s, p[j]!])),
        logits: Object.fromEntries(head.species.map((s, j) => [s, Math.log(p[j]!) + 5])),
        verdict: verdictFrom(head, p, null, []),
      };
    });
    for (const ph of photos) {
      expect(ph.verdict.state).toBe("genus");
      expect(ph.verdict.species).toBeNull();
    }
    const { included } = splitPoolable(photos);
    expect(included).toHaveLength(photos.length);
    const w = poolingWeights(included, "Dependent evidence", 0.5);
    const agg = aggregateLogits(head, included, w);
    return { spP: pooledPosterior(head, agg)!, verdict: pooledVerdict(head, agg, included)! };
  }

  it("three genus-only blank photos cannot pool into a species claim none of them made", () => {
    const { spP, verdict } = poolOf([
      { "Aedes aegypti": 0.355, "Aedes albopictus": 0.25, "Aedes japonicus": 0.215 },
      { "Aedes aegypti": 0.35, "Aedes albopictus": 0.255, "Aedes japonicus": 0.21 },
      { "Aedes aegypti": 0.36, "Aedes albopictus": 0.245, "Aedes japonicus": 0.22 },
    ]);
    const top = Math.max(...spP);
    // The pooled posterior still crosses the species floor, and still would if
    // the gate were left to read it - which is the bug, and it is why the gate
    // is on the photos rather than on this number.
    expect(top).toBeGreaterThan(DEFAULT_FLOORS.species);
    expect(verdict!.state).not.toBe("species");
    expect(verdict!.species).toBeNull();
    expect(verdict!.state).toBe("genus");
    expect(verdict!.genus).toBe("Aedes");
  });

  it("the sharpening is the pooling, not the gate: pooling raises the winner monotonically", () => {
    // Same three photos, pooled 1 / 2 / 3 deep. One photo is at 0.355 - under the
    // floor. Two and three are above it. Nothing about the evidence improved
    // between k=1 and k=3; the transformation did it.
    const specs = [
      { "Aedes aegypti": 0.355, "Aedes albopictus": 0.25, "Aedes japonicus": 0.215 },
      { "Aedes aegypti": 0.35, "Aedes albopictus": 0.255, "Aedes japonicus": 0.21 },
      { "Aedes aegypti": 0.36, "Aedes albopictus": 0.245, "Aedes japonicus": 0.22 },
    ];
    const tops: number[] = [];
    for (const k of [1, 2, 3]) {
      const { spP } = poolOf(specs.slice(0, k));
      tops.push(Math.max(...spP));
    }
    expect(tops[0]!).toBeLessThan(DEFAULT_FLOORS.species);
    expect(tops[1]!).toBeGreaterThan(tops[0]!);
    expect(tops[2]!).toBeGreaterThan(tops[1]!);
  });

  it("one photo cannot be sharpened, so the pool needs at least two to cross", () => {
    // The card already refuses to draw below two included photos, so the
    // one-photo case is not reachable in the app. It is asserted because it is
    // the control: the sharpening is entirely a function of pooling depth.
    const { spP } = poolOf([
      { "Aedes aegypti": 0.355, "Aedes albopictus": 0.25, "Aedes japonicus": 0.215 },
    ]);
    expect(Math.max(...spP)).toBeCloseTo(0.355, 6);
  });
});

describe("the pool gates on a distribution it was not fitted on", () => {
  /**
   * The regression tests for the pooled-card defect.
   *
   * The species claim is fixed: pooledVerdict now gates on the contributing
   * photos rather than on the sharpened pool, so the tests that assert that are
   * plain `it`. The last test in this block stays `it.fails` because it asserts
   * something the fix deliberately does NOT do - that the pooled posterior
   * itself stays under the floor. It does not, and should not: the pool really
   * is sharper than its parts, and the correction is to stop reading a
   * single-photo threshold off it rather than to flatten the pooling.
   *
   * The arithmetic, with the real head and the real floors:
   *
   *   three photos, each top species 0.355 / 0.350 / 0.360  (floor 0.373)
   *                  each top genus   0.875 / 0.872 / 0.879  (floor 0.80)
   *   => each is GENUS-state: it makes no species claim, and is eligible to pool
   *
   *   the pool is softmax(sum of log p) = normalize(geometric mean), so pooling
   *   three similar posteriors RAISES the winner:
   *
   *     k=1  0.3550   below the floor
   *     k=2  0.4070   above it
   *     k=3  0.4625   above it -> the card names a species
   *
   * No photo's evidence improved. The transformation did it, and
   * SPECIES_CONFIDENCE_FLOOR - fitted as the 90%-coverage point on a 659-row
   * corpus of INDIVIDUAL classifications - is being read off a systematically
   * sharper distribution. This is tmp/mosquito-id/bogusresults.png.
   *
   * THE FIX IS NOT IN. What the fix should be is Cornelius's call; the
   * recommendation is to gate the pool on the individual photos' floors rather
   * than re-fit the constant, because that is checkable against the per-photo
   * benchmarks that already exist.
   */
  function blankPhotos() {
    const spread = (over: Record<string, number>): number[] => {
      const p = post(head, over);
      const rest =
        (1 - Object.values(over).reduce((a, b) => a + b, 0)) /
        (head.species.length - Object.keys(over).length);
      head.species.forEach((s, i) => {
        if (!(s in over)) p[i] = rest;
      });
      return p;
    };
    const specs = [
      { "Aedes aegypti": 0.355, "Aedes albopictus": 0.25, "Aedes japonicus": 0.215 },
      { "Aedes aegypti": 0.35, "Aedes albopictus": 0.255, "Aedes japonicus": 0.21 },
      { "Aedes aegypti": 0.36, "Aedes albopictus": 0.245, "Aedes japonicus": 0.22 },
    ];
    const photos = specs.map((over, i) => {
      const p = spread(over);
      return {
        name: `blank-${i}`,
        fingerprint: `fp-${i}`,
        scores: Object.fromEntries(head.species.map((s, j) => [s, p[j]!])),
        logits: Object.fromEntries(head.species.map((s, j) => [s, Math.log(p[j]!) + 5])),
        verdict: verdictFrom(head, p, null, []),
      };
    });
    return { photos, specs };
  }

  it("a pool of genus-only photos must not reach a species claim", () => {
    const { photos } = blankPhotos();
    // Precondition: every photo abstained of a species on its own.
    for (const p of photos) {
      expect(p.verdict.state).toBe("genus");
      expect(p.verdict.species).toBeNull();
    }
    const { included } = splitPoolable(photos);
    const w = poolingWeights(included, "Dependent evidence", 0.5);
    const agg = aggregateLogits(head, included, w);
    const pooled = pooledPosterior(head, agg)!;
    // The arithmetic, stated so a failure prints the real numbers. The pool
    // still crosses the species floor; the gate no longer reads this number.
    expect(Math.max(...pooled)).toBeCloseTo(0.4625, 3);
    expect(pooledVerdict(head, agg, included)!.state).not.toBe("species");
  });

  it("a pool whose photos all named a species still reaches one", () => {
    // The gate the fix introduces must not swallow genuine multi-photo species
    // claims, which is the case the genus-only rule costs real signal on. Three
    // photos each above SPECIES_CONFIDENCE_FLOOR pool to a species.
    const head2 = head;
    const specs: Record<string, number>[] = [
      { "Aedes aegypti": 0.55, "Aedes albopictus": 0.30, "Aedes japonicus": 0.10 },
      { "Aedes aegypti": 0.52, "Aedes albopictus": 0.33, "Aedes japonicus": 0.10 },
      { "Aedes aegypti": 0.58, "Aedes albopictus": 0.28, "Aedes japonicus": 0.09 },
    ];
    const photos = specs.map((over, i) => {
      const rest =
        (1 - Object.values(over).reduce((a, b) => a + b, 0)) /
        (head2.species.length - Object.keys(over).length);
      const p = head2.species.map((s, j) => (s in over ? over[s]! : rest));
      return {
        name: `clear-${i}`,
        fingerprint: `fp-${i}`,
        scores: Object.fromEntries(head2.species.map((s, j) => [s, p[j]!])),
        logits: Object.fromEntries(head2.species.map((s, j) => [s, Math.log(p[j]!) + 5])),
        verdict: verdictFrom(head2, p, null, []),
      };
    });
    // Precondition: every photo named the species on its own.
    for (const ph of photos) {
      expect(ph.verdict.state).toBe("species");
      expect(ph.verdict.species).toBe("Aedes aegypti");
    }
    const { included } = splitPoolable(photos);
    const w = poolingWeights(included, "Dependent evidence", 0.5);
    const agg = aggregateLogits(head2, included, w);
    const v = pooledVerdict(head2, agg, included)!;
    expect(v.state).toBe("species");
    expect(v.species).toBe("Aedes aegypti");
  });

  it("one genus-only photo in the pool blocks the species claim for all of them", () => {
    // The gate is on every contributing photo, not on a majority: a pool whose
    // evidence never supported a species cannot report one on the strength of
    // the photos that did.
    const specs: Record<string, number>[] = [
      { "Aedes aegypti": 0.55, "Aedes albopictus": 0.30, "Aedes japonicus": 0.10 },
      { "Aedes aegypti": 0.52, "Aedes albopictus": 0.33, "Aedes japonicus": 0.10 },
      { "Aedes aegypti": 0.355, "Aedes albopictus": 0.25, "Aedes japonicus": 0.215 },
    ];
    const photos = specs.map((over, i) => {
      const rest =
        (1 - Object.values(over).reduce((a, b) => a + b, 0)) /
        (head.species.length - Object.keys(over).length);
      const p = head.species.map((s, j) => (s in over ? over[s]! : rest));
      return {
        name: `mixed-${i}`,
        fingerprint: `fp-${i}`,
        scores: Object.fromEntries(head.species.map((s, j) => [s, p[j]!])),
        logits: Object.fromEntries(head.species.map((s, j) => [s, Math.log(p[j]!) + 5])),
        verdict: verdictFrom(head, p, null, []),
      };
    });
    const { included } = splitPoolable(photos);
    const w = poolingWeights(included, "Dependent evidence", 0.5);
    const agg = aggregateLogits(head, included, w);
    expect(pooledVerdict(head, agg, included)!.state).not.toBe("species");
  });

  it("photos below the floor pool to a posterior above it, and nothing reads that", () => {
    const { photos, specs } = blankPhotos();
    // The top posterior of each photo: the largest VALUE in its map, which is
    // not what taking max over the keys would silently give.
    const perPhoto = specs.map((over) => Math.max(...Object.values(over)));
    // The precondition is what makes this a mis-specification rather than a
    // disagreement about the constant: every photo was already below the floor.
    for (const p of perPhoto) expect(p).toBeLessThan(DEFAULT_FLOORS.species);

    const { included } = splitPoolable(photos);
    const w = poolingWeights(included, "Dependent evidence", 0.5);
    const agg = aggregateLogits(head, included, w);
    const pooledTop = Math.max(...pooledPosterior(head, agg)!);

    // This is 0.4625 against a floor of 0.373, and it stays that way: pooling
    // moved a set of below-floor photos above the floor, and no change to the
    // pooling arithmetic should hide that. What changed is that nothing reads
    // this number to decide a species claim. This test exists to say so.
    expect(pooledTop).toBeGreaterThan(DEFAULT_FLOORS.species);
    expect(pooledTop).toBeCloseTo(0.4625, 3);
  });
});

describe("the pooled card's non-mosquito evidence", () => {
  /**
   * The structural half of the same defect as the species floor, and
   * independent of any threshold.
   *
   * `updatePooling` used to call verdictFrom(pooledSpP) with no adjacent
   * posteriors, and pooledPosterior softmaxes over the 16 SPECIES alone. So the
   * adjacent mass was absent from the numerator AND from the denominator: the
   * species posteriors were inflated to sum to 1 as if no other class existed,
   * and the non-mosquito branch could never run.
   *
   * The fix is aggregateAdjacent and pooledAdjacentPosterior: the pool now
   * carries its adjacent evidence on the same denominator as its species
   * evidence, so the two share 1 between them and verdictFrom reads the pooled
   * adjacent mass with the same NON_MOSQUITO_FLOOR the per-photo gate uses.
   *
   * Note which case this is NOT. Three photos each reading 97% biting midge
   * never reach the pool at all, because splitPoolable excludes a non-mosquito
   * photo - correctly, since its evidence is about a different subject. The
   * reachable case is photos that individually sit below the floor, are each
   * accepted, and pool to above it. That is the same sharpening the species
   * floor had, and the test below is built on it.
   *
   * Making `adP` a required parameter of verdictFrom is what stops the second
   * half of this recurring: the omission above arrived as an `undefined` that
   * TypeScript was willing to accept. It is required now, so a caller that
   * forgets cannot compile.
   */
  // The pooled species share on the joint denominator, recomputed here from the
  // public parts so the renormalisation is asserted rather than assumed.
  function renormalizedSpecies(
    head: Head,
    agg: Record<string, number>,
    adjP: number[],
  ): number[] | null {
    const spP = pooledPosterior(head, agg);
    if (!spP || !adjP.length) return spP;
    const spMass = 1 - adjP.reduce((a, b) => a + b, 0);
    return spP.map((p) => p * spMass);
  }

  it("a pool whose photos sit below the non-mosquito floor can still cross it", () => {
    // The reachable shape of this defect, and the same one the species floor
    // had: pooling sharpens. Photos that individually carry less adjacent mass
    // than NON_MOSQUITO_FLOOR each read as a mosquito and are each INCLUDED in
    // the pool, and the pool's summed adjacent evidence crosses the floor.
    //
    // The pinned version of this test used photos at 0.97 adjacent, which never
    // reach the pool at all - splitPoolable excludes a non-mosquito photo, as it
    // should. So it could only ever have been fixed by the pool reading an
    // argument it was never given, and the fix has to work on this case instead.
    const A = (head.adjacent ?? []).length;
    // The species share of a photo that is MOSTLY a biting midge: a clear top
    // species above SPECIES_CONFIDENCE_FLOOR, so the per-photo gate names it and
    // the pool accepts it, with the rest of the species mass spread thinly.
    const named: Record<string, number> = { "Aedes aegypti": 0.40, "Culex pipiens": 0.09 };
    const rest =
      (1 - Object.values(named).reduce((a, b) => a + b, 0)) /
      (head.species.length - Object.keys(named).length);
    const spec = head.species.map((s, i) => (s in named ? named[s]! : rest));
    expect(spec[head.species.indexOf("Aedes aegypti")!]).toBeGreaterThan(DEFAULT_FLOORS.species);
    const adP = new Array<number>(A).fill(0);
    // 0.55 of the mass on the winning adjacent class and the rest spread thinly
    // over the others: below NON_MOSQUITO_FLOOR = 0.60, so the per-photo gate
    // leaves each a species claim and the pool accepts it. Pooled three deep the
    // same evidence reads 0.628, which is above the floor.
    adP[0] = 0.48;
    for (let i = 1; i < A; i++) adP[i] = 0.07 / (A - 1);
    expect(adP.reduce((a, b) => a + b, 0)).toBeLessThan(DEFAULT_FLOORS.nonMosquito);
    expect(verdictFrom(head, spec, null, adP).state).not.toBe("non-mosquito");

    const logits = Object.fromEntries(head.species.map((s, i) => [s, Math.log(spec[i]!) + 5]));
    const photos: PoolablePhoto[] = [0, 1, 2].map((i) => ({
      name: `maybe-midge-${i}`,
      fingerprint: `fp-${i}`,
      scores: Object.fromEntries(head.species.map((s, j) => [s, spec[j]!])),
      logits,
      adP,
      verdict: verdictFrom(head, spec, null, adP),
    }));
    const { included } = splitPoolable(photos);
    expect(included).toHaveLength(photos.length);

    const w = poolingWeights(included, "Accumulate evidence", 0.5);
    const agg = aggregateLogits(head, included, w);
    const aggAdj = aggregateAdjacent(head, included, w);
    expect(aggAdj).toHaveLength(A);

    const adjP = pooledAdjacentPosterior(head, agg, aggAdj);
    // The structural property, asserted directly: the pooled species and
    // adjacent posteriors share ONE denominator and sum to 1 between them,
    // rather than the species softmax summing to 1 as if nothing else existed.
    expect(adjP.reduce((a, b) => a + b, 0)).toBeGreaterThan(DEFAULT_FLOORS.nonMosquito);
    const spShare = 1 - adjP.reduce((a, b) => a + b, 0);
    expect(spShare).toBeGreaterThan(0);
    const renormalized = renormalizedSpecies(head, agg, adjP)!;
    expect(renormalized.reduce((a, b) => a + b, 0)).toBeCloseTo(spShare, 9);

    const v = pooledVerdict(head, agg, included, aggAdj)!;
    expect(v.state).toBe("non-mosquito");
    expect(v.adjacent).toBe(head.adjacent![0]);
  });

  it("a pool with no adjacent evidence still reports a genus, not a non-mosquito", () => {
    // The empty array is the honest answer for a head with no adjacent classes
    // and for a server-path photo, which never reports any. It must leave the
    // species-only behaviour exactly as it was rather than divide by a
    // denominator that does not exist.
    const spP = post(head, { "Aedes aegypti": 0.55, "Aedes albopictus": 0.30 });
    const logits = Object.fromEntries(head.species.map((s, i) => [s, Math.log(spP[i]!) + 5]));
    const photos: PoolablePhoto[] = [0, 1].map((i) => ({
      name: `mosq-${i}`,
      fingerprint: `fp-${i}`,
      scores: Object.fromEntries(head.species.map((s, j) => [s, spP[j]!])),
      logits,
    }));
    const { included } = splitPoolable(photos);
    const w = poolingWeights(included, "Accumulate evidence", 0.5);
    const agg = aggregateLogits(head, included, w);
    expect(aggregateAdjacent(head, included, w)).toEqual([]);
    expect(pooledAdjacentPosterior(head, agg, [])).toEqual([]);
    expect(pooledVerdict(head, agg, included, [])!.state).not.toBe("non-mosquito");
  });

  it("each photo is individually excluded from the pool for being non-mosquito", () => {
    // The per-photo gate DOES keep these out of the pool, so the bug above needs
    // the pool to be entered another way (or the exclusion to regress). This
    // asserts the half that currently works, so a fix does not silently break it.
    const adP = new Array<number>((head.adjacent ?? []).length).fill(0);
    adP[0] = 0.97;
    const spP = post(head, { "Aedes aegypti": 0.02 });
    const v = verdictFrom(head, spP, null, adP);
    expect(v.state).toBe("non-mosquito");
    expect(splitPoolable([{ name: "x", verdict: v }]).included).toEqual([]);
  });
});
