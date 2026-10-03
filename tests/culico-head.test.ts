// The shape of culico-net-cls-v1's head, which is not the shape of a text head's.
//
// The head is a 16-row linear probe on a 21M TinyViT. Its graph appends a
// constant coordinate to the embedding so the probe's intercept has somewhere to
// live, and `bias_index` says which. That leaves the two blocks the gate reads
// mostly un-fitted: fitting 8 nuisance photographs and 8 adjacent families needs
// training data the probe never saw, so seven of each are placeholder rows
// carrying nothing but the intercept.
//
// Those rows are constants. They score the same on every photograph, so their
// posteriors rise exactly when the classifier is unsure - and a gate reading them
// as evidence refuses hesitant photographs and names whichever row the file lists
// first. That is what culico did: 3,730 of the 6,264 in-domain mosquitoes came
// back as "a photograph of a person", and the score panel put "a biting midge"
// above every one of them at the ~1% it actually held.
//
// These numbers are pinned so a refit that FILLS the blocks in shows up as a
// changed assertion here, which is the signal to revisit the gate's floors for
// that engine - not as a silent change in what the app refuses.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { informativeRows } from "../src/confidence/softmax";
import type { Head } from "../src/confidence/types";

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(
  readFileSync(join(here, "..", "public", "text_embeds_culico.json"), "utf8"),
) as Record<string, unknown>;
const head = { ...raw, biasIndex: raw.bias_index } as unknown as Head;

describe("culico's head", () => {
  it("declares which coordinate is the probe's intercept", () => {
    expect(raw.bias_index).toBe((raw.dim as number) - 1);
    expect(head.biasIndex).toBe(1152);
  });

  it("carries 16 species, 8 nuisance and 8 adjacent rows", () => {
    expect(head.species.length).toBe(16);
    expect(head.nuisance!.length).toBe(8);
    expect(head.adjacent!.length).toBe(8);
    // One of the adjacent classes is a fitted background row, not a family.
    expect(head.adjacent!.at(-1)).toBe("a photograph without a mosquito");
  });

  it("has no fitted nuisance detector at all", () => {
    expect(informativeRows(head, head.nuisance_emb, head.nuisance!.length).filter(Boolean)).toHaveLength(0);
  });

  it("has exactly one fitted adjacent detector", () => {
    const keep = informativeRows(head, head.adjacent_emb, head.adjacent!.length);
    expect(keep.filter(Boolean)).toHaveLength(1);
    expect(head.adjacent![keep.indexOf(true)]).toBe("a photograph without a mosquito");
  });

  it("is the only shipped head with a bias coordinate", () => {
    // The other two are text heads: every coordinate is image information, so
    // every row of theirs is read and none of this applies to them.
    for (const file of ["text_embeds.json", "text_embeds_b16.json"]) {
      const other = JSON.parse(
        readFileSync(join(here, "..", "public", file), "utf8"),
      ) as Record<string, unknown>;
      expect(other.bias_index, file).toBeUndefined();
    }
  });

  it("still scores at the scale its logit_scale and the temperature give", () => {
    // 2.5 / 2.5. Recorded because the refusal was never about this number: the
    // informative background row clears the 0.60 adjacent floor on 59% of the
    // held-out negatives at the cost of none of the 6,264 in-domain mosquitoes.
    expect(head.logit_scale).toBe(2.5);
  });
});