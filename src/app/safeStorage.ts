/**
 * `localStorage`, which throws rather than returning null in more situations
 * than people expect.
 *
 * The failure is not exotic. Safari in private browsing throws a quota
 * `SecurityError` on `setItem`. A browser with site data blocked for the origin
 * throws on `getItem`. Firefox with cookies-and-site-data cleared throws on
 * both. And `localStorage` can throw at ACCESS time, not only at write time, if
 * the origin is opaque.
 *
 * The app read three preferences at startup with bare `localStorage.getItem`.
 * A throw in any of them propagates out of `DOMContentLoaded`, so everything
 * after that line in the initialiser never runs: no engine load, no event
 * wiring, no thumbnails. The page renders its static shell and then does
 * nothing, with no error the user can see - the same shape as the "clicking
 * goes nowhere" class of bug this app has been fighting.
 *
 * The rule is that a preference is a preference: failing to read one means the
 * default, and failing to write one means the setting does not persist. Neither
 * is worth an exception, so both are absorbed here rather than at 40 call sites.
 */

/** Reads a preference, or null when storage is unavailable or the read throws. */
export function readPref(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    // Storage is unavailable: no preference was ever set, so there is nothing
    // to restore and the caller's default stands.
    return null;
  }
}

/**
 * Writes a preference, reporting whether it stuck.
 *
 * Returns false rather than throwing, because the caller usually has a fallback
 * it would rather use than an error: `poolingMethod` falls back to the shipped
 * default, and a UI control that cannot persist is still perfectly usable for
 * the session.
 */
export function writePref(key: string, value: string): boolean {
  try {
    const store = globalThis.localStorage;
    // The store can be ABSENT rather than throwing - an opaque origin has no
    // `localStorage` at all. Optional chaining would make the call a silent
    // no-op and still report success, which is worse than reporting failure:
    // the caller would believe a preference is persisted when it is not.
    if (!store) return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
