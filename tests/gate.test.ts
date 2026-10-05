// The 23 assertions from tests/gate.test.mjs, ported verbatim.
//
// That file lifted function bodies out of main.js by reading it as text and
// eval-ing them, which is why three agents could read this arithmetic for hours
// without being able to run it. The logic is unchanged; only the access changed:
// these are imports of real modules, so a change to the shipped code and a
// change to these expectations cannot drift apart silently.
//
// Each test below names the original check() it came from. Where a check made a
// claim about the shipped CONSTANTS, that is kept: reading the floors out of the
// module rather than restating them is the property the original was testing.
import { describe, it, expect, beforeAll } from "vitest";
import { realHead, post, adjPost, AD, S } from "./fixtures";
import type { Head } from "../src/confidence/types";
import { DEFAULT_FLOORS } from "../src/confidence/types";
import { genusOf, speciesGenusIndex } from "../src/confidence/genus";
import { fuseViews } from "../src/confidence/fuseViews";
import { verdictFrom, verdictSentence } from "../src/confidence/verdict";
import { viewAgreement } from "../src/confidence/viewAgreement";

let head: Head;

beforeAll(() => {
  head = realHead();
});

// A view whose posteriors and nuisance mass SUM TO 1, because that is what one
// softmax over the species, nuisance and adjacent rows produces and what
// fuseViews' log-linear pooling assumes. `post()` leaves the species vector
// short of 1 by whatever the fixture does not assign, and that remainder used to
// go nowhere because nothing read it - `nuTotal: 1e-6` stood in for "essentially
// no nuisance". It is real evidence now: the gate reads the nuisance block, and a
// view that assigns 10% of its mass to a species and 0.1 to nuisance is a photo
// the model would score as a nuisance photo. So the remainder is distributed over
// the species the fixture left at zero, which is where a softmax puts it.
const view = (over: Record<string, number>) => {
  const spP = post(head, over);
  const short = 1 - spP.reduce((a, b) => a + b, 0);
  const missing = spP.map((p, i) => (p === 0 ? i : -1)).filter((i) => i >= 0);
  const each = missing.length ? short / missing.length : 0;
  for (const i of missing) spP[i] = each;
  return {
    spP,
    nuTotal: 1e-6,
    scale: DEFAULT_FLOORS ? head.logit_scale / 2.5 : 0,
  };
};

describe("genus derivation", () => {
  it("genusOf splits on whitespace, so an epithet with a slash stays inside its genus", () => {
    expect(genusOf("Culiseta annulata/morsitans")).toBe("Culiseta");
    expect(genusOf("Anopheles maculipennis complex")).toBe("Anopheles");
    expect(genusOf("Aedes aegypti")).toBe("Aedes");
    expect(genusOf("  Aedes   aegypti  ")).toBe("Aedes");
    // A bare genus is its own genus, not the empty string.
    expect(genusOf("Aedes")).toBe("Aedes");
  });

  it("every shipping species lands in a genus with at least one member", () => {
    const idx = speciesGenusIndex(head);
    expect(head.species.length).toBe(S(head));
    expect([...idx.values()].every((m) => m.length >= 1)).toBe(true);
    expect([...idx.values()].flat().sort((a, b) => a - b).join(",")).toBe(
      [...Array(S(head)).keys()].join(","),
    );
  });
});

describe("the three states", () => {
  it("posterior above the species floor returns its argmax", () => {
    const v = verdictFrom(
      head,
      post(head, { "Aedes aegypti": 0.4, "Aedes albopictus": 0.35, "Culex pipiens": 0.25 }),
    null, []);
    expect(v.state).toBe("species");
    expect(v.species).toBe("Aedes aegypti");
    expect(v.genus).toBe("Aedes");
    expect(verdictSentence(v)).toBe(""); // nothing to add over the ranking
  });

  it("posterior exactly at the species floor still answers (>=, not >)", () => {
    const v = verdictFrom(head, post(head, { "Aedes aegypti": DEFAULT_FLOORS.species }), null, []);
    expect(v.state).toBe("species");
    expect(v.species).toBe("Aedes aegypti");
  });

  it("a spread posterior inside one genus gives genus-only, not a species", () => {
    // Top species 0.30 (below 0.373), but the three Aedes sum to 0.90.
    const v = verdictFrom(
      head,
      post(head, {
        "Aedes aegypti": 0.3,
        "Aedes albopictus": 0.35,
        "Aedes japonicus": 0.25,
        "Culex pipiens": 0.1,
      }),
    null, []);
    expect(v.state).toBe("genus");
    expect(v.genus).toBe("Aedes");
    expect(v.species).toBeNull();
    expect(v.topGenusP).toBeCloseTo(0.9, 9);
  });

  it("genus-only sentence names the runners-up, genus prefix stripped", () => {
    const v = verdictFrom(
      head,
      post(head, { "Aedes aegypti": 0.3, "Aedes albopictus": 0.35, "Aedes vexans": 0.25 }),
    null, []);
    // albopictus leads at 0.35 - under the species floor - and the two runners-up
    // are named in descending order after it.
    expect(verdictSentence(v)).toBe(
      "Definitely Aedes - most likely albopictus, possibly aegypti or vexans"
    );
    // Runners-up are siblings of the genus, never a species from another genus.
    expect(v.runnersUp.every((r) => genusOf(r.name) === "Aedes")).toBe(true);
  });

  it("below both floors the verdict is not confident", () => {
    const v = verdictFrom(
      head,
      post(head, { "Aedes aegypti": 0.1, "Culex pipiens": 0.2, "Culiseta annulata": 0.15 }),
    null, []);
    expect(v.state).toBe("unsure");
    expect(v.genus).toBeNull();
    expect(v.species).toBeNull();
    // Still an abstention, and it now says what it is torn between: a fixed line
    // is true of every unconfident photo and so says nothing about any of them.
    expect(verdictSentence(v)).toMatch(/^Not confident enough to name a genus/);
    expect(verdictSentence(v)).toContain("pipiens");
    expect(verdictSentence(v)).toContain("annulata");
  });

  it("a genus below the genus floor is not claimed even when a genus leads", () => {
    // No genus sums to 0.54: Culex leads at 0.45, Aedes at 0.35, Culiseta at 0.20.
    const p = post(head, {
      "Aedes aegypti": 0.2,
      "Aedes albopictus": 0.15,
      "Culex pipiens": 0.25,
      "Culex torrentium": 0.2,
      "Culiseta annulata": 0.2,
    });
    const v = verdictFrom(head, p, null, []);
    expect(v.topGenusP).toBeCloseTo(0.45, 9);
    expect(v.state).toBe("unsure");
    // A wrong genus is worse than no genus, so the leading genus is not named.
    expect(v.genus).toBeNull();
  });

  it("an empty posterior degrades to not confident rather than throwing", () => {
    expect(verdictFrom(head, [], null, []).state).toBe("unsure");
    expect(verdictFrom(head, null as unknown as number[], null, []).state).toBe("unsure");
  });
});

describe("the gate reads the fused posterior", () => {
  it("the gate is applied to the fused posterior, not per view", () => {
    const viewA = view({ "Aedes aegypti": 0.34, "Aedes albopictus": 0.33, "Culex pipiens": 0.33 });
    const viewB = view({ "Aedes aegypti": 0.85, "Aedes albopictus": 0.1, "Culex pipiens": 0.05 });
    // View A alone tops out at 0.34, under the species floor, so gating per view
    // would decline to answer it. View B alone answers. The photo is answered on
    // the pool of the two, which is the only place the gate may be applied.
    const alone = fuseViews(head, [viewA]);
    expect(alone!.verdict.state).not.toBe("species");
    expect(fuseViews(head, [viewB])!.verdict.state).toBe("species");
    // B first because that is the order every caller uses (crop, then whole
    // frame). Pooling is commutative, so the answer does not depend on it - but
    // keeping the caller's order means this test exercises the same call shape
    // the app makes.
    const fused = fuseViews(head, [viewB, viewA]);
    expect(fused!.verdict.state).toBe("species");
    expect(fused!.verdict.species).toBe("Aedes aegypti");
    // And it is the fused posterior, not view B copied through.
    expect(fused!.verdict.topSpeciesP).not.toBe(viewB.spP[1]);
  });

  it("the fused verdict is not recomputed from any single view's posterior", () => {
    const a = view({ "Culex pipiens": 0.9 });
    const b = view({ "Aedes aegypti": 0.9 });
    // Two disagreeing views pool to a near-tie at genus level: not confident.
    const fused = fuseViews(head, [a, b]);
    expect(fused!.verdict.state).toBe("unsure");
    // Two views disagreeing cost confidence, which is what the gate exists for.
    expect(Math.abs(fused!.verdict.topGenusP - 0.5)).toBeGreaterThan(1e-6);
  });
});

describe("a disagreement between the views costs the photo its species claim", () => {
  it("two views naming different species cannot reach a species verdict, however high the fused posterior", () => {
    const fused = fuseViews(head, [
      // Two confident-but-disagreeing views, which is the case the veto is
      // about.
      view({ "Aedes aegypti": 0.85, "Aedes albopictus": 0.1, "Culex pipiens": 0.05 }),
      view({ "Aedes albopictus": 0.85, "Aedes aegypti": 0.1, "Culex pipiens": 0.05 }),
    ]);
    expect(fused!.verdict.topSpeciesP).toBeGreaterThan(DEFAULT_FLOORS.species);
    expect(fused!.verdict.topGenusP).toBeGreaterThan(DEFAULT_FLOORS.genus);
    expect(fused!.agreement!.agree).toBe(false);
    expect(fused!.verdict.state).not.toBe("species");
    expect(fused!.verdict.genus).toBe("Aedes");
    expect(fused!.verdict.species).toBeNull();
  });

  it("the same posterior with agreeing views still names its species", () => {
    // One posterior, two verdicts: the ONLY difference is the agreement object.
    const spP = post(head, { "Aedes aegypti": 0.45, "Aedes albopictus": 0.4, "Culex pipiens": 0.15 });
    expect(verdictFrom(head, spP, { agree: true } as never, []).state).toBe("species");
    expect(verdictFrom(head, spP, { agree: false } as never, []).state).toBe("genus");
    // No agreement at all - one view, or a pool of photos - is not a disagreement.
    expect(verdictFrom(head, spP, null, []).state).toBe("species");
    expect(verdictFrom(head, spP, null, []).state).toBe("species");
  });

  it("a disagreement can also take the photo all the way to unsure", () => {
    // The demotion falls into the genus floor rather than past it.
    const spP = post(head, { "Aedes aegypti": 0.4, "Aedes albopictus": 0.15, "Culex pipiens": 0.45 });
    expect(verdictFrom(head, spP, { agree: true } as never, []).species).toBe("Culex pipiens");
    const v = verdictFrom(head, spP, { agree: false } as never, []);
    expect(v.state).toBe("unsure");
    expect(verdictSentence(v)).toMatch(/^Not confident enough to name a genus/);
  });

  it("the disagreement measure is computed once, by fuseViews, and is the same object", () => {
    const views = [
      // Disagreeing. The router reads `viewResults[0]` alone - always the crop -
      // so the crop at 0.85 has to be confident for
      // this pair to reach the pooling at all; the second view's own posterior is
      // irrelevant to that branch. The measure is computed once over the views
      // that were pooled, which is the point being pinned.
      view({ "Aedes aegypti": 0.85, "Aedes albopictus": 0.1, "Culex pipiens": 0.05 }),
      view({ "Aedes aegypti": 0.6, "Aedes albopictus": 0.35, "Culex pipiens": 0.05 }),
    ];
    const fused = fuseViews(head, views);
    expect(fused!.agreement).toEqual(
      viewAgreement(
        head,
        views.map((v) => v.spP),
        fused!.spP,
      ),
    );
    // One view cannot disagree with itself, so the gate is inert there.
    expect(fuseViews(head, [views[0]!])!.agreement).toBeNull();
    expect(fuseViews(head, [views[0]!])!.verdict.state).toBe("species");
  });
});

describe("the non-mosquito state", () => {
  it("a heavy adjacent posterior names a non-mosquito instead of a species", () => {
    const v = verdictFrom(
      head,
      post(head, { "Aedes aegypti": 0.99 }),
      { agree: true } as never,
      adjPost(head, { 0: 0.95 }),
);
    expect(v.state).toBe("non-mosquito");
    expect(v.adjacent).toBe(head.adjacent![0]);
    // The sentence names the plain-language subject, which is the whole point.
    const sent = verdictSentence(v);
    expect(sent).toContain(head.adjacent_common![0]!);
    expect(sent).toMatch(/does not look like a mosquito/i);
  });

  it("the non-mosquito state outranks a species claim, not just an unsure one", () => {
    // The defect this state exists for: a confident, well-separated mosquito
    // posterior alongside a big non-mosquito one must not render a ranking.
    const v = verdictFrom(
      head,
      post(head, { "Aedes aegypti": 0.999 }),
      { agree: true } as never,
      adjPost(head, { 2: 0.9 }),
);
    expect(v.state).toBe("non-mosquito");
  });

  it("a small adjacent mass leaves the photo's own verdict alone", () => {
    const v = verdictFrom(
      head,
      post(head, { "Aedes aegypti": 0.99 }),
      { agree: true } as never,
      adjPost(head, { 0: 0.05 }),
);
    expect(v.state).toBe("species");
    expect(v.species).toBe("Aedes aegypti");
  });

  it("no adjacent classes supplied means the gate cannot fire", () => {
    const v = verdictFrom(
      head,
      post(head, { "Aedes aegypti": 0.99 }),
      { agree: true } as never,
      [],
    );
    expect(v.state).toBe("species");
  });

  it("views that scored no adjacent classes pool to none, not to a flat split", () => {
    // The masses have to sum to 1 across the three groups, because that is what a
    // real softmax produces: 0.8 mosquito + 0.2 nuisance is one view's answer.
    // Species 0.8, nuisance 0.1, adjacent 0.1: the three blocks summing to 1, which
    // is what a real view's joint softmax produces.
    const views = [
      {
        spP: post(head, { "Aedes aegypti": 0.8 }),
        nuTotal: 0.1,
        adP: adjPost(head, { 0: 0.1 }),
        scale: 100,
      },
    ];
    // One view, so the pool is that view's own answer: the 0.1 of mass the adjacent
    // class carries survives as 0.1.
    const withAd = fuseViews(head, views);
    expect(withAd!.adP[0]).toBeCloseTo(0.1, 6);
    // The same view without the adjacent class: its 0.1 of adjacent mass becomes
    // nuisance mass, because the three blocks have to sum to 1 and this one left a
    // gap. The claim under test is that no adjacent posteriors were INVENTED, not
    // that the nuisance floor was never crossed.
    const noAd = fuseViews(head, [
      { spP: post(head, { "Aedes aegypti": 0.8 }), nuTotal: 0.2, scale: 100 },
    ]);
    expect(noAd!.adP).toEqual([]);
  });

  it("the non-mosquito floor is the shipped one", () => {
    expect(DEFAULT_FLOORS.nonMosquito).toBe(0.6);
  });

  it("the veto flag is the shipped one, not a local copy", () => {
    expect(DEFAULT_FLOORS.viewDisagreementVetoesSpecies).toBe(true);
  });
});

describe("the pooled card is not corrupted by an unsure photo", () => {
  it("keeps the genus-only photo at full weight and the unsure one below it", async () => {
    const { splitPoolable, unsurePoolWeight, UNSURE_POOL_WEIGHT_CAP } =
      await import("../src/confidence/pooling");
    const keep = verdictFrom(head, post(head, { "Aedes aegypti": 0.8 }), null, []);
    const coarse = verdictFrom(
      head,
      post(head, { "Aedes aegypti": 0.3, "Aedes albopictus": 0.35, "Aedes vexans": 0.25 }),
null, []);
    const drop = verdictFrom(
      head,
      post(head, { "Aedes aegypti": 0.1, "Culex pipiens": 0.2, "Culiseta annulata": 0.15 }),
    null, []);
    const { included, excluded } = splitPoolable([
      { name: "a", verdict: keep },
      { name: "b", verdict: coarse },
      { name: "c", verdict: drop },
    ]);
    expect(included.map((p) => p.verdict!.state)).toEqual(["species", "genus", "unsure"]);
    expect(excluded).toEqual([]);
    // The unsure photo is in the sum, but only up to the top posterior it
    // reached - 0.2 here, and never more than a photo that just missed naming.
    const unsure = included.find((p) => p.name === "c")!;
    expect(unsure.poolWeight).toBeCloseTo(0.2, 12);
    expect(unsure.poolWeight).toBeLessThan(UNSURE_POOL_WEIGHT_CAP);
    expect(unsurePoolWeight({ verdict: drop })).toBeCloseTo(0.2, 12);
    // It is the pool's SPECIES claim that it can never support: pooledVerdict
    // requires every photo in the pool to have claimed a species, so its
    // presence caps the claim at a genus. The claim the app had already
    // declined to make is not made by pooling.
    expect(included.some((p) => p.verdict === drop)).toBe(true);
    expect(included.filter((p) => p.verdict!.state === "species")).not.toContain(unsure);
  });
});

describe("adjacent class count", () => {
  it("the head carries adjacent classes at all", () => {
    expect(AD(head)).toBeGreaterThan(0);
  });
});

describe("the genus sentence ranks the species it is uncertain between", () => {
  // `runnersUp` holds every sibling EXCEPT the winner, so a sentence built from
  // its head names the second and third place and never mentions the most likely
  // species. The sentence is the one line that ranks them, so dropping the top of
  // the ranking makes a 3-way call read as a tie between the two least likely.
  //
  // Each case puts every species of one genus above the genus floor and under the
  // species floor, which is the ordinary genus-only outcome.

  it("leads with the most likely species, not a runner-up", () => {
    const v = verdictFrom(
      head,
      post(head, { "Aedes albopictus": 0.355, "Aedes aegypti": 0.30, "Aedes koreicus": 0.245 }),
      null, [],
    );
    expect(v.state).toBe("genus");
    expect(v.genus).toBe("Aedes");
    // `species` is the CLAIM and stays null: nothing cleared the species floor.
    expect(v.species).toBeNull();
    // `topSpecies` is the LEADER, and is what the sentence ranks from.
    expect(v.topSpecies).toBe("Aedes albopictus");
    expect(verdictSentence(v)).toBe(
      "Definitely Aedes - most likely albopictus, possibly aegypti or koreicus"
    );
  });

  it("names every species the ranking shows, in descending order", () => {
    const v = verdictFrom(
      head,
      post(head, { "Aedes albopictus": 0.355, "Aedes aegypti": 0.30, "Aedes koreicus": 0.245 }),
      null, [],
    );
    const said = verdictSentence(v);
    const at = [said.indexOf("albopictus"), said.indexOf("aegypti"), said.indexOf("koreicus")];
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("clears the species floor into the species sentence, which names the winner", () => {
    // The sibling case: once the top species passes SPECIES_CONFIDENCE_FLOOR the
    // sentence is empty and the ranking carries it, so `species` on the verdict
    // is what this fix reads. Assert it here so the two states cannot diverge.
    const v = verdictFrom(head, post(head, { "Aedes albopictus": 0.85 }), null, []);
    expect(v.state).toBe("species");
    expect(v.topSpecies).toBe("Aedes albopictus");
    expect(verdictSentence(v)).toBe("");
  });
});
