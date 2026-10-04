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

/**
 * Three candidates at one anchor, one of them well above DET_CONF and two well
 * below, with the two low ones placed to overlap the high one.
 */
function spreadTensor(): Float32Array {
  const N = 3;
  const data = new Float32Array(5 * N);
  const xs = [50, 50, 51];
  for (let i = 0; i < N; i++) {
    data[i] = xs[i]!;
    data[N + i] = 50;
    data[2 * N + i] = 20;
    data[3 * N + i] = 20;
    data[4 * N + i] = i === 0 ? DET_CONF + 0.1 : 0.01;
  }
  return data;
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

  it("is not entangled with the NMS threshold", () => {
    // Both were 0.70, so "they are different numbers" proved nothing except
    // that this change moved one of them. What actually has to hold is that
    // the gate is a per-candidate score comparison, not a suppression
    // threshold: raising NMS_IOU keeps every well-separated candidate and
    // drops only overlapping ones, so scores on either side of DET_CONF are
    // unaffected by it.
    const spread = (iou: number): number =>
      decodeDets(
        { data: spreadTensor(), dims: [1, 5, 3] } as unknown as OrtTensor,
        1, 0, iou,
      ).length;
    expect(spread(0.70)).toBe(spread(0.05));
    expect(NMS_IOU).toBe(0.70);
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
    walk("src");
    return out;
  };

  it("is not shadowed by a literal in the decoder", () => {
    // A hard-coded `if (bc < 0.50)` instead of the import passes every gate
    // test above at today's value, because the constant and the literal agree.
    // It is invisible until one of them moves. So: the gate must read the name.
    const src = readFileSync(join(root, "src", "app", "detector.ts"), "utf8");
    const gate = src.split("\n").find((l) => l.includes("DET_CONF") && l.includes("<"));
    expect(gate).toBeDefined();
    expect(gate).not.toMatch(/<\s*0\.\d/);
    expect(gate).toMatch(/\bDET_CONF\b/);
  });

  it("is declared exactly once across all of src", () => {
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
    // `toContain(String(value))` is a near-tautology: String(0.50) is "0.5", and
    // every comment here contains "0.5", so it passes whether or not the prose
    // agrees. Match the value as a whole token instead.
    const before = src.slice(0, decl!.index);
    const comment = before.slice(before.lastIndexOf("/**"));
    const quoted = comment.match(/\b0\.\d+\b/g) ?? [];
    expect(quoted.filter((q) => Number(q) === value).length).toBeGreaterThan(0);
    // And nothing in the comment may quote a different threshold as the value
    // of *this* constant, which a second copy of the number would be.
    const claimed = comment.match(/DET_CONF[^\n]*?\b(0\.\d+)\b/);
    if (claimed) expect(Number(claimed[1])).toBe(value);
  });
});
