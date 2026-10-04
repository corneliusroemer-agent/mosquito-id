/**
 * Unchecking the whole-frame view changes the numbers, not just the view count.
 *
 * `whole-frame-toggle.test.ts` pins the SCHEDULING of the re-classification pass
 * and `view-selection.test.ts` pins which views a photo offers. Neither can see
 * the fused posterior itself: the scheduling test drives a fake classifier that
 * returns one fixed embedding, so two views of a photo pool to exactly what one
 * view says and "the toggle changed nothing" is indistinguishable from "the
 * toggle worked". So the arithmetic is pinned here, against the shipped head and
 * the real `fuseViews`.
 *
 * The direction is what makes these assertions worth more than `not.toEqual`.
 * Log-linear pooling puts the two-view posterior at the GEOMETRIC MEAN of the two
 * views' posteriors - strictly between them wherever they disagree, and strictly
 * below the more confident view - so a fusion that silently dropped the second
 * view, pooled a view with itself, or averaged arithmetically instead all fail
 * here rather than producing "a different number".
 */
import { describe, it, expect, beforeAll } from "vitest";
import { fuseViews } from "../src/confidence/fuseViews";
import { realHead, post } from "./fixtures";
import { viewKinds } from "../src/app/viewSelection";
import type { Head, ViewResult } from "../src/confidence/types";

let head: Head;
beforeAll(() => {
  head = realHead();
});

/** A view scored on one picture, naming `species` at `top` and the rest flat. */
function view(species: string, top: number): ViewResult {
  const spP = post(head, { [species]: top });
  const rest = (1 - top) / (head.species.length - 1);
  for (let i = 0; i < spP.length; i++) if (spP[i] === 0) spP[i] = rest;
  return { spP, nuTotal: 0.05, scale: head.logit_scale / 2.5 };
}

// Two views that disagree, which is the only configuration in which pooling can
// be observed at all. `crop` is the more confident of the two, so the fused
// posterior must land between them and nearer the crop.
//
// The crop sits above `CROP_ONLY_MAX_POSTERIOR` because a crop below it is scored
// on its own and never reaches the pooling these tests pin (see
// `confidence-router.test.ts` for that branch). These assertions are about the
// pooling arithmetic and are unchanged; only the fixture row moved, and it moved
// onto a row that still pools.
const crop = () => view("Aedes aegypti", 0.9);
const whole = () => view("Culex pipiens", 0.4);

describe("toggling the whole-frame view moves the fused posterior", () => {
  it("pools the two views log-linearly, each with weight one", () => {
    const c = crop();
    const w = whole();
    const fused = fuseViews(head, [c, w])!;

    // The rule: log p_fused[i] = log p_crop[i] + log p_whole[i], renormalised.
    //
    // Written on log RATIOS between two species because the nuisance mass enters
    // the same denominator for every species and so cancels in a difference of
    // logs - the identity is exact where the absolute posteriors are not. `p.7` on
    // the crop and `0.4` on the whole frame is a real disagreement, and pooling
    // it must land exactly on their sum.
    const i = head.species.indexOf("Aedes aegypti")!;
    const j = head.species.indexOf("Culex pipiens")!;
    const ratio = (spP: number[]) => Math.log(spP[i]!) - Math.log(spP[j]!);
    expect(ratio(fused.spP)).toBeCloseTo(ratio(c.spP) + ratio(w.spP), 6);

    // Weight one each, which is what "equal weight" means and what the +4.5
    // points was measured with. It is NOT an arithmetic mean of probabilities
    // (that would sit 0.55 along the probability axis) and NOT a confidence-
    // weighted one (that would move the ratio by the ratio of the two tops).
    const arithmetic = (c.spP[i]! + w.spP[i]!) / 2;
    const confWeighted = (0.9 * c.spP[i]! + 0.4 * w.spP[i]!) / 1.3;
    const sum = fused.spP.reduce((a, b) => a + b, 0);
    const got = fused.spP[i]! / sum;
    expect(got).not.toBeCloseTo(arithmetic, 4);
    expect(got).not.toBeCloseTo(confWeighted, 4);
  });

  it("lands nearer the crop than the whole frame, on a disagreement", () => {
    // Direction, and the reason the ordering of the two views matters: `viewKinds`
    // puts the crop first because the nuisance gate is a statement about the
    // crop. Pooled, the crop's 0.7 has to still be the stronger of the two.
    const c = crop();
    const w = whole();
    const fused = fuseViews(head, [c, w])!;
    const i = head.species.indexOf("Aedes aegypti")!;
    const sum = fused.spP.reduce((a, b) => a + b, 0);
    const got = fused.spP[i]! / sum;
    // Off the crop's own number, in the direction of the whole frame's opinion -
    // which is what "the second view was pooled in" means from the outside. The
    // species the two views DISAGREE about is the one that moves most, so it is
    // the one worth pinning; a species both views rate alike barely moves, and a
    // regression that pooled the crop with itself would leave this at 0.7.
    expect(got).toBeLessThan(c.spP[i]!);
    expect(got).toBeGreaterThan(w.spP[i]!);

    // And the movement is toward the whole frame, not merely away from the crop:
    // it covers a large fraction of the gap between the two views' own numbers.
    const gap = c.spP[i]! - w.spP[i]!;
    expect(got).toBeGreaterThan(w.spP[i]! + gap / 2);
  });

  it("moves every species that the two views disagree about, by an amount that is not noise", () => {
    const c = crop();
    const w = whole();
    const one = fuseViews(head, [c])!;
    const two = fuseViews(head, [c, w])!;

    let biggest = 0;
    let moved = 0;
    for (let i = 0; i < head.species.length; i++) {
      const d = Math.abs(one.spP[i]! - two.spP[i]!);
      if (d > biggest) biggest = d;
      if (d > 1e-9) moved++;
    }
    // One view and two must not be the same distribution. The threshold is a
    // magnitude, not just inequality: a fusion that dropped the second view
    // moves nothing at all, and one that pooled a view with itself moves
    // nothing either, because log p + log p over two is log p.
    expect(biggest, "one view and two views produced the same posterior").toBeGreaterThan(1e-3);
    expect(moved, "only one species moved").toBeGreaterThan(1);
  });

  it("returns the photo to its starting numbers when the setting is toggled back", () => {
    // The round trip. A toggle that re-classified under a different rule each
    // time - a view cached under the wrong key, a scale left over from the other
    // engine - drifts here even when each single pass looks plausible.
    const c = crop();
    const w = whole();
    const before = fuseViews(head, [c, w])!;
    const off = fuseViews(head, [c])!;
    const after = fuseViews(head, viewKinds(true, true).map((_, i) => (i === 0 ? c : w)))!;

    expect(after.spP).toEqual(before.spP);
    expect(off.spP).not.toEqual(after.spP);
  });

  it("names the whole frame as the setting that changed, in the view list itself", () => {
    // The decision the toggle makes, on its own. Everything above is downstream
    // of these two lists differing, and a regression that made them equal would
    // be invisible to a test that only looked at posteriors.
    expect(viewKinds(true, true)).not.toEqual(viewKinds(true, false));
    expect(viewKinds(true, false)).toHaveLength(1);
    expect(viewKinds(true, true)).toHaveLength(2);
  });
});

describe("the toggle reaches every photo on screen", () => {
  // Read from the source because `main.js` is a `.js` file that `tsc --noEmit`
  // does not read at all and that cannot be imported without executing it. The
  // e2e spec drives the same invariant against the real DOM; this is the cheap
  // half that runs in `vitest run`.
  it("clears an engine re-run's narrowing before asking for a pass", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const MAIN = readFileSync(join(here, "..", "src", "app", "main.js"), "utf8");

    const start = MAIN.search(/^function wireWholeFrameToggle\b/m);
    expect(start, "wireWholeFrameToggle is in main.js").toBeGreaterThan(-1);
    const rest = MAIN.slice(start + 1);
    const end = rest.search(/^function [A-Za-z_$]/m);
    const fn = end < 0 ? rest : rest.slice(0, end);

    // A pass is requested...
    expect(fn).toContain("reclassifyRunner.request()");
    // ...and the engine re-run's photo-set narrowing is cleared first, so the
    // pass covers the gallery rather than the re-run's subset. Without this the
    // toggle is a no-op for every photo outside that subset.
    const clear = fn.indexOf("rerunPhotos = null;");
    const request = fn.indexOf("reclassifyRunner.request()");
    expect(clear, "the toggle never clears rerunPhotos").toBeGreaterThan(-1);
    expect(clear, "rerunPhotos is cleared after the pass is requested").toBeLessThan(request);
  });
});
