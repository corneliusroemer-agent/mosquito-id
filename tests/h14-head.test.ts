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

describe("what the app claims from this head is usually right", () => {
  it("holds the species floor that meets the accuracy contract", () => {
    const res = MOSQUITOES.map((f) => appScore(f));
    const claimed = res.filter((r) => r.verdict.state === "species");
    expect(claimed.length / res.length).toBeGreaterThan(0.2);
    const right = res.filter(
      (r, i) => r.verdict.state === "species" &&
        (r.verdict as { species: string }).species === HEAD.species[REF.species_index[i]!],
    );
    expect(right.length / claimed.length).toBeGreaterThan(0.9);
  });
});

describe("the per-engine floors H/14 is scored at", () => {
  it("are this engine's own, not culico's and not a widened default", () => {
    expect(floorsFor(ENGINE)).not.toBe(DEFAULT_FLOORS);
    expect(floorsFor(ENGINE).species).toBe(0.8);
    expect(floorsFor(ENGINE).genus).toBe(0.9);
    // The gate's floors are the shipped ones: this head's nuisance rows are real
    // text embeddings, so nothing about them needed re-deriving.
    expect(floorsFor(ENGINE).nonMosquito).toBe(DEFAULT_FLOORS.nonMosquito);
    expect(floorsFor(ENGINE).nuisance).toBe(DEFAULT_FLOORS.nuisance);
  });
});
