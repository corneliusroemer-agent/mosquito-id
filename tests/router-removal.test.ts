/**
 * Both views are always pooled when "include the whole photo" is on.
 *
 * The router this replaces discarded the whole frame whenever the crop's top
 * species posterior fell below 0.80. It was measured as an entropy win on a
 * 6-class species-only task; on the shipped 25-class joint it fires on 84-96% of
 * photos, so "include the whole photo" was usually a no-op and the crop the only
 * view that counted. Issues #85 and #90 are that, seen from the user's side.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { fuseViews } from "../src/confidence/fuseViews";
import { realHead, post } from "./fixtures";
import type { Head, ViewResult } from "../src/confidence/types";

let head: Head;
beforeAll(() => {
  head = realHead();
});

/** A view naming `species` at `top`, the rest spread flat. */
function view(species: string, top: number): ViewResult {
  const spP = post(head, { [species]: top });
  const rest = (1 - top) / (head.species.length - 1);
  for (let i = 0; i < spP.length; i++) if (spP[i] === 0) spP[i] = rest;
  return { spP, nuTotal: 0.05, scale: head.logit_scale / 2.5 };
}

describe("both views are always pooled (#85, #90)", () => {
  it("a low-confidence crop still changes the fused scores when the whole frame is added", () => {
    // The shape the router used to swallow: an unconfident crop naming one
    // species, and a whole frame that disagrees. If the frame were discarded,
    // the fused posterior would be exactly the crop's.
    const crop = view("Aedes aegypti", 0.45);
    const frame = view("Culex pipiens", 0.4);

    const cropOnly = fuseViews(head, [crop]);
    const pooled = fuseViews(head, [crop, frame]);

    expect(cropOnly).not.toBeNull();
    expect(pooled).not.toBeNull();
    expect(pooled!.nViews).toBe(2);
    // The regression this pins: previously `pooled` was identical to `cropOnly`.
    expect(pooled!.detail).not.toEqual(cropOnly!.detail);
  });

  it("reports nViews 2 regardless of how unsure the crop is", () => {
    for (const top of [0.2, 0.45, 0.6, 0.79, 0.81, 0.95]) {
      const r = fuseViews(head, [view("Aedes aegypti", top), view("Culex pipiens", 0.4)]);
      expect(r!.nViews).toBe(2);
    }
  });

  it("the whole frame can outvote an unconfident crop", () => {
    // A crop that barely names aegypti, a frame that is sure it is culex. With
    // the router this was impossible on exactly these rows.
    const crop = view("Aedes aegypti", 0.3);
    const frame = view("Culex pipiens", 0.95);
    const pooled = fuseViews(head, [crop, frame]);
    const best = Object.entries(pooled!.detail).sort((a, b) => b[1] - a[1])[0]!;
    expect(best[0]).toBe("Culex pipiens");
  });

  it("a single view still fuses to itself, up to the shared species+nuisance renormalisation", () => {
    // Not literally equal: fuseViews normalises species and nuisance together, so
    // a view carrying nuTotal renormalises its species down by 1/(1+nuTotal).
    // The invariant is that the SHAPE is preserved, which is what "there is no
    // separate single-view path to keep in step" means.
    const only = view("Aedes aegypti", 0.5);
    const r = fuseViews(head, [only]);
    expect(r!.nViews).toBe(1);
    // The view's species posteriors sum to 1 and its nuisance mass is nuTotal, so
    // the shared normalisation divides species by 1 + nuTotal.
    const raw = only.spP[head.species.indexOf("Aedes aegypti")]!;
    expect(r!.detail["Aedes aegypti"]).toBeCloseTo(raw / (1 + only.nuTotal), 6);
    expect(r!.nuP[0]).toBeCloseTo(only.nuTotal / (1 + only.nuTotal), 6);
  });
});
