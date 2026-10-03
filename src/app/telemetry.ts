/**
 * Client-side event log.
 *
 * Every event carries the engine in use and the photo on screen, which are the
 * two things that make a log line interpretable after the fact; both are read
 * from app state at the moment the event fires, so they describe what was
 * happening rather than what was true at load.
 *
 * The state is supplied as thunks rather than values so the binding stays live:
 * the engine can be switched and the selection can move between two events, and
 * a snapshot taken once at construction would report the wrong one.
 */

/** The app state an event is stamped with. Read at call time, never cached. */
export interface LogContext {
  /** Which inference engine is currently selected. */
  engine: () => string;
  /** The file name of the photo on screen, or null if there is none. */
  photo: () => string | null;
  /** Whether this deployment has an /api/log endpoint to POST to. */
  serverAvailable: () => boolean;
}

/** Anything serialisable a caller wants to attach to an event. */
export type LogData = Record<string, unknown>;

/**
 * Build the log function bound to one context.
 *
 * A factory rather than a context argument on every call: there are more than
 * thirty call sites, all of which care about the action and the data and none of
 * which should have to restate which engine is loaded.
 */
export function createLogger(ctx: LogContext): (action: string, data?: LogData) => void {
  return function sendLog(action: string, data: LogData = {}): void {
    const payload = {
      action,
      engine: ctx.engine(),
      photo: ctx.photo(),
      timestamp: new Date().toISOString(),
      ...data
    };
    console.log(`[CLIENT LOG] ${action}:`, payload);
    // Only the Cloud GPU deployment has an /api/log endpoint. Posting to it from
    // the static site just produces a failed request, which the browser reports as
    // a console error no matter how the promise is handled.
    if (!ctx.serverAvailable()) return;
    fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(() => { /* telemetry must never surface an error to the user */ });
  };
}
