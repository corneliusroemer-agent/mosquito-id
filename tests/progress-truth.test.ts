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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { beginModelLoad, clearProgress, completeLoadStep, loadStepProgress, setProgress } from "../src/app/progress";

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

/**
 * A clock the test drives, so the 500 ms rate throttle cannot swallow every
 * in-flight sample.
 *
 * `loadStepProgress` discards a non-`done` report that arrives within 500 ms of
 * the last one, because a rate needs a window rather than a sample. Real chunks
 * are seconds apart; a test loop is microseconds apart, so without this every
 * intermediate report is discarded and the test measures the throttle instead of
 * the invariant. Each `download` step advances the clock past the window.
 */
let clock = 0;
function advanceClock(ms: number): void {
  clock += ms;
  vi.spyOn(performance, "now").mockReturnValue(clock);
}

/** Run a whole download as a stream of chunks, reporting each one. */
function download(report: ReturnType<typeof loadStepProgress>, total: number, steps = 8): void {
  advanceClock(1000);
  for (let i = 1; i <= steps; i++) { advanceClock(1000); report(Math.round((total * i) / steps), total); }
  advanceClock(1000);
  report(total, total, true);
}

describe("the model progress bar", () => {
  let dom: Stub;
  beforeEach(() => { dom = stubDom(); clock = 0; });
  afterEach(() => { vi.restoreAllMocks(); });

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
    download(loadStepProgress("classifier", "culico"), CULICO, 10);
    record();
    completeLoadStep("classifier-session"); record();
    completeLoadStep("embeds"); record();

    expect(Math.max(...seen)).toBeLessThanOrEqual(100);
    expect(seen[seen.length - 1]).toBe(100);
  });

  it("never goes backwards across a phase change", () => {
    declareColdLoad();
    let last = 0;
    const check = () => { const w = dom.width(); expect(w).toBeGreaterThanOrEqual(last); last = w; };

    const det = loadStepProgress("detector", "Detector");
    for (let i = 1; i <= 8; i++) { advanceClock(1000); det((DETECTOR * i) / 8, DETECTOR); check(); }
    advanceClock(1000); det(DETECTOR, DETECTOR, true); check();
    completeLoadStep("detector-session"); check();
    const cls = loadStepProgress("classifier", "culico");
    for (let i = 1; i <= 8; i++) { advanceClock(1000); cls((CULICO * i) / 8, CULICO); check(); }
    advanceClock(1000); cls(CULICO, CULICO, true); check();
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

  it("holds the bar at its high-water mark when a step reports out of order", () => {
    // `loadFloor` is the only thing stopping the bar walking backwards, and with
    // the steps in execution order a well-behaved load never descends - so
    // nothing else in this file would notice it missing. The situation that
    // needs it is real: `fetchWithCache` falls through to a network fetch when
    // CacheStorage throws, so a step can report a low byte count after a later
    // report has already advanced the bar.
    declareColdLoad();
    const cls = loadStepProgress("classifier", "culico");
    advanceClock(1000); cls(CULICO, CULICO, true);
    const high = dom.width();
    expect(high).toBeGreaterThan(0);

    // A late, lower report from the same step must not pull the bar back.
    advanceClock(1000); cls(CULICO / 8, CULICO);
    expect(dom.width()).toBe(high);

    // Nor must a step completing behind one that already finished. This is the
    // `completeLoadStep` floor: a session step that lands out of order would,
    // without it, write its own smaller `endPct` straight to the bar.
    const stale = loadStepProgress("detector", "Detector");
    completeLoadStep("classifier-session");
    const after = dom.width();
    advanceClock(1000); stale(DETECTOR / 4, DETECTOR, true);
    expect(dom.width()).toBe(after);

    // A session step landing before an earlier one is the case that needs
    // `completeLoadStep`'s own floor: the WASM fallback can create the
    // classifier's session while the detector's is still being built, and
    // without the floor the detector then writes its smaller span straight to
    // the bar and the user sees it run backwards.
    completeLoadStep("classifier-session");
    const sessionHigh = dom.width();
    completeLoadStep("detector-session");
    expect(dom.width()).toBe(sessionHigh);
  });

  it("does not reach 100% from a byte step alone when a session step remains", () => {
    // The embeddings are declared as a SESSION step and are driven by no byte
    // reporter. If a plan ended on a byte step, that step's last byte would take
    // the bar to 100% with no session ever created - the original defect,
    // relocated. This pins that a trailing session step still has to be earned.
    beginModelLoad([
      { key: "classifier", bytes: CULICO },
      { key: "classifier-session" },
      { key: "embeds" },
    ]);
    download(loadStepProgress("classifier", "culico"), CULICO);
    expect(dom.width()).toBeLessThan(100);
    completeLoadStep("classifier-session");
    expect(dom.width()).toBeLessThan(100);
    completeLoadStep("embeds");
    expect(dom.width()).toBe(100);
  });

  it("leaves nothing to earn when every artefact is already in memory", () => {
    // The whole-cached path: no download and no session to build, so there are
    // no steps at all. The bar must not divide by zero or sit claiming progress
    // for work that is not happening - and must not leave a stale 100% on screen
    // from the previous load.
    completeLoadStep("detector-session");
    completeLoadStep("classifier-session");
    completeLoadStep("embeds");
    clearProgress();
    beginModelLoad([]);
    expect(dom.width()).toBe(0);
    // Every report for a step that is not in this plan is ignored rather than
    // throwing on an empty table.
    expect(() => loadStepProgress("classifier", "culico")(CULICO, CULICO, true)).not.toThrow();
    expect(dom.width()).toBe(0);
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

  it("ignores a byte report from a load that has been superseded", () => {
    // An engine switch re-enters `loadWebGPUModels` WITHOUT cancelling the
    // previous fetch, so the old call's reader keeps delivering chunks under the
    // same step keys. Those reports belong to a load that no longer exists and
    // must not move the new one's bar - otherwise the new bar reaches 100% on
    // bytes the new load never fetched.
    const stale = loadStepProgress("classifier", "culico");
    declareColdLoad();
    advanceClock(1000);
    stale(CULICO, CULICO, true);
    expect(dom.width()).toBe(0);
  });

  it("keeps reporting after a non-model clear, which is not the load's own", () => {
    // Clicking Samples during the 1.26 GB download clears the slot for the
    // "samples" owner. The model load is still running, and must keep advancing:
    // resetting the plan on any clear left the bar at 0% for the rest of the
    // download, with every later report discarded.
    declareColdLoad();
    download(loadStepProgress("detector", "Detector"), DETECTOR);
    completeLoadStep("detector-session");
    const cls = loadStepProgress("classifier", "culico");
    advanceClock(1000);
    cls(CULICO / 4, CULICO);
    const before = dom.width();
    expect(before).toBeGreaterThan(0);

    setProgress("samples", null, null);
    clearProgress("samples");

    advanceClock(1000);
    cls(CULICO / 2, CULICO);
    expect(dom.width()).toBeGreaterThan(before);
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