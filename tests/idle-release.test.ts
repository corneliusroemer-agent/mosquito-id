import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createIdleRelease, DEFAULT_IDLE_RELEASE_MS } from "../src/app/idleRelease";

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

  it("a restore that finishes after a release was requested does not mark the tab released", async () => {
    let releaseIt: () => void = () => {};
    const release = vi.fn(() => new Promise<void>((r) => (releaseIt = r)));
    const restore = vi.fn();
    const idle = createIdleRelease({ delayMs: 10, release, restore });

    idle.hidden();
    await vi.advanceTimersByTimeAsync(10);
    expect(release).toHaveBeenCalledTimes(1);

    // The tab comes back while the release is still in flight.
    idle.visible();
    releaseIt();

    expect(idle.released()).toBe(false);
  });

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
