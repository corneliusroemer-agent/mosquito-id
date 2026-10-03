// The non-mosquito gate, and what it says.
//
// The gate is checked FIRST, on purpose: "this is not a mosquito" is a claim
// about the photograph, so it has to outrank every species claim rather than sit
// beside one.
//
// It used to read the ADJACENT block only. That block is seven Diptera families
// that a non-expert reads as a mosquito, so it carries "this is a different
// insect". The NUISANCE block - eight rows that are literally photographs of
// walls, hands, plants and empty backgrounds - went unread, so the one class of
// photo that most needs rejecting had no path to rejection. A blank piece of
// paper could be named a species.
//
// The two blocks are NOT interchangeable, and neither is a plain sum of them:
//
//   adjacent  "this is a different insect" - a midge photo arguably SHOULD be
//             answered as a midge, so it needs a name the user can act on.
//   nuisance  "there is nothing mosquito-like here" - there is no family to
//             name, so it needs a sentence that says so instead of inventing one.
//
// So they get separate floors, separate fields on the verdict, and separate
// sentences. Measurements for every number quoted here are in
// investigations/2026-10-04-score-hardening/.
import { describe, it, expect, beforeAll } from "vitest";
import { realHead, post, adjPost, nuPost, splitHead, splitEmb, AD, NU, S } from "./fixtures";
import type { Head, Verdict } from "../src/confidence/types";
import { DEFAULT_FLOORS } from "../src/confidence/types";
import { softmaxJoint } from "../src/confidence/softmax";
import { verdictFrom, verdictSentence, nonMosquitoGate, nonMosquitoLabel } from "../src/confidence/verdict";

let head: Head;
beforeAll(() => {
  head = realHead();
});

const agree = { agree: true } as never;

describe("block sizes, pinned", () => {
  // A class moving between the two blocks changes what the gate reads and what
  // the sentence can name, and nothing else in the codebase would notice. These
  // are the numbers the shipped embeds file carries.
  it("the head carries 16 species, 8 nuisance and 7 adjacent rows", () => {
    expect(S(head)).toBe(16);
    expect(NU(head)).toBe(8);
    expect(AD(head)).toBe(7);
  });

  it("the nuisance rows are the non-insect photographs, not the insect families", () => {
    // Every nuisance label describes something that is not an insect. If one of
    // these were a family name it would belong in `adjacent` instead, where the
    // gate can name it.
    expect(head.nuisance!.every((n) => /^a photograph of /.test(n))).toBe(true);
    expect(head.nuisance).toContain("a photograph of a wall");
    expect(head.nuisance).toContain("a photograph of an empty background");
    expect(head.adjacent!.every((n) => /idae$/.test(n))).toBe(true);
  });

  it("softmaxJoint indexes the two blocks without overlapping the species", () => {
    const h = splitHead(["Aedes aegypti", "Culex pipiens"], ["a photograph of a wall"], ["Chironomidae"]);
    const j = softmaxJoint(h, splitEmb(h, "species", 0), { offsets: {} });
    expect(j.spP).toHaveLength(S(h));
    expect(j.nuP).toHaveLength(NU(h));
    expect(j.adP).toHaveLength(AD(h));
    // One softmax over all three: the three blocks sum to 1 between them.
    const total = j.spP.reduce((a, b) => a + b, 0) + j.nuP.reduce((a, b) => a + b, 0)
      + j.adP.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 12);
  });
});

describe("the gate reads the nuisance block", () => {
  // The defect: high nuisance, low adjacent. Before the fix the adjacent mass
  // was the only thing read, so this photo was named a species.
  it("a photo scoring high on nuisance and low on adjacent is not a mosquito", () => {
    const h = splitHead(
      ["Aedes aegypti", "Culex pipiens"],
      ["a photograph of a wall"],
      ["Chironomidae"],
    );
    const j = softmaxJoint(h, splitEmb(h, "nuisance", 0), { offsets: {} });
    expect(j.nuP[0]).toBeGreaterThan(DEFAULT_FLOORS.nuisance);
    expect(j.adP.reduce((a, b) => a + b, 0)).toBeLessThan(DEFAULT_FLOORS.nonMosquito);

    const v = verdictFrom(h, j.spP, agree, j.adP, DEFAULT_FLOORS, j.nuP);
    expect(v.state).toBe("non-mosquito");
    expect(v.species).toBeNull();
    expect(v.genus).toBeNull();
  });

  it("the nuisance verdict names what was seen instead of guessing a family", () => {
    // The distinction the coordinator asked for: a midge photo gets a family, a
    // wall photo must not, because there is no family to name.
    const h = splitHead(
      ["Aedes aegypti", "Culex pipiens"],
      ["a photograph of a wall", "a photograph of an empty background"],
      ["Chironomidae"],
    );
    const v = verdictFrom(h, softmaxJoint(h, splitEmb(h, "nuisance", 0), { offsets: {} }).spP,
      agree,
      [0],
      DEFAULT_FLOORS,
      nuPost(h, { 0: 0.9 }),
    );
    expect(v.state).toBe("non-mosquito");
    expect(v.nuisance).toBe("a photograph of a wall");
    // No family named: the photo is of a wall, and Chironomidae would be a guess.
    expect(v.adjacent).toBeUndefined();
    expect(v.adjacentCommon).toBeUndefined();
    const sent = verdictSentence(v);
    expect(sent).toMatch(/no mosquito/i);
    expect(sent).toContain("a photograph of a wall");
    expect(sent).not.toContain("Chironomidae");
  });

  it("a photo scoring high on adjacent still names the family", () => {
    // The other half of the distinction, and the case the gate already handled:
    // a midge is a real answer, so it is reported as one.
    const h = splitHead(
      ["Aedes aegypti", "Culex pipiens"],
      ["a photograph of a wall"],
      ["Chironomidae"],
    );
    const v = verdictFrom(h, post(h, { "Aedes aegypti": 0.99 }), agree,
      adjPost(h, { 0: 0.9 }), DEFAULT_FLOORS, []);
    expect(v.state).toBe("non-mosquito");
    expect(v.adjacent).toBe("Chironomidae");
    expect(v.nuisance).toBeUndefined();
    expect(verdictSentence(v)).toMatch(/biting midge|does not look like a mosquito/i);
  });

  it("the two blocks report independently, and the stronger one is chosen", () => {
    // Both blocks can clear on one photo - a hand holding a midge. Whichever is
    // stronger is the better answer, and the sentence has to match it.
    const h = splitHead(
      ["Aedes aegypti", "Culex pipiens"],
      ["a photograph of a hand"],
      ["Chironomidae"],
    );
    const v = verdictFrom(h, post(h, { "Aedes aegypti": 0.9 }), agree,
      adjPost(h, { 0: 0.95 }), DEFAULT_FLOORS, nuPost(h, { 0: 0.2 }));
    expect(v.state).toBe("non-mosquito");
    expect(v.adjacent).toBe("Chironomidae");
    expect(v.nuisance).toBeUndefined();

    const v2 = verdictFrom(h, post(h, { "Aedes aegypti": 0.9 }), agree,
      adjPost(h, { 0: 0.3 }), DEFAULT_FLOORS, nuPost(h, { 0: 0.6 }));
    expect(v2.state).toBe("non-mosquito");
    expect(v2.nuisance).toBe("a photograph of a hand");
    expect(v2.adjacent).toBeUndefined();
  });
});

describe("the fix does not make the app abstain from everything", () => {
  it("low nuisance AND low adjacent still returns a species", () => {
    const v = verdictFrom(head, post(head, { "Aedes aegypti": 0.85 }), agree,
      adjPost(head, { 0: 0.01 }), DEFAULT_FLOORS, nuPost(head, { 0: 0.01 }));
    expect(v.state).toBe("species");
    expect(v.species).toBe("Aedes aegypti");
  });

  it("low nuisance AND low adjacent still returns a genus when the species is soft", () => {
    const v = verdictFrom(head, post(head, { "Aedes aegypti": 0.3, "Aedes albopictus": 0.35, "Aedes vexans": 0.25 }),
      agree, adjPost(head, { 0: 0 }), DEFAULT_FLOORS, nuPost(head, { 0: 0 }));
    expect(v.state).toBe("genus");
    expect(v.genus).toBe("Aedes");
    // Unchanged: a genus verdict still does not CLAIM a species.
    expect(v.species).toBeNull();
  });

  it("no nuisance and no adjacent evidence means the gate cannot fire", () => {
    const v = verdictFrom(head, post(head, { "Aedes aegypti": 0.9 }), agree, [], DEFAULT_FLOORS, []);
    expect(v.state).toBe("species");
  });
});

describe("the extracted gate", () => {
  it("is a pure function of the two blocks and the floors", () => {
    const g = nonMosquitoGate(head, adjPost(head, { 3: 0.9 }), nuPost(head, { 2: 0.01 }), DEFAULT_FLOORS)!;
    expect(g.kind).toBe("adjacent");
    expect(g.name).toBe(head.adjacent![3]);
    expect(g.p).toBeCloseTo(0.9, 9);

    const n = nonMosquitoGate(head, adjPost(head, { 3: 0.01 }), nuPost(head, { 2: 0.9 }), DEFAULT_FLOORS)!;
    expect(n.kind).toBe("nuisance");
    expect(n.name).toBe(head.nuisance![2]);

    expect(nonMosquitoGate(head, adjPost(head, { 3: 0.01 }), nuPost(head, { 2: 0.01 }), DEFAULT_FLOORS)).toBeNull();
    expect(nonMosquitoGate(head, [], [], DEFAULT_FLOORS)).toBeNull();
  });

  it("respects each block's own floor rather than one shared number", () => {
    // Nuisance mass on real mosquitoes tops out at 0.204 and on the negatives at
    // 0.498, so a 0.60 floor on this block could never fire at all. Its floor is
    // its own number for that reason; this pins that the two are independent.
    expect(DEFAULT_FLOORS.nuisance).not.toBe(DEFAULT_FLOORS.nonMosquito);
    const loose = { ...DEFAULT_FLOORS, nonMosquito: 0.05 };
    const adHigh = nonMosquitoGate(head, adjPost(head, { 0: 0.9 }), [], loose)!;
    expect(adHigh.kind).toBe("adjacent");
    // Raising only the nuisance floor cannot affect an adjacent-only verdict.
    const tight = { ...DEFAULT_FLOORS, nuisance: 0.99 };
    expect(nonMosquitoGate(head, adjPost(head, { 0: 0.9 }), [], tight)!.kind).toBe("adjacent");
  });

  it("reports the winning class's own posterior, not the block mass", () => {
    const g = nonMosquitoGate(head, adjPost(head, { 0: 0.4, 1: 0.3 }), [], DEFAULT_FLOORS);
    expect(g!.kind).toBe("adjacent");
    expect(g!.p).toBeCloseTo(0.4, 9);
    expect(g!.mass).toBeCloseTo(0.7, 9);
  });
});

describe("the floors are separate numbers for separate claims", () => {
  it("nonMosquito stays at the shipped 0.60", () => {
    // Adjacent mass: p99 on the 6,264 in-domain mosquitoes is 0.31, so 0.60 costs
    // 15 of them (0.24%) and catches 11 of 700 true negatives.
    expect(DEFAULT_FLOORS.nonMosquito).toBe(0.6);
  });

  it("nuisance is the measured 0.05, not the adjacent 0.60", () => {
    // Nuisance MASS never reaches 0.60 on anything measured: max 0.498 over 700
    // true negatives, max 0.204 over 6,264 true mosquitoes. At 0.05 the block
    // adds 69 true negatives for 15 more lost mosquitoes; at 0.60 it is inert.
    expect(DEFAULT_FLOORS.nuisance).toBe(0.05);
  });

  it("a nuisance floor of 0.60 is out of reach on a gentle head, which is why it is not used", () => {
    // Pinned as a fact about the arithmetic, not a claim about intent. logit_scale
    // 1 gives a posterior a gentle function of the cosine, and even a nuisance row
    // scored at cosine 1 against species rows at cosine 0 takes only ~0.33 - the
    // shape of the real data, where nuisance mass peaks at 0.498 over 700 true
    // negatives. A 0.60 floor on this block would be a floor nothing reaches.
    const h = splitHead(["Aedes aegypti"], ["a photograph of a wall"], ["Chironomidae"], 1);
    const j = softmaxJoint(h, splitEmb(h, "nuisance", 0), { offsets: {} });
    expect(j.nuP[0]).toBeGreaterThan(0);
    expect(j.nuP[0]).toBeLessThan(DEFAULT_FLOORS.nonMosquito);
    // And the gate that actually ships does fire on it.
    expect(nonMosquitoGate(h, [], j.nuP, DEFAULT_FLOORS)!.kind).toBe("nuisance");
  });
});

/**
 * A head whose non-species blocks are mostly placeholders.
 *
 * culico-net-cls-v1 is a 16-row linear probe whose graph appends a constant
 * coordinate for the intercept, so `Head.biasIndex` points at the last one and
 * the other fifteen classes it carries were never fitted. Modelling that shape
 * here rather than reaching for the shipped file keeps this about the rule; the
 * shipped file's own shape is pinned separately below.
 *
 *   dim 4, bias at index 3. Species rows on 0 and 1; every nuisance row and the
 *   first two adjacent rows are (0,0,0,-20) - constants; the third adjacent row
 *   is (0,0,1,-20) - the one row that can tell a photograph from another.
 */
function placeholderHead(): Head {
  const rows = (r: number[][]): number[] => r.flat();
  const species_emb = rows([[1, 0, 0, 0], [0, 1, 0, 0]]);
  const nuisance_emb = rows([[0, 0, 0, -20], [0, 0, 0, -20]]);
  const adjacent_emb = rows([[0, 0, 0, -20], [0, 0, 0, -20], [0, 0, 1, -20]]);
  return {
    species: ["Aedes aegypti", "Culex pipiens"],
    nuisance: ["a photograph of a wall", "a photograph of a hand"],
    adjacent: ["Ceratopogonidae", "Chironomidae", "a photograph without a mosquito"],
    adjacent_common: ["a biting midge", "a non-biting midge", "a photo with no mosquito in it"],
    dim: 4,
    logit_scale: 1,
    biasIndex: 3,
    species_emb,
    nuisance_emb,
    adjacent_emb,
  };
}

describe("a block of placeholders is not a detector", () => {
  // The defect. A placeholder row scores the same on every photograph, so its
  // posterior rises exactly when the classifier is unsure. Read as evidence, a
  // block of them fires the gate on hesitation and names whichever row the file
  // lists first: on culico, "a photograph of a person" on 3,730 of 6,264
  // in-domain mosquitoes.
  it("cannot fire the nuisance gate, however much mass it carries", () => {
    const h = placeholderHead();
    // All the mass on the placeholders, and none on anything that can tell
    // photographs apart.
    const nuP = [0.4, 0.4];
    expect(nuP.reduce((a, b) => a + b, 0)).toBeGreaterThan(DEFAULT_FLOORS.nuisance);
    expect(nonMosquitoGate(h, [], nuP, DEFAULT_FLOORS)).toBeNull();
    const v = verdictFrom(h, post(h, { "Aedes aegypti": 0.9 }), agree, [], DEFAULT_FLOORS, nuP);
    expect(v.state).not.toBe("non-mosquito");
    expect(v.nuisance).toBeUndefined();
  });

  it("cannot fire the adjacent gate, and cannot be the class it names", () => {
    const h = placeholderHead();
    const adP = [0.45, 0.45, 0.02];
    expect(adP[0]! + adP[1]!).toBeGreaterThan(DEFAULT_FLOORS.nonMosquito);
    expect(nonMosquitoGate(h, adP, [], DEFAULT_FLOORS)).toBeNull();
  });

  it("still fires on the one row that carries image information", () => {
    const h = placeholderHead();
    const adP = [0.02, 0.02, 0.94];
    const g = nonMosquitoGate(h, adP, [], DEFAULT_FLOORS)!;
    expect(g.kind).toBe("adjacent");
    // The fitted background row, not a placeholder that happens to be nearby.
    expect(g.name).toBe("a photograph without a mosquito");
    expect(g.common).toBe("a photo with no mosquito in it");
    expect(g.mass).toBeCloseTo(0.94, 9);
  });

  it("a head with no bias coordinate is unaffected", () => {
    // The rule reads a coordinate the head names, so a text head that has none
    // has every one of its rows read - including rows whose only weight sits
    // where culico's intercept sits.
    const h = { ...placeholderHead(), biasIndex: -1 };
    const nuP = [0.4, 0.4];
    expect(nonMosquitoGate(h, [], nuP, DEFAULT_FLOORS)!.kind).toBe("nuisance");
  });
});

describe("what the score panel is told to name", () => {
  it("names the nuisance class when the gate tripped on the nuisance block", () => {
    // The panel used to promote the top ADJACENT class whatever the verdict had
    // said, so a wall was shown above a midge, and on a head of placeholders it
    // showed whichever one the file listed first - at the fraction it really
    // held.
    const h = placeholderHead();
    const v = verdictFrom(h, post(h, { "Aedes aegypti": 0.9 }), agree,
      [0, 0, 0.9], DEFAULT_FLOORS, [0.9, 0]);
    expect(v.nonMosquitoKind).toBe("adjacent");
    const l = nonMosquitoLabel(v)!;
    expect(l.name).toBe("a photo with no mosquito in it");
    expect(l.p).toBeCloseTo(0.9, 9);
  });

  it("names the plain-language family for an adjacent verdict", () => {
    const h = placeholderHead();
    // A head whose only readable adjacent rows are the fitted background one.
    const v: Verdict = { state: "non-mosquito", genus: null, species: null, topGenusP: 0, topSpeciesP: 0, runnersUp: [], nonMosquitoKind: "nuisance", nuisance: "a photograph of a wall", nonMosquitoP: 0.12 };
    expect(nonMosquitoLabel(v)).toEqual({ name: "a photograph of a wall", p: 0.12 });
    const adj: Verdict = { ...v, nonMosquitoKind: "adjacent", nuisance: undefined, adjacent: "Chironomidae", adjacentCommon: "a non-biting midge", nonMosquitoP: 0.8 };
    expect(nonMosquitoLabel(adj)!.name).toBe("a non-biting midge");
  });

  it("is null for every state that named nothing", () => {
    const h = placeholderHead();
    expect(nonMosquitoLabel(null)).toBeNull();
    expect(nonMosquitoLabel(verdictFrom(h, post(h, { "Aedes aegypti": 0.9 }), agree, [], DEFAULT_FLOORS, []))).toBeNull();
  });
});
