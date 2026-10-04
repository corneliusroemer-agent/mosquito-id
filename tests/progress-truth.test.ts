// The progress bar must not claim the model is loaded before it is.
//
// The defect: the bar was drawn per file and reached 100% on the last byte of a
// download. `InferenceSession.create` runs afterwards - WASM compile, graph
// init, weight upload - and until it returns, `window.modelsReady` is false and
// nothing can be classified. Measured on the 10.6 MB detector, the bar read a
// full 100% for 1.7 s while the model was not usable, and then reset to 0% for
// the next file, so the same screen showed "done" and "starting over" for one
// load.
//
// What is pinned here is the invariant, not the presentation: a full bar means
// an inference can run. These drive the real `progress.ts` against a minimal DOM
// stub, so what they assert on is the width the browser would actually render.
import { describe, it, expect, beforeEach } from "vitest";
import { beginModelLoad, completeLoadStep, loadStepProgress, clearProgress } from "../src/app/progress";

/** The three things the load has to fetch, at roughly the shipped sizes. */
const DETECTOR = 10_607_017;
const CULICO = 85_378_525;

interface Stub {
  width: () => number;
  indeterminate: () => boolean;
  meter: () => string;
  visible: () => boolean;
}

/**
 * The five elements `progress.ts` reads, and nothing else.
 *
 * A stub rather than jsdom because what is under test is the arithmetic that
 * chooses a width; a real layout engine would only add ways for the test to pass
 * for the wrong reason.
 */
function stubDom(): Stub {
  interface El { textContent: string; style: { width: string; visibility: string };
    classList: { toggle: (n: string, on?: boolean) => void; remove: (n: string) => void; add: (n: string) => void; contains: (n: string) => boolean } }
  const el = (): El => ({ textContent: "", style: { width: "0%", visibility: "hidden" }, classList: {
    toggle: () => {}, remove: () => {}, add: () => {}, contains: () => false,
  } });
  const nodes: Record<string, El> = {
    "progress-slot": el(), "progress-msg": el(), "progress-meter": el(),
    "progress-fill": el(), "btn-cancel-batch": el(),
  };
  const slot = nodes["progress-slot"] as El;
  const fill = nodes["progress-fill"] as El;
  const meter = nodes["progress-meter"] as El;
  let indeterminate = false;
  // `classList.toggle(name, on)` is what decides the indeterminate sweep.
  slot.classList.toggle = (name: string, on?: boolean) => { if (name === "indeterminate") indeterminate = !!on; };
  slot.classList.remove = (name: string) => { if (name === "indeterminate") indeterminate = false; };
  (globalThis as any).document = { getElementById: (id: string) => nodes[id] ?? null };
  return {
    width: () => parseFloat(fill.style.width) || 0,
    indeterminate: () => indeterminate,
    meter: () => meter.textContent,
    visible: () => slot.style.visibility === "visible",
  };
}

/** Run a whole download as a stream of chunks, reporting each one. */
function download(report: ReturnType<typeof loadStepProgress>, total: number, steps = 8): void {
  for (let i = 1; i <= steps; i++) report(Math.round((total * i) / steps), total);
  report(total, total, true);
}

describe("the model progress bar", () => {
  let dom: Stub;
  beforeEach(() => { dom = stubDom(); });

  /** The load `loadWebGPUModels` declares for a cold culico start, in the order it happens. */
  const declareColdLoad = () => beginModelLoad([
    { key: "detector", bytes: DETECTOR },
    { key: "detector-session" },
    { key: "classifier", bytes: CULICO },
    { key: "classifier-session" },
    { key: "embeds" },
  ]);

  it("does not read complete while the detector's session is still being created", () => {
    declareColdLoad();
    download(loadStepProgress("detector", "Detector (YOLO11n)"), DETECTOR);

    // Every byte of the detector has arrived. `InferenceSession.create` has not
    // returned, so the model cannot classify a single pixel yet.
    expect(dom.width()).toBeLessThan(100);

    completeLoadStep("detector-session");
    expect(dom.width()).toBeLessThan(100);
  });

  it("does not read complete once every byte of the whole load has arrived", () => {
    declareColdLoad();
    download(loadStepProgress("detector", "Detector (YOLO11n)"), DETECTOR);
    completeLoadStep("detector-session");
    download(loadStepProgress("classifier", "culico-net"), CULICO);

    // The classifier's 85 MB are on disk. Both sessions exist, but the head is
    // not parsed yet, so nothing can be classified.
    expect(dom.width()).toBeLessThan(100);

    completeLoadStep("classifier-session");
    completeLoadStep("embeds");
    expect(dom.width()).toBe(100);
  });

  it("never claims more than it knows at any point in a cold load", () => {
    declareColdLoad();
    const seen: number[] = [];
    const record = () => seen.push(dom.width());

    download(loadStepProgress("detector", "Detector"), DETECTOR); record();
    completeLoadStep("detector-session"); record();
    // Partial classifier, the way a throttled stream actually arrives.
    for (let i = 1; i <= 10; i++) { loadStepProgress("classifier", "culico")((CULICO * i) / 10, CULICO); record(); }
    download(loadStepProgress("classifier", "culico"), CULICO); record();
    completeLoadStep("classifier-session"); record();
    completeLoadStep("embeds"); record();

    expect(Math.max(...seen)).toBeLessThanOrEqual(100);
    expect(seen[seen.length - 1]).toBe(100);
  });

  it("never goes backwards across a phase change", () => {
    declareColdLoad();
    let last = 0;
    const check = () => { const w = dom.width(); expect(w).toBeGreaterThanOrEqual(last); last = w; };

    for (let i = 1; i <= 8; i++) { loadStepProgress("detector", "Detector")((DETECTOR * i) / 8, DETECTOR); check(); }
    loadStepProgress("detector", "Detector")(DETECTOR, DETECTOR, true); check();
    completeLoadStep("detector-session"); check();
    for (let i = 1; i <= 8; i++) { loadStepProgress("classifier", "culico")((CULICO * i) / 8, CULICO); check(); }
    loadStepProgress("classifier", "culico")(CULICO, CULICO, true); check();
    completeLoadStep("classifier-session"); check();
    completeLoadStep("embeds"); check();
  });

  it("shows something on a warm cache rather than sitting at nothing", () => {
    // Every step reports its whole size at once, which is what a CacheStorage hit
    // does. The bar still has to advance rather than jumping to 100%: the model
    // is not usable until the sessions exist.
    beginModelLoad([
      { key: "detector", bytes: DETECTOR },
      { key: "detector-session" },
      { key: "classifier", bytes: CULICO },
      { key: "classifier-session" },
      { key: "embeds" },
    ]);
    expect(dom.visible()).toBe(true);

    loadStepProgress("detector", "Detector (YOLO11n)")(DETECTOR, DETECTOR, true);
    expect(dom.width()).toBeGreaterThan(0);
    expect(dom.width()).toBeLessThan(100);
  });

  it("reaches 100% on a warm cache only once the sessions exist", () => {
    beginModelLoad([
      { key: "detector", bytes: DETECTOR },
      { key: "detector-session" },
      { key: "classifier", bytes: CULICO },
      { key: "classifier-session" },
      { key: "embeds" },
    ]);
    loadStepProgress("detector", "Detector (YOLO11n)")(DETECTOR, DETECTOR, true);
    loadStepProgress("classifier", "culico")(CULICO, CULICO, true);
    expect(dom.width()).toBeLessThan(100);

    completeLoadStep("detector-session");
    completeLoadStep("classifier-session");
    completeLoadStep("embeds");
    expect(dom.width()).toBe(100);
  });

  it("does not leap ahead of a download it has not started yet", () => {
    // The steps are declared in the order the load performs them, which is what
    // makes the bar a single forward advance. Listed the other way round - all
    // the downloads first, then the sessions - the bar jumped to ~97% the moment
    // the detector's session was created, and then sat there through the whole
    // 81 MB classifier download: technically monotone, and still a lie about how
    // much of the load was left.
    declareColdLoad();
    download(loadStepProgress("detector", "Detector"), DETECTOR);
    completeLoadStep("detector-session");

    // The classifier has not sent a byte yet, so most of the bar must be left.
    expect(dom.width()).toBeLessThan(90);

    download(loadStepProgress("classifier", "culico"), CULICO);
    completeLoadStep("classifier-session");
    expect(dom.width()).toBeLessThan(100);
    completeLoadStep("embeds");
    expect(dom.width()).toBe(100);
  });

  it("ignores a step that is not part of this load", () => {
    declareColdLoad();
    // A report arriving from a superseded load must not move this one's bar.
    loadStepProgress("some-other-model", "stale")(500, 1000, true);
    expect(dom.width()).toBe(0);
  });

  it("starts a new load from zero rather than from the last one's position", () => {
    declareColdLoad();
    completeLoadStep("detector-session");
    completeLoadStep("classifier-session");
    completeLoadStep("embeds");
    expect(dom.width()).toBe(100);

    clearProgress();
    declareColdLoad();
    expect(dom.width()).toBe(0);
  });

  it("ignores a byte report that arrives after the load was cleared", () => {
    // A superseded load can still have a stream in flight: `loadWebGPUModels`
    // is re-entered on an engine switch, and the previous call's reader keeps
    // delivering chunks. Its report must not resurrect a cleared slot or move
    // the bar of whatever comes next.
    declareColdLoad();
    clearProgress();
    // `done`, so it bypasses the 500 ms rate throttle - a throttled first
    // sample would be discarded and the test would pass without reaching the
    // guard at all.
    loadStepProgress("detector", "Detector (YOLO11n)")(DETECTOR, DETECTOR, true);
    expect(dom.visible()).toBe(false);
    expect(dom.width()).toBe(0);
  });

  it("does not leave a full bar behind when the load is cleared", () => {
    declareColdLoad();
    completeLoadStep("detector-session");
    completeLoadStep("classifier-session");
    completeLoadStep("embeds");
    clearProgress();
    expect(dom.visible()).toBe(false);
    expect(dom.width()).toBe(0);
  });
});