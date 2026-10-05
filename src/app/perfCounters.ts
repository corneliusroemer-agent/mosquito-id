/**
 * Structural counters: how much work the app actually did, as numbers a test can
 * assert on.
 *
 * None of these are timings. A timing assertion on a shared, loaded box with a
 * stubbed model is unfalsifiable - it passes on a good day and fails on a bad one
 * for reasons that have nothing to do with the code. A COUNT is different: it is
 * the same on every machine, and every one of these is a claim about how much
 * work a path does rather than how long it takes, which is exactly the claim that
 * silently regresses. A double classification, a render that reads layout after
 * writing, and a cache that stopped bounding itself are all invisible in a
 * screenshot and unmissable in a counter.
 *
 * Two rules the counters are built to keep:
 *
 * - **A counter is counted at the operation, not at its caller.** `classifierCalls`
 *   is incremented where a session is actually run, so a new call site cannot
 *   bypass it the way a counter placed on one function's callers can.
 * - **Nothing here changes what the app does.** The layout probe patches the DOM
 *   only while it is armed (`armLayoutCounters`), which nothing in the app does,
 *   so an unarmed page runs exactly the code it ran before this module existed.
 *
 * The live gauges (full-resolution frames, ORT sessions) are REGISTERED by
 * `main.js` rather than read here, because the state they report is app state and
 * this module has no business reaching into it.
 */

/**
 * How many full-resolution frames may be live at once.
 *
 * A count of frames, not bytes: the photographs behind them differ by an order of
 * magnitude and the bound that matters is what is resident. The retention work
 * (`fix/drop-fullres-canvas`) owns the cache that enforces this; until that branch
 * is merged nothing in the app bounds it, which is what counter 4 reports.
 *
 * ONCE THAT BRANCH LANDS, this constant must be deleted here and the registration
 * in `main.js` pointed at `FULL_RES_CACHE_FRAMES` from `./fullResSource`. Two
 * copies of the bound is exactly the kind of duplication that lets the real one
 * move and this one not.
 */
export const FULL_RES_CACHE_FRAMES = 2;

/**
 * Longest edge past which a retained canvas is a full-resolution frame rather
 * than a display copy.
 *
 * The same 2048 the retention branch caps display canvases at. Below it, a canvas
 * is smaller than any panel paints and holds nothing a render needs again.
 */
export const FULL_RES_MIN_EDGE = 2048;

export type CounterName =
  | "classifierCalls"
  | "detectorCalls"
  | "serverViewCalls"
  | "renders";

interface Counters {
  classifierCalls: number;
  detectorCalls: number;
  serverViewCalls: number;
  renders: number;
}

function zeroCounters(): Counters {
  return { classifierCalls: 0, detectorCalls: 0, serverViewCalls: 0, renders: 0 };
}

const counters: Counters = zeroCounters();

// ---- Whole-image read probe ----

/**
 * `drawImage` calls whose SOURCE area was at least this many pixels, counted
 * while the probe is armed.
 *
 * A source area, not a destination area and not an elapsed time: what costs a
 * photograph is how much of it a step reads. The detector's 640 px letterbox and
 * a crop cut are both `drawImage`, and only the source area tells them apart.
 */
let wholeImageMinSourceArea = 0;

/** Every whole-image read since the last reset, and the threshold it used. */
const wholeImageReads = { total: 0, minSourceArea: 0, byCaller: new Map<string, number>() };

/**
 * Count the `drawImage` calls that read a whole photograph.
 *
 * Only the tests arm this. The app never does, so a shipped page carries no
 * patched canvas method and pays nothing for the counting - the same bargain
 * `armLayoutCounters` makes.
 *
 * Idempotent, like that one: arming an armed probe only moves the threshold,
 * because a second patch would double every count.
 */
export function armWholeImageReads(minSourceArea: number): void {
  if (typeof CanvasRenderingContext2D === "undefined") return;
  wholeImageMinSourceArea = minSourceArea;
  wholeImageReads.minSourceArea = minSourceArea;
  if (drawImagePatched) return;
  drawImagePatched = true;

  const original = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (
    this: CanvasRenderingContext2D,
    ...args: unknown[]
  ): void {
    const area = sourceAreaOf(args);
    // Counted BEFORE the call, and only for a call that is going to happen: a
    // drawImage that throws has read nothing.
    if (area >= wholeImageMinSourceArea) {
      wholeImageReads.total++;
      const where = describeWholeImageRead(args);
      wholeImageReads.byCaller.set(where, (wholeImageReads.byCaller.get(where) ?? 0) + 1);
    }
    (original as (...a: unknown[]) => void).apply(this, args);
  };
  restoresDrawImage.push(() => {
    CanvasRenderingContext2D.prototype.drawImage = original;
  });
}

/** Undo `armWholeImageReads`. A page that was never armed is left alone. */
export function disarmWholeImageReads(): void {
  if (!drawImagePatched) return;
  drawImagePatched = false;
  wholeImageMinSourceArea = 0;
  for (const restore of restoresDrawImage.splice(0).reverse()) restore();
}

let drawImagePatched = false;
const restoresDrawImage: Array<() => void> = [];

/**
 * The area of the SOURCE rectangle a `drawImage` reads, or 0 when it cannot be
 * told.
 *
 * Three forms, per the HTML spec: 3 and 5 arguments read the whole image, and 9
 * read the named sub-rectangle. An image with no `width`/`height` - a video
 * element mid-load, an `ImageData` - cannot be measured and reports 0, which
 * never clears a positive threshold. That is the safe direction: an unmeasurable
 * read is not claimed to be a whole-image one.
 */
function sourceAreaOf(args: unknown[]): number {
  const image = args[0] as { width?: number; height?: number } | null | undefined;
  if (!image) return 0;
  if (args.length >= 9) {
    const sw = Number(args[3]);
    const sh = Number(args[4]);
    if (!Number.isFinite(sw) || !Number.isFinite(sh)) return 0;
    return Math.abs(sw * sh);
  }
  const w = Number(image.width);
  const h = Number(image.height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return 0;
  return Math.abs(w * h);
}

/**
 * What a whole-image read was, in enough detail to name the line that made it.
 *
 * The source's constructor plus its dimensions, because that is what
 * distinguishes the four reads of one photograph: the full-resolution frame it
 * was copied into, the display copy, the detector's letterbox. A count with no
 * breakdown says how many and not which, which is the number a reader cannot
 * act on.
 */
function describeWholeImageRead(args: unknown[]): string {
  const image = args[0] as { width?: number; height?: number; constructor?: { name?: string } } | null;
  if (!image) return "unknown";
  const kind = image.constructor?.name ?? "unknown";
  const w = Number.isFinite(image.width) ? image.width : "?";
  const h = Number.isFinite(image.height) ? image.height : "?";
  const sub = args.length >= 9 ? ` sub ${args[3]}x${args[4]}` : "";
  return `${kind} ${w}x${h}${sub}`;
}

/** Layout-forcing reads seen inside a render, and the worst single render. */
const layouts = { total: 0, worstRender: 0, byRender: new Map<string, number>() };

/** How many render scopes are open. A read counts only while this is > 0. */
let renderDepth = 0;

/** Layout reads charged to the scope currently open, innermost last. */
const readStack: number[] = [];

/**
 * How many full-resolution frames the app currently holds, or null when nothing
 * has registered a source. Registered by `main.js`.
 */
let fullResSource: (() => number) | null = null;

/** ORT sessions the app currently holds, or null when nothing registered. */
let ortSessionSource: (() => number) | null = null;

// ---- Operation counters ----

/** One run of the classifier session. Counted where the session is run. */
export function noteClassifierCall(): void {
  counters.classifierCalls++;
}

/** One run of the detector session. */
export function noteDetectorCall(): void {
  counters.detectorCalls++;
}

/** One `/api/predict` view request. The server path's analogue of a classifier call. */
export function noteServerViewCall(): void {
  counters.serverViewCalls++;
}

/**
 * A layout-forcing read that happened inside a render.
 *
 * Called by the probe, which is only installed while armed. A read outside every
 * render scope is not counted: the claim these counters make is about reads
 * inside a write batch, and a read on its own - a measurement, a scroll into view
 * from an event handler - is not one.
 */
export function noteForcedLayout(): void {
  if (renderDepth <= 0) return;
  const top = readStack.length - 1;
  if (top >= 0) readStack[top] = readStack[top]! + 1;
  layouts.total++;
}

/**
 * Run `fn` as a render, charging the layout reads inside it to this render.
 *
 * Scopes nest, because a render is not always the outermost thing: the batch loop
 * renders between two photos' inferences, and `renderActivePhoto` can be reached
 * from inside a strip render's handler. Reads are charged to the innermost open
 * scope, which is the one whose code did the reading.
 */
export function withRenderScope<T>(name: string, fn: () => T): T {
  readStack.push(0);
  renderDepth++;
  try {
    return fn();
  } finally {
    renderDepth--;
    const reads = readStack.pop() ?? 0;
    layouts.byRender.set(name, reads);
    if (reads > layouts.worstRender) layouts.worstRender = reads;
  }
}

// ---- Live gauges ----

/**
 * Register where the app's live full-resolution frames can be counted.
 *
 * A provider rather than a read of app state, because this module holds no
 * reference to the gallery and the counting rule (what counts as full
 * resolution) belongs to whoever owns the frames.
 *
 * `null` unregisters. The gauges are module-level state, so a test that
 * registers one leaks it to every later test in the process - and a leaked
 * provider makes "reports null before anything registered" pass or fail
 * depending on which file ran first.
 */
export function registerFullResSource(fn: (() => number) | null): void {
  fullResSource = fn;
}

export function registerOrtSessionSource(fn: (() => number) | null): void {
  ortSessionSource = fn;
}

/**
 * Full-resolution frames live right now, or null when no source is registered.
 *
 * Null rather than 0 for "unknown": a page with nothing registered has not been
 * measured, and reporting that as zero would make the bound pass for the wrong
 * reason.
 */
export function liveFullResFrames(): number | null {
  return fullResSource ? fullResSource() : null;
}

/**
 * ORT sessions the app holds right now, or null when no source is registered.
 *
 * Counted as the sessions that are actually reachable - every entry in the
 * per-engine cache, plus the bound detector session, de-duplicated by identity.
 * A session still pointed at by `sessClip` after the cache was emptied is a live
 * session even though the cache says the count is zero, and that is the case this
 * is here to see.
 */
export function liveOrtSessions(): number | null {
  return ortSessionSource ? ortSessionSource() : null;
}

// ---- Reads ----

export interface PerfSnapshot {
  classifierCalls: number;
  detectorCalls: number;
  serverViewCalls: number;
  renders: number;
  forcedLayouts: number;
  /** The most layout-forcing reads any single render scope has made. */
  worstRenderLayouts: number;
  /** Layout reads per named render, from the last time each ran. */
  layoutsByRender: Record<string, number>;
  /** Whole-image `drawImage` reads since the last reset. See `armWholeImageReads`. */
  wholeImageReads: number;
  /** What each whole-image read was, so a count can be acted on. */
  wholeImageReadsBySource: Record<string, number>;
  /** The source-area threshold the probe was armed with. */
  wholeImageMinSourceArea: number;
  fullResFrames: number | null;
  ortSessions: number | null;
}

export function snapshot(): PerfSnapshot {
  return {
    ...counters,
    forcedLayouts: layouts.total,
    worstRenderLayouts: layouts.worstRender,
    layoutsByRender: Object.fromEntries(layouts.byRender),
    wholeImageReads: wholeImageReads.total,
    wholeImageReadsBySource: Object.fromEntries(wholeImageReads.byCaller),
    wholeImageMinSourceArea: wholeImageReads.minSourceArea,
    fullResFrames: liveFullResFrames(),
    ortSessions: liveOrtSessions(),
  };
}

/** Zero every count. Gauges are re-read from their sources and are not touched. */
export function resetCounters(): void {
  Object.assign(counters, zeroCounters());
  layouts.total = 0;
  layouts.worstRender = 0;
  layouts.byRender.clear();
  readStack.length = 0;
  renderDepth = 0;
  wholeImageReads.total = 0;
  wholeImageReads.byCaller.clear();
}

// ---- The layout probe ----

/**
 * The layout-reading properties the probe wraps, by name.
 *
 * Names rather than the properties themselves, because `Element.prototype` at
 * module scope throws in the unit-test environment: vitest runs `environment:
 * "node"` and there is no `Element` there. Resolved inside `armLayoutCounters`,
 * which only ever runs in a browser.
 *
 * The whole family, not `getBoundingClientRect` alone: they all force a
 * synchronous layout of the document, so a regression that swapped one for
 * another would be invisible to a rect-only counter.
 */
const LAYOUT_PROP_NAMES = [
  "clientWidth",
  "clientHeight",
  "scrollWidth",
  "scrollHeight",
  "offsetWidth",
  "offsetHeight",
] as const;

type PatchedGetter = () => unknown;

interface Restore {
  target: object;
  prop: string;
  descriptor: PropertyDescriptor;
}

/** Restorers for an armed probe, so arming twice cannot stack patches. */
let restores: Restore[] = [];
let armed = false;

/**
 * Count layout-forcing reads made inside a render.
 *
 * Idempotent: arming an already-armed page is a no-op, and `disarmLayoutCounters`
 * puts every property back exactly as it was. `getBoundingClientRect` is patched
 * on `Element.prototype` and the rest on their own prototypes, because the
 * property a getter lives on is where it has to be replaced.
 *
 * Only the tests arm this. The app never does, so a shipped page carries no
 * patched getter and no counter in its render path.
 */
export function armLayoutCounters(): void {
  if (armed) return;
  if (typeof Element === "undefined") return;
  armed = true;

  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    noteForcedLayout();
    return rect.call(this);
  };
  restores.push({
    target: Element.prototype,
    prop: "getBoundingClientRect",
    descriptor: Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect")!,
  });

  for (const prop of LAYOUT_PROP_NAMES) {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, prop);
    const original = descriptor?.get;
    if (!original) continue;
    Object.defineProperty(Element.prototype, prop, {
      configurable: true,
      get(this: unknown) {
        noteForcedLayout();
        return (original as PatchedGetter).call(this);
      },
    });
    restores.push({ target: Element.prototype, prop, descriptor });
  }
}

/** Undo `armLayoutCounters`. A page that was never armed is left alone. */
export function disarmLayoutCounters(): void {
  if (!armed) return;
  armed = false;
  for (const { target, prop, descriptor } of restores.reverse()) {
    Object.defineProperty(target, prop, descriptor);
  }
  restores = [];
}