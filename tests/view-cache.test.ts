/**
 * Toggling the whole-frame view is a re-fusion, not a re-classification (#59).
 *
 * The control changes which views are POOLED. It does not change what any view
 * says - the crop canvas and the whole frame are the same pixels either way - so
 * a toggle that re-runs the classifier is re-deriving a number it already has.
 *
 * What is pinned here is the CACHE, not a speed: `readViewCache`/`writeViewCache`
 * are driven with a counting stand-in for the classifier, and the assertions are
 * that the counter does not move and that the numbers come out identical to the
 * ones a fresh classification produces. Nothing here measures time - the
 * structural claim is "zero classifier calls", which is checkable without a
 * stopwatch and is the part that would regress.
 *
 * The two failure modes this is written against, in order of likelihood:
 *
 * 1. The cache is keyed too loosely, so a photo whose crop changed, or a photo
 *    re-scored by another engine or another head, reads a stale posterior. The
 *    shape is identical either way, so this cannot be caught downstream - it has
 *    to be caught by asserting the miss.
 * 2. The cache stores the FUSED posterior instead of the per-view one. That makes
 *    the toggle look free while destroying what pooling is for: `viewAgreement`
 *    compares the views against each other, and one fused distribution carries
 *    no per-view detail to compare. Every view-agreement assertion below is
 *    aimed at that.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { fuseViews } from "../src/confidence/fuseViews";
import {
  beginRecompute, readViewCache, writeViewCache, ownsRecompute,
} from "../src/app/photoRecord";
import type { ViewCacheStamp } from "../src/app/photoRecord";
import { viewsFor } from "../src/app/views";
import { viewKinds, type ViewKind } from "../src/app/viewSelection";
import { realHead } from "./fixtures";
import type { Head, ViewResult } from "../src/confidence/types";
import type { PhotoState } from "../src/app/photoRecord";

let head: Head;
beforeAll(() => { head = realHead(); });

/** A canvas stand-in: the classify path only passes the node through. */
const canvas = (w: number, h: number): HTMLCanvasElement =>
  ({ width: w, height: h }) as HTMLCanvasElement;

/** A photo record with only the fields this test reads. */
function photo(over: Partial<PhotoState> = {}): PhotoState {
  return {
    name: "photo.jpg",
    fingerprint: null,
    fullCanvas: canvas(1000, 800),
    cropCanvas: null,
    contextCanvas: null,
    cropBox: null,
    contextBox: null,
    crop_rejected: false,
    is_cropped: true,
    manual_full_photo: false,
    scores: {},
    detail: {},
    logits: null,
    adP: null,
    verdict: null,
    adjacentDetail: null,
    agreement: null,
    viewsLanded: 0,
    viewsTotal: 0,
    scoredBy: "webgpu-fp16",
    status: "ok",
    rev: 0,
    pending: false,
    error: null,
    ...over,
  } as PhotoState;
}

/**
 * A classifier that counts its calls and returns a DIFFERENT posterior per view,
 * because a fake that returns the same one everywhere makes two views pool to
 * what one view says - and then "the toggle changed nothing" cannot be told
 * apart from "the cache did not work".
 */
function countingClassifier(calls: string[]): (kind: ViewKind) => ViewResult {
  return (kind) => {
    calls.push(kind);
    const species = kind === "crop" ? "Aedes aegypti" : "Culex pipiens";
    const top = kind === "crop" ? 0.9 : 0.4;
    const rest = (1 - top) / (head.species.length - 1);
    const spP = head.species.map((n) => (n === species ? top : rest));
    return { spP, nuTotal: 0.05, scale: head.logit_scale / 2.5 };
  };
}

/** A second head object, standing in for a refit. Structurally identical. */
const otherHead = (): Head => ({ ...head, species: [...head.species] });

/**
 * The classify loop `classifyViews` runs, with the cache in it and the
 * classifier behind a counter.
 *
 * This is the shape of the loop in `main.js` with the model and the DOM left
 * out, so the number this test can make a claim about - how many times the
 * classifier was called - is the real one.
 */
function classifyViews(
  p: PhotoState,
  previews: PhotoState[],
  idx: number,
  rev: number,
  cropCv: HTMLCanvasElement | null,
  cropBox: [number, number, number, number] | null,
  includeWholeFrame: boolean,
  engine: string,
  classify: (kind: ViewKind) => ViewResult,
  headRef: unknown,
): { landed: ViewResult[]; cached: number } {
  const stamp: ViewCacheStamp = { contentRev: p.contentRev || 0, engine, head: headRef };
  const views = viewsFor(p, cropCv, cropBox, includeWholeFrame);
  const landed: ViewResult[] = [];
  let cached = 0;
  for (const view of views) {
    if (!ownsRecompute(p, previews, idx, rev)) break;
    const hit = readViewCache(p, view.kind, stamp);
    let v: ViewResult;
    if (hit) {
      cached++;
      v = hit;
    } else {
      v = classify(view.kind);
      if (!ownsRecompute(p, previews, idx, rev)) break;
      writeViewCache(p, view.kind, stamp, v);
    }
    if (!ownsRecompute(p, previews, idx, rev)) break;
    landed.push(v);
  }
  return { landed, cached };
}

const CROP_BOX: [number, number, number, number] = [10, 10, 210, 210];

describe("a whole-frame toggle re-fuses cached views", () => {
  it("runs zero classifier calls, and produces what a full re-classification produces", () => {
    const full = canvas(1000, 800);
    const crop = canvas(200, 200);
    const p = photo({ fullCanvas: full, cropCanvas: crop, cropBox: CROP_BOX });
    const previews = [p];

    // First pass, under the shipped default (both views). Every view is a miss,
    // so the classifier runs once per view and both results are filed.
    const firstCalls: string[] = [];
    const classify = countingClassifier(firstCalls);
    const rev1 = beginRecompute(p, true);
    const first = classifyViews(p, previews, 0, rev1, crop, CROP_BOX, true, "webgpu-fp16", classify, head);
    expect(firstCalls, "the first pass classified nothing").toEqual(["crop", "whole"]);
    expect(first.cached).toBe(0);

    // The toggle. `beginRecompute(p, false)`: the pixels are unchanged, which is
    // the whole point - a re-pool is not a new crop.
    const secondCalls: string[] = [];
    const rev2 = beginRecompute(p, false);
    const second = classifyViews(p, previews, 0, rev2, crop, CROP_BOX, false, "webgpu-fp16", countingClassifier(secondCalls), head);

    // The claim, stated as a count rather than a duration.
    expect(secondCalls, "the toggle re-ran the classifier").toEqual([]);
    expect(second.cached).toBe(1);

    // And the numbers are the ones the crop view alone would produce, which is
    // what `fuseViews([cropView])` gives - identical to classifying that one view
    // from scratch, because that IS what it did.
    const fromCache = fuseViews(head, second.landed)!;
    const fromScratch = fuseViews(head, [classify("crop")])!;
    expect(fromCache.spP).toEqual(fromScratch.spP);
    expect(fromCache.labels).toEqual(fromScratch.labels);
    expect(fromCache.logits).toEqual(fromScratch.logits);
    expect(fromCache.verdict).toEqual(fromScratch.verdict);
  });

  it("toggling back on is a re-fusion too, from the same two cached views", () => {
    // Both directions. The reported failure was one-sided, but the mechanism is
    // not: turning the view ON after a crop-only pass needs the whole frame's
    // posterior, and that it was never classified is precisely the case where a
    // cache has to be honest about missing.
    const crop = canvas(200, 200);
    const p = photo({ cropCanvas: crop, cropBox: CROP_BOX });
    const previews = [p];
    const classify = countingClassifier([]);

    const rev1 = beginRecompute(p, true);
    const cropOnly = classifyViews(p, previews, 0, rev1, crop, CROP_BOX, false, "webgpu-fp16", classify, head);
    expect(cropOnly.cached).toBe(0);

    // Turning it on: the crop is cached, the whole frame is not - it was never
    // classified. Exactly one classifier call, for the view that is genuinely new.
    const onCalls: string[] = [];
    const rev2 = beginRecompute(p, false);
    const both = classifyViews(p, previews, 0, rev2, crop, CROP_BOX, true, "webgpu-fp16", countingClassifier(onCalls), head);
    expect(onCalls).toEqual(["whole"]);
    expect(both.cached).toBe(1);

    // And now both directions are free. Turning it back off leaves the crop
    // alone in the pool, which is one view rather than the two `both` landed -
    // the same view, not the same list.
    const offCalls: string[] = [];
    const rev3 = beginRecompute(p, false);
    const offAgain = classifyViews(p, previews, 0, rev3, crop, CROP_BOX, false, "webgpu-fp16", countingClassifier(offCalls), head);
    expect(offCalls, "the second toggle off re-ran the classifier").toEqual([]);
    expect(offAgain.landed).toEqual(both.landed.slice(0, 1));
  });
});

describe("the cache key", () => {
  const crop = canvas(200, 200);
  const CROP_BOX: [number, number, number, number] = [10, 10, 210, 210];

  it("misses when the photo's pixels change", () => {
    // A new crop is new pixels. `beginRecompute(p, true)` is what a crop release
    // does, and it must cost a re-classification: the old crop's posterior
    // describes pixels the photo is no longer showing.
    const p = photo({ cropCanvas: crop, cropBox: CROP_BOX });
    const previews = [p];
    const rev1 = beginRecompute(p, true);
    classifyViews(p, previews, 0, rev1, crop, CROP_BOX, true, "webgpu-fp16", countingClassifier([]), head);

    const newCrop = canvas(300, 300);
    p.cropCanvas = newCrop;
    const calls: string[] = [];
    const rev2 = beginRecompute(p, true);
    const r = classifyViews(p, previews, 0, rev2, newCrop, CROP_BOX, true, "webgpu-fp16", countingClassifier(calls), head);
    expect(calls).toEqual(["crop", "whole"]);
    expect(r.cached, "a re-cropped photo read a stale posterior").toBe(0);
  });

  it("misses when the engine switches", () => {
    const p = photo({ cropCanvas: crop, cropBox: CROP_BOX });
    const previews = [p];
    const rev1 = beginRecompute(p, true);
    classifyViews(p, previews, 0, rev1, crop, CROP_BOX, true, "webgpu-fp16", countingClassifier([]), head);

    // A different engine's arithmetic is a different posterior for the same
    // pixels. The shape is identical, so nothing downstream can catch a stale
    // read - which is why the miss has to be asserted here.
    const calls: string[] = [];
    const rev2 = beginRecompute(p, true);
    const r = classifyViews(p, previews, 0, rev2, crop, CROP_BOX, true, "webgpu-int8", countingClassifier(calls), head);
    expect(calls, "an engine switch reused the old engine's posteriors").toEqual(["crop", "whole"]);
    expect(r.cached).toBe(0);
  });

  it("misses when the head is refitted", () => {
    // Identity, not equality: a refit produces a new head object over the same
    // species names, so any value comparison of the two would call them the same
    // head and serve the old fit's numbers.
    const p = photo({ cropCanvas: crop, cropBox: CROP_BOX });
    const previews = [p];
    const rev1 = beginRecompute(p, true);
    classifyViews(p, previews, 0, rev1, crop, CROP_BOX, true, "webgpu-fp16", countingClassifier([]), head);

    const refit = otherHead();
    expect(JSON.stringify(refit.species)).toBe(JSON.stringify(head.species));

    const calls: string[] = [];
    const rev2 = beginRecompute(p, true);
    const r = classifyViews(p, previews, 0, rev2, crop, CROP_BOX, true, "webgpu-fp16", countingClassifier(calls), refit);
    expect(calls, "a refitted head served the previous fit's posteriors").toEqual(["crop", "whole"]);
    expect(r.cached).toBe(0);
  });

  it("keys on view kind, so the two views do not stand in for each other", () => {
    // The two views of one photo disagree - that is the whole reason two views
    // exist - so a cache that filed the crop's posterior under "whole" would pool
    // the crop with itself and report agreement that no two views ever had.
    const p = photo({ cropCanvas: crop, cropBox: CROP_BOX });
    const previews = [p];
    const classify = countingClassifier([]);
    const rev = beginRecompute(p, true);
    classifyViews(p, previews, 0, rev, crop, CROP_BOX, true, "webgpu-fp16", classify, head);

    const stamp: ViewCacheStamp = { contentRev: p.contentRev || 0, engine: "webgpu-fp16", head };
    const gotCrop = readViewCache(p, "crop", stamp)!;
    const gotWhole = readViewCache(p, "whole", stamp)!;
    expect(gotCrop).not.toBe(gotWhole);
    const i = head.species.indexOf("Aedes aegypti")!;
    expect(gotCrop.spP[i]!).toBeGreaterThan(gotWhole.spP[i]!);
  });

  it("is NOT keyed on the content fingerprint", () => {
    // The fingerprint is the file's bytes and exists for cross-photo
    // de-duplication. Two different photos of one file share it, and one photo's
    // crop changes without it changing at all - so it cannot stand in for "these
    // are the pixels this view was scored from", and the two must not be
    // conflated. Here two photos share a fingerprint and neither reads the
    // other's posterior.
    const p1 = photo({ name: "a.jpg", fingerprint: "same", cropCanvas: canvas(200, 200) });
    const p2 = photo({ name: "b.jpg", fingerprint: "same", cropCanvas: canvas(200, 200) });
    const previews = [p1, p2];
    const classify = countingClassifier([]);
    const r1 = beginRecompute(p1, true);
    classifyViews(p1, previews, 0, r1, p1.cropCanvas!, CROP_BOX, false, "webgpu-fp16", classify, head);
    const r2 = beginRecompute(p2, true);
    classifyViews(p2, previews, 1, r2, p2.cropCanvas!, CROP_BOX, false, "webgpu-fp16", classify, head);

    // Distinct entries: each photo holds its OWN result object, so the shared
    // fingerprint bought p2 nothing. Had the cache been keyed on the fingerprint
    // this would be the same object twice, and p2 would have served a posterior
    // computed from a canvas it never showed the model.
    expect(p1.viewCache?.crop).toBeDefined();
    expect(p2.viewCache?.crop).toBeDefined();
    expect(p1.viewCache?.crop).not.toBe(p2.viewCache?.crop);
    expect(p1.viewCache?.crop?.result).not.toBe(p2.viewCache?.crop?.result);
  });
});

describe("viewAgreement survives a cached toggle", () => {
  // The trap this whole design turns on. `viewAgreement` is handed each view's
  // own posterior and asked whether they named the same species, so a cache of
  // the FUSED posterior would make a cached toggle report agreement the app
  // never computed - and would make it impossible to compute later, because the
  // per-view detail would already be gone. Every assertion below reads
  // per-view detail out of the cache.

  const crop = canvas(200, 200);
  const CROP_BOX: [number, number, number, number] = [10, 10, 210, 210];

  it("still reports that two views disagreed after a cached re-fusion", () => {
    const p = photo({ cropCanvas: crop, cropBox: CROP_BOX });
    const previews = [p];
    const classify = countingClassifier([]);

    const rev1 = beginRecompute(p, true);
    const both = classifyViews(p, previews, 0, rev1, crop, CROP_BOX, true, "webgpu-fp16", classify, head);
    const fusedBoth = fuseViews(head, both.landed)!;
    // The two views name different species, so the pool cannot report agreement.
    expect(fusedBoth.agreement).not.toBeNull();
    expect(fusedBoth.agreement!.agree).toBe(false);
    expect(fusedBoth.agreement!.topSpecies).toBe("Aedes aegypti");
    expect(fusedBoth.agreement!.runnersUp).toContain("Culex pipiens");

    // A cached re-fusion of the same two views under a different pooling reports
    // the same disagreement, because it is the same per-view detail.
    const rev2 = beginRecompute(p, false);
    const calls: string[] = [];
    const again = classifyViews(p, previews, 0, rev2, crop, CROP_BOX, true, "webgpu-fp16", countingClassifier(calls), head);
    expect(calls).toEqual([]);
    const fusedAgain = fuseViews(head, again.landed)!;
    expect(fusedAgain.agreement).toEqual(fusedBoth.agreement);
  });

  it("reports no agreement at all on the crop-only side, as a one-view pool must", () => {
    // The other direction of the trap: a one-view pool has nothing to disagree
    // with, and `viewAgreement` returns null below two views. A cache that
    // carried the old two-view agreement through a narrowing toggle would report
    // a disagreement between views that are no longer in the pool at all.
    const p = photo({ cropCanvas: crop, cropBox: CROP_BOX });
    const previews = [p];
    const classify = countingClassifier([]);

    const rev1 = beginRecompute(p, true);
    const both = classifyViews(p, previews, 0, rev1, crop, CROP_BOX, true, "webgpu-fp16", classify, head);
    expect(fuseViews(head, both.landed)!.agreement).not.toBeNull();

    const rev2 = beginRecompute(p, false);
    const cropOnly = classifyViews(p, previews, 0, rev2, crop, CROP_BOX, false, "webgpu-fp16", countingClassifier([]), head);
    expect(cropOnly.landed).toHaveLength(1);
    expect(fuseViews(head, cropOnly.landed)!.agreement).toBeNull();
  });

  it("leaves the whole frame cached under a narrowing toggle, so widening back is free", () => {
    // Why the cache holds BOTH kinds rather than only the ones currently pooled:
    // the view that is not in the pool is still classified, and keeping it is
    // what makes the widening toggle cost nothing. A cache that filed only what
    // it fused would force a re-classification on the way back up.
    const p = photo({ cropCanvas: crop, cropBox: CROP_BOX });
    const previews = [p];
    const classify = countingClassifier([]);
    const rev1 = beginRecompute(p, true);
    classifyViews(p, previews, 0, rev1, crop, CROP_BOX, true, "webgpu-fp16", classify, head);

    const rev2 = beginRecompute(p, false);
    classifyViews(p, previews, 0, rev2, crop, CROP_BOX, false, "webgpu-fp16", countingClassifier([]), head);

    expect(Object.keys(p.viewCache!).sort()).toEqual(["crop", "whole"]);

    const calls: string[] = [];
    const rev3 = beginRecompute(p, false);
    const widened = classifyViews(p, previews, 0, rev3, crop, CROP_BOX, true, "webgpu-fp16", countingClassifier(calls), head);
    expect(calls, "widening re-classified a view that was still cached").toEqual([]);
    expect(widened.landed).toHaveLength(2);
  });
});

describe("the rev guard governs the cache as it governs the record", () => {
  // `idleRelease`'s generation idiom: work captures the generation it started
  // for and returns without touching anything if it no longer matches. A cache
  // needs the same guard, because writing into it is itself a write - a stale
  // in-flight classification that files its result would leave a view of pixels
  // the photo no longer shows, and the next toggle would re-fuse it.

  const crop = canvas(200, 200);
  const CROP_BOX: [number, number, number, number] = [10, 10, 210, 210];

  it("does not file a result from an overtaken classification", () => {
    const p = photo({ cropCanvas: crop, cropBox: CROP_BOX });
    const previews = [p];
    const rev = beginRecompute(p, true);
    // A newer crop release overtakes this one before it runs.
    beginRecompute(p, true);

    const calls: string[] = [];
    const r = classifyViews(p, previews, 0, rev, crop, CROP_BOX, true, "webgpu-fp16", countingClassifier(calls), head);

    expect(r.landed).toHaveLength(0);
    expect(calls, "the classifier ran for a photo it no longer owns").toEqual([]);
    expect(p.viewCache, "an overtaken classification wrote into the cache").toBeUndefined();
  });

  it("does not file a result for a photo deleted mid-pass", () => {
    const p = photo({ cropCanvas: crop, cropBox: CROP_BOX });
    const previews = [p];
    const rev = beginRecompute(p, true);
    previews.length = 0;

    const r = classifyViews(p, previews, 0, rev, crop, CROP_BOX, true, "webgpu-fp16", countingClassifier([]), head);
    expect(r.landed).toHaveLength(0);
    expect(p.viewCache).toBeUndefined();
  });
});

describe("viewsFor names the kind of each view", () => {
  // The cache is keyed by kind, and the caller cannot be left to work the kind
  // out again from canvas identity - that would be a second implementation of the
  // decision `viewKinds` just made.

  const full = canvas(1000, 800);
  const crop = canvas(200, 200);

  it("tags the crop and the whole frame", () => {
    const views = viewsFor(photo({ fullCanvas: full }), crop, [10, 10, 210, 210], true);
    expect(views.map((v) => v.kind)).toEqual(["crop", "whole"]);
  });

  it("tags the single view a photo with no crop offers", () => {
    const views = viewsFor(photo({ fullCanvas: full }), null, null, true);
    expect(views.map((v) => v.kind)).toEqual(["whole"]);
  });

  it("does not fuse the whole frame with itself", () => {
    // The batch path passes cropCv === fullCanvas. Tagging both as what they are
    // keeps that photo to one entry under one kind, so a later toggle cannot
    // find two views where there is one.
    const views = viewsFor(photo({ fullCanvas: full }), full, null, true);
    expect(views.map((v) => v.kind)).toEqual(["whole"]);
  });

  it("agrees with viewKinds on how many views there are", () => {
    for (const hasCrop of [true, false]) {
      for (const include of [true, false]) {
        const kinds = viewKinds(hasCrop, include);
        const views = viewsFor(
          photo({ fullCanvas: full }),
          hasCrop ? crop : null,
          hasCrop ? [0, 0, 200, 200] : null,
          include,
        );
        expect(views.map((v) => v.kind)).toEqual(kinds);
      }
    }
  });
});