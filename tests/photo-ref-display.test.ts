/**
 * A photo is shown as a number on its tile and by filename in the results table,
 * and nothing said they were the same photo. These are the places that pair them.
 *
 * Rendered-text assertions need a browser, so what is pinned here is the wiring:
 * that the number-bearing reference reaches each surface, and that the hint row
 * carries the selected photo's filename rather than only the generic hint.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const html = read("index.html");
const main = read("src/app/main.js");
const table = read("src/app/resultsTable.ts");

describe("the number and the filename are shown together", () => {
  it("puts the reference beside the strip hint", () => {
    expect(html).toContain('id="photo-ref"');
    // In the same paragraph as the hint, not a panel of its own.
    expect(html).toMatch(/class="hint">[^<]*<span id="photo-ref"/);
  });

  it("fills it from the selected photo", () => {
    expect(main).toMatch(/getElementById\("photo-ref"\)/);
    expect(main).toContain("refEl.textContent = ref");
    expect(main).toContain("const ref = photoRef(p, selectedIndex + 1)");
  });

  it("carries the number in the results table's filename column", () => {
    expect(table).toContain("const ref = photoRef(p, i + 1)");
    expect(table).not.toMatch(/<td title="\$\{escapeHtml\(p\.name\)\}"/);
  });

  it("exports the number beside the filename, not inside it", () => {
    // A spreadsheet matches on `Filename`; "Photo 4 · nothing.jpg" is not a
    // filename. The number is a column of its own.
    expect(table).toContain('let csv = "Photo,Filename,');
    expect(table).toContain("const num = i + 1;");
    expect(table).not.toContain('csv += `"${p.name}"');
  });

  it("truncates the hint row's filename rather than wrapping it", () => {
    const at = html.indexOf(".photo-ref {");
    expect(at).toBeGreaterThan(-1);
    const rule = html.slice(at, at + 400);
    expect(rule).toContain("text-overflow: ellipsis");
    expect(rule).toContain("white-space: nowrap");
    // `overflow` and `text-overflow` are inert on a non-replaced inline box, so
    // without this the rule above silently does nothing and a long filename
    // overflows the viewport. `e2e/tier1/mobile.spec.ts` is what catches the
    // effect; this is the declaration that makes it work.
    expect(rule).toMatch(/display:\s*inline-block/);
    // The full value stays reachable, on hover and by keyboard.
    expect(main).toContain("refEl.title = ref");
    expect(html).toMatch(/id="photo-ref"[^>]*tabindex="0"/);
  });
});
