// The rev guard and the score commit, on the record every classification path
// writes into.
//
// Two real bugs of this project were gaps in exactly this protocol, and both
// were invisible because `main.js` was unchecked:
//
//   - 6647d05 forwarded `nuP` to the pooled card from the crop-release path and
//     the batch path separately; one site was updated and one was not, and the
//     pooled card's non-mosquito gate silently read no nuisance evidence.
//   - 91029e3 handed a model's classifier logits to a softmax instead of its
//     embedding, and every photo came back "unsure" rather than throwing.
//
// The first is a field the commit path never wrote. This test pins what
// `commitScores` does and does not write, so a future change to that set is a
// visible diff rather than a silent divergence between two writers again.
import { describe, it, expect, vi } from "vitest";
import { beginRecompute, commitScores, markComputeFailed, ownsRecompute,
         Superseded, type PhotoState } from "../src/app/photoRecord";
import type { Verdict } from "../src/confidence/types";

const VERDICT: Verdict = {
  state: "species", genus: "Aedes", species: "Aedes aegypti",
  topGenusP: 0.9, topSpeciesP: 0.8, runnersUp: [],
};

const fused = () => ({
  labels: { Aedes: 0.9, Culex: 0.1 },
  detail: { "Aedes aegypti": 0.8, "Culex pipiens": 0.05 },
  logits: { "Aedes aegypti": 4.1, "Culex pipiens": 1.2 },
  adP: [0.02, 0.01],
  nuP: [0.05],
  adjacentDetail: { "biting midge": 0.02, "house fly": 0.01 },
  verdict: VERDICT,
});

const photo = (over: Partial<PhotoState> = {}): PhotoState => ({
  name: "a.jpg", fingerprint: null,
  displayCanvas: null, fullW: null, fullH: null,
  cropCanvas: null, contextCanvas: null,
  cropBox: null, contextBox: null,
  crop_rejected: false, is_cropped: false, manual_full_photo: false,
  scores: {}, detail: {}, logits: null, adP: null, verdict: null,
  adjacentDetail: null, agreement: null, viewsLanded: 0, viewsTotal: 0,
  scoredBy: "webgpu-fp16", status: "queued…",
  rev: 0, pending: true, error: null,
  detTime: null, clipTime: null, totalTime: null,
  ...over,
});

describe("beginRecompute", () => {
  it("bumps the revision and marks the photo pending", () => {
    const p = photo({ rev: 3, pending: false });
    expect(beginRecompute(p)).toBe(4);
    expect(p.rev).toBe(4);
    expect(p.pending).toBe(true);
  });

  it("clears the agreement, which described the previous crop's views", () => {
    // Leaving it in place put an agreement about two views of a DIFFERENT crop
    // next to a pending recompute for the crop now being drawn.
    const p = photo({ agreement: { agree: true, topSpecies: "Aedes aegypti", runnersUp: [], fusedTop: 0.8 } });
    beginRecompute(p);
    expect(p.agreement).toBeNull();
    expect(p.viewsLanded).toBe(0);
    expect(p.viewsTotal).toBe(0);
  });

  it("clears a previous error", () => {
    const p = photo({ error: "boom" });
    beginRecompute(p);
    expect(p.error).toBeNull();
  });
});

describe("ownsRecompute", () => {
  it("accepts the computation that still holds the revision", () => {
    const p = photo();
    const previews = [p];
    const rev = beginRecompute(p);
    expect(ownsRecompute(p, previews, 0, rev)).toBe(true);
  });

  it("rejects a superseded release", () => {
    const p = photo();
    const previews = [p];
    const stale = beginRecompute(p);
    beginRecompute(p); // a newer crop release overtakes it
    expect(ownsRecompute(p, previews, 0, stale)).toBe(false);
  });

  it("rejects a photo deleted mid-flight", () => {
    const p = photo();
    const rev = beginRecompute(p);
    p.removed = true;
    expect(ownsRecompute(p, [p], 0, rev)).toBe(false);
  });

  it("rejects a photo no longer in previews", () => {
    const p = photo();
    const rev = beginRecompute(p);
    expect(ownsRecompute(p, [], 0, rev)).toBe(false);
  });

  it("rejects a batch that replaced the slot object", () => {
    const original = photo({ name: "a.jpg" });
    const rev = beginRecompute(original);
    const replacement = photo({ name: "b.jpg" });
    expect(ownsRecompute(original, [replacement], 0, rev)).toBe(false);
  });
});

describe("commitScores", () => {
  it("files every field the fused result carries", () => {
    const p = photo({ pending: true, error: "boom" });
    const f = fused();
    commitScores(p, f, "webgpu-fp16");
    expect(p.scores).toEqual(f.labels);
    expect(p.detail).toEqual(f.detail);
    expect(p.logits).toEqual(f.logits);
    expect(p.adP).toEqual(f.adP);
    expect(p.adjacentDetail).toEqual(f.adjacentDetail);
    expect(p.verdict).toEqual(f.verdict);
    expect(p.scoredBy).toBe("webgpu-fp16");
    expect(p.pending).toBe(false);
    expect(p.error).toBeNull();
  });

  it("does NOT write the nuisance block - pinned, not endorsed", () => {
    // 6647d05 added `nuP` to the pooled card and had to touch main.js at every
    // photo site to do it. Nothing wrote it here at HEAD, and the pooled card's
    // non-mosquito gate therefore reads no nuisance evidence. This is recorded
    // as a fact about the shipped behaviour so that adding it is a deliberate,
    // visible change rather than a silent one - and so this test is what fails
    // when someone does add it deliberately.
    const p = photo();
    commitScores(p, fused(), "webgpu-fp16");
    expect(p.nuP).toBeUndefined();
  });

  it("files the engine it was told, not a read of module state", () => {
    const p = photo();
    commitScores(p, fused(), "server-gpu");
    expect(p.scoredBy).toBe("server-gpu");
  });
});

describe("markComputeFailed", () => {
  it("clears pending, records the message and logs once", () => {
    const log = vi.fn();
    const p = photo({ pending: true });
    markComputeFailed(p, new Error("WebGPU unavailable"), log);
    expect(p.pending).toBe(false);
    expect(p.error).toBe("Classification failed: WebGPU unavailable");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("crop_failed", { name: "a.jpg", error: "Error: WebGPU unavailable" });
  });

  it("copes with a thrown non-Error", () => {
    const p = photo({ pending: true });
    markComputeFailed(p, "just a string", vi.fn());
    expect(p.error).toBe("Classification failed: just a string");
  });
});

describe("Superseded", () => {
  it("is an Error, so a catch can tell it from a model failure", () => {
    const e = new Superseded();
    expect(e).toBeInstanceOf(Error);
  });
});
