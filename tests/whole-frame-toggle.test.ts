/**
 * Unchecking the whole-frame view must not freeze the page.
 *
 * The reported failure was a freeze, not a slow re-classification: ten sample
 * photos classified fine, the toggle worked, and the page stopped responding.
 * The cause was in `reclassifyForWholeFrame`, which built its work list and
 * started every photo's inference in one synchronous loop. Ten photos meant ten
 * concurrent runs on the single onnxruntime session, and the batch path that
 * normally populates the gallery goes out of its way to keep that session to one
 * run at a time precisely because a run occupies the main thread.
 *
 * So the invariant pinned here is the scheduling, and it is pinned against the
 * real `createReclassifyRunner` with a fake classifier rather than by reading
 * the source: what has to hold is that no two classifications overlap, and that
 * a toggle during a pass produces exactly one more pass instead of a second one
 * beside it. Both are observable from a fake.
 *
 * Every wait is bounded. The bug this fixes is a livelock-shaped one, and a test
 * that hangs on a regression is a test nobody runs again.
 */
import { describe, it, expect } from "vitest";
import { createReclassifyRunner } from "../src/app/reclassifyQueue";
import { DEFAULT_INCLUDE_WHOLE_FRAME, readIncludeWholeFrame } from "../src/app/viewSelection";

/** One photo on screen, with the setting its current verdict was fused under. */
interface FakePhoto {
  name: string;
  /** The `includeWholeFrame` value in force when this photo was last classified. */
  classifiedUnder: boolean;
  pending: boolean;
  error: string | null;
  hasCanvas: boolean;
  removed?: boolean;
}

/** The state the app keeps, plus what the fake classifier recorded. */
interface World {
  photos: FakePhoto[];
  setting: boolean;
  /** Every classification the fake was asked for, in the order it was asked. */
  started: string[];
  /** The deepest number of classifications that were ever in flight together. */
  peakConcurrency: number;
  inFlight: number;
  renders: number;
  passes: number;
}

/**
 * The classifier, standing in for `classifyViews`.
 *
 * `release` is a gate the test holds, so overlap can be provoked deliberately:
 * with the old code every photo entered the fake in the same tick, and with the
 * runner exactly one does.
 */
function fakeClassifier(world: World, release?: Promise<void>) {
  return async (photo: FakePhoto) => {
    world.started.push(photo.name);
    world.inFlight++;
    world.peakConcurrency = Math.max(world.peakConcurrency, world.inFlight);
    try {
      if (release) await release;
      // One macrotask, so a second classification has a chance to start if the
      // runner is going to let one.
      await new Promise((r) => setTimeout(r, 0));
      photo.classifiedUnder = world.setting;
      photo.pending = false;
    } finally {
      world.inFlight--;
    }
  };
}

/** Ten photos, all settled and classified under `setting`. */
function world(n = 10, setting = true): World {
  return {
    photos: Array.from({ length: n }, (_, i) => ({
      name: `photo-${i}.jpg`,
      classifiedUnder: setting,
      pending: false,
      error: null,
      hasCanvas: true,
    })),
    setting,
    started: [],
    peakConcurrency: 0,
    inFlight: 0,
    renders: 0,
    passes: 0,
  };
}

/** The runner wired to a world, the same three things `main.js` supplies. */
function runnerFor(w: World, release?: Promise<void>) {
  const runner = createReclassifyRunner<FakePhoto>({
    due: () => w.photos.filter((p) => !p.removed && !p.pending && !p.error && p.hasCanvas),
    currentSetting: () => w.setting,
    classify: fakeClassifier(w, release),
    onSettled: () => {
      w.renders++;
      w.passes = runner.passes;
    },
  });
  return runner;
}

/** Resolve/reject so a hang fails the test instead of stalling the run. */
const settleWithin = <T,>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} did not settle in ${ms}ms`)), ms)),
  ]);

describe("toggling the whole-frame view", () => {
  it("never runs two classifications at once", async () => {
    // The freeze itself. Ten photos, one run at a time.
    const w = world(10);
    const runner = runnerFor(w);
    w.setting = false;

    await settleWithin(runner.request(), 5_000, "the re-classification pass");

    expect(w.started).toHaveLength(10);
    expect(w.peakConcurrency).toBe(1);
  });

  it("leaves every photo classified under the setting that is now active", async () => {
    // The invariant the re-classification exists for: no photo is left holding a
    // verdict fused from views the setting no longer includes.
    const w = world(10);
    const runner = runnerFor(w);
    w.setting = false;

    await settleWithin(runner.request(), 5_000, "the re-classification pass");

    expect(w.photos.every((p) => p.classifiedUnder === false)).toBe(true);
    expect(w.photos.some((p) => p.pending)).toBe(false);
  });

  it("runs exactly one pass per toggle", async () => {
    const w = world(6);
    const runner = runnerFor(w);

    w.setting = false;
    await settleWithin(runner.request(), 5_000, "the first pass");
    expect(runner.passes).toBe(1);

    w.setting = true;
    await settleWithin(runner.request(), 5_000, "the second pass");
    expect(runner.passes).toBe(2);

    expect(w.started).toHaveLength(12);
    // One render for the pass, not one per photo: the old code painted a dozen
    // times over before the first inference had started.
    expect(w.renders).toBe(2);
  });

  it("toggles back the other way just as cleanly", async () => {
    // Direction does not change the mechanism, so both directions are pinned.
    // Turning it back on is the more expensive one: two views per photo.
    const w = world(10, false);
    const runner = runnerFor(w);
    w.setting = true;

    await settleWithin(runner.request(), 5_000, "the pass");

    expect(w.peakConcurrency).toBe(1);
    expect(w.photos.every((p) => p.classifiedUnder)).toBe(true);
  });

  it("coalesces a toggle during a pass into one follow-up, not a second pass", async () => {
    // The re-entrancy guard. A pass is held open by a release gate, three toggles
    // land inside it, and the answer is exactly one more pass - which then runs
    // to completion under the setting that is current when it starts.
    const w = world(10);
    let open!: () => void;
    const gate = new Promise<void>((res) => { open = res; });
    const runner = runnerFor(w, gate);

    const first = runner.request();
    await new Promise((r) => setTimeout(r, 5));
    w.setting = false;
    runner.request();
    w.setting = true;
    runner.request();
    w.setting = false;
    expect(runner.passes, "three toggles during one pass started more than one pass").toBe(1);

    open();
    await settleWithin(first, 5_000, "the pass and its follow-up");

    expect(runner.passes).toBe(2);
    expect(w.peakConcurrency).toBe(1);
    expect(w.photos.every((p) => p.classifiedUnder === false)).toBe(true);
  });

  it("abandons the rest of a pass whose setting changed under it", async () => {
    // The photos a stale pass already finished were scored under a setting that
    // is no longer in force. They are not results, and the follow-up pass is
    // what redoes them: `due` re-reads and they are settled again by then.
    const w = world(10);
    let open!: () => void;
    const gate = new Promise<void>((res) => { open = res; });
    const runner = runnerFor(w, gate);

    const first = runner.request();
    await new Promise((r) => setTimeout(r, 5));
    w.setting = false;
    runner.request();
    open();
    await settleWithin(first, 5_000, "the pass and its follow-up");

    expect(runner.passes).toBe(2);
    expect(w.photos.every((p) => p.classifiedUnder === false)).toBe(true);
  });

  it("leaves alone the photos it must not touch", async () => {
    // A photo that was never classified, that failed, or that has no canvas has
    // nothing to re-fuse, and its tile already says why.
    const w = world(3);
    w.photos[0]!.error = "Classification failed: boom";
    w.photos[1]!.pending = true;
    w.photos[2]!.hasCanvas = false;
    const runner = runnerFor(w);
    w.setting = false;

    await settleWithin(runner.request(), 5_000, "the pass");

    expect(w.started).toEqual([]);
  });

  it("keeps going when one photo's classification fails", async () => {
    // A rejected promise in the queue must not strand the photos behind it:
    // `main.js`'s own `classify` catches, and the runner must not depend on it.
    const w = world(3);
    let n = 0;
    const runner = createReclassifyRunner<FakePhoto>({
      due: () => w.photos,
      currentSetting: () => w.setting,
      classify: async (p) => {
        n++;
        w.started.push(p.name);
        if (n === 2) throw new Error("inference exploded");
        p.classifiedUnder = w.setting;
        p.pending = false;
      },
    });
    w.setting = false;

    await settleWithin(runner.request(), 5_000, "the pass");

    expect(w.started).toEqual(["photo-0.jpg", "photo-1.jpg", "photo-2.jpg"]);
    expect(w.photos[2]!.classifiedUnder).toBe(false);
  });

  it("does nothing when there is nothing on screen", async () => {
    const w = world(0);
    const runner = runnerFor(w);
    w.setting = false;

    await settleWithin(runner.request(), 5_000, "the pass");

    expect(runner.passes).toBe(1);
    expect(w.started).toEqual([]);
  });
});

describe("a persisted whole-frame setting", () => {
  // The report's persistence: the value is in localStorage, so a browser that
  // froze under it booted straight back into the same configuration. What makes
  // that survivable is that an unrecognised stored value is the default rather
  // than a third state - asserted here so a future edit to the reader cannot
  // make a corrupt value into a crash.
  it("reads a stored value that is neither true nor false as the default", () => {
    for (const raw of ["", "TRUE", "1", "0", "yes", "{", "false ", "undefined"]) {
      expect(readIncludeWholeFrame({ getItem: () => raw }), `stored ${JSON.stringify(raw)}`).toBe(
        DEFAULT_INCLUDE_WHOLE_FRAME,
      );
    }
    expect(readIncludeWholeFrame({ getItem: () => "false" })).toBe(false);
    expect(readIncludeWholeFrame({ getItem: () => "true" })).toBe(true);
  });

  it("is the default when storage cannot be read at all", () => {
    const throwing = {
      getItem() {
        throw new Error("storage disabled");
      },
    };
    expect(readIncludeWholeFrame(throwing as any)).toBe(DEFAULT_INCLUDE_WHOLE_FRAME);
    expect(readIncludeWholeFrame(null)).toBe(DEFAULT_INCLUDE_WHOLE_FRAME);
  });

  it("boots into a persisted setting without running anything", async () => {
    // The reload case. Reading the preference is the whole of boot: it sets the
    // variable and the checkbox, and it re-classifies nothing, because there is
    // nothing classified yet. A build that classified on boot would make every
    // stored value a startup bill.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "src", "app", "main.js"), "utf8");
    const start = src.indexOf("function wireWholeFrameToggle");
    const fn = src.slice(start, src.indexOf("\n}", start));
    // The read happens once, before the listener is attached; the listener body
    // is the only thing that drives the pass.
    expect(fn.indexOf("readIncludeWholeFrame(")).toBeLessThan(fn.indexOf('addEventListener("change"'));
    expect(fn.match(/reclassifyRunner\.request\(\)/g)).toHaveLength(1);
  });
});
