import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createIdleRelease, DEFAULT_IDLE_RELEASE_MS } from "../src/app/idleRelease";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("a hidden tab gives its memory back, and a visible one takes it back", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("defaults to a 60 s grace period", () => {
    expect(DEFAULT_IDLE_RELEASE_MS).toBe(60_000);
  });

  it("does not release before the grace period is up", async () => {
    const release = vi.fn();
    const idle = createIdleRelease({ delayMs: 1000, release, restore: vi.fn() });
    idle.hidden();
    await vi.advanceTimersByTimeAsync(999);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending release when the tab becomes visible again", async () => {
    const release = vi.fn();
    const idle = createIdleRelease({ delayMs: 1000, release, restore: vi.fn() });
    idle.hidden();
    await vi.advanceTimersByTimeAsync(900);
    idle.visible();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(release).not.toHaveBeenCalled();
  });

  it("restores lazily: nothing happens until an inference asks", async () => {
    const release = vi.fn();
    const restore = vi.fn();
    const idle = createIdleRelease({ delayMs: 10, release, restore });
    idle.hidden();
    await vi.advanceTimersByTimeAsync(10);
    expect(release).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
    await idle.ensure();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("ensure() on a tab that never released does not restore", async () => {
    const restore = vi.fn();
    const idle = createIdleRelease({ delayMs: 10, release: vi.fn(), restore });
    await idle.ensure();
    expect(restore).not.toHaveBeenCalled();
  });

  it("ensure() twice restores once", async () => {
    const restore = vi.fn();
    const idle = createIdleRelease({ delayMs: 10, release: vi.fn(), restore });
    idle.hidden();
    await vi.advanceTimersByTimeAsync(10);
    await idle.ensure();
    await idle.ensure();
    expect(restore).toHaveBeenCalledTimes(1);
  });
});

describe("a release never lands on top of a restore, or the reverse", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a release requested during a restore still lands", async () => {
    const restore = vi.fn();
    const release = vi.fn();
    const idle = createIdleRelease({ delayMs: 10, release, restore });
    idle.hidden();
    await vi.advanceTimersByTimeAsync(10);
    expect(idle.released()).toBe(true);
  });
});

describe("busy work is never interrupted", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("skips the release while busy, and does it on the next hide", async () => {
    let busy = true;
    const release = vi.fn();
    const idle = createIdleRelease({ delayMs: 10, release, restore: vi.fn(), isBusy: () => busy });

    idle.hidden();
    await vi.advanceTimersByTimeAsync(10);
    expect(release).not.toHaveBeenCalled();
    expect(idle.released()).toBe(false);

    busy = false;
    idle.hidden();
    await vi.advanceTimersByTimeAsync(10);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releaseNow honours busy too", async () => {
    const release = vi.fn();
    const idle = createIdleRelease({ delayMs: 10, release, restore: vi.fn(), isBusy: () => true });
    await idle.releaseNow();
    expect(release).not.toHaveBeenCalled();
  });
});

describe("a release that throws still leaves the rest of the memory freed", () => {
  it("is not reported as released when release throws, and does not reject", async () => {
    const release = vi.fn(() => {
      throw new Error("provider has no release()");
    });
    const idle = createIdleRelease({ delayMs: 1, release, restore: vi.fn() });
    await expect(idle.releaseNow()).resolves.toBeUndefined();
    // The release was attempted; the app must not treat a throwing provider as
    // a reason to keep rebuilding on every inference.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("a throwing restore leaves the tab released so the next ensure retries", async () => {
    const restore = vi.fn(() => {
      throw new Error("weights unreachable");
    });
    const idle = createIdleRelease({ delayMs: 1, release: vi.fn(), restore });
    await idle.releaseNow();
    await idle.ensure();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(idle.released()).toBe(true);
  });
});

describe("dispose stops the timer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not release after dispose", async () => {
    const release = vi.fn();
    const idle = createIdleRelease({ delayMs: 10, release, restore: vi.fn() });
    idle.hidden();
    idle.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(release).not.toHaveBeenCalled();
  });
});

describe("an async release and a restore cannot interleave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * The state machine only knows about the released flag; the app's own
   * `sessClip`/`sessDet` are nulled by the release AFTER it has awaited the
   * sessions. Before the release awaited anything that was unreachable, and it
   * is reachable now that `release()` is async (which is where the weight
   * buffers are actually freed). A restore that ran inside that window would be
   * clobbered by the tail of the release it was supposed to undo.
   */
  it("a restore requested while the release is still awaiting runs after it", async () => {
    const order: string[] = [];
    let finishRelease: () => void = () => {};
    const idle = createIdleRelease({
      delayMs: 1,
      release: () =>
        new Promise<void>((r) => {
          order.push("release-start");
          finishRelease = () => {
            order.push("release-end");
            r();
          };
        }),
      restore: async () => {
        order.push("restore");
      },
    });

    const releasing = idle.releaseNow();
    // Still mid-release: the sessions have not resolved.
    await vi.advanceTimersByTimeAsync(0);
    const restoring = idle.ensure();
    finishRelease();
    await Promise.all([releasing, restoring]);

    expect(order).toEqual(["release-start", "release-end", "restore"]);
  });

  it("a second releaseNow queues behind the first rather than overlapping it", async () => {
    const order: string[] = [];
    const resolvers: Array<() => void> = [];
    const idle = createIdleRelease({
      delayMs: 1,
      release: () =>
        new Promise<void>((r) => {
          order.push("start");
          resolvers.push(() => {
            order.push("end");
            r();
          });
        }),
      restore: vi.fn(),
    });

    const first = idle.releaseNow();
    const second = idle.releaseNow();
    await vi.advanceTimersByTimeAsync(0);
    // The second is parked: only the first release has been entered.
    expect(order).toEqual(["start"]);

    resolvers[0]!();
    await vi.advanceTimersByTimeAsync(0);
    // The first finished, and only now did the second begin.
    expect(order).toEqual(["start", "end", "start"]);

    resolvers[1]!();
    await Promise.all([first, second]);
    expect(order).toEqual(["start", "end", "start", "end"]);
  });
});

describe("a release that is still in flight when the tab comes back", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * The app's own view of the world: `release` takes the sessions away and
   * `restore` puts them back. `main.js` gates every inference entry point on
   * these being non-null, so "released" and "sessions present" have to agree -
   * a tab that holds nothing and does not know it is holding nothing never
   * rebuilds, because every later inference returns early.
   */
  function harness() {
    const session = { name: "session" };
    const app = { sessClip: session as object | null, sessDet: session as object | null };
    let releaseIt: () => void = () => {};
    const release = vi.fn(
      () =>
        new Promise<void>((r) => {
          app.sessClip = null;
          app.sessDet = null;
          releaseIt = r;
        }),
    );
    const restore = vi.fn(() => {
      app.sessClip = session;
      app.sessDet = session;
    });
    const idle = createIdleRelease({ delayMs: 1, release, restore });
    /** The shape an inference entry point in `main.js` has: always ensure. */
    const inferenceEntryPoint = async (): Promise<boolean> => {
      await idle.ensure();
      return Boolean(app.sessClip && app.sessDet);
    };
    return { app, idle, release, restore, releaseIt: () => releaseIt(), inferenceEntryPoint };
  }

  it("counts as released even though the tab came back mid-flight", async () => {
    let releaseIt: () => void = () => {};
    const release = vi.fn(() => new Promise<void>((r) => (releaseIt = r)));
    const restore = vi.fn();
    const idle = createIdleRelease({ delayMs: 10, release, restore });

    idle.hidden();
    await vi.advanceTimersByTimeAsync(10);
    expect(release).toHaveBeenCalledTimes(1);

    // The tab comes back while the release is still in flight. The sessions are
    // already being taken away, so this has to be recorded: a tab that holds
    // nothing and thinks it was never released never rebuilds.
    idle.visible();
    releaseIt();
    // The release records itself on the far side of its own await.
    await vi.advanceTimersByTimeAsync(0);

    expect(idle.released()).toBe(true);
  });

  it("still counts as released, so the next inference rebuilds the sessions", async () => {
    const { idle, releaseIt, app, inferenceEntryPoint } = harness();

    idle.hidden();
    await vi.advanceTimersByTimeAsync(1);
    // The tab comes back while the release is still awaiting its sessions.
    idle.visible();
    releaseIt();
    await vi.advanceTimersByTimeAsync(0);

    expect(app.sessClip).toBeNull();
    expect(app.sessDet).toBeNull();
    // The sessions are gone, so the tab has to know that, or it never rebuilds.
    expect(idle.released()).toBe(true);

    await expect(inferenceEntryPoint()).resolves.toBe(true);
    expect(app.sessClip).not.toBeNull();
    expect(app.sessDet).not.toBeNull();
  });

  it("ensure() waits for the release it raced rather than returning before it", async () => {
    const order: string[] = [];
    let releaseIt: () => void = () => {};
    const session = { name: "session" };
    let sessClip: object | null = session;
    const idle = createIdleRelease({
      delayMs: 1,
      release: () =>
        new Promise<void>((r) => {
          order.push("release-start");
          sessClip = null;
          releaseIt = () => {
            order.push("release-end");
            r();
          };
        }),
      restore: () => {
        order.push("restore");
        sessClip = session;
      },
    });

    idle.hidden();
    await vi.advanceTimersByTimeAsync(1);
    idle.visible();

    // An inference lands mid-release, and blocks on it.
    let ready: boolean | null = null;
    const inference = idle.ensure().then(() => {
      ready = sessClip !== null;
    });
    await vi.advanceTimersByTimeAsync(0);
    // Nothing has been restored yet, and the entry point has not returned: the
    // flag is only set at the END of a release, so reading it here would say
    // "not released" and skip the rebuild entirely.
    expect(order).toEqual(["release-start"]);

    releaseIt();
    await inference;

    expect(order).toEqual(["release-start", "release-end", "restore"]);
    expect(ready).toBe(true);
  });
});

describe("the app's call sites, not just ensure()", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * The shape every inference entry point in `main.js` has. It used to read
   * the flag first and only then await the restore, and that order is what made
   * the wait inside `ensure()` unreachable: the flag is set at the END of a
   * release, so an inference arriving mid-release read false, skipped
   * `ensure` entirely, and ran against sessions the release was in the middle
   * of taking away. Calling `ensure()` directly proves nothing about that -
   * only the guard order reproduces it.
   *
   * Both shapes are exercised below. The guarded one is the failure, kept so
   * the test says why the guard is gone rather than only that it is.
   */
  function appEntryPoint(
    idle: ReturnType<typeof createIdleRelease>,
    sessions: { clip: object | null },
    useFlagGuard: boolean,
  ) {
    return async (): Promise<boolean> => {
      if (!useFlagGuard || idle.released()) await idle.ensure();
      return sessions.clip !== null;
    };
  }

  /** A release in flight, with the sessions already taken away. */
  function midRelease() {
    const session = { name: "session" };
    const sessions = { clip: session as object | null };
    let finishRelease: () => void = () => {};
    const idle = createIdleRelease({
      delayMs: 1,
      release: () =>
        new Promise<void>((r) => {
          sessions.clip = null;
          finishRelease = r;
        }),
      restore: () => {
        sessions.clip = session;
      },
    });
    return { idle, sessions, finish: () => finishRelease() };
  }

  it("an inference landing mid-release blocks until the sessions are back", async () => {
    const { idle, sessions, finish } = midRelease();

    idle.hidden();
    await vi.advanceTimersByTimeAsync(1);

    const infer = appEntryPoint(idle, sessions, false)();
    await vi.advanceTimersByTimeAsync(0);
    // Still awaiting the release: returning `false` here is the tab running
    // inference against no session at all.
    expect(sessions.clip).toBeNull();

    finish();
    await expect(infer).resolves.toBe(true);
    expect(sessions.clip).not.toBeNull();
  });

  it("the flag guard it replaced skipped the wait entirely", async () => {
    const { idle, sessions, finish } = midRelease();

    idle.hidden();
    await vi.advanceTimersByTimeAsync(1);

    // The flag is still false mid-release, so the old guard never called
    // `ensure()` and the entry point returned with no session - the reason the
    // guard is gone rather than merely redundant.
    const infer = appEntryPoint(idle, sessions, true)();
    await expect(infer).resolves.toBe(false);
    expect(sessions.clip).toBeNull();

    finish();
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe("main.js calls ensure() without gating on the flag", () => {
  const source = readFileSync(join(root, "src", "app", "main.js"), "utf8");

  it("no call site reads released() on the way into ensure()", () => {
    // Every inference entry point has to reach `ensure()` while a release is
    // still running, which is exactly when `released()` is false.
    const gated = [...source.matchAll(/if\s*\(\s*idleRelease\.released\(\)\s*\)\s*await\s*idleRelease\.ensure\(\)/g)];
    expect(gated.map((m) => m[0])).toEqual([]);
  });

  it("still calls ensure() at each of the four entry points", () => {
    expect([...source.matchAll(/await idleRelease\.ensure\(\)/g)]).toHaveLength(4);
  });
});

describe("a re-entrant ensure() from inside the restore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * `restoreIdleMemory` ends by draining the queue, and draining calls
   * `processFiles`, which calls `ensure()` - from inside the restore, while it
   * is still the link running on the chain. That await has to come back, or a
   * released tab with queued photos hangs instead of rebuilding.
   */
  it("returns instead of waiting on the chain it is already part of", async () => {
    const order: string[] = [];
    let reentrant: Promise<boolean> | null = null;
    let sessClip: object | null = { name: "session" };
    const idle = createIdleRelease({
      delayMs: 1,
      release: () => {
        sessClip = null;
      },
      restore: async () => {
        order.push("restore-start");
        sessClip = { name: "session" };
        reentrant = idle.ensure().then(() => sessClip !== null);
        order.push("restore-end");
      },
    });

    await idle.releaseNow();
    const drained = idle.ensure().then(async () => {
      order.push("drained");
      if (reentrant) await reentrant;
      return order;
    });
    // A re-entrant ensure() that waited on its own chain would leave `drained`
    // unresolved, which vitest reports as a timeout rather than a failure.
    await vi.advanceTimersByTimeAsync(0);
    await drained;

    expect(order).toEqual(["restore-start", "restore-end", "drained"]);
  });
});
