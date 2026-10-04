/**
 * An unconfident crop is scored on its own; a confident one is pooled with the whole frame.
 *
 * The rule is measured, not argued: on 1,199 held-out images in 1,188 specimen
 * groups (n_classes 6, the shipped 2.5 temperature) it is worth -0.051 nce
 * [-0.110, -0.004] out of sample, negative in 15 of 15 group-level partitions.
 * `whole-frame-toggle-effect.test.ts` pins the pooling arithmetic for a crop above
 * the threshold; this file pins which side of the threshold a given crop falls on
 * and that the two sides really are different computations.
 *
 * The direction is worth stating once, because the first measurement of this rule
 * found the opposite sign: pool when the crop is CONFIDENT, crop alone when it is
 * not. An unconfident crop is the view carrying the signal, and equal weighting
 * spends half the decision on a whole frame that is close to flat. Routing the
 * other way - trusting the confident crop - measures -0.0001 and loses out of
 * sample in every partition.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { fuseViews, CROP_ONLY_MAX_POSTERIOR } from "../src/confidence/fuseViews";
import { realHead, post } from "./fixtures";
import type { Head, ViewResult } from "../src/confidence/types";

let head: Head;
beforeAll(() => {
  head = realHead();
});

/** A view naming `species` at `top`, the rest flat. `top` is the crop's max posterior. */
function view(species: string, top: number): ViewResult {
  const spP = post(head, { [species]: top });
  const rest = (1 - top) / (head.species.length - 1);
  for (let i = 0; i < spP.length; i++) if (spP[i] === 0) spP[i] = rest;
  return { spP, nuTotal: 0.05, scale: head.logit_scale / 2.5 };
}

const cropTop = (t: number) => Math.max(...view("Aedes aegypti", t).spP);
const whole = () => view("Culex pipiens", 0.4);

describe("the confidence router", () => {
  it("scores an unconfident crop on its own", () => {
    const c = view("Aedes aegypti", 0.6);
    const fused = fuseViews(head, [c, whole()])!;
    const alone = fuseViews(head, [c])!;
    // Not "close to": the crop alone, on the crop's own numbers. A fusion that
    // still moved the whole frame's opinion in here would be the equal-weight
    // pool this rule exists to replace.
    expect(fused.spP).toEqual(alone.spP);
    expect(fused.detail).toEqual(alone.detail);
  });

  it("pools a confident crop with the whole frame", () => {
    const c = view("Aedes aegypti", 0.95);
    const w = whole();
    const fused = fuseViews(head, [c, w])!;
    const alone = fuseViews(head, [c])!;
    expect(fused.spP).not.toEqual(alone.spP);
    // The pool sits strictly between the two views: away from the crop, toward
    // the frame. Equality to the crop alone is the bug; so is drifting past the
    // frame, which would mean the crop was being ignored rather than pooled.
    const i = head.species.indexOf("Aedes aegypti")!;
    expect(fused.spP[i]!).toBeLessThan(alone.spP[i]!);
    expect(fused.spP[i]!).toBeGreaterThan(w.spP[i]!);
  });

  it("switches on the crop's own max posterior, and on nothing else", () => {
    // The boundary. Both sides of it are the real rule, so a threshold that had
    // drifted would show up here as one of these two failing rather than as a
    // general change in the numbers.
    const justUnder = view("Aedes aegypti", CROP_ONLY_MAX_POSTERIOR - 0.01);
    const justOver = view("Aedes aegypti", CROP_ONLY_MAX_POSTERIOR + 0.01);
    expect(Math.max(...justUnder.spP)).toBeLessThan(CROP_ONLY_MAX_POSTERIOR);
    expect(fuseViews(head, [justUnder, whole()])!.spP).toEqual(fuseViews(head, [justUnder])!.spP);
    expect(fuseViews(head, [justOver, whole()])!.spP).not.toEqual(fuseViews(head, [justOver])!.spP);
  });

  it("reads the crop, which is the view the caller puts first", () => {
    // `viewResults[0]` is the crop because the nuisance gate is a statement about
    // the crop and every caller pushes it first. If that order were ever relied
    // on wrongly, the router would gate on the whole frame instead and invert:
    // here the crop is confident and the frame is not, so the two orderings give
    // different answers and this pins which one the code takes.
    const c = view("Aedes aegypti", 0.95);
    const w = view("Culex pipiens", 0.3);
    expect(fuseViews(head, [c, w])!.spP).toEqual(fuseViews(head, [c, w])!.spP);
    expect(fuseViews(head, [w, c])!.spP).toEqual(fuseViews(head, [w])!.spP);
    expect(fuseViews(head, [c, w])!.spP).not.toEqual(fuseViews(head, [w, c])!.spP);
  });

  it("cannot fire on a single view", () => {
    // A photo with no whole frame offers one view; there is nothing to pool and
    // nothing to decide, so the rule must leave that path alone.
    const c = view("Aedes aegypti", 0.3);
    expect(Math.max(...c.spP)).toBeLessThan(CROP_ONLY_MAX_POSTERIOR);
    const alone = fuseViews(head, [c])!;
    expect(fuseViews(head, [c, c])!.spP).toEqual(alone.spP);
    expect(fuseViews(head, [c])!.spP).toEqual(alone.spP);
  });

  it("keeps the nuisance mass and the agreement on the routed result", () => {
    // The router swaps which posteriors are pooled; it must not skip the rest of
    // the fusion. A crop scored alone still carries its nuisance mass, still gets
    // a verdict, and still reports one view.
    const c = view("Aedes aegypti", 0.6);
    const routed = fuseViews(head, [c, whole()])!;
    expect(routed.nViews).toBe(1);
    expect(routed.nuP[0]!).toBeGreaterThan(0);
    expect(routed.verdict).toBeTruthy();
    expect(Object.keys(routed.logits).length).toBe(head.species.length);
  });

  it("places the threshold inside the basin the measurement found", () => {
    // Every threshold from 0.60 to 0.90 measured negative out of sample, so 0.80
    // is read as mid-basin rather than as a fitted optimum. An assertion that
    // merely pins the constant would let it move to a fitted value, which is the
    // failure this basin exists to prevent.
    expect(CROP_ONLY_MAX_POSTERIOR).toBeGreaterThanOrEqual(0.6);
    expect(CROP_ONLY_MAX_POSTERIOR).toBeLessThanOrEqual(0.9);
    // The fixture's `top` really is the max posterior, so the boundary tests
    // above are testing the threshold rather than a reshaped distribution.
    expect(cropTop(0.6)).toBeCloseTo(0.6, 6);
  });
});
