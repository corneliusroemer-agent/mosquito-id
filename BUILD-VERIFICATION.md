# Build verification for the Vite switch

Measured on the commit that made `src/confidence/*.ts` the code the site runs.
Node 24.10.0, Vite 7.3.6, tsc 5.9.x, vitest 3.2.7, aarch64 devcontainer.

## The build

```
npm ci && npm run build      # build = tsc --noEmit && vite build
✓ tsc --noEmit clean
✓ 13 modules transformed
✓ built in ~130ms
```

## The output

```
dist/assets/index-*.js       59,459 bytes   (20,725 gzipped)
dist/index.html               45,638 bytes
dist/ total                2,815,973 bytes  (2.8 MB, mostly the sample photos)
```

The two large JSONs in `dist/` are `text_embeds.json` (673 KB) and
`text_embeds_b16.json` (272 KB), copied verbatim from `public/`. They are static
assets, not inlined into the bundle.

## The model is not in the bundle

This was the failure mode the switch was written to avoid: a static import of the
1.26 GB classifier or the embeddings would inline ~1.9 GB.

- Nothing under `src/` imports a `.onnx`, an embeddings `.json`, or an R2 URL at
  module scope. The model is fetched at runtime by `src/model/fetch.ts`.
- `dist/` is 2.8 MB and the bundle is 59 KB. A 1 GB artifact cannot be hiding in
  either.
- The only R2 URLs in the bundle are the runtime fetch bases, as string literals:
  ```
  https://pub-2bbf73b4e93d40c9af925724fbd48d51.r2.dev/
  https://pub-2bbf73b4e93d40c9af925724fbd48d51.r2.dev/images/
  ```

## The confidence arithmetic ships once

The whole point of the switch: the tests certify the code that runs. Counting is
by literal occurrence, since minified names are unreadable.

```
Math.exp in src/confidence/*.ts   8
Math.exp in the bundle            8
```

Eight in the bundle and eight in `src/` means one copy. The old `main.js`, which
the bundle replaced, carried its own separate 8.

A second check on a copy that was easy to miss: `src/app/main.js` still defined
`viewAgreement` and `agreementSentence` locally after the other eight functions
moved to modules. Nothing called them — `fuseViews` computes the agreement with
the module's copy and returns it on its result — so they were dead. The bundle
was byte-identical before and after deleting them, which is what confirms the
bundler had already shaken them out.

## Tests

```
npx vitest run       51 passed / 3 files
                       tests/gate.test.ts              24
                       tests/regressions.test.ts       26
                       tests/pooling-equivalence.test.ts 1
npx playwright test   2 passed, against the real dist/ via `vite preview`
```

The e2e suite aborts every model request (`**/*.onnx`, `**/*.r2.dev`,
`**/text_embeds*.json`), so it exercises the shell — the bundle parses and runs,
the DOM is present, the species route renders — without loading the classifier.

## A note on `dist/` staleness

`playwright.config.ts` starts `vite preview` with
`reuseExistingServer: !process.env.CI`. A `dist/` left from an earlier build is
served in preference to a fresh one, so a test can pass against a bundle that is
not the one you just built. Build explicitly before trusting a local run.
