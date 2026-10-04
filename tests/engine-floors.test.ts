// Which floors each engine is scored at, and why culico is not scored at the
// shipped ones.
//
// The floors are absolute thresholds on a posterior, so inheriting one across
// engines is a claim the inheriting engine has never been tested for. culico's
// head was refitted on 2026-10-04 (docs/HEADS.md) and is a trained probe whose
// posterior is far sharper than the text head DEFAULT_FLOORS were fitted on; at
// the shipped 0.373 it clears a species floor on 70% of in-corpus photographs at
// 72% accuracy, against the ~88% the threshold was chosen to deliver.
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
  it("leaves every other engine on the shipped floors", () => {
    for (const key of Object.keys(WEBGPU_MODELS)) {
      if (key === "webgpu-culico") continue;
      expect(floorsFor(key), key).toBe(DEFAULT_FLOORS);
    }
    expect(floorsFor("server-gpu")).toBe(DEFAULT_FLOORS);
    expect(floorsFor("an-engine-that-does-not-exist")).toBe(DEFAULT_FLOORS);
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
