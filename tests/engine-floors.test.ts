// Which floors each engine is scored at, and why two engines are not scored at
// the shipped ones.
//
// The floors are absolute thresholds on a posterior, so inheriting one across
// engines is a claim the inheriting engine has never been tested for. Two heads were
// refitted from zero-shot text heads to trained probes on 2026-10-04 (docs/HEADS.md),
// and both produce posteriors DEFAULT_FLOORS was not fitted on.
//
// culico at the shipped 0.373 species floor clears on 70% of in-corpus photographs
// at 72% accuracy, against the ~88% the threshold was chosen to deliver. B/16 has the
// sharper problem that its nuisance floor governs its non-mosquito gate outright,
// because it carries no adjacent block.
//
// The values were fitted on one half of a held-out corpus and read on the other,
// then checked against the corpus the head was fitted on. This file pins the
// outcome rather than the curve: an engine that silently falls back to
// DEFAULT_FLOORS, or one that loses its override, fails here.
import { describe, expect, it } from "vitest";
import { floorsFor, cosineOffsetsFor, WEBGPU_MODELS } from "../src/app/modelConfig";
import { DEFAULT_FLOORS, localViewScale, type Floors, type Head } from "../src/confidence/types";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, "..", "public", "text_embeds_culico.json"), "utf8"));
const CULICO = { ...raw, biasIndex: raw.bias_index } as unknown as Head;

describe("per-engine floors", () => {
  it("leaves the engines with no override on the shipped floors", () => {
    for (const key of Object.keys(WEBGPU_MODELS)) {
      // culico, H/14 and B/16 each carry an entry of their own; see below and
      // modelConfig.ts. None may leak to an engine that has no entry.
      if (key === "webgpu-culico" || key === "webgpu-fp16" || key === "webgpu-b16") continue;
      expect(floorsFor(key), key).toBe(DEFAULT_FLOORS);
    }
    expect(floorsFor("server-gpu")).toBe(DEFAULT_FLOORS);
    expect(floorsFor("an-engine-that-does-not-exist")).toBe(DEFAULT_FLOORS);
  });

  it("scores B/16 at floors fitted against its own posterior, including a nuisance floor", () => {
    // B/16's head was refitted on 2026-10-04 (docs/HEADS.md). Its `nuisance` floor is
    // the one that matters most: B/16 carries no adjacent block, so those eight rows
    // are the gate's only evidence, and the shipped 0.05 was fitted on H/14. Every
    // other engine keeps 0.05 - a global default is not widened to fix one engine.
    const f = floorsFor("webgpu-b16");
    expect(f.species).toBe(0.8);
    expect(f.genus).toBe(0.9);
    expect(f.nuisance).toBe(0.2);
    expect(DEFAULT_FLOORS.nuisance).toBe(0.05);
    // The floor is not the temperature: `logit_scale` must stay equal to it, or the
    // app's softmax stops being the probe's own.
    expect(f.temperature).toBe(DEFAULT_FLOORS.temperature);
  });

  it("scores culico at its own, higher, floors", () => {
    const f = floorsFor("webgpu-culico");
    expect(f.species).toBeGreaterThan(DEFAULT_FLOORS.species);
    expect(f.genus).toBeGreaterThan(DEFAULT_FLOORS.genus);
    // The two the fit did NOT move: the non-mosquito gate's behaviour was
    // measured against this head and did not need to change.
    expect(f.nonMosquito).toBe(DEFAULT_FLOORS.nonMosquito);
    expect(f.nuisance).toBe(DEFAULT_FLOORS.nuisance);
    expect(f.viewDisagreementVetoesSpecies).toBe(DEFAULT_FLOORS.viewDisagreementVetoesSpecies);
    expect(f.temperature).toBe(DEFAULT_FLOORS.temperature);
  });

  it("scores H/14 at its own floors, fitted against its own posteriors", () => {
    // H/14 is the engine DEFAULT_FLOORS was fitted on, and at the shipped 0.373
    // it names a species on 86.7% of held-out photographs and is right 83.66% of
    // the time - under the ~88% contract. At 0.80 it is right 97.05% at 37.4%
    // coverage. docs/HEADS.md carries the measurement.
    const f = floorsFor("webgpu-fp16");
    expect(f.species).toBeGreaterThan(DEFAULT_FLOORS.species);
    expect(f.genus).toBeGreaterThan(DEFAULT_FLOORS.genus);
    // Its gate floors are unchanged: the nuisance and adjacent rows on this head
    // are real text embeddings, not placeholders, so the block never needed
    // re-deriving and moving one would be a change nobody measured.
    expect(f.nonMosquito).toBe(DEFAULT_FLOORS.nonMosquito);
    expect(f.nuisance).toBe(DEFAULT_FLOORS.nuisance);
    expect(f.temperature).toBe(DEFAULT_FLOORS.temperature);
  });

  it("returns a whole floors object, not a partial one", () => {
    // A spread that forgot a key would silently fall back to DEFAULT_FLOORS for
    // that one field and read as a decision nobody made.
    const f = floorsFor("webgpu-culico") as Floors;
    for (const k of Object.keys(DEFAULT_FLOORS) as (keyof Floors)[]) {
      expect(f[k], k).toBeDefined();
      expect(typeof f[k], k).toBe(typeof DEFAULT_FLOORS[k]);
    }
  });

  it("is paired with the same opt-in shape as the cosine calibration", () => {
    // Both are per-engine corrections that must not leak to an engine they were
    // not fitted against. culico is opted out of the calibration (a probe's
    // intercepts already carry the class priors) and opted in to its own floors.
    expect(Object.keys(cosineOffsetsFor("webgpu-culico"))).toHaveLength(0);
    expect(floorsFor("webgpu-culico")).not.toBe(DEFAULT_FLOORS);
  });

  it("cannot change the head's scale, which is the probe's own softmax", () => {
    // The floor and the scale are different knobs and this change touched only
    // one of them. localViewScale must stay exactly 1 for culico.
    expect(localViewScale(CULICO)).toBe(1);
    expect(floorsFor("webgpu-culico").temperature).toBe(DEFAULT_FLOORS.temperature);
  });
});
