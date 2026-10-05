/**
 * Releasing GPU and model memory while the tab is in the background.
 *
 * Several tabs of this app open at once is the normal case, not the edge case:
 * each one holds an onnxruntime session (the classifier alone is 1.26 GB of
 * weights, plus whatever the execution provider has allocated on the device) and
 * a WebGPU device. Browsers keep background tabs alive, so a laptop ends up
 * carrying all of it at once, and the tab holding the least RAM loses.
 *
 * So a hidden tab gives its memory back after a grace period, and takes it back
 * when it is needed again. Three decisions are baked in here rather than at the
 * call site, and each of them is a bug that has to not happen:
 *
 * - **The timer runs only while hidden.** Becoming visible cancels a pending
 *   release outright; a tab that flickers between windows must not pay a reload
 *   it did not need.
 * - **A release never interleaves with a restore, or the reverse.** Both are
 *   async (session teardown is not synchronous), so without ordering a slow
 *   release could land after a restore and free the sessions the restore had
 *   just rebuilt. Every release and restore runs on one serialised chain, so
 *   whichever was asked for second runs second.
 * - **Busy means no release.** A batch mid-inference is holding canvases and
 *   tensors that a release would pull out from under it. The timer still runs;
 *   if the tab goes visible again first, nothing happens, and if it goes hidden
 *   again after the batch ends, it releases then.
 *
 * Release is best-effort and never throws into the caller: a provider that
 * cannot release, or a session that is already gone, must not stop the rest from
 * being freed.
 */

export interface IdleReleaseOptions {
  /** How long a tab stays hidden before it gives its memory back. */
  delayMs?: number;
  /** Free everything expensive. Must not throw. */
  release: () => void | Promise<void>;
  /** Rebuild whatever `release` freed. Must not throw. */
  restore: () => void | Promise<void>;
  /**
   * Whether work is in flight that a release would interrupt. Read at the moment
   * the timer fires, not when the tab was hidden.
   */
  isBusy?: () => boolean;
  /** Called after a completed release, for logging. */
  onRelease?: (info: { waitedMs: number }) => void;
}

export interface IdleRelease {
  /** The document became hidden. Starts the grace period. */
  hidden(): void;
  /** The document became visible. Cancels a pending release. */
  visible(): void;
  /** True while a release or restore is running. */
  busy(): boolean;
  /** True once a release has completed and no restore has been asked for. */
  released(): boolean;
  /**
   * True when there is something for `ensure` to wait for or do: a release is
   * running, or one completed and no restore has been asked for.
   *
   * This, not `released()`, is what an inference entry point should read before
   * awaiting. `released()` is false for the whole duration of a release, so
   * gating on it skips `ensure` exactly when the wait matters. Gating on
   * nothing costs a microtask on every call, because `ensure` is async and
   * awaiting it suspends even when it returns without doing anything - which is
   * enough to let another writer of the progress slot land first and replace the
   * message the reader was waiting for.
   */
  needsEnsure(): boolean;
  /**
   * Make the expensive state exist again if it was released. Safe to call on
   * every inference: it does nothing when nothing was released.
   */
  ensure(): Promise<void>;
  /** Release now, skipping the grace period. Used by tests and by teardown. */
  releaseNow(): Promise<void>;
  /** Stop the timer and drop all state. Does not release. */
  dispose(): void;
}

export const DEFAULT_IDLE_RELEASE_MS = 60_000;

export function createIdleRelease(opts: IdleReleaseOptions): IdleRelease {
  const delayMs = opts.delayMs ?? DEFAULT_IDLE_RELEASE_MS;
  const isBusy = opts.isBusy ?? (() => false);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let hiddenAt: number | null = null;
  let isReleased = false;
  let inFlight: Promise<void> = Promise.resolve();
  // How many releases/restores are queued or running. `ensure` waits on this
  // rather than reading `isReleased`, which is only true once a release has
  // FINISHED.
  let pending = 0;
  // Bumped on every transition. Work captures the generation it was started for
  // and returns without touching anything if it no longer matches.
  let generation = 0;

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function generationOf(): number {
    return generation;
  }

  async function doRelease(waitedMs: number): Promise<void> {
    // Read AFTER the await boundary below would be too late; this read is what
    // keeps a release from starting while a batch is running.
    if (isBusy()) return;
    try {
      await opts.release();
    } catch {
      // A provider that cannot free its buffers is not a reason to keep the
      // rest. The state still says released, because the next inference will
      // rebuild through `restore` either way.
    }
    // The sessions are gone whatever the tab did while this was awaiting, so
    // this has to be recorded unconditionally. A visibility change bumps the
    // generation, and bailing out here on a stale one used to discard the
    // completion of a release that had already destroyed everything: the tab
    // was left holding no sessions and believing it had never released, so
    // every later `ensure` returned early and nothing rebuilt it. Only a
    // reload recovered. Ordering against a concurrent restore is the serialised
    // chain's job, not this flag's - a restore asked for while this release is
    // in flight is already queued behind it and will see the flag set.
    isReleased = true;
    opts.onRelease?.({ waitedMs });
  }

  function schedule(): void {
    cancelTimer();
    if (hiddenAt === null) return;
    timer = setTimeout(() => {
      timer = null;
      const waited = hiddenAt === null ? delayMs : Date.now() - hiddenAt;
      hiddenAt = null;
      const gen = generationOf();
      enqueue(() => doRelease(waited), gen);
    }, delayMs);
  }

  /**
   * Serialise every release and restore through one chain.
   *
   * The generation counter alone is not enough. It guards the STATE - whether
   * the tab counts as released - but `release` and `restore` mutate the app's
   * own state as they run: a release that is still awaiting its sessions can
   * null out `sessClip` after a restore has already rebuilt it. Once `release`
   * became async (awaiting `InferenceSession.release()`, which is where the
   * weight buffers are actually destroyed) that window opened, so all three
   * entry points queue here instead.
   */
  function enqueue(work: () => Promise<void>, gen: number): Promise<void> {
    pending++;
    const run = inFlight.then(work).then(() => {
      if (gen === generation) generation++;
    });
    // Swallow a rejection on the chain itself so one failed link cannot poison
    // every later one; `work` already contains its own error handling.
    inFlight = run.catch(() => {});
    void inFlight.finally(() => {
      pending--;
    });
    return run;
  }

  return {
    hidden(): void {
      if (hiddenAt === null) hiddenAt = Date.now();
      generation++;
      schedule();
    },
    visible(): void {
      hiddenAt = null;
      generation++;
      cancelTimer();
    },
    busy(): boolean {
      return isReleased;
    },
    released(): boolean {
      return isReleased;
    },
    needsEnsure(): boolean {
      return pending > 0 || isReleased;
    },
    async ensure(): Promise<void> {
      // Wait for a release that is already under way rather than reading
      // `isReleased` and finding it still false. The flag is set at the END of
      // the release, so an inference arriving mid-release used to see "not
      // released", skip the restore, and then run against sessions the release
      // was in the middle of taking away.
      if (pending > 0) await inFlight;
      if (!isReleased) return;
      const gen = generationOf();
      isReleased = false;
      return enqueue(async () => {
        try {
          await opts.restore();
        } catch {
          // Left released, so the next `ensure` tries again rather than the app
          // running inference against sessions that are not there.
          isReleased = true;
        }
      }, gen);
    },
    async releaseNow(): Promise<void> {
      hiddenAt = null;
      generation++;
      cancelTimer();
      return enqueue(() => doRelease(0), generationOf());
    },
    dispose(): void {
      hiddenAt = null;
      generation++;
      cancelTimer();
    },
  };
}
