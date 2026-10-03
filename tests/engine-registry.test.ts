/**
 * The engine selector and the engine map must offer the same engines.
 *
 * They are written in two files - `index.html` for the options, `modelConfig.ts`
 * for what the app can actually load - and a key in one with no counterpart in
 * the other is an engine the user can pick and the app cannot fetch. The map is
 * what `?engine=` and the saved `mosquito_engine` preference are resolved
 * against, so a stale key left in a browser by a removed engine resolves to
 * nothing rather than to an error.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CALIBRATED_ENGINES, WEBGPU_MODELS } from "../src/app/modelConfig";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(root, "index.html"), "utf8");

/** The value of every `<option>` in the engine selector. */
function optionValues(): string[] {
  const select = HTML.match(/<select id="engine-select"[\s\S]*?<\/select>/);
  expect(select, "the engine selector is not in index.html").not.toBeNull();
  return [...select![0]!.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]!);
}

describe("the engine registry", () => {
  it("offers no engine that the app cannot load", () => {
    for (const value of optionValues()) {
      if (value === "server-gpu") continue; // a separate deployment, not a model file
      expect(Object.keys(WEBGPU_MODELS), `"${value}" is offered but not in WEBGPU_MODELS`).toContain(value);
    }
  });

  it("has no INT8 engine", () => {
    // A 609 MB download of a tower that already ships in FP16, and onnxruntime-web
    // has no INT8 WebGPU kernels, so the session falls back to WASM CPU and runs
    // an order of magnitude slower - a slow path to a worse one.
    expect(Object.keys(WEBGPU_MODELS).filter((k) => /int8/i.test(k))).toEqual([]);
    expect([...CALIBRATED_ENGINES].filter((k) => /int8/i.test(k))).toEqual([]);
    expect([...optionValues()].filter((v) => /int8/i.test(v))).toEqual([]);
    expect(HTML).not.toMatch(/INT8/i);
    expect(JSON.stringify(WEBGPU_MODELS)).not.toMatch(/int8/i);
  });

  it("keeps every calibrated engine in the map", () => {
    // A calibrated engine nothing can select is dead configuration that reads as
    // a live one.
    for (const engine of CALIBRATED_ENGINES) {
      expect(Object.keys(WEBGPU_MODELS), engine).toContain(engine);
    }
  });
});
