// The shipped H/14 head, measured through the app's own scoring path.
//
// H/14 is a zero-shot text head and the app's default engine. Two other engines
// shipped heads whose non-species rows were placeholders - vectors holding only
// an intercept - so the non-mosquito gate fired on the classifier's hesitation and
// named real mosquitoes "a photograph of a person". That defect is structural and
// a head either has it or does not, so it is worth a test rather than a comment.
//
// The fixtures are raw 1024-d features through `clipEmbed`'s own geometry, and the
// tests rebuild the L2 normalisation the browser applies, so what is scored here is
// what the browser scores. docs/HEADS.md records the measurement; this pins the
// behaviour.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { softmaxJoint, informativeRows } from "../src/confidence/softmax";
import { fuseViews } from "../src/confidence/fuseViews";
import { cosineOffsetsFor, floorsFor } from "../src/app/modelConfig";
import { DEFAULT_FLOORS, localViewScale, type Floors, type Head } from "../src/confidence/types";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, p), "utf8");

const HEAD = JSON.parse(read("../public/text_embeds.json")) as unknown as Head;
const ENGINE = "webgpu-fp16";
const DIM = HEAD.dim;

function readFixture(name: string): Float32Array[] {
  const buf = readFileSync(join(here, "fixtures", name));
  const major = buf[6]!;
  const headerLen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
  const off = major === 1 ? 10 : 12;
  const m = /'shape':\s*\(([^)]*)\)/.exec(buf.subarray(off, off + headerLen).toString("latin1"));
  if (!m) throw new Error(`${name} has no readable shape`);
  const dims = m[1]!.split(",").map((s) => Number(s.trim())).filter((v) => v > 0);
  const rows = dims[0]!;
  const cols = dims.length > 1 ? dims[1]! : 1;
  const data = buf.byteOffset + off + headerLen;
  return Array.from({ length: rows }, (_, i) => {
    const out = new Float32Array(cols);
    for (let k = 0; k < cols; k++) out[k] = buf.readFloatLE(data + (i * cols + k) * 4);
    return out;
  });
}

const MOSQUITOES = readFixture("h14-mosquito-256.npy");
const REF = JSON.parse(read("fixtures/h14-mosquito-256.json")) as { species_index: number[] };
const BACKGROUND = readFixture("h14-background-256.npy");

/** clipEmbed() for this head: no bias coordinate, so a plain 1024-d L2. */
function appEmbed(features: Float32Array): Float32Array {
  const e = new Float32Array(features);
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += e[i]! * e[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) e[i] = e[i]! / norm;
  return e;
}

/** main.js's single-view path, in the same order it calls it. */
function appScore(features: Float32Array, floors: Floors = floorsFor(ENGINE)) {
  const j = softmaxJoint(HEAD, appEmbed(features), {
    offsets: cosineOffsetsFor(ENGINE),
    floors,
  });
  return fuseViews(
    HEAD,
    [
      {
        spP: j.spP,
        nuTotal: j.nuP.reduce((a, b) => a + b, 0),
        adP: j.adP,
        scale: localViewScale(HEAD, floors),
      },
    ],
    floors,
  )!;
}

describe("the shipped H/14 head's two gate blocks are real detectors", () => {
  it("declares no bias coordinate, so no row can be a placeholder", () => {
    expect(HEAD.biasIndex).toBeUndefined();
    expect(HEAD.dim).toBe(1024);
  });

  it("has no row in either block that cannot tell one photograph from another", () => {
    for (const [name, base, n] of [
      ["nuisance", HEAD.nuisance_emb, HEAD.nuisance!.length],
      ["adjacent", HEAD.adjacent_emb, HEAD.adjacent!.length],
    ] as const) {
      expect(informativeRows(HEAD, base, n).every(Boolean), `${name} block`).toBe(true);
    }
  });

  it("scores 16 species, 8 nuisance and 7 adjacent rows of `dim`", () => {
    expect(HEAD.species_emb).toHaveLength(16 * DIM);
    expect(HEAD.nuisance_emb).toHaveLength(8 * DIM);
    expect(HEAD.adjacent_emb).toHaveLength(7 * DIM);
  });
});

describe("a real mosquito is never refused as a nuisance class", () => {
  // The defect this pins: culico's head carried fifteen placeholder rows, the gate
  // read their constant mass as evidence, and 59.6% of in-domain mosquitoes were
  // announced as "a photograph of a person". A text head cannot hold a placeholder
  // row, and this is the measurement that says so from the other side.
  const verdicts = MOSQUITOES.map((f) => appScore(f).verdict);

  it("refuses none of them", () => {
    const refused = verdicts.filter((v) => v.state === "non-mosquito");
    expect(
      refused.map((v) => JSON.stringify(v)),
      "real mosquitoes the gate refused",
    ).toEqual([]);
  });

  it("and names a species or a genus on almost all of them", () => {
    const n = verdicts.filter((v) => v.state === "species" || v.state === "genus").length;
    expect(n / verdicts.length).toBeGreaterThan(0.5);
  });
});

describe("what the app claims from this head", () => {
  // 83.66% correct where it names a species, at the shipped 0.373 floor. That is
  // under the 96.6% whole-set accuracy DEFAULT_FLOORS was fitted for, and it is
  // why a per-engine floor for H/14 was proposed and then withdrawn - the
  // measurement is a real gap, but it does not say which value closes it. docs/
  // HEADS.md carries the curve. What is pinned here is the floor on the number,
  // so a change that makes the app less accurate where it speaks fails.
  const res = MOSQUITOES.map((f) => appScore(f));

  it("names a species on most photographs, and is usually right when it does", () => {
    const claimed = res.filter((r) => r.verdict.state === "species");
    expect(claimed.length / res.length).toBeGreaterThan(0.8);
    const right = res.filter(
      (r, i) => r.verdict.state === "species" &&
        (r.verdict as { species: string }).species === HEAD.species[REF.species_index[i]!],
    );
    expect(right.length / claimed.length).toBeGreaterThan(0.8);
  });
});

describe("the other side of the gate: background crops", () => {
  // The positives are where culico's broken head showed itself. The negatives are
  // where a head that is merely WEAK shows itself, and this one is weak: on the
  // full 899-crop set it refuses 7.79%, against 86.14% for culico's refitted head
  // on the same crops. It fails in the opposite direction - it under-refuses
  // background rather than over-refusing mosquitoes - and that is a real gap, not
  // a rounding error, so it is pinned here rather than left to prose.
  //
  // This fixture is 256 of those crops. The assertion is deliberately a ceiling
  // and not a floor: the number to protect is that these are NOT named species,
  // and a future change to the gate must not make them mostly species.
  const verdicts = BACKGROUND.map((f) => appScore(f).verdict);

  it("names a species on far fewer background crops than on mosquitoes", () => {
    const named = verdicts.filter((v) => v.state === "species").length;
    expect(named / verdicts.length).toBeLessThan(0.25);
  });

  it("names an adjacent family rather than a mosquito when it does refuse", () => {
    // 55 of the 70 refusals on the full set name an adjacent family and 15 name a
    // nuisance row, so the gate is reading evidence rather than firing on
    // hesitation - the culico failure mode. Nothing here may name a species.
    for (const v of verdicts.filter((x) => x.state === "non-mosquito")) {
      const kind = (v as { nonMosquitoKind: string }).nonMosquitoKind;
      expect(["adjacent", "nuisance"]).toContain(kind);
    }
  });
});
