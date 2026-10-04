/**
 * The one progress slot every long operation draws into.
 *
 * #progress-slot is in the DOM from first paint at a constant height, so the
 * only things that change here are its visibility, the message and the bar.
 * Model loading, photo processing and the sample fetch all draw here rather than
 * each owning a box that had to be shown and hidden - a box appearing or
 * disappearing is what pushed the rest of the page around, and what the zero
 * Cumulative LayoutShift the app measures depends on.
 *
 * OWNERSHIP is the whole reason this is one module. Model loading and batch
 * processing overlap in time, and whoever finishes last must not clear the other's
 * bar, so every write records an owner and a clear is ignored unless it names
 * the current one.
 *
 * Depends on nothing: it reads the DOM by id and keeps its own single variable.
 */

/** Which long operation currently owns the slot. */
export type ProgressOwner = "model" | "batch" | "samples";

// ---- Shared progress slot ----
// #progress-slot is in the DOM from first paint at a constant height, so these
// are the only things that change: its visibility, the message, the bar. Model
// loading and photo processing both draw here rather than each owning a box
// that had to be hidden and shown - a box appearing or disappearing is what
// pushed the rest of the page around. Ownership keeps a late model-load
// completion from clearing a batch that is still running.
let progressOwner: ProgressOwner | null = null;

// `text` is deliberately ignored. Progress is shown by the bar alone: a
// sentence describing what the app is currently doing is not information about
// the photo, and it was asked to go. Only a failure is worth a sentence, and
// that goes through setProgressError.
//
// `meter` is the exception, and it is not a sentence: it is the transfer
// measurement - bytes arrived and time remaining - which is the number the user
// needs to decide whether to wait. It goes to its own element so that no
// caller can turn the slot back into a status line by accident.
export function setProgress(owner: ProgressOwner, text: string | null, pct: number | null | undefined, meter?: string | null): void {
  const slot = document.getElementById("progress-slot");
  if (!slot) return;
  progressOwner = owner;
  const msg = document.getElementById("progress-msg");
  const meterEl = document.getElementById("progress-meter");
  const fill = document.getElementById("progress-fill");
  if (msg) msg.textContent = "";
  if (meterEl) meterEl.textContent = meter || "";
  if (fill) {
    slot.classList.toggle("indeterminate", pct === null || pct === undefined);
    fill.style.width = `${Math.max(0, Math.min(100, pct || 0))}%`;
  }
  slot.style.visibility = "visible";
  // getElementById can only promise HTMLElement; this id is a <button> in
  // index.html, and `disabled` is what the caller is asserting about.
  const cancel = document.getElementById("btn-cancel-batch") as HTMLButtonElement | null;
  if (cancel) cancel.disabled = owner !== "batch";
}

// A failure is worth a sentence: unlike "loading" it describes something the
// user has to act on.
export function setProgressError(text: string): void {
  const msg = document.getElementById("progress-msg");
  if (msg) msg.textContent = text;
}

export function clearProgress(owner?: ProgressOwner): void {
  if (owner !== undefined && owner !== progressOwner) return;
  const slot = document.getElementById("progress-slot");
  if (!slot) return;
  progressOwner = null;
  slot.style.visibility = "hidden";
  slot.classList.remove("indeterminate");
  const fill = document.getElementById("progress-fill");
  if (fill) fill.style.width = "0%";
  const meterEl = document.getElementById("progress-meter");
  if (meterEl) meterEl.textContent = "";
  // getElementById can only promise HTMLElement; this id is a <button> in
  // index.html, and `disabled` is what the caller is asserting about.
  const cancel = document.getElementById("btn-cancel-batch") as HTMLButtonElement | null;
  if (cancel) { cancel.disabled = true; cancel.onclick = null; }
}

// ---- The model load as one bar ----
// A model is not loaded when its last byte arrives. `InferenceSession.create`
// then still has to parse the graph, compile the WASM and upload the weights -
// measured at 1.7 s for the 10.6 MB detector and several seconds for the 1.2 GB
// classifier - and until it returns, `window.modelsReady` is false and nothing
// can be classified.
//
// A bar that reads 100% through that window says "done" about work that has not
// happened, and the user cannot tell those seconds from a hang. So the bar is
// the WHOLE load rather than the byte count: the bytes own the first
// `DOWNLOAD_SHARE` of it, and the last slice is earned by the session actually
// becoming usable. 100% means an inference can run, which is the only claim
// worth making.

/** The share of the bar the downloaded bytes may fill. The rest is session setup. */
const DOWNLOAD_SHARE = 90;

/** One thing the load has to get through, in the order it happens. */
export interface LoadStep {
  key: string;
  /** The step's bytes, when it is a download. Omitted for a session step. */
  bytes?: number;
}

interface PlacedStep extends LoadStep {
  startPct: number;
  endPct: number;
  bytes: number;
}

let loadSteps: PlacedStep[] = [];
let loadTotalBytes = 0;
// Highest fraction reached, so a step reporting out of order cannot walk the bar
// backwards. A reset to a lower number reads as a glitch, not as progress.
let loadFloor = 0;
let loadGeneration = 0;

const stepByKey = (key: string): PlacedStep | undefined => loadSteps.find((s) => s.key === key);

/**
 * Declare the load, so the bar can be a single advance rather than a restart per
 * file.
 *
 * `steps` must be the steps this load will actually perform, in order: a model
 * already in `clipSessions` contributes none, and listing it anyway would leave
 * the bar short of 100% forever. Byte steps are weighted by their declared size,
 * which is what makes a 10.6 MB detector visible against a 1.2 GB classifier
 * instead of each drawing its own 0-100%.
 */
export function beginModelLoad(steps: LoadStep[]): void {
  const downloadSteps = steps.filter((s) => (s.bytes ?? 0) > 0);
  const sessionSteps = steps.length - downloadSteps.length;
  loadTotalBytes = downloadSteps.reduce((n, s) => n + (s.bytes ?? 0), 0);
  // With no declared bytes to weigh them by, byte steps share the download
  // portion equally rather than being dropped.
  const bytePortion = downloadSteps.length ? DOWNLOAD_SHARE / downloadSteps.length : 0;
  const sessionPortion = sessionSteps ? (100 - DOWNLOAD_SHARE) / sessionSteps : 0;
  loadSteps = [];
  // Bumped by every `beginModelLoad`. A byte reporter captures the value it was
  // handed and ignores itself once it no longer matches, which is what stops a
  // SUPERSEDED load's still-open reader from driving the new load's bar: an
  // engine switch re-enters `loadWebGPUModels` without cancelling the previous
  // fetch, and both then share the keys "detector" and "classifier".
  loadGeneration++;
  let pct = 0;
  steps.forEach((step, i) => {
    const bytes = step.bytes ?? 0;
    const span = bytes > 0
      ? (loadTotalBytes > 0 ? DOWNLOAD_SHARE * (bytes / loadTotalBytes) : bytePortion)
      : sessionPortion;
    const end = i === steps.length - 1 ? 100 : pct + span;
    loadSteps.push({ ...step, bytes, startPct: pct, endPct: end });
    pct = end;
  });
  loadFloor = 0;
  setProgress("model", null, 0);
}

/**
 * The byte reporter for one step of the current load.
 *
 * Reports the load's overall position, not this file's: the bar advances once
 * across the whole load instead of drawing 0-100% three times.
 */
export function loadStepProgress(key: string, label: string): (got: number, total: number, done?: boolean) => void {
  const start = performance.now();
  let lastAt = start;
  let lastGot = 0;
  // `done` bypasses the throttle: a cache hit reports completion exactly once,
  // and throttling a single sample is what left a returning user watching a
  // bar that never left 0%.
  const generation = loadGeneration;
  return (got, total, done) => {
    // A superseded load owns nothing. `loadWebGPUModels` is re-entered on an
    // engine switch without cancelling the previous fetch, so the old call's
    // reader keeps delivering chunks under the SAME step keys - reporting them
    // would drive the new load's bar to 100% on bytes the new load never
    // fetched, and resurrect a slot that has already been hidden.
    if (generation !== loadGeneration || !loadSteps.length) return;
    const now = performance.now();
    if (!done && now - lastAt < 500) return;   // rate needs a window, not a sample
    const rate = done ? 0 : ((got - lastGot) / (now - lastAt)) * 1000;
    lastAt = now;
    lastGot = got;
    const known = total > 0;
    // A cache hit reports its stored size and the network reports Content-Length;
    // either way the declared size is the denominator that keeps the step's
    // weight equal to the share it was allotted.
    const step = stepByKey(key);
    const span = step ? step.endPct - step.startPct : 0;
    const fraction = known ? Math.min(1, got / total) : done ? 1 : 0;
    const mb = (x: number) => (x / 1048576).toFixed(0);
    let text = known ? `${label}: ${mb(got)} / ${mb(total)} MB` : label;
    // Nothing is appended on completion. It used to say "ready", which was the
    // lie this module exists to remove: the bytes were ready, the session was
    // not, and the bar's own last slice is what now reports the difference.
    if (!done && rate > 0) {
      text += ` · ${mb(rate)} MB/s`;
      if (known) {
        const secs = Math.round((total - got) / rate);
        text += secs > 0 ? ` · ${secs}s left` : " · done";
      }
    }
    loadFloor = Math.max(loadFloor, step ? step.startPct + span * fraction : 0);
    setProgress("model", text, loadFloor, text);
  };
}

/**
 * Record that a session step finished, so the bar can advance past the bytes.
 *
 * Called when an `InferenceSession` exists and can serve an inference - not when
 * its file arrived.
 */
export function completeLoadStep(key: string, meter?: string): void {
  const step = stepByKey(key);
  if (!step) return;
  loadFloor = Math.max(loadFloor, step.endPct);
  setProgress("model", null, loadFloor, meter ?? null);
}
