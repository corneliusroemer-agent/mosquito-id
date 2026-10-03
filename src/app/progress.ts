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

// Bytes moved so far, the total when the server sent one, and the time the
// transfer started - enough for a rate, and from a rate an ETA.
export function makeTransferProgress(label: string): (got: number, total: number, done?: boolean) => void {
  const start = performance.now();
  let lastAt = start;
  let lastGot = 0;
  // `done` bypasses the throttle: a cache hit reports completion exactly once,
  // and throttling a single sample is what left a returning user watching a
  // bar that never left 0%.
  return (got, total, done) => {
    const now = performance.now();
    if (!done && now - lastAt < 500) return;   // rate needs a window, not a sample
    const rate = done ? 0 : ((got - lastGot) / (now - lastAt)) * 1000;
    lastAt = now;
    lastGot = got;
    const known = total > 0;
    const mb = (x: number) => (x / 1048576).toFixed(0);
    let text = known ? `${label}: ${mb(got)} / ${mb(total)} MB` : label;
    if (done) {
      text += " · ready";
    } else if (rate > 0) {
      text += ` · ${mb(rate)} MB/s`;
      if (known) {
        const secs = Math.round((total - got) / rate);
        text += secs > 0 ? ` · ${secs}s left` : " · done";
      }
    }
    setProgress("model", text, known ? (100 * got) / total : null, text);
  };
}
