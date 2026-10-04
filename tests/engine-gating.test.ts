// The classifier is only built on the route that runs it.
//
// The species guide is a route of the classifier shell (`#/species/<slug>`), not
// a separate page, so a tab opened on one used to fetch YOLO11n plus the 1.2 GB
// engine and build an ORT session for a classifier it would never run - 60 KB of
// species text paying for the whole model. Three tabs on a species route measured
// 1,222 MB of live heap each, all of it from work whose result was never read.
//
// The gate has to be right in both directions, and the direction that breaks
// silently is the second one: opening on the species guide and then navigating to
// the classifier must still initialise the engine, or the classifier arrives with
// no model behind it and the app looks simply broken.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

type Globals = {
  location: { hash: string };
  document: {
    title: string;
    querySelector(sel: string): unknown;
    getElementById(id: string): unknown;
  };
  window: { scrollTo(x: number, y: number): void };
  fetch: (url: string) => Promise<unknown>;
};
const g = globalThis as unknown as Globals;

/** What the classifier does when its route comes up, told as counts instead of models. */
interface FakeEngine {
  /** Fetches a model would issue - the thing that must not happen on the guide. */
  fetches: string[];
  /** ORT sessions the engine would build. */
  sessions: number;
  start(): void;
}

function fakeEngine(): FakeEngine {
  const e: FakeEngine = {
    fetches: [],
    sessions: 0,
    start() {
      // Stands in for initEngine(): a /api/health probe, then the weight fetches
      // that a session is built from.
      e.fetches.push("/api/health");
      e.fetches.push("…/yolo11n.onnx");
      e.fetches.push("…/text_encoder/model.onnx");
      e.sessions += 1;
    },
  };
  return e;
}

function stubDom() {
  const classList = () => {
    const set = new Set<string>();
    return {
      add: (c: string) => void set.add(c),
      remove: (c: string) => void set.delete(c),
      contains: (c: string) => set.has(c),
      has: (c: string) => set.has(c),
    };
  };
  const classifier = { classList: classList() };
  const speciesView = { classList: classList() };
  g.document = {
    title: "Mosquito ID",
    querySelector: (sel: string) => (sel === ".app-container" ? classifier : null),
    getElementById: (id: string) => (id === "kb-view" ? speciesView : id === "kb-body" ? { innerHTML: "" } : null),
  } as unknown as Globals["document"];
  g.window = { scrollTo() {} };
  g.location = { hash: "" };
  // species-data.json, for the guide route's own render.
  g.fetch = async () => ({ ok: true, json: async () => ({ species: [] }) });
  return { classifier, speciesView };
}

const saved = { location: g.location, document: g.document, window: g.window, fetch: g.fetch };

describe("engine construction is gated on the route", () => {
  beforeEach(stubDom);
  afterEach(() => {
    g.location = saved.location;
    g.document = saved.document;
    g.window = saved.window;
    g.fetch = saved.fetch;
  });

  it("builds no engine and fetches no model on a species route", async () => {
    stubDom();
    g.location.hash = "#/species/aedes-albopictus";
    const { initRouter } = await import("../src/app/router");
    const engine = fakeEngine();

    const onHashChange = initRouter(() => engine.start());
    onHashChange();
    await Promise.resolve();

    expect(engine.sessions).toBe(0);
    expect(engine.fetches).toEqual([]);
  });

  it("builds the engine on the classifier route", async () => {
    stubDom();
    g.location.hash = "";
    const { initRouter } = await import("../src/app/router");
    const engine = fakeEngine();

    const onHashChange = initRouter(() => engine.start());
    onHashChange();
    await Promise.resolve();

    expect(engine.sessions).toBe(1);
    expect(engine.fetches).toContain("/api/health");
  });

  it("builds the engine when the guide navigates to the classifier", async () => {
    stubDom();
    g.location.hash = "#/species/aedes-albopictus";
    const { initRouter } = await import("../src/app/router");
    const engine = fakeEngine();

    const onHashChange = initRouter(() => engine.start());
    onHashChange();
    await Promise.resolve();
    expect(engine.sessions).toBe(0);

    // The navigation: location changes, hashchange fires.
    g.location.hash = "";
    onHashChange();
    await Promise.resolve();

    expect(engine.sessions).toBe(1);
    expect(engine.fetches).toContain("/api/health");
  });

  it("starts the engine once, however often the classifier route is applied", async () => {
    stubDom();
    g.location.hash = "";
    const { initRouter } = await import("../src/app/router");
    const engine = fakeEngine();

    const onHashChange = initRouter(() => engine.start());
    onHashChange();
    g.location.hash = "#/species/aedes-albopictus";
    onHashChange();
    g.location.hash = "";
    onHashChange();
    await Promise.resolve();

    // One download, one set of sessions: the guide route does not undo a build.
    expect(engine.sessions).toBe(1);
    expect(engine.fetches).toHaveLength(3);
  });

  it("still routes the guide when the engine is not involved", async () => {
    const { classifier, speciesView } = stubDom();
    g.location.hash = "#/species/aedes-albopictus";
    const { initRouter } = await import("../src/app/router");

    const onHashChange = initRouter();
    onHashChange();
    await Promise.resolve();

    expect(classifier.classList.has("route-off")).toBe(true);
    expect(speciesView.classList.has("route-off")).toBe(false);
  });

  it("main.js starts the engine through the router's gate and nowhere else", () => {
    // The callback above is the seam, but what makes the fix real is main.js
    // using it: an `initEngine()` sitting in DOMContentLoaded outside the gate
    // would build the engine on a species tab again and the router could not
    // stop it. main.js is not importable from a test - it wires the whole page
    // at module scope - so this reads it as text, the way tests/main-js-imports
    // does for the same reason.
    const src = readFileSync(join(here, "..", "src", "app", "main.js"), "utf8");
    const gates = [...src.matchAll(/initRouter\(\s*(\(\)|function)\s*=>\s*\{/g)];
    expect(gates).toHaveLength(1);

    // Every initEngine() call sits inside the gate's callback body. Take the
    // text from the gate's opening brace to the matching close and require the
    // call to be in there rather than anywhere else in the file.
    const start = gates[0]!.index! + gates[0]![0].length;
    let depth = 1;
    let end = start;
    for (; end < src.length && depth > 0; end++) {
      if (src[end] === "{") depth++;
      else if (src[end] === "}") depth--;
    }
    const gated = src.slice(start, end);
    const outside = src.slice(0, start) + src.slice(end);
    expect(gated).toMatch(/initEngine\(\)\s*\./);
    // `async function initEngine() {` is a declaration, not a call, so this
    // looks for the parenthesis-and-then-use of a call rather than the name.
    expect(outside).not.toMatch(/initEngine\(\)\s*[.(]/);
    // Only the definition and that one call: no second alias waiting to be
    // called from somewhere that has not thought about the route.
    expect(src.match(/initEngine\(/g)).toHaveLength(2);
  });
});
