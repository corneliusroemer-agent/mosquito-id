/**
 * The b16-ft head, and the engine that ships it.
 *
 * The head is a linear probe on the crop-jitter fine-tuned BioCLIP B/16, so it is a
 * different KIND of object from the two text heads beside it: it has an intercept,
 * it is fitted rather than prompted, and its rows carry the margin the fit found.
 * Three things follow, and each has bitten an engine before, so each is asserted
 * here rather than left to a comment:
 *
 *   1. It is 513-wide with `bias_index: 512`, because the exported graph appends a
 *      constant 1.0 and the app's head is a bare dot product with nowhere else to
 *      put an intercept. A head that declared 512 rows of 512 would be scored
 *      against a feature vector the browser never produces.
 *   2. Its rows are NOT unit norm. Re-normalising a fitted readout discards the
 *      only thing that says how sure the classifier is, and it would put the
 *      species block on the same footing as the nuisance placeholders.
 *   3. Its nuisance block is placeholders except for one fitted row, so the gate
 *      reads exactly one detector rather than nine constants that tie. The eight
 *      text prompts the other B/16 head carries were written against the FROZEN
 *      encoder's embedding space; the fine-tuned tower's features have moved off
 *      it, so carrying those rows across would be eight confident, wrong answers.
 *
 * The engine ships WITHOUT becoming the default, and that is the load-bearing
 * property of this file's last test: the host is still confirming the fine-tune
 * gain on dataset v2, and the instruction is that the default does not flip unless
 * that confirmation comes out in favour.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { softmaxJoint, informativeRows } from "../src/confidence/softmax";
import { localViewScale, DEFAULT_FLOORS, type Head } from "../src/confidence/types";
import { CALIBRATED_ENGINES, cosineOffsetsFor, floorsFor, WEBGPU_MODELS } from "../src/app/modelConfig";
import { PER_GENUS_COSINE_OFFSET } from "../src/confidence/calibration";
import { capabilityOf } from "../src/app/granularity";

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, "..", "public", "text_embeds_b16ft.json"), "utf8")) as Record<string, unknown>;
const HEAD = { ...raw, biasIndex: raw.bias_index } as unknown as Head;
const DIM = HEAD.dim;
const BIAS = HEAD.biasIndex ?? -1;

/** clipEmbed for this head: L2-normalise all 513 coordinates, the constant included. */
function appEmbed(feats: number[]): Float32Array {
  const e = Float32Array.from(feats);
  let n = 0;
  for (let i = 0; i < DIM; i++) n += e[i]! * e[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) e[i] = e[i]! / n;
  return e;
}

describe("the b16-ft head's shape is what the app expects", () => {
  it("is 16 species rows of 513, with the bias coordinate it declares", () => {
    expect(DIM).toBe(513);
    expect(raw.bias_index).toBe(512);
    expect(BIAS).toBe(512);
    expect(HEAD.species).toHaveLength(16);
    expect(HEAD.species_emb).toHaveLength(16 * DIM);
    for (const r of HEAD.species_emb!) expect(Number.isFinite(r)).toBe(true);
  });

  it("scores at scale 1.0, which is the only scale at which it is the probe", () => {
    // `softmaxJoint` multiplies every logit by logit_scale / temperature. A fitted
    // probe's posterior is the softmax of its own decision function, so the app
    // reproduces it only at 1.0 - which is why logit_scale here equals this
    // engine's temperature rather than the 100 a text head needs.
    expect(localViewScale(HEAD, floorsFor("webgpu-b16-ft"))).toBe(1);
    expect(HEAD.logit_scale).toBe(floorsFor("webgpu-b16-ft").temperature);
  });

  it("keeps the probe's own row magnitudes rather than unit-normalising them", () => {
    const norms = HEAD.species!.map((_, i) => {
      let s = 0;
      for (let k = 0; k < DIM; k++) s += HEAD.species_emb![i * DIM + k]! ** 2;
      return Math.sqrt(s);
    });
    expect(new Set(norms.map((n) => n.toFixed(4))).size).toBeGreaterThan(1);
    expect(Math.min(...norms)).toBeGreaterThan(0);
  });

  it("separates all sixteen species, so the engine can name one", () => {
    // `capabilityOf` is what reporting reads, so this is the assertion that the
    // engine really reports at species granularity rather than at the one its
    // dropdown label claims.
    expect(capabilityOf(HEAD)).toBe("species");
  });

  it("gives the gate exactly one informative nuisance row", () => {
    expect(HEAD.nuisance).toHaveLength(9);
    expect(HEAD.nuisance_emb).toHaveLength(9 * DIM);
    const keep = informativeRows(HEAD, HEAD.nuisance_emb, 9);
    const informative = keep.filter(Boolean).length;
    // The eight text prompts were fitted against the frozen encoder's space and
    // are carried as intercept-only placeholders, so they cannot fire the gate.
    // The ninth, `a photograph without a mosquito`, is fitted on this engine's own
    // negatives and is the gate's only evidence.
    expect(informative).toBe(1);
    expect(keep[8]).toBe(true);
    expect(HEAD.nuisance![8]).toBe("a photograph without a mosquito");
  });

  it("has no per-genus cosine calibration, which was fitted on another encoder", () => {
    // Read the real CALIBRATED_ENGINES rather than restating it: a local copy of the
    // set is a thing that drifts, and this assertion is about the shipped map.
    expect(Object.keys(cosineOffsetsFor("webgpu-b16-ft"))).toEqual([]);
    expect(CALIBRATED_ENGINES.has("webgpu-b16-ft")).toBe(false);
    // And it must be opting out explicitly - `softmaxJoint` defaults to
    // PER_GENUS_COSINE_OFFSET when `opts.offsets` is undefined, so an engine that
    // inherited the H/14 correction would look calibrated while being biased by it.
    expect(cosineOffsetsFor("webgpu-b16-ft")).not.toBe(PER_GENUS_COSINE_OFFSET);
  });

  it("scores a photograph without producing NaN, and names one of its sixteen", () => {
    // A synthetic embedding, which is all `softmaxJoint` needs: it is pure in the
    // head and the vector. The probe's rows are real, so this is a real softmax.
    const e = appEmbed(new Array(DIM).fill(0).map((_, i) => (i === 512 ? 1 : Math.sin(i * 0.37) * 0.05)));
    const j = softmaxJoint(HEAD, e, { offsets: cosineOffsetsFor("webgpu-b16-ft") });
    expect(j.spP).toHaveLength(16);
    expect(j.spP.every((p) => Number.isFinite(p) && p >= 0)).toBe(true);
    // The species block shares ONE softmax with the nine nuisance rows, so the
    // species posteriors sum to the probability that the photograph is a mosquito at
    // all - not to 1. Requiring 1 would be requiring the head to have no nuisance
    // block; docs/HEADS.md records the whole species block summing to 1 as the thing
    // that is NOT true of a fitted head. What must hold is that species and nuisance
    // together exhaust the mass.
    const spMass = j.spP.reduce((a, b) => a + b, 0);
    const nuMass = j.nuP.reduce((a, b) => a + b, 0);
    expect(spMass).toBeGreaterThan(0);
    expect(spMass).toBeLessThan(1);
    expect(spMass + nuMass).toBeCloseTo(1, 6);
    const top = j.spP.indexOf(Math.max(...j.spP));
    expect(HEAD.species).toContain(HEAD.species[top]);
  });
});

describe("the b16-ft engine ships without becoming the default", () => {
  it("is in the engine map, with the weights and head it needs", () => {
    const e = WEBGPU_MODELS["webgpu-b16-ft"];
    if (!e) throw new Error("webgpu-b16-ft is not in WEBGPU_MODELS");
    expect(e.path).toBe("bioclip_b16_ft_fp16.onnx");
    expect(e.embedsPath).toBe("text_embeds_b16ft.json");
    expect(e.taxonomyPath).toBe("taxonomy_b16ft.json");
    expect(e.reports).toBe("species");
    expect(e.size).toBeGreaterThan(0);
  });

  it("leaves the shipped B/16 engine selectable and the default where it was", () => {
    // Flipping the default is a separate, deliberate act. The fine-tune's gain is
    // DEV evidence plus a dataset-v2 confirmation the host has not finished, and
    // the standing instruction is that the default does not flip if that
    // confirmation comes out against it. So `webgpu-b16` must remain in the map
    // and the page's `selected` option must remain the H/14 default.
    const b16 = WEBGPU_MODELS["webgpu-b16"];
    if (!b16) throw new Error("webgpu-b16 is not in WEBGPU_MODELS");
    expect(b16.embedsPath).toBe("text_embeds_b16.json");
    const html = readFileSync(join(here, "..", "index.html"), "utf8");
    const selected = /<option value="([^"]+)" selected>/.exec(html);
    expect(selected, "no engine is marked selected in index.html").not.toBeNull();
    expect(selected![1]).toBe("webgpu-fp16");
  });

  it("is offered in the selector", () => {
    const html = readFileSync(join(here, "..", "index.html"), "utf8");
    expect(html).toContain('<option value="webgpu-b16-ft"');
    // And it must not be the option the browser starts on.
    expect(/<option value="webgpu-b16-ft"[^>]*\bselected\b/.test(html)).toBe(false);
  });
});
