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

/** The bound logger, as a module that only needs to call one accepts it. */
export type LogFn = (action: string, data?: LogData) => void;

/**
 * Build the log function bound to one context.
 *
 * A factory rather than a context argument on every call: there are more than
 * thirty call sites, all of which care about the action and the data and none of
 * which should have to restate which engine is loaded.
 */
/**
 * An explicit diagnostic sink, read once from `?log=`.
 *
 * Absent on the deployed site: the cost of a wrong guess here is a failed
 * request per log line, which is the noise this whole path exists to remove.
 */
function diagnosticSink(): string | null {
  try {
    const v = new URLSearchParams(location.search).get("log");
    return v && /^https?:\/\//.test(v) ? v.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

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
    // Where the payload goes. The Cloud GPU deployment serves /api/log; the
    // static Pages deploy serves neither, and posting there is the /api/health
    // 404 in the console. A diagnostic sink can be pointed at with
    // ?log=<origin> so a local run reports into a file instead of nowhere.
    const sink = diagnosticSink();
    if (sink) {
      fetch(`${sink}/api/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        mode: "cors",
      }).catch(() => {});
      return;
    }
    if (!ctx.serverAvailable()) return;
    fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(() => { /* telemetry must never surface an error to the user */ });
  };
}
