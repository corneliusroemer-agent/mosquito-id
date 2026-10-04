/**
 * The one pass that re-classifies photos already on screen.
 *
 * Unchecking the whole-frame view has to re-run inference over every photo
 * already classified, because a verdict fused from two views does not describe
 * a one-view setting. The batch path runs its inference serially - one photo at
 * a time - because onnxruntime-web occupies the main thread for the length of a
 * run. This path used to start every photo at once, which put ten concurrent
 * runs on one session.
 *
 * So the scheduling lives here rather than in `main.js`: the thing that has to
 * be right is "one run at a time, and a toggle during a pass produces exactly
 * one more pass", and that is checkable here without a 1.26 GB model, a browser
 * or the rest of the app.
 */

/** What one pass has to do. All of it is injected, so nothing here needs a DOM. */
export interface ReclassifyRunnerOptions<T> {
  /**
   * The photos to re-classify, in order, read fresh at the start of every pass.
   * A photo that has already been re-run in this pass is `pending` again and
   * drops out, so a follow-up pass picks up only what the abandoned one left.
   */
  due: () => T[];
  /**
   * Classify one photo to completion. Must settle even when the work is dropped:
   * a rejected promise here stalls the pass, and every photo behind it in the
   * queue with it.
   */
  classify: (photo: T) => Promise<void>;
  /**
   * The setting as it stands right now.
   *
   * Read before the pass and after every photo: a toggle that lands mid-pass
   * changes it, and the photos that pass already finished were scored under the
   * old one. Those are not results, and leaving them standing is the exact
   * disagreement the toggle exists to prevent.
   */
  currentSetting: () => boolean;
  /** Runs after a pass and every follow-up it triggered have settled. */
  onSettled?: () => void;
  /**
   * A photo whose classification rejected. Called instead of letting the
   * rejection end the pass, because the photos behind it in the queue would then
   * never be re-classified at all and the page would be left under a setting the
   * user chose and nothing reflecting it.
   */
  onPhotoFailed?: (photo: T, err: unknown) => void;
}

export interface ReclassifyRunner {
  /**
   * Run a pass, or - if one is already running - ask for exactly one more and
   * return the same promise. Returns when everything it started has settled.
   */
  request(): Promise<void>;
  /** Passes started so far. One per toggle, plus one per toggle that landed mid-pass. */
  readonly passes: number;
  readonly inFlight: boolean;
}

/**
 * A serial, re-entrancy-safe pass runner.
 *
 * Two invariants, and the freeze was a violation of the first:
 *
 * 1. **One classification at a time.** Photos are awaited in order, so the pass
 *    holds the single inference slot the rest of the app assumes it holds.
 * 2. **One pass per toggle.** A toggle during a pass sets a flag rather than
 *    starting a second pass beside it, and the flag is consumed by a follow-up
 *    that starts from the current setting. Several toggles during one pass
 *    coalesce into that single follow-up.
 */
export function createReclassifyRunner<T>(opts: ReclassifyRunnerOptions<T>): ReclassifyRunner {
  let tail: Promise<void> = Promise.resolve();
  let inFlight = false;
  let queued = false;
  let passes = 0;

  async function runPass(): Promise<void> {
    const setting = opts.currentSetting();
    for (const photo of opts.due()) {
      try {
        await opts.classify(photo);
      } catch (err) {
        opts.onPhotoFailed?.(photo, err);
      }
      if (opts.currentSetting() !== setting) return;
    }
  }

  function request(): Promise<void> {
    if (inFlight) {
      queued = true;
      return tail;
    }
    inFlight = true;
    tail = (async () => {
      try {
        do {
          queued = false;
          passes++;
          await runPass();
        } while (queued);
      } finally {
        inFlight = false;
      }
      opts.onSettled?.();
    })();
    return tail;
  }

  return {
    request,
    get passes() {
      return passes;
    },
    get inFlight() {
      return inFlight;
    },
  };
}
