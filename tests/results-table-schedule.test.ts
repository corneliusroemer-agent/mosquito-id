import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderResultsTable, resultsTableRenderPending, scheduleResultsTable } from "../src/app/resultsTable";
import type { ClassifiedPhoto } from "../src/app/types";

/**
 * The results table, rebuilt once per frame instead of once per photo.
 *
 * The batch loop calls it for every photo as it lands, and it clears the tbody
 * and re-derives every row, so a 100-photo batch rebuilt the table 100 times
 * over rows that were still arriving. The photos land faster than frames do, so
 * one rebuild per frame shows the same table at the only rate it can be read at.
 *
 * A frame that captured the photo list it was scheduled with would redraw the
 * list as it stood when the batch started - the exact staleness the synchronous
 * path never had - so the list is read through a getter, and that is pinned
 * here rather than assumed.
 *
 * The DOM is stubbed rather than installed: `jsdom` is not a dependency of this
 * suite, and what is under test is the scheduling, not the markup.
 */

/** The rows the table built, in order. The tbody stands in for the real one. */
let rows: string[] = [];
/** The frame callbacks queued and not yet run, and which are still live. */
let frames: Array<{ run: () => void; live: boolean }> = [];

function photo(name: string): ClassifiedPhoto {
  return {
    name,
    fullCanvas: null,
    cropCanvas: null,
    cropBox: null,
    contextBox: null,
    scores: { aedes: 0.8, culex: 0.2 },
    detail: { "Aedes aegypti": 0.7, "Culex pipiens": 0.3 },
    verdict: null,
    is_cropped: false,
    pending: false,
    error: null,
    crop_rejected: false,
  } as unknown as ClassifiedPhoto;
}

/** Run every live queued frame, as the browser would before the next paint. */
function paint(): void {
  const queued = frames;
  frames = [];
  for (const f of queued) if (f.live) f.run();
}

/** How many frames actually ran, cancelled ones not counted. */
let painted = 0;

beforeEach(() => {
  rows = [];
  frames = [];
  painted = 0;
  const tbody = {
    set innerHTML(v: string) { if (v === "") rows = []; },
    get innerHTML() { return ""; },
    appendChild(tr: { html: string }) { rows.push(tr.html); },
  };
  (globalThis as Record<string, unknown>).document = {
    getElementById(id: string) {
      if (id === "results-table") return { querySelector: () => tbody };
      if (id === "table-summary") return { textContent: "" };
      return null;
    },
    createElement: () => ({ className: "", html: "", set innerHTML(v: string) { this.html = v; } }),
  };
  (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: () => void) => {
    frames.push({ run: () => { painted++; cb(); }, live: true });
    return frames.length;
  };
  (globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => {
    const f = frames[id - 1];
    if (f) f.live = false;
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).document;
  delete (globalThis as Record<string, unknown>).requestAnimationFrame;
  delete (globalThis as Record<string, unknown>).cancelAnimationFrame;
});

describe("scheduleResultsTable", () => {
  it("renders once for however many photos landed, not once per photo", () => {
    // The batch: a hundred results, each asking for a table, all inside one
    // frame. The list grows between them, exactly as the app's does.
    const list: ClassifiedPhoto[] = [];
    for (let i = 0; i < 100; i++) {
      list.push(photo(`p${i}.jpg`));
      scheduleResultsTable(() => list);
    }
    expect(resultsTableRenderPending()).toBe(true);
    paint();
    // One frame, one rebuild, and it saw all hundred.
    expect(painted).toBe(1);
    expect(rows).toHaveLength(100);
    expect(rows[99]).toContain("p99.jpg");
  });

  it("keeps updating as the batch runs, one frame at a time", () => {
    let list: ClassifiedPhoto[] = [];
    for (let i = 0; i < 3; i++) {
      list = [...list, photo(`p${i}.jpg`)];
      scheduleResultsTable(() => list);
      paint();
    }
    expect(rows).toHaveLength(3);
    expect(resultsTableRenderPending()).toBe(false);
  });

  it("reads the photo list when the frame runs, not when it was asked for", () => {
    // The prepend that made this necessary: a new batch goes in front, so the
    // array the frame was scheduled with is not the array the page holds.
    let list = [photo("old.jpg")];
    scheduleResultsTable(() => list);
    list = [photo("new.jpg"), ...list];
    paint();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("new.jpg");
  });

  it("renders synchronously when a caller asks for it directly", () => {
    // A test hook and the end of a batch both read the row straight after this
    // call, so the contract is "the table shows these when this returns".
    renderResultsTable([photo("a.jpg"), photo("b.jpg")]);
    expect(rows).toHaveLength(2);
    expect(resultsTableRenderPending()).toBe(false);
  });

  it("does not leave a queued frame behind a synchronous render", () => {
    scheduleResultsTable(() => [photo("queued.jpg")]);
    renderResultsTable([photo("a.jpg")]);
    expect(resultsTableRenderPending()).toBe(false);
    // And the queued frame really is gone: running it would redraw the same
    // rows over the better one, at a moment nobody asked for.
    paint();
    expect(painted).toBe(0);
    expect(rows).toHaveLength(1);
  });
});