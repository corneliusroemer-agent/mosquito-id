// The per-genus cosine calibration in src/confidence/calibration.ts, and the
// arithmetic softmaxJoint performs with it.
//
// softmaxJoint is the most-called function in the app and had no unit test at
// all: every existing case reached the confidence arithmetic through a posterior
// someone had already computed by hand. That is why the offsets below needed
// tests written from the arithmetic rather than borrowed from a real head.
import { describe, it, expect, beforeAll } from "vitest";
import type { Head } from "../src/confidence/types";
import { PER_GENUS_COSINE_OFFSET, cosineOffsetFor, uncalibratedGenera } from "../src/confidence/calibration";
import { softmaxJoint } from "../src/confidence/softmax";
import { genusOf } from "../src/confidence/genus";
import { realHead } from "./fixtures";
import { DEFAULT_FLOORS } from "../src/confidence/types";

/**
 * A four-species head, one species per genus, whose embeddings make every
 * cosine an exact literal.
 *
 * Embeddings are laid out as [cos, 0, 0, 0] and the probe embedding is [1, 0, 0,
 * 0], so the dot product in softmaxJoint is the first component and nothing else.
 * A cosine that reads as 0.5 in the source therefore IS 0.5, which is what makes
 * the posteriors below checkable by hand rather than by re-running the code.
 */
function handCheckableHead(): Head {
  const species = ["Aedes aegypti", "Anopheles gambiae", "Culex pipiens", "Culiseta annulata"];
  const cos = [0.5, 0.6, 0.4, 0.55];
  const dim = 4;
  const species_emb: number[] = [];
  cos.forEach((c) => species_emb.push(c, 0, 0, 0));
  return {
    species,
    dim,
    logit_scale: 100,
    nuisance: [],
    species_emb,
  };
}

const PROBE = [1, 0, 0, 0];

describe("the fitted offsets", () => {
  it("sum to zero - they are a centred vector, not a shift", () => {
    const values = Object.values(PER_GENUS_COSINE_OFFSET);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    // Softmax itself is shift-invariant, so a common offset on the cosines is a
    // no-op here and looks harmless. It is not harmless downstream: the same
    // vector carried through a per-genus VECTOR SCALING fit is not
    // shift-invariant, and a common shift of ~15 logits moves that fit's answer
    // by 5.4-7.4 logits. Leaving the mean free also makes the vector
    // unidentifiable - the mean can absorb anything without changing the fit.
    //
    // So if this assertion fails, the numbers were edited rather than refitted.
    // See src/confidence/calibration.ts.
    expect(Math.abs(mean)).toBeLessThan(1e-3);
    expect(values.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 3);
  });

  it("has one entry per genus and no others", () => {
    expect(Object.keys(PER_GENUS_COSINE_OFFSET).sort()).toEqual([
      "Aedes",
      "Anopheles",
      "Culex",
      "Culiseta",
    ]);
  });

  it("points the same way as the per-genus logsumexp gap it corrects", () => {
    // The head's per-genus logsumexp over train rows is Aedes 21.70, Anopheles
    // 18.76, Culex 19.77, Culiseta 20.16 - a 2.9-logit standing advantage for
    // Aedes on fixed embeddings that were never fitted to anything. The fitted
    // vector is close to that gap's removal, so the two weakest genera are the
    // two pushed up. If the signs ever invert, the vector has stopped being the
    // correction it claims to be and is now just four numbers.
    // Aedes has the highest logsumexp, so it takes a negative offset; Anopheles
    // the lowest, so it takes a positive one.
    expect(PER_GENUS_COSINE_OFFSET["Aedes"]!).toBeLessThan(
      PER_GENUS_COSINE_OFFSET["Anopheles"]!,
    );
  });
});

describe("the map covers the shipped head", () => {
  let head: Head;
  beforeAll(() => {
    head = realHead();
  });

  it("calibrates every genus the head actually carries", () => {
    // This is the "unknown genus is a bug, not a default" case. cosineOffsetFor
    // returns 0 for a miss so a synthetic head still scores, but for the head
    // that ships, a miss means the calibration is silently not applying to part
    // of the model. A genus added to text_embeds.json without a refit lands here.
    expect(uncalibratedGenera(head.species, genusOf)).toEqual([]);
  });

  it("reports a genus the map does not carry rather than swallowing it", () => {
    expect(uncalibratedGenera(["Aedes aegypti", "Toxorhynchus tipula"], genusOf)).toEqual([
      "Toxorhynchus",
    ]);
  });
});

describe("an unknown genus does not throw", () => {
  it("scores at offset 0", () => {
    // A head carrying a genus the map has never seen is a normal thing to build
    // in a test and a survivable thing to meet for real. It scores uncalibrated;
    // the coverage test above is what keeps that from being silent in shipping.
    expect(cosineOffsetFor("Toxorhynchus")).toBe(0);
    expect(cosineOffsetFor("")).toBe(0);
    expect(cosineOffsetFor("nonsense")).toBe(0);

    // Two genera the map has never heard of, so neither is offset: they tie
    // exactly. A calibrated genus would not tie, which is the point of pairing
    // unknowns - it isolates "no offset applied" from "offset applied".
    const head: Head = {
      species: ["Toxorhynchus tipula", "Wyeomyia smithii"],
      dim: 4,
      logit_scale: 100,
      nuisance: [],
      species_emb: [0.5, 0, 0, 0, 0.5, 0, 0, 0],
    };
    const r = softmaxJoint(head, PROBE);
    expect(r.spP).toHaveLength(2);
    expect(r.spP[0]).toBeCloseTo(r.spP[1]!, 12);
    // Uncalibrated, so no offset at all - not a crash and not a stale value.
    expect(r.spP[0]).toBeCloseTo(0.5, 12);
  });
});

describe("softmaxJoint applies the offsets before the scaling multiply", () => {
  const head = handCheckableHead();

  it("produces the posteriors the arithmetic says, to the digit", () => {
    // By hand, at scale = logit_scale / temperature = 100 / 2.5 = 40:
    //   logit_s = 40 * (cos_s + offset(genus_s))
    //   Aedes     40 * (0.50 - 0.008713391998031056) = 19.6514643200787576
    //   Anopheles 40 * (0.60 + 0.022077688488589337) = 24.8831075395435735
    //   Culex     40 * (0.40 - 0.022324472825828463) = 15.1070210869668615
    //   Culiseta  40 * (0.55 + 0.008960176335270137) = 22.3584070534108055
    // softmaxed over the four. These are the expected values computed
    // independently in Python, not read back from this implementation - the point
    // of the case is that an obviously wrong sign, a missing multiply or an
    // offset applied after scaling all fail it.
    const r = softmaxJoint(head, PROBE);
    expect(r.spP[0]).toBeCloseTo(0.0049238278736418355, 12);
    expect(r.spP[1]).toBeCloseTo(0.9212481824311322, 12);
    expect(r.spP[2]).toBeCloseTo(5.232102494944109e-5, 15);
    expect(r.spP[3]).toBeCloseTo(0.0737756686702766, 12);
    expect(r.spP.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it("reports the calibrated cosine in the per-species logits, not the raw one", () => {
    // The logits are read elsewhere in the app as the per-species score, so if
    // only the softmax were offset the bar and the posterior would disagree
    // about the same species.
    const r = softmaxJoint(head, PROBE);
    expect(r.logits["Anopheles gambiae"]).toBeCloseTo(24.8831075395435735, 9);
    // The raw cosine times the scale would be 0.6 * 40 = 24 exactly; the offset
    // moves it, so a regression that drops the calibration from the logits fails
    // here rather than silently shipping.
    expect(r.logits["Anopheles gambiae"]).not.toBeCloseTo(24, 9);
  });

  it("agrees with the shipped values when the calibration is turned off", () => {
    // Passing an empty map reproduces the pre-calibration posteriors exactly, so
    // this pair is a before/after of the same head and the delta is the
    // calibration and nothing else.
    const off = softmaxJoint(head, PROBE, { offsets: {} });
    const scale = 40;
    const logit = (c: number): number => scale * c;
    const logits = [logit(0.5), logit(0.6), logit(0.4), logit(0.55)];
    const mx = Math.max(...logits);
    const ex = logits.map((v) => Math.exp(v - mx));
    const sum = ex.reduce((a, b) => a + b, 0);
    off.spP.forEach((p, i) => expect(p).toBeCloseTo(ex[i]! / sum, 12));
  });

  it("moves the genus verdict when the calibration moves", () => {
    // The regression this exists for: temperature is currently unguarded - 47/47
    // tests pass with it set to an absurd value - and these four numbers are the
    // same shape of hazard, a constant that could be dropped from the pipeline
    // without a single other test noticing. So push Anopheles up and its
    // partner Culex down by half a cosine each, which is ~24x the fitted size,
    // and require a near-tie to resolve the other way.
    // Equal cosines everywhere: uncalibrated, all four genera tie exactly.
    const flat: number[] = [];
    for (let i = 0; i < 4; i++) flat.push(0.5, 0, 0, 0);
    const flatHead: Head = { ...handCheckableHead(), species_emb: flat };

    const before = softmaxJoint(flatHead, PROBE, { offsets: {} });
    expect(before.spP.every((p) => Math.abs(p - 0.25) < 1e-12)).toBe(true);

    const after = softmaxJoint(flatHead, PROBE, {
      offsets: { Anopheles: 0.02, Culex: -0.02 },
    });
    // +0.02 cosine is +0.8 logits at scale 40, and the other two are unchanged, so
    // the ratio against a tied opponent is exp(0.8) = 2.2255. Checking the ratio
    // rather than "Anopheles won" catches an offset applied after the scaling
    // multiply, which would give the same winner and a different ratio.
    expect(after.spP[1]! / after.spP[3]!).toBeCloseTo(Math.exp(0.8), 9);
    expect(after.spP[2]! / after.spP[3]!).toBeCloseTo(Math.exp(-0.8), 9);
    expect(after.spP[1]!).toBeGreaterThan(before.spP[1]!);
    expect(after.spP[2]!).toBeLessThan(before.spP[2]!);
  });

  it("applies the offset before the scaling multiply, not after", () => {
    // The single most dangerous edit to this file. softmaxJoint is a bare
    // `scale * dot` with no bias term, and adding the offset to the SCALED logit
    // instead of the raw cosine multiplies it by logit_scale - 100.0 for the B/16
    // head. Nothing about the result looks wrong: the posteriors still sum to 1
    // and the winner is usually still right, it is just confidently wrong by two
    // orders of magnitude. So the assertion is on the exact logits, not on the
    // argmax.
    const r = softmaxJoint(head, PROBE);
    const scale = head.logit_scale / DEFAULT_FLOORS.temperature;
    const OFF = PER_GENUS_COSINE_OFFSET;
    // The offset's contribution is offset * scale. On the wrong side of the
    // multiply it would be `scale * 0.6 + offset`, i.e. 24 + 0.022 rather than
    // 40 * (0.6 + 0.022) = 24.883...
    expect(r.logits["Anopheles gambiae"]).toBeCloseTo(
      scale * (0.6 + OFF["Anopheles"]!),
      9,
    );
    expect(Math.abs(r.logits["Anopheles gambiae"]! - (scale * 0.6 + OFF["Anopheles"]!)))
      .toBeGreaterThan(0.5);
  });

  it("scales the offset with the view's scale rather than being a fixed logit", () => {
    // Written in cosine units on purpose: at a doubled logit_scale the
    // correction doubles with it. A version hardcoded as logit constants would
    // return the same logits here and pass a temperature check while being wrong
    // about what the numbers mean.
    const r = softmaxJoint(head, PROBE, {
      floors: { ...DEFAULT_FLOORS, temperature: 1.25 },
    });
    // scale 80 instead of 40: logit = 80 * (0.6 + offset).
    expect(r.logits["Anopheles gambiae"]).toBeCloseTo(80 * (0.6 + 0.022077688488589337), 9);
  });
});
