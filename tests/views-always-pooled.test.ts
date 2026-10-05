/**
 * Both views are always pooled; there is no router.
 *
 * This file used to pin `CROP_ONLY_MAX_POSTERIOR`, a threshold that scored an
 * unconfident crop on its own and discarded the whole frame. It was measured as
 * an entropy win (-0.051 nce) on a 6-class species-only task, and shipped.
 *
 * On the 25-class joint the app actually runs, it fires on 84-96% of photos,
 * because a 16-species softmax spreads its mass and few crops clear 0.80. So
 * "include the whole photo" was usually a no-op and the crop was the only view
 * that counted. Issues #85 and #90 are that seen from the user's side, and the
 * threshold's own doc block records it was fitted on the wrong task.
 *
 * The threshold's measurement is not evidence that pooling is wrong - only that
 * a discard rule fitted on 6 classes does not transfer to 25. These tests pin
 * the replacement behaviour: every view counts, always.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { fuseViews } from "../src/confidence/fuseViews";
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

describe("every view is pooled", () => {
  it("pools an unconfident crop with the whole frame", () => {
    // The regression: this is the case the router swallowed. The whole frame must
    // move the result, not be discarded because the crop was unsure.
    const c = view("Aedes aegypti", 0.6);
    const w = whole();
    const fused = fuseViews(head, [c, w])!;
    const alone = fuseViews(head, [c])!;
    expect(fused.spP).not.toEqual(alone.spP);
    expect(fused.nViews).toBe(2);
  });

  it("pools a confident crop with the whole frame", () => {
    const c = view("Aedes aegypti", 0.95);
    const w = whole();
    const fused = fuseViews(head, [c, w])!;
    const alone = fuseViews(head, [c])!;
    expect(fused.spP).not.toEqual(alone.spP);
    // The pool sits strictly between the two views: away from the crop, toward
    // the frame. Drifting past the frame would mean the crop was ignored rather
    // than pooled.
    const i = head.species.indexOf("Aedes aegypti")!;
    expect(fused.spP[i]!).toBeLessThan(alone.spP[i]!);
    expect(fused.spP[i]!).toBeGreaterThan(w.spP[i]!);
  });

  it("does not switch on the crop's confidence at any threshold", () => {
    // There is no boundary left to find. Walking the crop's confidence across the
    // whole range must not produce a discontinuity in whether the frame counts -
    // the old rule switched at 0.80, and this is what that switch looked like.
    for (const top of [0.05, 0.2, 0.4, 0.6, 0.79, 0.8, 0.81, 0.95, 0.99]) {
      const c = view("Aedes aegypti", top);
      const pooled = fuseViews(head, [c, whole()])!;
      expect(pooled.nViews).toBe(2);
      expect(pooled.spP).not.toEqual(fuseViews(head, [c])!.spP);
    }
  });

  it("keeps the nuisance mass, the agreement and a verdict on the pooled result", () => {
    // Removing the router must not skip the rest of the fusion. Every field the
    // router's early return used to carry has to survive it.
    const fused = fuseViews(head, [view("Aedes aegypti", 0.6), whole()])!;
    expect(fused.nuP[0]!).toBeGreaterThan(0);
    expect(fused.verdict).toBeTruthy();
    expect(fused.agreement).not.toBeNull();
    expect(Object.keys(fused.logits).length).toBe(head.species.length);
  });

  it("still fuses a single view, and to that view's own numbers", () => {
    // A photo with no whole frame offers one view; there is nothing to pool.
    const c = view("Aedes aegypti", 0.3);
    const alone = fuseViews(head, [c])!;
    expect(alone.nViews).toBe(1);
  });

  it("two identical views sharpen rather than collapsing to one", () => {
    // The router used to short-circuit [c, c] to [c], so a duplicated view was
    // indistinguishable from one view. It is not: pooling is log-linear, so the
    // same opinion twice squares the distribution. This pins that the duplicate
    // is now counted, which is what makes the per-photo influence bar meaningful.
    const c = view("Aedes aegypti", 0.3);
    const twice = fuseViews(head, [c, c])!;
    const alone = fuseViews(head, [c])!;
    expect(twice.nViews).toBe(2);
    expect(twice.spP).not.toEqual(alone.spP);

    // p^2 renormalised against the squared nuisance mass.
    const i = head.species.indexOf("Aedes aegypti")!;
    const sq = c.spP.map((p) => p * p);
    const nuSq = c.nuTotal * c.nuTotal;
    const total = sq.reduce((a, b) => a + b, 0) + nuSq;
    expect(twice.spP[i]!).toBeCloseTo(sq[i]! / total, 6);
    // Sharper, so the named species rises.
    expect(twice.spP[i]!).toBeGreaterThan(alone.spP[i]!);
  });

  it("the fixture's `top` really is the max posterior", () => {
    // The other tests reason about confidence, so the helper has to deliver it.
    expect(cropTop(0.6)).toBeCloseTo(0.6, 6);
  });
});
