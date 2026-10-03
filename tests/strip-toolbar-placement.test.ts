// The three bulk actions live in the header row, not the strip's own row. Spec
// R4.12.
//
// This is a layout rule, and a layout rule is checkable from the markup rather
// than from a browser: which element the buttons are a descendant of decides
// which row they cost width to. There is no need for a rendered box to know that
// `#btn-select-all` is under `.gallery-nav`, and asserting on a rendered box
// would make this test depend on a browser that the app's own spec says must
// never run headless against a contended origin.
//
// What cannot be read from text, and is deliberately not asserted here: the strip's
// pixel width, and whether the header wraps at a given viewport. Those are
// `e2e/tier1/layout-shift.spec.ts`'s business.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");

const ACTIONS = ["btn-select-all", "btn-select-none", "btn-delete-all"];

/**
 * The body of the `<div>` whose opening tag starts at `open`, found by counting
 * `<div` / `</div>` from there.
 *
 * Textual rather than a parsed tree: the project has no HTML parser dependency,
 * and a regex over the whole file cannot tell an ancestor from a neighbour - which
 * is the whole question here.
 */
function divBody(open: number): string {
  let depth = 0;
  for (const m of html.slice(open).matchAll(/<div\b|<\/div>/g)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(open, open + m.index);
  }
  throw new Error("unterminated <div>");
}

function bodyOf(selector: string): string {
  const at = html.indexOf(selector);
  expect(at, `${selector} is in index.html`).toBeGreaterThan(-1);
  return divBody(at);
}

describe("bulk action placement (spec R4.12)", () => {
  it("puts every bulk action inside the gallery header", () => {
    const nav = bodyOf('<div class="gallery-nav">');
    for (const id of ACTIONS) {
      expect(nav, `#${id} belongs to .gallery-nav`).toContain(`id="${id}"`);
    }
    // The wrapper the buttons used to share with the strip is gone; a stray one
    // would be dead CSS, but if it came back it would be taking the strip's row
    // again, so its absence is part of the rule.
    expect(html).not.toContain("strip-toolbar");
  });

  it("orders the actions before the arrows, so the destructive action is not last in the row", () => {
    const nav = bodyOf('<div class="gallery-nav">');
    const arrows = nav.indexOf('class="gallery-arrows"');
    expect(arrows).toBeGreaterThan(-1);
    for (const id of ACTIONS) {
      expect(nav.indexOf(`id="${id}"`), `#${id} precedes the arrows`).toBeLessThan(arrows);
    }
    // Their order among themselves is the user's, not a rule: only the grouping
    // and the position relative to the arrows are asserted.
  });

  it("leaves the strip alone in its own row", () => {
    const section = bodyOf('<div id="gallery-section"');
    const strip = section.indexOf('id="thumbnail-strip"');
    expect(strip).toBeGreaterThan(-1);
    // Nothing between the strip's own opening tag and the start of the next
    // sibling: whatever shares this row would narrow the one element in the app
    // whose width is a budget.
    const afterStrip = section.slice(strip);
    const nextOpeningDiv = afterStrip.indexOf("<div");
    expect(afterStrip.slice(0, nextOpeningDiv)).not.toMatch(/<button\b/);
  });

  it("keeps every button's accessible name on the button itself", () => {
    // A move is where a name gets lost. Each of the five header-row buttons is
    // named by its own `aria-label`, not by a wrapper or an adjacent label.
    const nav = bodyOf('<div class="gallery-nav">');
    for (const id of [...ACTIONS, "btn-prev", "btn-next"]) {
      const at = nav.indexOf(`id="${id}"`);
      expect(at, `#${id} is in the header`).toBeGreaterThan(-1);
      const tag = nav.slice(at, nav.indexOf(">", at));
      expect(tag, `#${id} has an aria-label`).toMatch(/\baria-label="[^"]+"/);
    }
  });
});
