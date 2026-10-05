/**
 * The counter module's own arithmetic: what a count means, who a layout read is
 * charged to, and what an unregistered gauge reports.
 *
 * The claims these counters exist to make are about the APP - a double
 * classification, a render that reads layout after writing - and those are
 * asserted in `e2e/tier1/perf-counters.spec.ts` against the real render path.
 * What is here is the part that would make those assertions unsound if it were
 * wrong: a counter that cannot be reset, a read charged to the wrong render, and
 * a gauge that reports zero for "not measured".
 *
 * The layout PROBE is not tested here. `armLayoutCounters` patches
 * `Element.prototype`, and vitest runs `environment: "node"` - there is no
 * `Element`, so the probe is covered from the Playwright tier instead, which is
 * also the only place it can be checked against real layout.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  FULL_RES_CACHE_FRAMES,
  FULL_RES_MIN_EDGE,
  liveFullResFrames,
  liveOrtSessions,
  noteClassifierCall,
  noteDetectorCall,
  noteForcedLayout,
  noteServerViewCall,
  registerFullResSource,
  registerOrtSessionSource,
  resetCounters,
  snapshot,
  withRenderScope,
} from "../src/app/perfCounters";

// The gauges are module state. Unregistering after each test is what keeps
// "reports null before anything registered" from depending on whether another
// test file ran first in the same process.
afterEach(() => {
  registerFullResSource(null);
  registerOrtSessionSource(null);
});

describe("operation counters", () => {
  beforeEach(() => resetCounters());

  it("starts at zero on every name", () => {
    const s = snapshot();
    expect(s.classifierCalls).toBe(0);
    expect(s.detectorCalls).toBe(0);
    expect(s.serverViewCalls).toBe(0);
    expect(s.forcedLayouts).toBe(0);
  });

  it("counts each kind of call separately", () => {
    noteClassifierCall();
    noteClassifierCall();
    noteDetectorCall();
    noteServerViewCall();
    const s = snapshot();
    expect(s.classifierCalls).toBe(2);
    expect(s.detectorCalls).toBe(1);
    expect(s.serverViewCalls).toBe(1);
  });

  it("resets every count", () => {
    noteClassifierCall();
    noteDetectorCall();
    withRenderScope("thumbnails", () => {
      noteForcedLayout();
    });
    resetCounters();
    const s = snapshot();
    expect(s.classifierCalls).toBe(0);
    expect(s.detectorCalls).toBe(0);
    expect(s.forcedLayouts).toBe(0);
    expect(s.worstRenderLayouts).toBe(0);
    // The reset clears the per-render breakdown too, or a second measurement
    // would be charged the first one's worst render.
    expect(Object.keys(s.layoutsByRender)).toHaveLength(0);
  });
});

describe("a layout read is charged to the render that made it", () => {
  beforeEach(() => resetCounters());

  it("counts a read made inside a render", () => {
    withRenderScope("thumbnails", () => {
      noteForcedLayout();
      noteForcedLayout();
    });
    const s = snapshot();
    expect(s.forcedLayouts).toBe(2);
    expect(s.layoutsByRender.thumbnails).toBe(2);
  });

  it("does not count a read made outside every render", () => {
    // The claim these counters make is about a read INSIDE a write batch. A read
    // on its own - a measurement, a scroll into view from an event handler - is
    // not one, and counting it would make the per-render budget meaningless.
    noteForcedLayout();
    expect(snapshot().forcedLayouts).toBe(0);
  });

  it("charges a nested read to the innermost render, not the outer one", () => {
    // The batch loop renders between two photos' inferences, and a render can be
    // reached from inside another one's handler. A read belongs to the code that
    // made it, or the outer render's number is not that render's number.
    withRenderScope("outer", () => {
      noteForcedLayout();
      withRenderScope("inner", () => {
        noteForcedLayout();
        noteForcedLayout();
      });
      noteForcedLayout();
    });
    const s = snapshot();
    expect(s.layoutsByRender.inner).toBe(2);
    expect(s.layoutsByRender.outer).toBe(2);
    expect(s.forcedLayouts).toBe(4);
  });

  it("keeps the worst single render, not the running total", () => {
    withRenderScope("cheap", () => noteForcedLayout());
    withRenderScope("expensive", () => {
      noteForcedLayout();
      noteForcedLayout();
      noteForcedLayout();
    });
    withRenderScope("cheap-again", () => noteForcedLayout());
    const s = snapshot();
    expect(s.worstRenderLayouts).toBe(3);
    // The last run of each name is what `layoutsByRender` holds, which is what
    // makes it a per-render reading rather than a per-name total.
    expect(s.layoutsByRender.cheap).toBe(1);
    expect(s.layoutsByRender.expensive).toBe(3);
  });

  it("closes its scope when the render throws", () => {
    // A scope that leaked on a throw would leave every later read uncounted -
    // and would leave `renderDepth` above zero for the rest of the session, so
    // the counter would quietly stop working exactly when something had gone
    // wrong.
    expect(() =>
      withRenderScope("boom", () => {
        noteForcedLayout();
        throw new Error("render failed");
      }),
    ).toThrow("render failed");
    const s = snapshot();
    expect(s.layoutsByRender.boom).toBe(1);
    withRenderScope("after", () => noteForcedLayout());
    expect(snapshot().forcedLayouts).toBe(2);
  });

  it("returns what the render returned", () => {
    // A wrapper that dropped the return value would break every caller, and the
    // counters are not worth that.
    expect(withRenderScope("r", () => 42)).toBe(42);
  });
});

describe("live gauges report unmeasured as null, not as zero", () => {
  it("reports null before anything has registered a source", () => {
    // Zero here would make `expect(live).toBeLessThanOrEqual(bound)` pass on a
    // page nothing was measured on, which is the failure a gauge is supposed to
    // be immune to.
    expect(liveFullResFrames()).toBeNull();
    expect(liveOrtSessions()).toBeNull();
  });

  it("reports what the registered source says", () => {
    registerFullResSource(() => 7);
    registerOrtSessionSource(() => 3);
    expect(liveFullResFrames()).toBe(7);
    expect(liveOrtSessions()).toBe(3);
    const s = snapshot();
    expect(s.fullResFrames).toBe(7);
    expect(s.ortSessions).toBe(3);
  });

  it("reads the source fresh every time rather than caching it", () => {
    let frames = 1;
    registerFullResSource(() => frames);
    expect(liveFullResFrames()).toBe(1);
    frames = 5;
    expect(liveFullResFrames()).toBe(5);
  });

  it("does not reset a gauge when the counts are reset", () => {
    // A gauge is a reading of live state and a count is an event tally. Zeroing
    // the tally must not make a photo's frame disappear.
    registerFullResSource(() => 2);
    resetCounters();
    expect(liveFullResFrames()).toBe(2);
  });
});

describe("the frame bound", () => {
  it("is two slots and a 2048 px display edge", () => {
    // Both are the retention branch's numbers. If that branch lands, these move
    // to `./fullResSource` - see the note there. A spec asserting a different
    // number from this one would pass against the wrong bound.
    expect(FULL_RES_CACHE_FRAMES).toBe(2);
    expect(FULL_RES_MIN_EDGE).toBe(2048);
  });
});