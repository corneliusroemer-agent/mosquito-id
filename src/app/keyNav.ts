/**
 * Deciding whether a key event belongs to the app or to whatever the user is
 * actually focused on.
 *
 * The app has one global arrow/Home/End handler that walks the photo selection,
 * which is right for the common case - the page has focus, the user presses
 * Right, the selection moves. It was guarded by a single check,
 * `e.target instanceof HTMLInputElement`, and that guard is a list of one.
 *
 * A `<select>` is not an `HTMLInputElement`. So with the engine dropdown
 * focused, ArrowDown and ArrowUp changed the ENGINE instead of moving through
 * the dropdown's options, and ArrowLeft/ArrowRight changed the photo selection.
 * Home and End did the same: on a dropdown they are the keys that jump to the
 * first and last option. Nothing about that is recoverable, because the
 * selection the user sees afterwards has nothing to do with the control they
 * were using.
 *
 * The rule is therefore about the TARGET, not the key: the handler owns an event
 * only when the user is not typing into, or operating, some other control.
 */

/**
 * What this module needs to know about an event target, and nothing else.
 *
 * A structural parameter rather than an `EventTarget`, for the same reason
 * `readIncludeWholeFrame` takes a `PreferenceStore`: the unit suite runs in a
 * node environment with no DOM, so a function that reached for `instanceof
 * Element` could only be tested in a browser. The caller in `main.js` does the
 * narrowing, and it is three property reads.
 */
export interface KeyTarget {
  /** Uppercase, as `Element.tagName` is. */
  tagName: string;
  isContentEditable?: boolean;
  role?: string | null;
}

/**
 * Elements that own their own arrow, Home and End keys.
 *
 * `BUTTON` is deliberately absent. A button owns Enter and Space, which this
 * handler never claimed, and it does not own the arrows - and the app's own
 * handler FOCUSES the selected tile's button after every move, so excluding
 * buttons would stop the selection dead after the first keypress. That is not
 * hypothetical: `e2e/tier1/strip-feedback.spec.ts` ("focus follows the
 * selection when the keyboard moves it") caught it.
 */
const KEY_OWNERS = new Set(["INPUT", "SELECT", "TEXTAREA", "OPTION"]);

/**
 * Roles that stand in for a control. `div[role=slider]` and friends behave like
 * the native element without being one, and `getAttribute` returns null rather
 * than undefined, so the caller may pass either.
 */
const KEY_OWNER_ROLES = new Set(["slider", "listbox", "combobox", "spinbutton", "menu"]);

export interface KeyModifiers {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * True when the app's global key handler should ignore this event.
 *
 * `target` is null when the event did not come from an element — the document
 * itself, or a target in a different document. That is treated as "nothing else
 * owns it", which is the behaviour the app has always had.
 *
 * A modifier counts as the user driving a browser or OS shortcut rather than the
 * app: Alt+Left is Back in every browser, and swallowing it is the same class of
 * bug as swallowing a dropdown's arrows.
 */
export function keyEventBelongsElsewhere(
  target: KeyTarget | null | undefined,
  modifiers?: KeyModifiers,
): boolean {
  if (modifiers?.ctrlKey || modifiers?.metaKey || modifiers?.altKey) return true;
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (KEY_OWNERS.has(target.tagName.toUpperCase())) return true;
  return KEY_OWNER_ROLES.has(target.role ?? "");
}

/**
 * Narrow a real event target to what `keyEventBelongsElsewhere` needs.
 *
 * Kept beside the predicate so the unit suite never has to construct a DOM: the
 * property reads are the part that could be wrong (a lowercase tag, a null role),
 * and this is where they happen.
 */
export function describeKeyTarget(target: EventTarget | null): KeyTarget | null {
  const el = target as Partial<Element> | null;
  if (!el || typeof el.tagName !== "string") return null;
  return {
    tagName: el.tagName,
    isContentEditable: Boolean((el as HTMLElement).isContentEditable),
    role: typeof el.getAttribute === "function" ? el.getAttribute("role") : null,
  };
}
