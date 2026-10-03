/**
 * A photo the detector could not crop is still a classified photo.
 *
 * Two failures came out of one missing distinction. The detector finds no box at
 * all, or it finds one, the crop is made, and the nuisance gate rejects that
 * crop - and the app used to carry a single `fallback` bit for the second case
 * while every consumer read it as the first. So a photo that was classified on
 * its whole frame and named was struck off the list of photos that can be
 * pooled, and the tile carried a cross saying no mosquito had been detected,
 * which is a claim about the picture the app never made.
 *
 * The predicates are pure and are tested over their whole input cross-product in
 * `thumbnail-strip.test.ts`. What is pinned here is the record the classify path
 * actually builds, because the defect lived in the seam between that record and
 * those predicates, and nothing else in the suite crosses it: `main.js` is a
 * `.js` file, which `tsc --noEmit` does not read at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { badge, contributesToPool } from "../src/app/thumbnailStrip";
import type { ClassifiedPhoto } from "../src/app/types";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** `classifyImage`, and nothing after it. */
function classifySource(): string {
  const src = readFileSync(join(root, "src", "app", "main.js"), "utf8");
  const start = src.indexOf("async function classifyImage");
  const end = src.indexOf("// ---- Batch Processing ----");
  expect(start, "classifyImage not found in main.js").toBeGreaterThan(-1);
  expect(end, "the batch-processing marker not found in main.js").toBeGreaterThan(start);
  return src.slice(start, end);
}

/** The record as the app builds it, for one verdict. */
function classified(over: Partial<ClassifiedPhoto>): ClassifiedPhoto {
  return {
    name: "photo.jpg",
    fullCanvas: null,
    cropCanvas: null,
    cropBox: null,
    contextBox: null,
    scores: {},
    detail: {},
    verdict: { state: "species", genus: "Aedes", species: "Aedes aegypti" },
    is_cropped: false,
    pending: false,
    error: null,
    crop_rejected: false,
    ...over,
  };
}

describe("the whole-frame classification path", () => {
  it("records a rejected crop as a rejected crop", () => {
    const src = classifySource();
    // The nuisance gate drops the crop and keeps the frame; the flag says which
    // of the two that was.
    expect(src).toMatch(/crop_rejected:\s*cropRejected/);
    expect(src).toMatch(/cropRejected = true/);
  });

  it("carries no flag that pools off the crop's fate", () => {
    // `fallback` was one boolean for two unrelated events and every reader gave
    // it the meaning it did not have. A field named for the old conflation
    // coming back is the same defect wearing a new name.
    expect(classifySource()).not.toMatch(/\bfallback\b/);
  });

  it("says what happened, in the status it writes", () => {
    // The status is what the results table shows, and it reaches further than the
    // tile does: on a batch of GBIF photos a reader sees it per row.
    const status = classifySource().match(/const status = [\s\S]*?;\n/);
    expect(status, "the status assignment is not where it is expected").not.toBeNull();
    expect(status![0]).toMatch(/the detector found no box/);
    expect(status![0]).toMatch(/the crop was rejected as a nuisance/);
    expect(status![0]).not.toMatch(/no mosquito/i);
  });

  it("pools a photo the gate's crop rejection left classified on its whole frame", () => {
    expect(contributesToPool(classified({ crop_rejected: true, verdict: { state: "genus", genus: "Culex" } })))
      .toBe(true);
  });

  it("shows that photo as analysed rather than as a failure", () => {
    const b = badge(classified({ crop_rejected: true, is_cropped: false }));
    expect(b.glyph).not.toBe("✕");
    expect(b.title.toLowerCase()).not.toMatch(/no mosquito|not a mosquito/);
  });
});
