/**
 * The whole-frame view is optional.
 *
 * Fusing a crop with its whole frame is the app's largest measured accuracy
 * win, and it was unconditional: `viewsFor` and the batch paths each said
 * "always both" without saying it, so a user who wanted a crop judged on its own
 * could not have one. The whole frame is now a header-row checkbox.
 *
 * What is pinned here is the decision (`viewKinds`), what it means downstream
 * (`fuseViews` over the resulting view counts), and the wiring - which is read
 * from the source text, because `main.js` is a `.js` file that `tsc --noEmit`
 * does not read at all and that cannot be imported without executing it.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_INCLUDE_WHOLE_FRAME,
  WHOLE_FRAME_KEY,
  readIncludeWholeFrame,
  viewKinds,
} from "../src/app/viewSelection";
import { fuseViews } from "../src/confidence/fuseViews";
import { realHead, post } from "./fixtures";
import type { Head, ViewResult } from "../src/confidence/types";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const MAIN = readFileSync(join(root, "src", "app", "main.js"), "utf8");
const VIEWS = readFileSync(join(root, "src", "app", "views.ts"), "utf8");
const HTML = readFileSync(join(root, "index.html"), "utf8");

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

/**
 * The body of `fn`, from its declaration to the next top-level `function`.
 *
 * `src` defaults to main.js; a function that has been extracted to a typed
 * module is read from there instead, which is the point of the extraction - the
 * source of truth for a function is wherever it now lives, and reading a stale
 * copy out of main.js is how a wiring check passes against deleted code.
 */
function body(fn: string, src: string = MAIN): string {
  // `export function` in an extracted module, plain `function` in main.js.
  const start = src.search(new RegExp(`^(export )?(async )?function ${fn}\\b`, "m"));
  expect(start, `${fn} is in the file it was looked for in`).toBeGreaterThan(-1);
  const rest = src.slice(start + 1);
  const next = rest.search(/^(async )?function [A-Za-z_$]/m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** The window of main.js around `marker`, wide enough to hold its statement. */
function around(marker: string): string {
  const at = MAIN.indexOf(marker);
  expect(at, `${marker} is in main.js`).toBeGreaterThan(-1);
  return MAIN.slice(Math.max(0, at - 2500), at + 2500);
}

describe("which views a photo offers", () => {
  it("gives a cropped photo both views, whole photo included (the default)", () => {
    expect(viewKinds(true, true)).toEqual(["crop", "whole"]);
  });

  it("gives a cropped photo only its crop when the whole photo is excluded", () => {
    expect(viewKinds(true, false)).toEqual(["crop"]);
  });

  it("still gives an uncropped photo its whole frame with the whole photo excluded", () => {
    // The whole frame is not an addition to a crop here, it is all there is.
    // Dropping it would leave a photo with nothing to judge.
    expect(viewKinds(false, false)).toEqual(["whole"]);
    expect(viewKinds(false, true)).toEqual(["whole"]);
  });

  it("never returns an empty view set, in any state", () => {
    for (const hasCrop of [true, false]) {
      for (const include of [true, false]) {
        expect(viewKinds(hasCrop, include).length, `crop=${hasCrop} include=${include}`).toBeGreaterThan(0);
      }
    }
  });

  it("orders the crop first where there is one", () => {
    // The nuisance gate is a statement about the crop, so the crop is scored
    // first in every state that has one.
    expect(viewKinds(true, true)[0]).toBe("crop");
    expect(viewKinds(true, false)[0]).toBe("crop");
  });
});

describe("what the view count does to the fused result", () => {
  // Two views that name different species: the case the disagreement veto exists
  // for, and the case that makes the fused top different from either view's.
  const crop = () => view("Aedes aegypti", 0.6);
  const whole = () => view("Culex pipiens", 0.45);

  it("fuses two disagreeing views into something neither of them said", () => {
    const fused = fuseViews(head, [crop(), whole()])!;
    expect(fused.nViews).toBe(2);
    expect(fused.agreement?.agree).toBe(false);
  });

  it("names the crop alone when the whole frame is excluded", () => {
    // One view is that view's own softmax - no second opinion to be outvoted,
    // and no disagreement left to see.
    const only = fuseViews(head, [crop()])!;
    expect(only.nViews).toBe(1);
    expect(only.detail["Aedes aegypti"]).toBeGreaterThan(only.detail["Culex pipiens"]!);
    expect(only.agreement).toBeNull();
  });

  it("fuses to null on zero views, so nothing can be pooled from an empty set", () => {
    expect(fuseViews(head, [])).toBeNull();
  });

  it("changes the pooled posterior coherently rather than breaking it", () => {
    const two = fuseViews(head, [crop(), whole()])!;
    const one = fuseViews(head, [crop()])!;
    // Not NaN, and normalised: the one-view fusion is still a distribution.
    const mass = one.spP.reduce((a, b) => a + b, 0);
    // The species block sums to less than 1 by however much the nuisance mass
    // took - that is what keeps a fused score readable next to a single view's,
    // so it is asserted rather than normalised away.
    expect(Number.isFinite(mass)).toBe(true);
    expect(mass).toBeGreaterThan(0);
    expect(mass).toBeLessThan(1);
    expect(mass).toBeCloseTo(1 - one.nuP[0]!, 6);
    expect(Number.isNaN(one.detail["Aedes aegypti"]!)).toBe(false);
    // A different pooled verdict, not the same one from fewer inputs.
    expect(one.spP).not.toEqual(two.spP);
  });

  it("reports the same views to the verdict it was fused from", () => {
    // The per-photo verdict, the pooled card and `viewsTotal` all read the one
    // fused result, so a photo cannot claim two views and be pooled on one.
    const only = fuseViews(head, [crop()])!;
    expect(only.nViews).toBe(1);
    expect(only.verdict.state).not.toBe("non-mosquito");
  });
});

describe("the preference survives a reload", () => {
  const store = (v: string | null | undefined) => ({
    getItem: (_k: string): string | null => {
      if (v === undefined) throw new Error("storage access denied");
      return v;
    },
  });

  it("defaults to including the whole photo", () => {
    expect(DEFAULT_INCLUDE_WHOLE_FRAME).toBe(true);
    expect(readIncludeWholeFrame(store(null))).toBe(true);
  });

  it("reads a stored exclusion back", () => {
    expect(readIncludeWholeFrame(store("false"))).toBe(false);
  });

  it("reads a stored inclusion back", () => {
    expect(readIncludeWholeFrame(store("true"))).toBe(true);
  });

  it("falls back to the default on a stale key rather than throwing", () => {
    // A value this build does not write - an older or newer key, a hand edit -
    // is not a third state.
    expect(readIncludeWholeFrame(store("no"))).toBe(true);
    expect(readIncludeWholeFrame(store(""))).toBe(true);
    expect(readIncludeWholeFrame(store("0"))).toBe(true);
    expect(readIncludeWholeFrame(store(undefined))).toBe(true);
    expect(readIncludeWholeFrame(null)).toBe(true);
  });

  it("uses a key of its own, so it cannot collide with the engine preference", () => {
    expect(WHOLE_FRAME_KEY).toBe("mosquito_include_whole_frame");
    expect(WHOLE_FRAME_KEY).not.toBe("mosquito_engine");
  });
});

describe("the control", () => {
  const navRow = () => {
    const from = HTML.indexOf('<div class="gallery-nav">');
    const to = HTML.indexOf('id="thumbnail-strip"');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return HTML.slice(from, to);
  };

  it("is a checkbox in the gallery header row, beside the bulk actions", () => {
    const nav = navRow();
    expect(nav, "the whole-frame checkbox is in the header row").toContain('id="chk-whole-frame"');
    // Flush with the controls it belongs beside, and ahead of them in the row.
    expect(nav.indexOf('id="chk-whole-frame"')).toBeLessThan(nav.indexOf('id="btn-select-all"'));
  });

  it("is not inside the results card's aggregation options", () => {
    const from = HTML.indexOf('id="pooling-methods"');
    const to = HTML.indexOf('id="gallery-section"');
    expect(from).toBeGreaterThan(-1);
    expect(HTML.slice(from, to)).not.toContain("chk-whole-frame");
  });

  it("says which view is optional, on the control itself", () => {
    const at = HTML.indexOf('id="chk-whole-frame"');
    const label = HTML.slice(HTML.lastIndexOf("<label", at), HTML.indexOf("</label>", at));
    expect(label).toMatch(/whole photo/i);
    // "Use uncropped" would not say what is being added to what.
    expect(label).not.toMatch(/uncropped/i);
  });

  it("starts checked, so a first visit behaves as it always has", () => {
    const at = HTML.indexOf('id="chk-whole-frame"');
    const tag = HTML.slice(HTML.lastIndexOf("<input", at), HTML.indexOf(">", at));
    expect(tag).toMatch(/\bchecked\b/);
  });

  it("names the effect of turning it off, on its tooltip", () => {
    const at = HTML.indexOf('id="chk-whole-frame"');
    const label = HTML.slice(HTML.lastIndexOf("<label", at), HTML.indexOf("</label>", at));
    expect(label).toMatch(/title="[^"]+"/);
    expect(label).toMatch(/no crop is always judged on the whole photo/i);
  });
});

describe("every classify path asks the same question", () => {
  it("routes the crop-release path through viewKinds", () => {
    // viewsFor was extracted to src/app/views.ts; read it there, not in main.js.
    expect(body("viewsFor", VIEWS)).toContain("viewKinds(");
  });

  it("has the crop-release path still calling that viewsFor", () => {
    // The half that extraction cannot prove on its own: that main.js's crop
    // release reaches the module's decision rather than a copy of it left
    // behind. Without this, a renamed or shadowed local `viewsFor` would satisfy
    // the check above while the shipped path asked no one.
    // The adapter is a `const` arrow, not a declaration, so it is read as the
    // statement rather than as a function body.
    const adapter = around("const viewsFor = (p, cropCv, cropBox) =>");
    expect(adapter).toMatch(/_viewsFor\(p, cropCv, cropBox, includeWholeFrame\)/);
    expect(around("async function classifyViews")).toMatch(/viewsFor\(p, cropCv, cropBox\)/);
  });

  it("routes the local batch path through viewKinds", () => {
    const src = MAIN.slice(MAIN.indexOf("async function classifyImage"));
    expect(src.slice(0, src.indexOf("// ---- Batch Processing ----"))).toContain("viewKinds(");
  });

  it("routes the server batch path through viewKinds", () => {
    expect(around("const views = [serverView(data)]")).toContain("viewKinds(");
  });

  it("skips the whole frame's inference when it is excluded", () => {
    // The saving is the point of turning it off: an excluded whole frame costs
    // no model inference, not merely no weight in the sum.
    const src = MAIN.slice(MAIN.indexOf("async function classifyImage"));
    const guard = src.slice(0, src.indexOf("const clipTime"));
    expect(guard).toMatch(/viewKinds\([^;]*\.includes\("whole"\)\s*\)[\s\S]*clipEmbed\(fullCv\)/);
  });

  it("re-classifies the photos already on screen when the setting changes", () => {
    // A photo's verdict describes the views it was fused from. Leaving a
    // two-view verdict on screen under a one-view setting is exactly the
    // disagreement the per-photo verdict and the pooled card must not have.
    //
    // The pass itself moved into `reclassifyQueue`, which is where the freeze
    // was; what has to stay true here is that the toggle still drives it and
    // that the pass still calls the real classifier.
    expect(body("wireWholeFrameToggle")).toContain("reclassifyRunner.request()");
    const runner = MAIN.slice(MAIN.indexOf("const reclassifyRunner = createReclassifyRunner"));
    expect(runner).toContain("classifyViews(");
    expect(runner).toContain("currentSetting: () => includeWholeFrame");
  });

  it("does not start a pass per photo", () => {
    // The freeze: every due photo's inference was launched in the same
    // synchronous loop, so ten photos put ten runs on the one onnxruntime
    // session the batch path deliberately keeps to one at a time. The runner
    // awaits each photo, so `classify` must be reached through it and not
    // collected into an array of promises.
    const runner = MAIN.slice(MAIN.indexOf("const reclassifyRunner = createReclassifyRunner"));
    const body = runner.slice(0, runner.indexOf("\n});"));
    expect(body).not.toMatch(/\.map\([^)]*async|\.forEach\([^)]*async|Promise\.all/);
    expect(body).toContain("await classifyViews(");
  });

  it("persists the setting under the key it reads", () => {
    const src = body("wireWholeFrameToggle");
    expect(src).toContain("readIncludeWholeFrame(");
    expect(src).toContain(`localStorage.setItem(WHOLE_FRAME_KEY`);
  });
});