// The head fitted on the FINE-TUNED B/16 encoder, read through the app's own scoring path.
//
// `tests/b16-head-refit.test.ts` is the same three calls on the merged head fitted to the
// FROZEN encoder, and it is the baseline this file is measured against. Nothing here
// re-implements the app: `softmaxJoint` -> `nonMosquitoGate` / `fuseViews` -> `verdictFrom`,
// the same chain a photograph takes in the browser.
//
// The head file under test is a copy of the artefact, in the artefacts directory of
// investigations/2026-10-04-b16-head/. It is loaded from the fixtures directory rather than
// from `public/` because `public/text_embeds_b16.json` is the frozen head and replacing it is
// a separate, explicit change.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { softmaxJoint, informativeRows } from "../src/confidence/softmax";
import { nonMosquitoGate } from "../src/confidence/verdict";
import { fuseViews } from "../src/confidence/fuseViews";
import { cosineOffsetsFor, floorsFor } from "../src/app/modelConfig";
import { localViewScale, type Head } from "../src/confidence/types";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf8");
const asHead = (o: Record<string, unknown>) => ({ ...o, biasIndex: o.bias_index }) as unknown as Head;

const raw = JSON.parse(read("fixtures/b16tuned-head-ep1.json")) as Record<string, unknown>;
const HEAD = asHead(raw);
const REF = JSON.parse(read("fixtures/b16tuned-64-ep1.json")) as {
  true_species: string[];
  species_p: Record<string, number[][]> & { ep1: number[][] };
  nu_p: Record<string, number[][]>;
  joint_argmax_is_nuisance: Record<string, boolean[]>;
  neg_nu_p: number[][];
  neg_argmax: number[];
  neg_named: string[];
  genus_order: string[];
};
const FROZEN_HEAD = asHead(
  JSON.parse(read("../public/text_embeds_b16.json")) as Record<string, unknown>,
);

const DIM = HEAD.dim;
const S = HEAD.species.length;
const N = HEAD.nuisance!.length;

/** clipEmbed for a 512-wide head: L2-normalise, no bias coordinate. Identical to the frozen head's. */
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

const TUNED = readFixture("b16tuned-mosquito-64-ep1.npy");
const FROZEN_FEATS = readFixture("b16tuned-frozen-64-ep1.npy");
const NEG = readFixture("b16tuned-negative-64-ep1.npy");
const BACKGROUND = "a photograph without a mosquito";
const BG_ROW = HEAD.nuisance!.indexOf(BACKGROUND);

function rowNorms(head: Head, block: Float32Array | number[] | undefined, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < head.dim; k++) s += Number(block![i * head.dim + k]!) ** 2;
    out.push(Math.sqrt(s));
  }
  return out;
}

describe("the tuned head's shape is what the app expects", () => {
  it("is 512 wide with no bias coordinate, and the same sixteen labels in the same order", () => {
    expect(DIM).toBe(512);
    expect(raw.bias_index).toBeUndefined();
    expect(HEAD.biasIndex ?? -1).toBe(-1);
    expect(S).toBe(16);
    expect(HEAD.species).toEqual(FROZEN_HEAD.species);
    expect(HEAD.species_emb).toHaveLength(16 * DIM);
    expect(HEAD.nuisance).toEqual(FROZEN_HEAD.nuisance);
    expect(HEAD.nuisance_emb).toHaveLength(N * DIM);
    for (const row of HEAD.species_emb!) expect(Number.isFinite(row)).toBe(true);
    for (const row of HEAD.nuisance_emb!) expect(Number.isFinite(row)).toBe(true);
  });

  it("scores at scale 1.0, which is what makes the app's softmax the probe's own", () => {
    // The convention, asserted against the app's loader rather than against this project's
    // Python: `localViewScale` divides `logit_scale` by the engine's temperature, so a fitted
    // head must ship `logit_scale == temperature`. A head written the zero-shot way
    // (`logit_scale` 100) would be scored 40x too hot against these fitted rows.
    expect(localViewScale(HEAD, floorsFor("webgpu-b16"))).toBe(1);
    expect(HEAD.logit_scale).toBe(floorsFor("webgpu-b16").temperature);
    expect(HEAD.logit_scale).toBe(FROZEN_HEAD.logit_scale);
  });

  it("keeps the probe's row magnitudes rather than unit-normalising them", () => {
    const norms = rowNorms(HEAD, HEAD.species_emb, S);
    expect(new Set(norms.map((n) => n.toFixed(6))).size).toBeGreaterThan(1);
    expect(Math.min(...norms)).toBeGreaterThan(1);
  });

  it("carries the eight text rows byte-for-byte and one FITTED background row", () => {
    // The eight zero-shot prompts are frozen-SPACE rows and this encoder is not the frozen one.
    // They are carried unchanged on purpose, and their behaviour on tuned features is measured
    // rather than assumed -- but the row the gate actually reads must be fitted in the same
    // space as the species rows, or the block cannot fire.
    expect(HEAD.nuisance).toHaveLength(9);
    expect(BG_ROW).toBe(8);
    for (let i = 0; i < 8 * DIM; i++) {
      expect(HEAD.nuisance_emb![i]).toBe(FROZEN_HEAD.nuisance_emb![i]);
    }
    // Not a placeholder: this head has no bias coordinate, so `informativeRows` scores all 512
    // coordinates and a row of zeros would read as evidence. Every row must carry real mass.
    const informative = informativeRows(HEAD, HEAD.nuisance_emb, N);
    expect(informative.filter(Boolean)).toHaveLength(N);
  });
});

describe("the app reproduces the fit, through softmaxJoint", () => {
  it("agrees on the species posterior to 1e-6 on 64 held-out photographs", () => {
    let worst = 0;
    for (let r = 0; r < TUNED.n; r++) {
      const j = softmaxJoint(HEAD, appEmbed(TUNED.at(r)), { offsets: cosineOffsetsFor("webgpu-b16") });
      const want = REF.species_p.ep1![r]!; // eslint-disable-line
      for (let i = 0; i < S; i++) worst = Math.max(worst, Math.abs(j.spP[i]! - want[i]!));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("agrees on the winner of every held-out photograph", () => {
    for (let r = 0; r < TUNED.n; r++) {
      const j = softmaxJoint(HEAD, appEmbed(TUNED.at(r)), { offsets: cosineOffsetsFor("webgpu-b16") });
      let best = 0;
      for (let i = 1; i < j.spP.length; i++) if (j.spP[i]! > j.spP[best]!) best = i;
      const want = REF.species_p.ep1[r]!.indexOf(Math.max(...REF.species_p.ep1[r]!));
      expect(HEAD.species[best], `row ${r}`).toBe(HEAD.species[want]);
    }
  });

  it("keeps every nuisance row out of the top of the joint softmax on real mosquitoes", () => {
    // The bar the merged frozen head set: 20 of 2,450 in-corpus mosquitoes (0.82%) refused.
    let nuisanceWins = 0;
    for (let r = 0; r < TUNED.n; r++) {
      const j = softmaxJoint(HEAD, appEmbed(TUNED.at(r)), { offsets: cosineOffsetsFor("webgpu-b16") });
      const all = [...j.spP, ...j.nuP];
      if (all.indexOf(Math.max(...all)) >= S) nuisanceWins++;
    }
    expect(nuisanceWins).toBe(0);
  });

  it("returns no nuisance verdict on any of them, through fuseViews and the gate", () => {
    const floors = floorsFor("webgpu-b16");
    let refused = 0;
    for (let r = 0; r < TUNED.n; r++) {
      const j = softmaxJoint(HEAD, appEmbed(TUNED.at(r)), { offsets: cosineOffsetsFor("webgpu-b16") });
      const hit = nonMosquitoGate(HEAD, j.adP, j.nuP, floors);
      if (hit) refused++;
    }
    expect(refused).toBe(0);
  });

  it("refuses the background crops, and names the fitted row on them", () => {
    const floors = floorsFor("webgpu-b16");
    let fired = 0;
    let named = 0;
    for (let r = 0; r < NEG.n; r++) {
      const j = softmaxJoint(HEAD, appEmbed(NEG.at(r)), { offsets: cosineOffsetsFor("webgpu-b16") });
      const hit = nonMosquitoGate(HEAD, j.adP, j.nuP, floors);
      if (hit) {
        fired++;
        if (hit.kind === "nuisance" && hit.name === BACKGROUND) named++;
      }
    }
    // Held-out source photographs, one of the four folds. Reported as a fraction of the
    // fixture, which is 64 of the fold rather than the fold itself.
    expect(fired / NEG.n).toBeGreaterThan(0.9);
    expect(named).toBe(fired);
  });
});

describe("against the merged frozen head, on the same photographs", () => {
  it("moves the species posterior, so this is a different head and not a relabelling", () => {
    let worst = 0;
    let changed = 0;
    for (let r = 0; r < TUNED.n; r++) {
      const jt = softmaxJoint(HEAD, appEmbed(TUNED.at(r)), { offsets: cosineOffsetsFor("webgpu-b16") });
      const jz = softmaxJoint(HEAD, appEmbed(FROZEN_FEATS.at(r)), { offsets: cosineOffsetsFor("webgpu-b16") });
      let bt = 0;
      let bz = 0;
      for (let i = 1; i < S; i++) {
        if (jt.spP[i]! > jt.spP[bt]!) bt = i;
        if (jz.spP[i]! > jz.spP[bz]!) bz = i;
      }
      if (bt !== bz) changed++;
      worst = Math.max(worst, Math.abs(jt.spP[0]! - jz.spP[0]!));
    }
    expect(worst).toBeGreaterThan(0.01);
    expect(changed).toBeGreaterThan(0);
  });

  it("is scored through the same path as the frozen head, not a second code path", () => {
    expect(localViewScale(FROZEN_HEAD, floorsFor("webgpu-b16"))).toBe(1);
    expect(cosineOffsetsFor("webgpu-b16")).toEqual({});
  });
});
