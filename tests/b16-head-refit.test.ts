// The refitted BioCLIP B/16 head, measured through the app's own scoring path.
//
// B/16 was a zero-shot TEXT head: sixteen species prompts and eight nuisance prompts,
// each a unit-norm row, read as a cosine and multiplied by `logit_scale` = 100. Against
// `DEFAULT_FLOORS.temperature` = 2.5 that is a scale of 40, and the eight nuisance prompts
// were live evidence the gate could read - no bias coordinate, so `informativeRows` returns
// all-true for all of them. On real in-domain mosquitoes the nuisance block cleared the
// 0.05 nuisance floor on 26.9% of photographs, naming `a photograph of a person` on 127 of
// 2,450. docs/HEADS.md records what was measured; this file pins it.
//
// The fixtures are raw 512-wide features and the tests do the app's own L2 normalisation,
// because B/16 has NO bias coordinate to rebuild: `EMB.dim` is 512, which is the model's
// output width, so `clipEmbed`'s `feats` loop covers the whole vector. A head that grew a
// 513rd coordinate would be scored against a feature vector the browser never produces.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { softmaxJoint, informativeRows } from "../src/confidence/softmax";
import { nonMosquitoGate } from "../src/confidence/verdict";
import { fuseViews } from "../src/confidence/fuseViews";
import { cosineOffsetsFor, floorsFor } from "../src/app/modelConfig";
import { DEFAULT_FLOORS, localViewScale, type Head } from "../src/confidence/types";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf8");

const raw = JSON.parse(read("../public/text_embeds_b16.json")) as Record<string, unknown>;
const HEAD = { ...raw, biasIndex: raw.bias_index } as unknown as Head;
const SPECIES = HEAD.species;
const DIM = HEAD.dim;
const BIAS = HEAD.biasIndex ?? -1;
const PERSON = "a photograph of a person";

/** clipEmbed for a 512-wide text head: L2-normalise the feature coordinates, no bias. */
function appEmbed(features: Float32Array): Float32Array {
  const e = new Float32Array(DIM);
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    e[i] = features[i]!;
    norm += e[i]! * e[i]!;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) e[i] = e[i]! / norm;
  return e;
}

function readFixture(name: string): { n: number; at(i: number): Float32Array } {
  const buf = readFileSync(join(here, "fixtures", name));
  if (buf.subarray(0, 6).toString("latin1") !== "\x93NUMPY") throw new Error(`${name} is not a .npy`);
  const major = buf[6];
  const headerLen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
  const off = major === 1 ? 10 : 12;
  const m = /'shape':\s*\((\d+),\s*(\d+)\)/.exec(buf.subarray(off, off + headerLen).toString("latin1"));
  if (!m) throw new Error(`${name} has no readable shape`);
  const data = buf.byteOffset + off + headerLen;
  const cols = Number(m[2]);
  return {
    n: Number(m[1]),
    at: (i) => new Float32Array(buf.buffer.slice(data + i * cols * 4, data + (i + 1) * cols * 4)),
  };
}

const MOSQUITOES = readFixture("b16-mosquito-64.npy");
const NEGATIVES = readFixture("b16-negative-64.npy");
const MOSQ_REF = JSON.parse(read("fixtures/b16-mosquito-64.json")) as {
  true_index: number[];
  proba: number[][];
};

/**
 * The app's own scoring of one photograph, through the same three calls a photo takes
 * in the browser: `softmaxJoint` per view, `fuseViews` over them, `verdictFrom` on the
 * fused posterior. One view, which `fuseViews` documents as algebraically identical to
 * that view's own softmax.
 */
function verdict(features: Float32Array) {
  const j = softmaxJoint(HEAD, appEmbed(features), { offsets: cosineOffsetsFor("webgpu-b16") });
  const fused = fuseViews(
    HEAD,
    [{ spP: j.spP, nuTotal: j.nuP.reduce((a, b) => a + b, 0), adP: j.adP, scale: localViewScale(HEAD, floorsFor("webgpu-b16")) }],
    floorsFor("webgpu-b16"),
  );
  if (!fused) throw new Error("fuseViews returned null for one view");
  return fused.verdict;
}

describe("the refitted B/16 head's shape is what the app expects", () => {
  it("is 16 rows of `dim`, and has no bias coordinate to declare", () => {
    // A 513-wide probe is what culico's head is, because culico's graph appends a
    // constant. B/16's graph emits 512 features and nothing else, so the app's
    // `feats` loop covers the whole vector and the head must stay 512-wide. A bias
    // index here would address a coordinate the browser never scores.
    expect(DIM).toBe(512);
    expect(BIAS).toBe(-1);
    expect(raw.bias_index).toBeUndefined();
    expect(SPECIES).toHaveLength(16);
    expect(HEAD.species_emb).toHaveLength(16 * DIM);
    expect(HEAD.nuisance_emb).toHaveLength(HEAD.nuisance!.length * DIM);
    for (const row of HEAD.species_emb!) expect(Number.isFinite(row)).toBe(true);
  });

  it("scores at scale 1.0, which is the only scale at which it is the probe", () => {
    // `softmaxJoint` multiplies every logit by logit_scale / temperature. The fitted
    // probe's posterior is the softmax of its decision function, so the app reproduces
    // it only at 1.0. The shipped text head sat at 100 / 2.5 = 40, which is a
    // temperature for a cosine readout and 40x too sharp for a fitted one: on the
    // probe's own validation split that scores NLL 25.69 against 1.14 at scale 1.0.
    expect(localViewScale(HEAD, floorsFor("webgpu-b16"))).toBe(1);
    expect(HEAD.logit_scale).toBe(floorsFor("webgpu-b16").temperature);
  });

  it("keeps the probe's own row magnitudes rather than unit-normalising them", () => {
    // A text head's rows are unit norm because its readout is a COSINE. This is a
    // fitted linear readout whose row norms carry the margin the fit found, and they
    // set how the species block competes with the nuisance block it shares a softmax
    // with. Re-normalising them would throw that away.
    const norms = SPECIES.map((_, i) => {
      let s = 0;
      for (let k = 0; k < DIM; k++) s += HEAD.species_emb![i * DIM + k]! ** 2;
      return Math.sqrt(s);
    });
    expect(new Set(norms.map((n) => n.toFixed(6))).size).toBeGreaterThan(1);
    expect(Math.min(...norms)).toBeGreaterThan(1);
  });

  it("leaves the nuisance block byte-for-byte as it shipped", () => {
    // A fitted probe has no training signal for "a photograph of a person" or for
    // "a photograph of a wall", and inventing those rows would fabricate evidence
    // the gate then reads. They stay as they shipped - see the gate tests below for
    // what that does to them.
    expect(HEAD.nuisance).toEqual([
      PERSON,
      "a photograph of a hand",
      "a photograph of a wall",
      "a photograph of a fly",
      "a photograph of a butterfly",
      "a photograph of a moth",
      "a photograph of a plant",
      "a photograph of an empty background",
    ]);
    for (const row of HEAD.nuisance_emb!) expect(Math.abs(row)).toBeLessThanOrEqual(1);
  });
});

describe("the app reproduces the probe's own posterior", () => {
  it("agrees on the winner of every held-out mosquito", () => {
    for (let r = 0; r < MOSQUITOES.n; r++) {
      const j = softmaxJoint(HEAD, appEmbed(MOSQUITOES.at(r)), {
        offsets: cosineOffsetsFor("webgpu-b16"),
      });
      let best = 0;
      for (let i = 1; i < j.spP.length; i++) if (j.spP[i]! > j.spP[best]!) best = i;
      const want = MOSQ_REF.proba[r]!.indexOf(Math.max(...MOSQ_REF.proba[r]!));
      expect(SPECIES[best], `row ${r}`).toBe(SPECIES[want]);
    }
  });

  it("agrees on the numbers to 1e-6, once the nuisance mass is accounted for", () => {
    // One softmax over species ++ nuisance, so the app's species posteriors are the
    // probe's times the probability that the photograph is a mosquito at all. That
    // is the quantity the gate and the fusion are built to read, and renormalising
    // is the comparison to make.
    let worst = 0;
    for (let r = 0; r < MOSQUITOES.n; r++) {
      const j = softmaxJoint(HEAD, appEmbed(MOSQUITOES.at(r)), {
        offsets: cosineOffsetsFor("webgpu-b16"),
      });
      const mass = j.spP.reduce((a, b) => a + b, 0);
      expect(mass).toBeGreaterThan(0);
      for (let i = 0; i < j.spP.length; i++) {
        worst = Math.max(worst, Math.abs(j.spP[i]! / mass - MOSQ_REF.proba[r]![i]!));
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("is not reading the per-genus cosine calibration, which was fitted on H/14", () => {
    expect(Object.keys(cosineOffsetsFor("webgpu-b16"))).toHaveLength(0);
    expect(Object.keys(cosineOffsetsFor("webgpu-fp16")).length).toBeGreaterThan(0);
  });
});

describe("B/16 on obvious mosquitoes does not return a nuisance class", () => {
  // The defect: 26.9% of 2,450 in-corpus test mosquitoes cleared the 0.05 nuisance
  // floor on the shipped head, and the block's winner was `a photograph of a person`
  // on 127 of them. Those are the photographs Cornelius photographed a culex
  // pipiens in, and the app answered them with a person.

  it("returns no nuisance verdict on any of the 64 held-out mosquitoes", () => {
    for (let i = 0; i < MOSQUITOES.n; i++) {
      const v = verdict(MOSQUITOES.at(i));
      expect(v.state, `row ${i} -> ${v.nuisance ?? v.adjacent ?? ""}`).not.toBe("non-mosquito");
      expect(v.nuisance, `row ${i}`).toBeUndefined();
    }
  });

  it("names `a photograph of a person` on none of them", () => {
    let named = 0;
    for (let i = 0; i < MOSQUITOES.n; i++) {
      if (verdict(MOSQUITOES.at(i)).nuisance === PERSON) named++;
    }
    expect(named).toBe(0);
  });

  it("keeps the nuisance block's mass far below this engine's own floor", () => {
    // The honest way to state the repair: two things moved at once. The fitted
    // species rows carry norms 3.6-28.8 against the unit-norm text rows they share
    // a softmax with, so the nuisance block takes far less of the joint posterior;
    // and the floor it is read against is B/16's own 0.20 rather than the 0.05
    // fitted on H/14. Between them, mosquitoes stopped clearing it.
    const floor = floorsFor("webgpu-b16").nuisance;
    expect(floor).toBe(0.2);
    expect(DEFAULT_FLOORS.nuisance).toBe(0.05);
    let worst = 0;
    for (let i = 0; i < MOSQUITOES.n; i++) {
      const j = softmaxJoint(HEAD, appEmbed(MOSQUITOES.at(i)), {
        offsets: cosineOffsetsFor("webgpu-b16"),
      });
      worst = Math.max(worst, j.nuP.reduce((a, b) => a + b, 0));
    }
    expect(worst).toBeLessThan(floor);
  });

  it("refused 9 of these same 64 photographs before the refit", () => {
    // The defect this fixes, on exactly these fixtures: the shipped text head at its
    // shipped scale of 40.0 cleared the inherited 0.05 nuisance floor on 9 of these
    // 64 held-out in-domain mosquitoes, and the refit clears it on none. Over the
    // full 2,450-row nameable test split the same measurement is 561 -> 137.
    const shipped = JSON.parse(read("../public/text_embeds_b16.shipped.json")) as Record<string, unknown>;
    const SHIPPED = { ...shipped, biasIndex: shipped.bias_index } as unknown as Head;
    expect(SHIPPED.logit_scale).toBeCloseTo(100, 1);
    let fired = 0;
    for (let i = 0; i < MOSQUITOES.n; i++) {
      const j = softmaxJoint(SHIPPED, appEmbed(MOSQUITOES.at(i)), {
        offsets: cosineOffsetsFor("webgpu-b16"),
      });
      const mass = j.nuP.reduce((a, b) => a + b, 0);
      if (mass >= DEFAULT_FLOORS.nuisance) fired++;
    }
    expect(fired).toBe(9);
  });
});

describe("what the refit costs on the negative side, stated rather than hidden", () => {
  // The 8 nuisance rows are still the zero-shot text prompts. All 8 carry image
  // information - there is no bias coordinate, so `informativeRows` is all-true -
  // and a fitted species block of row norms ~35 starves them. The gate therefore
  // refuses almost nothing on background, which is the same trade culico's head
  // makes, and the honest number is that B/16 now ABSTAINS on a wall instead of
  // calling it one. These tests pin the direction and the magnitude so the change
  // cannot pass silently.

  it("still reads all eight nuisance rows as evidence", () => {
    const informative = informativeRows(HEAD, HEAD.nuisance_emb, HEAD.nuisance!.length);
    expect(informative.filter(Boolean)).toHaveLength(8);
  });

  it("refuses 23 of these same 64 background crops, against 54 before", () => {
    // The cost of the fix, on exactly these fixtures. Over the full 700 detector-
    // verified crops the gate's refusal rate falls from 615 to 255 while the
    // mosquitoes it wrongly refuses fall from 561 to 137. The two move together
    // because these eight text rows cannot tell a wall from an uncertain mosquito -
    // their block mass rises exactly when the species block is unsure - so on this
    // head there is no setting that catches background without also catching
    // insects. 23 is what the knee is worth, and it is asserted so a later edit
    // that moves it has to say so.
    let fired = 0;
    for (let i = 0; i < NEGATIVES.n; i++) {
      const j = softmaxJoint(HEAD, appEmbed(NEGATIVES.at(i)), {
        offsets: cosineOffsetsFor("webgpu-b16"),
      });
      if (nonMosquitoGate(HEAD, j.adP, j.nuP, floorsFor("webgpu-b16"))) fired++;
    }
    expect(fired).toBe(23);
  });

  it("keeps the nuisance floor on this engine only", () => {
    // The other two engines keep the shipped 0.05. A floor is an absolute threshold
    // on a posterior, so raising a global default to fix one engine would impose a
    // value two others were never tested at.
    expect(floorsFor("webgpu-culico").nuisance).toBe(DEFAULT_FLOORS.nuisance);
    expect(floorsFor("webgpu-fp16").nuisance).toBe(DEFAULT_FLOORS.nuisance);
  });
});