// src/app/main.js is the entry point, and `tsc --noEmit` cannot check it: the
// tsconfig sets neither allowJs nor checkJs, so the compiler ignores a .js file
// entirely and a bad import there produces no error at any stage before the
// browser loads the page.
//
// Vite does not save us either. A named import of a binding the target module
// does not export is a warning during the build, not an error, so a rename in
// src/confidence/*.ts that main.js still refers to ships as a bundle calling
// undefined - which for an aliased re-export reads as `undefined is not a
// function` on the first photo, not as a build failure.
//
// This reads main.js as text and resolves every import by hand against what each
// target module actually exports.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const MAIN = join(root, "src", "app", "main.js");

/**
 * The names each module exports, read from the source text.
 *
 * Deliberately textual rather than a dynamic import: importing a module to read
 * its exports would execute it, and several of these touch `document` at module
 * scope. A source scan cannot be fooled by a re-export whose origin is missing,
 * which is one of the cases worth catching.
 */
function exportedNames(file: string): Set<string> {
  const src = readFileSync(file, "utf8");
  const out = new Set<string>();
  // `export { a, b as c }` / `export { a } from "./x"`
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      out.add((as[1] ?? as[0]!).trim());
    }
  }
  // `export const/let/var/function/class/async function`
  for (const m of src.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    out.add(m[1]!);
  }
  // `export type` / `export interface` - types vanish at build time, so an import
  // of one under `import type` is erased and cannot be missing at runtime. Counted
  // anyway so the scan below has nothing to explain away.
  for (const m of src.matchAll(/export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/g)) {
    out.add(m[1]!);
  }
  if (/export\s+default\b/.test(src)) out.add("default");
  return out;
}

interface ParsedImport {
  spec: string;
  names: string[];
  typeOnly: boolean;
}

/**
 * Resolve an extensionless specifier the way the bundler does: try the literal
 * path, then the extensions Vite resolves for this project. Without this every
 * import in main.js - all of which are extensionless - fails the existence check.
 */
function resolveModule(from: string, spec: string): string | null {
  const base = resolvePath(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.js`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every `import ... from "..."` in main.js, with the names it binds. */
function parseImports(src: string): ParsedImport[] {
  const out: ParsedImport[] = [];
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s*from\s*["']([^"']+)["']/g)) {
    const clause = m[1]!.trim();
    const spec = m[2]!;
    if (!spec.startsWith(".")) continue; // no bare imports in this project
    const typeOnly = /^type\s/.test(clause);
    const names: string[] = [];
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      for (const part of braced[1]!.split(",")) {
        const t = part.trim();
        if (!t) continue;
        const as = t.split(/\s+as\s+/);
        // `import { a as b }` binds b locally and requires a to be exported.
        names.push((as[0] ?? as[1]!).trim());
      }
    }
    const bare = clause.replace(/\{[\s\S]*\}/, "").replace(/^type\s+/, "").trim();
    if (bare && !bare.startsWith("*")) names.push("default");
    out.push({ spec, names, typeOnly });
  }
  return out;
}

describe("every import in main.js resolves", () => {
  const src = readFileSync(MAIN, "utf8");
  const imports = parseImports(src);

  it("finds main.js's imports at all", () => {
    // Guards the parser above: if it silently matched nothing, every assertion
    // below would pass vacuously, which is the failure mode a text-based check
    // has and a compiler does not.
    expect(imports.length).toBeGreaterThanOrEqual(8);
    expect(imports.some((i) => i.spec.includes("confidence/softmax"))).toBe(true);
  });

  it("points at a file that exists", () => {
    for (const imp of imports) {
      expect(
        resolveModule(MAIN, imp.spec) !== null,
        `main.js imports ${imp.spec}, which does not resolve to a file`,
      ).toBe(true);
    }
  });

  it("binds only names the target module actually exports", () => {
    for (const imp of imports) {
      const target = resolveModule(MAIN, imp.spec);
      if (target === null) continue; // covered by the case above
      const exported = exportedNames(target);
      expect(exported.size, `${imp.spec} yielded no exports - the scan missed them`).toBeGreaterThan(0);
      for (const name of imp.names) {
        expect(
          exported.has(name),
          `main.js imports { ${name} } from '${imp.spec}', which does not export it`,
        ).toBe(true);
      }
    }
  });

  it("keeps importing the calibration the softmax applies", () => {
    // Not a general rule - main.js has no business knowing which confidence
    // modules exist. It is here so that a refactor that moves softmaxJoint's
    // calibration out of ./softmax, or drops the module, fails here rather than
    // as a silently uncalibrated app.
    const softmaxSrc = readFileSync(join(root, "src", "confidence", "softmax.ts"), "utf8");
    expect(softmaxSrc).toMatch(/from "\.\/calibration"/);
  });
});
