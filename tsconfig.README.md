# Where the type-safety boundary sits

`tsconfig.json` covers everything under `src`, `tests` and `e2e` **except the
`.js` files**, because it sets neither `allowJs` nor `checkJs` and so the
compiler ignores them entirely.

**`src/app/main.js` is therefore NOT type-checked.** Nothing in `src/app/*.ts`
is exempt: every TypeScript module in `src/`, `src/confidence/` and `src/app/`
is checked at `strict` + `noUncheckedIndexedAccess`. The one JavaScript file that
matters is `main.js`, and it is the entry point every agent edits.

## Measured, at 29ad10a

| | lines | type-checked |
|---|---|---|
| `src/**/*.ts` | 5,852 | yes |
| `src/app/main.js` | 2,676 | **no** |
| of which extracted to `.ts` so far | 630 (`photoRecord.ts`, `views.ts`, `embedding.ts`) | yes |

Turning `checkJs` on for `main.js` alone reports **405 errors**. That is the
size of the remaining unchecked surface, and it is why the plan is extraction
rather than "make it type-check": 405 is not a task, and typing the state as it
stands was measured at 447 — worse than doing nothing, because typing a record
loosely is not typing it.

`tests/main-js-imports.test.ts` covers the gap `tsc` leaves: it reads `main.js`
as text and resolves every import against what each target module actually
exports. That catches a stale import after an extraction. It does **not** catch
a type error inside `main.js`, a wrong argument shape, or a misspelled property.

## What is still JavaScript, and why

| region | why it is still `.js` |
|---|---|
| `processFiles`, the batch loop | reads and writes ~30 fields of the photo record in one function; extracting it means passing the record and five render callbacks. That is a restructure, not a move. |
| `renderThumbnails` / `renderActivePhoto` / `buildTile` | DOM node caches keyed by photo slot. Typed, they would need a `Map<PhotoState, HTMLElement>` and a decision about what happens when a slot is replaced. |
| `setupCropSurfaces` and the pointer handlers | the same, plus module-level drag state. |
| `loadWebGPUModels` / `initEngine` | module state rebinding mid-download; the order is the correctness, not the types. |

Extract those as their own slices, each green, in that order of blast radius.

## What is worth checking before trusting a slice landed

`npm run build` runs `tsc --noEmit && vite build`, and the vite half catches
things `tsc` does not: a duplicate declaration in `main.js` (an adapter shadowing
an import of the same name) builds clean under `tsc` and fails at bundle time.
That is the clearest evidence the boundary is still in the middle of the file.
