// That the detector's box threshold is one number, declared once, and that the
// decoder reads that declaration rather than a literal of its own.
//
// DET_CONF was 0.70 for the life of the app and no test mentioned it anywhere,
// which is how a change to it could have been half-applied without anything
// going red: an evaluator harness pinned to one value and the app on another,
// a second literal left in the decoder, or a doc comment quoting a number the
// constant no longer holds. None of those are a correctness bug in any one file
// - they are the class of defect that only shows up as the shipped threshold and
// the measured one disagreeing months later.
//
// So: the gate is `>=`, not `>`, because the constant is documented as the
// score below which a box is discarded and half the difference between "0.50"
// and "not 0.50" is a boundary nobody has ever tested.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DET_CONF, NMS_IOU } from "../src/app/modelConfig";
import { decodeDets } from "../src/app/detector";
import type { OrtTensor } from "../src/app/types";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const CONFIG = join(root, "src", "app", "modelConfig.ts");

/** One candidate at anchor 0: cx, cy, w, h in the letterboxed frame, one class score. */
function tensorWith(scores: readonly number[]): OrtTensor {
  const N = scores.length;
  const nc = 1;
  const data = new Float32Array((4 + nc) * N);
  for (let i = 0; i < N; i++) {
    data[i] = 50;            // cx
    data[N + i] = 50;        // cy
    data[2 * N + i] = 20;    // w
    data[3 * N + i] = 20;    // h
    data[4 * N + i] = scores[i]!;
  }
  return { data, dims: [1, 4 + nc, N] } as unknown as OrtTensor;
}

/** r = 1, dx = dy = 0: the decode is the identity, so the box comes back as written. */
function decode(scores: readonly number[]): number[] {
  return decodeDets(tensorWith(scores), 1, 0, 0).map((d) => d.conf);
}

describe("the detector's confidence gate", () => {
  it("keeps a box whose score is exactly the threshold", () => {
    // `bc < DET_CONF` discards strictly below, so the threshold itself fires.
    // A `<=` here would silently drop every detection the constant names.
    expect(decode([DET_CONF])).toEqual([DET_CONF]);
  });

  it("discards a box one representable step below the threshold", () => {
    const below = Math.fround(DET_CONF - 1e-6);
    if (below >= DET_CONF) throw new Error("the step did not move the value");
    expect(decode([below])).toEqual([]);
  });

  it("gates on the threshold, not on some other number", () => {
    // If the decoder hard-coded a literal, DET_CONF would stop meaning anything
    // and this pair would come out on the wrong side.
    expect(decode([DET_CONF + 0.01])).toHaveLength(1);
    expect(decode([DET_CONF - 0.01])).toHaveLength(0);
  });

  it("is independent of the NMS threshold", () => {
    // Both were 0.70 and both are load-bearing. Changing one must not move the
    // other, which a test that only ever passes one of them could not see.
    expect(DET_CONF).not.toBe(NMS_IOU);
  });
});

describe("where the threshold is declared", () => {
  const srcFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|js)$/.test(e.name)) out.push(rel);
      }
    };
    walk(join("src", "app"));
    return out;
  };

  it("is declared exactly once in src/app", () => {
    const sites = srcFiles().filter((f) =>
      /^export const DET_CONF\b/m.test(readFileSync(join(root, f), "utf8")));
    expect(sites).toEqual([join("src", "app", "modelConfig.ts")]);
  });

  it("is quoted with its own value in the comment that explains it", () => {
    // The constant carries the measurement that justifies it. A comment that
    // quotes a different number is the disagreement this file exists to stop.
    const src = readFileSync(CONFIG, "utf8");
    const decl = src.match(/^export const DET_CONF = ([\d.]+);$/m);
    expect(decl).not.toBeNull();
    const value = Number(decl![1]);
    expect(value).toBe(DET_CONF);
    const before = src.slice(0, decl!.index);
    const comment = before.slice(before.lastIndexOf("/**"));
    expect(comment).toContain(String(value));
  });
});
