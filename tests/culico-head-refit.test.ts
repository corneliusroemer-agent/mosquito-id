// The refitted culico head, measured through the app's own scoring path.
//
// The head was a trained linear probe before 2026-10-04 and is one now, fitted
// on the features the BROWSER produces. That makes the conversion the whole job:
// `softmaxJoint` is a bare `scale * dot` over 1153-wide rows, so a probe's own
// softmax survives the trip only if the rows are its coefficients and the scale
// is exactly 1. These tests hold both ends of that - the head file's shape, and
// the posterior the app derives from it - against real photographs.
//
// The fixtures are raw 1152-wide features, not the 1153-wide vectors the app
// scores, so the tests rebuild the constant bias coordinate and the L2
// normalisation themselves. That is deliberate: `clipEmbed` divides the bias
// coordinate by the feature norm along with everything else, and a test that
// skipped that step would pass against a head whose intercept means something
// else in the browser than in the notebook it was fitted in.
//
// docs/HEADS.md records what was measured and why. This file pins the behaviour.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { softmaxJoint, informativeRows } from "../src/confidence/softmax";
import { nonMosquitoGate } from "../src/confidence/verdict";
import { cosineOffsetsFor } from "../src/app/modelConfig";
import { DEFAULT_FLOORS, localViewScale, type Head } from "../src/confidence/types";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf8");

const raw = JSON.parse(read("../public/text_embeds_culico.json")) as Record<string, unknown>;
const HEAD = { ...raw, biasIndex: raw.bias_index } as unknown as Head;
const SPECIES = HEAD.species;
const DIM = HEAD.dim;
const BIAS = HEAD.biasIndex ?? -1;
const BACKGROUND = "a photograph without a mosquito";

/** clipEmbed(): the graph's constant 1.0, then L2-normalise over all 1153. */
function appEmbed(features: Float32Array): Float32Array {
  const e = new Float32Array(DIM);
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    e[i] = i === BIAS ? 1 : features[i]!;
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

const MOSQUITOES = readFixture("culico-mosquito-64.npy");
const NEGATIVES = readFixture("culico-negative-64.npy");
const MOSQ_REF = JSON.parse(read("fixtures/culico-mosquito-64.json")) as {
  true_index: number[];
  proba: number[][];
};

/** The app's own scoring of one photograph. */
function score(features: Float32Array) {
  return softmaxJoint(HEAD, appEmbed(features), { offsets: cosineOffsetsFor("webgpu-culico") });
}

describe("the refitted head's shape is what the app expects", () => {
  it("is 16 rows of `dim`, with the intercept on the declared coordinate", () => {
    expect(DIM).toBe(1153);
    expect(BIAS).toBe(DIM - 1);
    expect(SPECIES).toHaveLength(16);
    expect(HEAD.species_emb).toHaveLength(16 * DIM);
    expect(HEAD.adjacent_emb).toHaveLength(HEAD.adjacent!.length * DIM);
    expect(HEAD.nuisance_emb).toHaveLength(HEAD.nuisance!.length * DIM);
    for (const row of HEAD.species_emb!) expect(Number.isFinite(row)).toBe(true);
  });

  it("scores at scale 1.0, which is the only scale at which it is the probe", () => {
    // `softmaxJoint` multiplies every logit by logit_scale / temperature. The
    // probe's own posterior is the softmax of its decision function, so the app
    // reproduces it only at 1.0. This is the assertion that makes a head file
    // whose rows were rescaled - or a temperature retuned against the old rows -
    // fail loudly rather than quietly return different numbers in the browser.
    expect(localViewScale(HEAD)).toBe(1);
    expect(HEAD.logit_scale).toBe(DEFAULT_FLOORS.temperature);
  });

  it("keeps the probe's own row magnitudes rather than unit-normalising them", () => {
    // A text head's rows are unit norm because its readout is a COSINE. This is
    // a fitted linear readout whose row norms carry the margin the fit found,
    // and they also set how the species block competes with the two blocks it
    // shares a softmax with. Re-normalising them would silently rescale that.
    const norms = SPECIES.map((_, i) => {
      let s = 0;
      for (let k = 0; k < DIM; k++) s += HEAD.species_emb![i * DIM + k]! ** 2;
      return Math.sqrt(s);
    });
    expect(new Set(norms.map((n) => n.toFixed(6))).size).toBeGreaterThan(1);
    expect(Math.min(...norms)).toBeGreaterThan(1);
  });

  it("separates all sixteen species, so the app reports species rather than genus", () => {
    const seen = new Set<string>();
    for (let i = 0; i < SPECIES.length; i++) {
      let key = "";
      const f = new Float32Array(DIM);
      for (let k = 0; k < DIM; k++) {
        f[k] = HEAD.species_emb![i * DIM + k]!;
        key += `${f[k]},`;
      }
      seen.add(key);
    }
    expect(seen.size).toBe(16);
  });
});

describe("the app reproduces the probe's own posterior", () => {
  // 64 held-out in-domain mosquitoes, drawn from the test split of the fitted
  // corpus so the probe never saw them. `proba` is the fitted probe's own
  // 16-way distribution on exactly these photographs.
  it("agrees on the winner of every one", () => {
    for (let r = 0; r < MOSQUITOES.n; r++) {
      const j = score(MOSQUITOES.at(r));
      let best = 0;
      for (let i = 1; i < j.spP.length; i++) if (j.spP[i]! > j.spP[best]!) best = i;
      const want = MOSQ_REF.proba[r]!.indexOf(Math.max(...MOSQ_REF.proba[r]!));
      expect(SPECIES[best], `row ${r}`).toBe(SPECIES[want]);
    }
  });

  it("agrees on the numbers to 1e-6, once the non-species mass is accounted for", () => {
    // `softmaxJoint` puts species, nuisance and adjacent in ONE softmax, so its
    // species posteriors are the probe's times the probability that the
    // photograph is a mosquito at all - which is exactly what the app wants, and
    // is why renormalising is the comparison to make. On this fixture the two
    // other blocks take 0.4%-28% of the mass, entirely from the fifteen
    // placeholder rows, and the measured gap after renormalising is 1e-8.
    let worst = 0;
    for (let r = 0; r < MOSQUITOES.n; r++) {
      const j = score(MOSQUITOES.at(r));
      const mass = j.spP.reduce((a, b) => a + b, 0);
      expect(mass).toBeGreaterThan(0);
      expect(mass).toBeLessThan(1);
      for (let i = 0; i < j.spP.length; i++) {
        worst = Math.max(worst, Math.abs(j.spP[i]! / mass - MOSQ_REF.proba[r]![i]!));
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("is not reading the per-genus cosine calibration, which was fitted on H/14", () => {
    // `cosineOffsetsFor` is opt-in per engine precisely because those four
    // numbers are a correction to a zero-shot text head's prompts. A probe's
    // intercepts already carry the class priors, so applying the offsets here
    // would bias a correct posterior with a correction from another model.
    expect(Object.keys(cosineOffsetsFor("webgpu-culico"))).toHaveLength(0);
    expect(Object.keys(cosineOffsetsFor("webgpu-fp16")).length).toBeGreaterThan(0);
  });
});

describe("the one fitted adjacent row still detects background", () => {
  const informative = informativeRows(HEAD, HEAD.adjacent_emb, HEAD.adjacent!.length);
  const row = informative.indexOf(true);

  it("is still the only adjacent row that carries any image information", () => {
    expect(informative.filter(Boolean)).toHaveLength(1);
    expect(HEAD.adjacent![row]).toBe(BACKGROUND);
  });

  it("refuses 60 of the 64 held-out background crops", () => {
    // The same 0.60 floor, on 64 of the 700 detector-verified in-domain
    // background crops. This row was refitted on those negatives on 2026-10-04,
    // jointly with the species rows, because the row that shipped with the head
    // had been fitted against the OLD species logits and could no longer win the
    // softmax they shared. Held out by SOURCE PHOTO - 538 photographs, up to two
    // detector crops each - the refitted row refuses 86.1% of the 700 against
    // 56.3% for the row it replaced, at 0.00% of 1,500 in-domain mosquitoes lost
    // against 0.13%.
    let fired = 0;
    for (let i = 0; i < NEGATIVES.n; i++) {
      if (score(NEGATIVES.at(i)).adP[row]! >= DEFAULT_FLOORS.nonMosquito) fired++;
    }
    expect(fired).toBe(60);
  });

  it("still refuses none of the 64 in-domain mosquitoes", () => {
    let fired = 0;
    for (let i = 0; i < MOSQUITOES.n; i++) {
      if (score(MOSQUITOES.at(i)).adP[row]! >= DEFAULT_FLOORS.nonMosquito) fired++;
    }
    expect(fired).toBe(0);
  });

  it("is what the gate names on a background crop, and nothing on a mosquito", () => {
    let negativesRefused = 0;
    let named = 0;
    for (let i = 0; i < NEGATIVES.n; i++) {
      const j = score(NEGATIVES.at(i));
      const hit = nonMosquitoGate(HEAD, j.adP, j.nuP);
      if (hit) {
        negativesRefused++;
        if (hit.kind === "adjacent" && hit.name === BACKGROUND) named++;
      }
    }
    expect(negativesRefused).toBe(60);
    expect(named).toBe(60);
    for (let i = 0; i < MOSQUITOES.n; i++) {
      const j = score(MOSQUITOES.at(i));
      expect(nonMosquitoGate(HEAD, j.adP, j.nuP), `row ${i}`).toBeNull();
    }
  });
});
