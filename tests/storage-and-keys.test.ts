import { describe, it, expect, vi, afterEach } from "vitest";
import { keyEventBelongsElsewhere, describeKeyTarget, type KeyTarget } from "../src/app/keyNav";
import { readPref, writePref } from "../src/app/safeStorage";

/**
 * Two defects that share a failure shape: an exception thrown inside
 * `DOMContentLoaded` before the app has wired anything, so the page renders its
 * static shell and then does nothing.
 *
 * Both are pinned here as unit tests on the predicate and the wrapper rather
 * than as e2e, because the thing that must not regress is "this cannot throw",
 * and a test that has to arrange a real browser's private mode to prove it is a
 * test that will quietly stop testing.
 */

describe("the global key handler leaves other controls alone", () => {
  /** Stands in for `describeKeyTarget(e.target)` on a real element. */
  const el = (tagName: string, extra: Partial<KeyTarget> = {}): KeyTarget => ({
    tagName,
    isContentEditable: false,
    role: null,
    ...extra,
  });

  it("leaves a <select> its own arrows, which the old guard did not", () => {
    // The engine dropdown. A select is NOT an HTMLInputElement, so the shipped
    // guard `target instanceof HTMLInputElement` returned false for it and the
    // app took ArrowDown, ArrowUp, Home and End away from the control.
    expect(keyEventBelongsElsewhere(el("SELECT"))).toBe(true);
  });

  it("does not care about case, because Element.tagName is uppercase but need not be", () => {
    expect(keyEventBelongsElsewhere(el("select"))).toBe(true);
    expect(keyEventBelongsElsewhere(el("Select"))).toBe(true);
  });

  it("still leaves an <input> alone, which is what the old guard did", () => {
    expect(keyEventBelongsElsewhere(el("INPUT"))).toBe(true);
  });

  it("leaves a <textarea> alone", () => {
    expect(keyEventBelongsElsewhere(el("TEXTAREA"))).toBe(true);
  });

  it("does NOT exclude a <button>, because the app focuses the tile button itself", () => {
    // A button owns Enter and Space, which this handler never claims, and it does
    // not own the arrows. The handler ends every move with
    // `tileNodes.get(...)?.btn.focus()`, so the selected tile's button is where
    // focus usually IS - and excluding buttons stopped the selection dead after
    // the first keypress. Caught by `e2e/tier1/strip-feedback.spec.ts`.
    expect(keyEventBelongsElsewhere(el("BUTTON"))).toBe(false);
  });

  it("leaves a contenteditable region alone", () => {
    expect(keyEventBelongsElsewhere(el("DIV", { isContentEditable: true }))).toBe(true);
  });

  it("leaves an ARIA slider or listbox alone, for a div standing in for one", () => {
    expect(keyEventBelongsElsewhere(el("DIV", { role: "slider" }))).toBe(true);
    expect(keyEventBelongsElsewhere(el("DIV", { role: "listbox" }))).toBe(true);
    expect(keyEventBelongsElsewhere(el("DIV", { role: "combobox" }))).toBe(true);
  });

  it("still handles the keys when the page itself has focus", () => {
    // The whole point of the handler: document.body owns nothing.
    expect(keyEventBelongsElsewhere(el("BODY"))).toBe(false);
    expect(keyEventBelongsElsewhere(el("DIV", { class: "tile" } as Partial<KeyTarget>))).toBe(false);
  });

  it("handles an event whose target is not an element at all", () => {
    expect(keyEventBelongsElsewhere(null)).toBe(false);
    expect(keyEventBelongsElsewhere(undefined)).toBe(false);
  });

  it("leaves browser and OS shortcuts alone", () => {
    // Alt+Left is Back in every browser; the app swallowing it is the same bug.
    expect(keyEventBelongsElsewhere(el("BODY"), { altKey: true })).toBe(true);
    expect(keyEventBelongsElsewhere(el("BODY"), { metaKey: true })).toBe(true);
    expect(keyEventBelongsElsewhere(el("BODY"), { ctrlKey: true })).toBe(true);
  });

  it("still handles the keys when no modifier is held", () => {
    expect(keyEventBelongsElsewhere(el("BODY"), {})).toBe(false);
    expect(keyEventBelongsElsewhere(el("BODY"), { shiftKey: true } as never)).toBe(false);
  });
});

describe("describeKeyTarget narrows a real event target", () => {
  it("returns null for a target that is not an element", () => {
    expect(describeKeyTarget(null)).toBe(null);
    expect(describeKeyTarget({} as EventTarget)).toBe(null);
    expect(describeKeyTarget("a string" as unknown as EventTarget)).toBe(null);
  });

  it("reads tagName, isContentEditable and role, and nothing else", () => {
    const fake = { tagName: "SELECT", isContentEditable: false, getAttribute: (k: string) => (k === "role" ? "combobox" : null) };
    expect(describeKeyTarget(fake as unknown as EventTarget)).toEqual({
      tagName: "SELECT",
      isContentEditable: false,
      role: "combobox",
    });
  });

  it("survives a target with no getAttribute, which a bare object has", () => {
    expect(describeKeyTarget({ tagName: "DIV" } as unknown as EventTarget)).toEqual({
      tagName: "DIV",
      isContentEditable: false,
      role: null,
    });
  });

  it("round-trips: a described select is one the handler leaves alone", () => {
    // The two halves are the seam. If describeKeyTarget stopped reading tagName,
    // every test above would still pass and the app would still be broken.
    const described = describeKeyTarget({ tagName: "SELECT" } as unknown as EventTarget);
    expect(keyEventBelongsElsewhere(described)).toBe(true);
  });
});

describe("a preference that cannot be read or written is a default, not a crash", () => {
  // The node test environment has no localStorage at all, which is itself part
  // of the "absent" case below. A working store is installed per-test and torn
  // down, so nothing leaks between them.
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  /** A minimal working store: getItem/setItem/removeItem over a Map. */
  function memoryStore(): Storage {
    const m = new Map<string, string>();
    return {
      get length() { return m.size; },
      clear: () => m.clear(),
      key: (i: number) => [...m.keys()][i] ?? null,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, String(v)); },
      removeItem: (k: string) => { m.delete(k); },
    } as Storage;
  }

  function install(value: Storage | undefined) {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  function breakStorage(mode: "get" | "set" | "both" | "absent") {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        if (mode === "absent") return undefined;
        if (mode === "get" || mode === "both") throw new DOMException("blocked", "SecurityError");
        return {
          getItem: () => null,
          setItem: () => {
            if (mode === "set") throw new DOMException("quota", "QuotaExceededError");
          },
        };
      },
    });
  }

  it("readPref returns null when getItem throws", () => {
    breakStorage("get");
    expect(readPref("mosquito_engine")).toBe(null);
  });

  it("readPref returns null when localStorage itself is undefined", () => {
    // An opaque origin has no localStorage object at all, so even ACCESS throws
    // or yields undefined - `localStorage.getItem` on undefined is a TypeError.
    breakStorage("absent");
    expect(readPref("mosquito_pooling")).toBe(null);
  });

  it("readPref still reads when storage works", () => {
    const store = memoryStore();
    store.setItem("mosquito_engine", "webgpu-culico");
    install(store);
    expect(readPref("mosquito_engine")).toBe("webgpu-culico");
    expect(readPref("never-set")).toBe(null);
  });

  it("writePref reports false instead of throwing when setItem throws", () => {
    // Safari private browsing: quota exceeded on the very first write.
    breakStorage("set");
    expect(writePref("mosquito_pooling", "Dependent evidence")).toBe(false);
  });

  it("writePref reports true when it sticks", () => {
    install(memoryStore());
    expect(writePref("mosquito_corr", "0.35")).toBe(true);
    expect(readPref("mosquito_corr")).toBe("0.35");
  });

  it("writePref reports false when there is no storage object at all", () => {
    install(undefined);
    expect(writePref("k", "v")).toBe(false);
  });

  it("neither wrapper throws, whatever storage does", () => {
    // The property under test is not a value: it is that nothing in this module
    // can propagate an exception into DOMContentLoaded.
    for (const mode of ["get", "set", "both", "absent"] as const) {
      breakStorage(mode);
      expect(() => readPref("k")).not.toThrow();
      expect(() => writePref("k", "v")).not.toThrow();
    }
  });
});
