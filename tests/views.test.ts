// What a view carries, before fuseViews pools it.
//
// fuseViews collapsed a nuisance vector to a single index once, so every
// non-mosquito verdict read "a photograph of a person"; verdictFrom then
// consumed that collapsed value. Both modules were TypeScript by the time that
// was found. What was not typed was the code that BUILT what they were handed,
// so nothing required a view to carry the fields they read - which is what
// `views.ts` now states, and what these tests pin.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { viewsFor, viewResultFrom, serverView, classifyCanvasServer,
         posteriorSummary, verdictSummary, genusTotals, round4 } from "../src/app/views";
import { realHead } from "./fixtures";
import { softmaxJoint } from "../src/confidence/softmax";
import type { Box } from "../src/app/views";
import type { Head } from "../src/confidence/types";
import type { PhotoState } from "../src/app/photoRecord";

let head: Head;
beforeAll(() => { head = realHead(); });

/**
 * A species posterior the shape a server sends: one entry per species in head
 * order, descending, summing to 1.
 */
function ramp(): Record<string, number> {
  const w = head.species.map((_, i) => head.species.length - i);
  const sum = w.reduce((a, b) => a + b, 0);
  const detail: Record<string, number> = {};
  head.species.forEach((n, i) => { detail[n] = w[i]! / sum; });
  return detail;
}

/** A canvas stand-in: views.ts only reads width/height and passes the node on. */
const canvas = (w: number, h: number): HTMLCanvasElement =>
  ({ width: w, height: h }) as HTMLCanvasElement;

const photo = (full: HTMLCanvasElement | null): Pick<PhotoState, "fullCanvas"> =>
  ({ fullCanvas: full }) as Pick<PhotoState, "fullCanvas">;

describe("viewsFor", () => {
  it("offers the crop and the whole frame for a cropped photo", () => {
    const full = canvas(1000, 800);
    const crop = canvas(200, 200);
    const views = viewsFor(photo(full), crop, [10, 10, 210, 210], true);
    expect(views).toHaveLength(2);
    expect(views[0]).toEqual({ canvas: crop, box: [10, 10, 210, 210] });
    expect(views[1]).toEqual({ canvas: full, box: [0, 0, 1000, 800] });
  });

  it("offers only the crop when the whole frame is turned off", () => {
    const full = canvas(1000, 800);
    const views = viewsFor(photo(full), canvas(200, 200), [0, 0, 200, 200], false);
    expect(views).toHaveLength(1);
    expect(views[0]!.canvas).not.toBe(full);
  });

  it("does NOT fuse the whole frame with itself", () => {
    // The batch path passes cropCv === fullCanvas for a photo the detector found
    // nothing in. Treating that as a crop would run the same pixels twice and
    // fuse a view with itself, which is not a second opinion.
    const full = canvas(640, 480);
    const views = viewsFor(photo(full), full, null, true);
    expect(views).toHaveLength(1);
    expect(views[0]).toEqual({ canvas: full, box: [0, 0, 640, 480] });
  });

  it("offers the whole frame alone for a photo with no crop", () => {
    const views = viewsFor(photo(canvas(640, 480)), null, null, true);
    expect(views).toHaveLength(1);
    expect(views[0]!.box).toEqual([0, 0, 640, 480]);
  });

  it("offers nothing when there is no frame", () => {
    expect(viewsFor(photo(null), null, null, true)).toEqual([]);
  });
});

describe("viewResultFrom", () => {
  // The nuisance classes must enter as their COMBINED MASS, never individually.
  // `ViewResult.nuTotal` is a number and `nuP` is the per-class vector; passing
  // the vector's first element instead of its sum is exactly the collapse that
  // made every non-mosquito verdict read "a photograph of a person".
  it("sums the nuisance posteriors into the mass", () => {
    const emb = head.species_emb as number[];
    const v = viewResultFrom(head, emb, "webgpu-fp16", head.logit_scale / 2.5);
    expect(typeof v.nuTotal).toBe("number");
    expect(Number.isFinite(v.nuTotal)).toBe(true);
    // Not one class's posterior: the mass is at least the largest of them.
    const joint = softmaxJoint(head, emb, {});
    expect(v.nuTotal).toBeGreaterThanOrEqual(Math.max(...joint.nuP) - 1e-9);
    expect(v.nuTotal).toBeCloseTo(joint.nuP.reduce((a: number, b: number) => a + b, 0), 10);
  });

  it("carries a species posterior one entry per species", () => {
    const v = viewResultFrom(head, head.species_emb as number[], "webgpu-fp16", 40);
    expect(v.spP).toHaveLength(head.species.length);
  });

  it("carries the scale it was scored AT, not one read at fuse time", () => {
    // fuseViews refuses to pool two views scored on different scales, and the
    // engine can switch while a photo's second view is in flight.
    expect(viewResultFrom(head, head.species_emb as number[], "webgpu-fp16", 11).scale).toBe(11);
  });

  it("carries the adjacent block, so the non-mosquito gate can name a class", () => {
    const v = viewResultFrom(head, head.species_emb as number[], "webgpu-fp16", 40);
    expect(v.adP).toHaveLength((head.adjacent ?? []).length);
  });
});

describe("serverView", () => {
  it("reads the species posterior the server sent, in head order", () => {
    const detail = ramp();
    const v = serverView({ detail }, head, 40);
    expect(v.spP).toHaveLength(head.species.length);
    // Index-aligned with head.species, NOT with whatever order the server used:
    // a response whose species arrive in a different order reads as every
    // species scoring the wrong number, with no error anywhere.
    head.species.forEach((name, i) => expect(v.spP[i]).toBeCloseTo(detail[name]!, 12));
    expect(v.scale).toBe(40);
  });

  it("reports the nuisance mass as whatever the species did not take", () => {
    const detail = ramp();
    const v = serverView({ detail }, head, 40);
    const speciesMass = v.spP.reduce((a, b) => a + b, 0);
    expect(v.nuTotal).toBeCloseTo(1 - speciesMass, 10);
  });

  it("floors the nuisance mass, so a certain-mosquito server cannot be believed", () => {
    const detail: Record<string, number> = {};
    head.species.forEach((n) => { detail[n] = 1 / head.species.length; });
    expect(serverView({ detail }, head, 40).nuTotal).toBe(1e-12);
  });

  it("treats a species the server omitted as zero, not as a hole in the vector", () => {
    const detail: Record<string, number> = {};
    detail[head.species[0]!] = 0.5;
    const v = serverView({ detail }, head, 40);
    expect(v.spP).toHaveLength(head.species.length);
    expect(v.spP.slice(1).every((x) => x === 0)).toBe(true);
  });

  it("carries no adjacent block: the server reports no adjacent classes", () => {
    const detail = ramp();
    expect(serverView({ detail }, head, 40).adP).toBeUndefined();
  });
});

describe("classifyCanvasServer", () => {
  it("reports the box it was given, not the one the server echoed back", async () => {
    // A server answering with a different box is describing a crop the user is
    // not looking at, so its labels are logged out and ignored.
    const log = vi.fn();
    const wanted = [10, 20, 30, 40];
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ labels: {}, detail: {}, logits: {}, cropBox: [0, 0, 1, 1] }),
    })));
    const p = { fullCanvas: { toBlob: (r: (b: Blob | null) => void) => r(new Blob()) } as unknown as HTMLCanvasElement, name: "a.jpg" };
    await classifyCanvasServer(p, wanted as Box, log);
    expect(log).toHaveBeenCalledWith("server_crop_box_diverged", { requested: wanted, returned: [0, 0, 1, 1] });
    vi.unstubAllGlobals();
  });

  it("stays silent when the box agrees", async () => {
    const log = vi.fn();
    const box: Box = [1, 2, 3, 4];
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, json: async () => ({ labels: {}, detail: {}, logits: {}, cropBox: box }),
    })));
    const p = { fullCanvas: { toBlob: (r: (b: Blob | null) => void) => r(new Blob()) } as unknown as HTMLCanvasElement, name: "a.jpg" };
    await classifyCanvasServer(p, box, log);
    expect(log).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("throws on a server error rather than scoring nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    const p = { fullCanvas: { toBlob: (r: (b: Blob | null) => void) => r(new Blob()) } as unknown as HTMLCanvasElement, name: "a.jpg" };
    await expect(classifyCanvasServer(p, [0, 0, 1, 1], vi.fn())).rejects.toThrow(/503/);
    vi.unstubAllGlobals();
  });

  it("throws rather than posting a null body", async () => {
    const p = { fullCanvas: { toBlob: (r: (b: Blob | null) => void) => r(null) } as unknown as HTMLCanvasElement, name: "a.jpg" };
    await expect(classifyCanvasServer(p, [0, 0, 1, 1], vi.fn())).rejects.toThrow(/Could not encode/);
  });
});

describe("round4", () => {
  it("rounds to 4 dp, and reports anything else as null", () => {
    expect(round4(0.123456789)).toBe(0.1235);
    expect(round4(0)).toBe(0);
    expect(round4(NaN)).toBeNull();
    expect(round4(Infinity)).toBeNull();
    expect(round4(null)).toBeNull();
    expect(round4("0.5")).toBeNull();
  });
});

describe("posteriorSummary", () => {
  it("reports spN 0 for no posterior, rather than a set of zeroes", () => {
    // A uniformly-zero distribution is indistinguishable from "no result" in
    // every log line that reports only a conclusion, which is why spN is here.
    expect(posteriorSummary(null, head)).toEqual({ spN: 0 });
    expect(posteriorSummary({}, head)).toEqual({ spN: 0 });
  });

  it("counts the non-zero entries", () => {
    expect(posteriorSummary({ spP: [0, 0.5, 0, 0.5] }, head)).toMatchObject({ spN: 4, spNonZero: 2 });
  });

  it("names the winning index", () => {
    expect(posteriorSummary({ spP: [0.1, 0.7, 0.2] }, head)).toMatchObject({ spTopIdx: 1, spMax: 0.7 });
  });

  it("reports the genus total of the winning genus", () => {
    const spP = head.species.map(() => 0);
    spP[head.species.indexOf("Aedes aegypti")] = 0.6;
    expect(posteriorSummary({ spP }, head).genusTotal).toBeCloseTo(0.6, 10);
  });
});

describe("genusTotals", () => {
  it("sums every species of the winning species' genus", () => {
    const spP = head.species.map(() => 0);
    spP[head.species.indexOf("Aedes aegypti")] = 0.4;
    spP[head.species.indexOf("Aedes albopictus")] = 0.2;
    expect(genusTotals({ spP }, head.species.indexOf("Aedes aegypti"), head)).toBeCloseTo(0.6, 10);
  });

  it("is null, not 0, when there is no head or no winner", () => {
    // 0 would read as "this genus scored nothing", when the truth is "there was
    // nothing to score".
    expect(genusTotals({ spP: [0.5] }, 0, null)).toBeNull();
    expect(genusTotals({ spP: [0.5] }, -1, head)).toBeNull();
  });
});

describe("verdictSummary", () => {
  it("is empty for a photo with no verdict, rather than zeroes", () => {
    expect(verdictSummary({ verdict: null })).toEqual({});
  });

  it("carries the state, genus and both top posteriors", () => {
    const s = verdictSummary({
      verdict: { state: "species", genus: "Aedes", species: "Aedes aegypti",
                 topGenusP: 0.91, topSpeciesP: 0.83, runnersUp: [] },
    });
    expect(s).toMatchObject({ state: "species", genus: "Aedes", topGenusP: 0.91, topSpeciesP: 0.83 });
  });
});
