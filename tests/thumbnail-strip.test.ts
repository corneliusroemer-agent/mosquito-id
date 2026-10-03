import { describe, expect, it } from "vitest";
import {
  badge, canView, checkLabel, contributesToPool, entersPooledSum, inclusionSummary,
  photoState, poolExclusionReason, removeLabel, shiftIncluded, shiftIncludedForPrepend,
  shiftSelected, validateIncluded, viewLabel,
} from "../src/app/thumbnailStrip";
import { splitPoolable } from "../src/confidence/pooling";
import type { PoolablePhoto } from "../src/confidence/pooling";
import type { Verdict } from "../src/confidence/types";
import type { ClassifiedPhoto, Verdictish } from "../src/app/types";

/**
 * The strip's predicates, over the whole cross-product of their inputs.
 *
 * The strip accumulated six defects that all lived *between* states rather than
 * inside one, so the enumeration here is exhaustive rather than sampled: every
 * combination of `pending` / `error` / `fallback` / `is_cropped` /
 * `verdict.state`, including combinations the app never builds, because the
 * predicates must still be total.
 *
 * The spec is `docs/THUMBNAIL-STRIP-SPEC.md`; its section numbers are cited.
 */

const verdict = (state: Verdictish["state"]): Verdict => ({
  state, genus: null, species: null, topGenusP: 0, topSpeciesP: 0, runnersUp: [],
});

/**
 * The same photo, as the confidence layer's `PoolablePhoto`.
 *
 * The app's `ClassifiedPhoto` declares its verdict with the narrower
 * `Verdictish`, which is the three states restated and is not assignable to the
 * confidence layer's `Verdict` without the extra fields the fixtures fill in
 * above. One cast here rather than a second verdict shape in every test.
 */
const poolable = (p: ClassifiedPhoto): PoolablePhoto => p as unknown as PoolablePhoto;

/** A photo in the state the app builds for "analysed, cropped, named to species". */
function photo(over: Partial<ClassifiedPhoto> = {}): ClassifiedPhoto {
  return {
    name: "photo.jpg",
    fullCanvas: null,
    cropCanvas: null,
    cropBox: null,
    contextBox: null,
    scores: {},
    detail: {},
    verdict: verdict("species"),
    is_cropped: true,
    pending: false,
    error: null,
    fallback: false,
    ...over,
  };
}

const PENDING = [true, false] as const;
const ERRORS = [null, "decode failed"] as const;
const FALLBACKS = [true, false] as const;
const CROPPED = [true, false] as const;
const VERDICTS = [null, "species", "genus", "unsure", "non-mosquito"] as const;

/** Every combination of the five inputs a tile's enabled/disabled state reads. */
const COMBINATIONS = PENDING.flatMap((pending) =>
  ERRORS.flatMap((error) =>
    FALLBACKS.flatMap((fallback) =>
      CROPPED.flatMap((is_cropped) =>
        VERDICTS.map((v) => ({
          pending, error, fallback, is_cropped,
          verdict: v === null ? null : verdict(v),
        })),
      ),
    ),
  ),
);

describe("photoState", () => {
  it("is total: every combination maps to one of the six states", () => {
    const seen = new Set(COMBINATIONS.map((c) => photoState(photo(c))));
    expect([...seen].sort()).toEqual(
      ["cropped", "error", "non-mosquito", "queued", "uncropped", "unsure"].sort(),
    );
  });

  it("applies the spec §1 precedence: error, then queued, then the declining verdicts", () => {
    // An error on a photo the classifier had already named is still an error.
    expect(photoState(photo({ error: "boom", verdict: verdict("species"), is_cropped: true }))).toBe("error");
    // A re-classification in flight is queued, whatever the previous crop said.
    expect(photoState(photo({ pending: true, verdict: verdict("species") }))).toBe("queued");
    expect(photoState(photo({ pending: true, error: "boom" }))).toBe("error");
    // A photo analysed and refused a name is not "cropped" whatever the crop says.
    expect(photoState(photo({ verdict: verdict("non-mosquito"), is_cropped: true }))).toBe("non-mosquito");
    expect(photoState(photo({ verdict: verdict("unsure"), is_cropped: true }))).toBe("unsure");
    // No verdict and no crop is uncropped; no verdict but a crop is cropped.
    expect(photoState(photo({ verdict: null, is_cropped: false }))).toBe("uncropped");
    expect(photoState(photo({ verdict: null, is_cropped: true }))).toBe("cropped");
  });
});

describe("canView (spec §1.1)", () => {
  it("is true for every photo in every state", () => {
    for (const c of COMBINATIONS) {
      expect(canView(photo(c)), JSON.stringify(c)).toBe(true);
    }
  });

  it("is true for a photo that failed before it had any pixels", () => {
    expect(canView(photo({ pending: true, fullCanvas: null, cropCanvas: null }))).toBe(true);
    expect(canView(photo({ error: "decode failed", fullCanvas: null }))).toBe(true);
  });
});

describe("contributesToPool (spec §1.1)", () => {
  it("is exactly: not pending, not errored, not fallback, not non-mosquito", () => {
    for (const c of COMBINATIONS) {
      const expected = !c.pending && !c.error && !c.fallback && c.verdict?.state !== "non-mosquito";
      expect(contributesToPool(photo(c)), JSON.stringify(c)).toBe(expected);
    }
  });

  it("closes the checkbox on a fallback photo even though the photo is viewable", () => {
    const fb = photo({ fallback: true, is_cropped: false, verdict: null });
    expect(canView(fb)).toBe(true);
    expect(contributesToPool(fb)).toBe(false);
  });

  it("leaves an unsure photo checkable: deciding not to trust it is the user's call", () => {
    expect(contributesToPool(photo({ verdict: verdict("unsure") }))).toBe(true);
    expect(entersPooledSum(photo({ verdict: verdict("unsure") }))).toBe(false);
  });

  it("leaves checkable a photo with no verdict that nothing has excluded", () => {
    expect(contributesToPool(photo({ verdict: null, is_cropped: false, manual_full_photo: true }))).toBe(true);
  });
});

describe("entersPooledSum agrees with splitPoolable (spec §1.1)", () => {
  it("matches splitPoolable for every combination, checkable or not", () => {
    for (const c of COMBINATIONS) {
      const p = photo(c);
      const { included } = splitPoolable([poolable(p)]);
      expect(entersPooledSum(p), JSON.stringify(c)).toBe(included.length === 1);
    }
  });

  it("routes every checkable photo that has a verdict to exactly one of the two lists", () => {
    // A checked photo that is neither pooled nor listed with a reason is the
    // silent drop. It is reachable only for a photo with no verdict at all,
    // which splitPoolable deliberately does not classify.
    for (const c of COMBINATIONS) {
      if (!c.verdict) continue;
      const p = photo(c);
      if (!contributesToPool(p)) continue;
      const { included, abstained } = splitPoolable([poolable(p)]);
      expect(included.length + abstained.length, JSON.stringify(c)).toBe(1);
    }
  });

  it("differs from the strip's permission only on fallback, which is the seam §1 records", () => {
    // splitPoolable sums a whole-frame view it is handed; the strip is what
    // keeps the nuisance gate's rejected photo out of the fusion step.
    const fb = photo({ fallback: true, is_cropped: false });
    expect(contributesToPool(fb)).toBe(false);
    expect(entersPooledSum(fb)).toBe(true);
  });

  it("never lets a photo into the sum that the strip has closed the checkbox for", () => {
    // The one combination where the strip's rule is strictly tighter.
    for (const c of COMBINATIONS) {
      if (contributesToPool(photo(c))) continue;
      expect(c.pending || !!c.error || c.fallback || c.verdict?.state === "non-mosquito",
        JSON.stringify(c)).toBe(true);
    }
  });
});

describe("checkLabel (spec §3.3)", () => {
  it("never claims a disabled checkbox can be included", () => {
    for (const c of COMBINATIONS) {
      const p = photo(c);
      const label = checkLabel(p, 1);
      if (contributesToPool(p)) continue;
      expect(label, JSON.stringify(c)).not.toMatch(/^Include photo/);
    }
  });

  it("is never empty, in any state", () => {
    for (const c of COMBINATIONS) {
      expect(checkLabel(photo(c), 1).trim().length, JSON.stringify(c)).toBeGreaterThan(0);
    }
  });

  it("gives each disabled state its own reason, carrying the error text", () => {
    expect(checkLabel(photo({ pending: true, verdict: null }), 1)).toBe("Waiting for this photo to be analysed");
    expect(checkLabel(photo({ error: "decode failed", verdict: null }), 1)).toBe("This photo failed: decode failed");
    expect(checkLabel(photo({ fallback: true, is_cropped: false, verdict: null }), 1))
      .toContain("nuisance gate");
    expect(checkLabel(photo({ verdict: verdict("non-mosquito") }), 1)).toContain("found no mosquito");
  });

  it("warns an unsure photo that checking it does not get it into the sum", () => {
    expect(checkLabel(photo({ verdict: verdict("unsure") }), 4)).toBe(
      "Include photo 4 (photo.jpg) in the pooled result — it will be listed as not confident enough to name a genus",
    );
  });

  it("tracks the photo's current 1-based position and name", () => {
    expect(checkLabel(photo({ name: "photo_C.jpg" }), 3)).toBe("Include photo 3 (photo_C.jpg) in the pooled result");
    expect(viewLabel(photo({ name: "photo_C.jpg" }), 3)).toBe("View photo 3: photo_C.jpg");
    expect(removeLabel(photo({ name: "photo_C.jpg" }), 3)).toBe("Remove photo 3: photo_C.jpg");
  });

  it("survives a photo with no name", () => {
    const p = photo({ name: undefined });
    expect(viewLabel(p, 1)).toBe("View photo 1: (unnamed)");
    expect(checkLabel(p, 1)).toContain("(unnamed)");
  });
});

describe("poolExclusionReason (spec §3.3)", () => {
  it("is empty exactly for the photos the strip would let into the sum", () => {
    for (const c of COMBINATIONS) {
      const p = photo(c);
      const reason = poolExclusionReason(p);
      if (contributesToPool(p)) continue;
      expect(reason.length, JSON.stringify(c)).toBeGreaterThan(0);
    }
  });

  it("says something different about each of the four reasons", () => {
    const reasons = new Set([
      poolExclusionReason(photo({ error: "x", verdict: null })),
      poolExclusionReason(photo({ pending: true, verdict: null })),
      poolExclusionReason(photo({ fallback: true, is_cropped: false, verdict: null })),
      poolExclusionReason(photo({ verdict: verdict("non-mosquito") })),
    ]);
    expect(reasons.size).toBe(4);
  });

  it("carries the error text through", () => {
    expect(poolExclusionReason(photo({ error: "decode failed", verdict: null }))).toContain("analysis failed");
  });
});

describe("badge (spec §3.5)", () => {
  it("never has an empty title, in any state", () => {
    for (const c of COMBINATIONS) {
      const p = photo(c);
      if (p.pending) expect(badge(p).title, JSON.stringify(c)).not.toBe("");
      if (p.error) expect(badge(p).title, JSON.stringify(c)).toBe(p.error);
    }
  });

  it("does not put a green cropped tick on a photo that is not a mosquito", () => {
    const nm = badge(photo({ verdict: verdict("non-mosquito") }));
    expect(nm.className).not.toContain("cropped");
    expect(nm.glyph).toBe("✕");
    expect(nm.title).toBe("No mosquito detected in this photo");
  });

  it("distinguishes no-mosquito from no-crop", () => {
    expect(badge(photo({ fallback: true, is_cropped: false, verdict: null })).title)
      .not.toBe(badge(photo({ verdict: verdict("non-mosquito") })).title);
  });

  it("gives the queued and unsure states their own glyphs", () => {
    expect(badge(photo({ pending: true, verdict: null })).glyph).toBe("…");
    expect(badge(photo({ verdict: verdict("unsure") })).glyph).toBe("?");
  });
});

describe("shiftIncluded (spec §3.4)", () => {
  // A strip of 5 with only photos 1, 2 and 4 checked. Deleting each position in
  // turn: the table a stale index would get wrong.
  it("removes the deleted index and moves everything after it down one", () => {
    const checked = () => new Set([1, 2, 4]);
    expect([...shiftIncluded(checked(), 0)]).toEqual([0, 1, 3]);
    expect([...shiftIncluded(checked(), 1)]).toEqual([1, 3]);
    expect([...shiftIncluded(checked(), 2)]).toEqual([1, 3]);
    expect([...shiftIncluded(checked(), 3)]).toEqual([1, 2, 3]);
    expect([...shiftIncluded(checked(), 4)]).toEqual([1, 2]);
  });

  it("reduces a fully-checked strip of five to the other four", () => {
    for (let d = 0; d < 5; d++) {
      expect([...shiftIncluded(new Set([0, 1, 2, 3, 4]), d)], `del=${d}`).toEqual([0, 1, 2, 3]);
    }
  });

  it("leaves a check before the deletion where it is", () => {
    expect([...shiftIncluded(new Set([0]), 2)]).toEqual([0]);
    expect([...shiftIncluded(new Set([3]), 3)]).toEqual([]);
    expect([...shiftIncluded(new Set(), 0)]).toEqual([]);
  });

  it("keeps a photo checked across a deletion before it", () => {
    const set = new Set([0, 1, 2]);
    shiftIncluded(set, 0);
    // The photo that was index 1 is now index 0 and stays checked.
    expect([...validateIncluded(shiftIncluded(set, 0), 2)]).toEqual([0, 1]);
  });

  it("does not mutate its input", () => {
    const before = new Set([0, 1, 2]);
    shiftIncluded(before, 0);
    expect([...before]).toEqual([0, 1, 2]);
  });
});

describe("shiftIncludedForPrepend (spec §4)", () => {
  it("moves every existing index up by the size of the new batch", () => {
    expect([...shiftIncludedForPrepend(new Set([0, 1, 2]), 3)]).toEqual([3, 4, 5]);
    expect([...shiftIncludedForPrepend(new Set(), 3)]).toEqual([]);
    expect([...shiftIncludedForPrepend(new Set([0, 1]), 0)]).toEqual([0, 1]);
  });
});

describe("validateIncluded (spec §3.4, §4)", () => {
  it("drops every index that is not a valid position", () => {
    expect([...validateIncluded(new Set([0, 1, 2, 3]), 3)]).toEqual([0, 1, 2]);
    expect([...validateIncluded(new Set([0, 5, -1, 2]), 3)]).toEqual([0, 2]);
    expect([...validateIncluded(new Set([0, 1]), 0)]).toEqual([]);
  });

  it("drops non-integers, so a stray value cannot silently alias a photo", () => {
    expect([...validateIncluded(new Set([0, 1.5, NaN, "2" as unknown as number]), 3)]).toEqual([0]);
  });

  it("leaves a valid set untouched", () => {
    expect([...validateIncluded(new Set([0, 2]), 3)]).toEqual([0, 2]);
  });

  it("is what makes three checked boxes stop reaching the card as one", () => {
    // The reported defect: three boxes ticked, the card counting fewer photos
    // than were ticked, because the strip wrote indices the card could not
    // resolve and the card dropped them without saying so.
    const written = new Set([1, 2, 3]);   // stale indices from reused tiles
    expect([...written]).toHaveLength(3);
    const resolved = Array.from(validateIncluded(written, 3)).map((i) => `photo_${i}`);
    expect(resolved).toHaveLength(2);
    // After the strip re-validates on render, what is left is what the boxes say.
    const boxes = [1, 2].map((i) => `photo_${i}`);
    expect([...validateIncluded(written, 3)].map((i) => `photo_${i}`)).toEqual(boxes);
  });
});

describe("shiftSelected (spec §3.4)", () => {
  // Strip of 5, delete position `d`, selection starts on 2.
  it("follows the photo when a photo before it is deleted", () => {
    expect(shiftSelected(2, 0, 4)).toBe(1);
    expect(shiftSelected(2, 1, 4)).toBe(1);
  });

  it("stays put when the selected photo itself is deleted", () => {
    expect(shiftSelected(2, 2, 4)).toBe(2);
  });

  it("stays put when a photo after it is deleted", () => {
    expect(shiftSelected(2, 3, 4)).toBe(2);
    expect(shiftSelected(2, 4, 4)).toBe(2);
  });

  it("clamps when the selection fell off the end", () => {
    expect(shiftSelected(4, 4, 4)).toBe(3);
    expect(shiftSelected(0, 0, 0)).toBe(0);
  });

  it("never returns an index outside the strip", () => {
    for (let len = 0; len <= 6; len++) {
      for (let sel = 0; sel < 6; sel++) {
        for (let del = 0; del < 6; del++) {
          const next = shiftSelected(sel, del, len);
          expect(next, `sel=${sel} del=${del} len=${len}`).toBeGreaterThanOrEqual(0);
          expect(next, `sel=${sel} del=${del} len=${len}`).toBeLessThanOrEqual(Math.max(0, len - 1));
        }
      }
    }
  });
});

describe("inclusionSummary (spec §3.3, §8 row 5)", () => {
  it("says how many are checked and how many contribute when they differ", () => {
    expect(inclusionSummary(3, 1)).toBe("3 checked, 1 in the pooled result");
    expect(inclusionSummary(2, 0)).toBe("2 checked, 0 in the pooled result");
  });

  it("does not add a second number when every checked photo contributes", () => {
    expect(inclusionSummary(3, 3)).toBe("3 photos in the pooled result");
    expect(inclusionSummary(1, 1)).toBe("1 photo in the pooled result");
  });

  it("says so when nothing is checked", () => {
    expect(inclusionSummary(0, 0)).toBe("No photos checked");
  });
});
