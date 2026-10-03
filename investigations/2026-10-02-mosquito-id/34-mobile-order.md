# 34 — Mobile section order

Branch `agent/mobile-order` (pushed), one commit `3835ebf` on top of `2193582`. CSS-only plus one
inert wrapper `<div class="dropzone-copy">` around the dropper's two text lines.

https://github.com/corneliusroemer-agent/mosquito-id/compare/main...agent/mobile-order

## What changed

Everything lives in the existing `@media (max-width: 768px)` block at index.html:703.

- `.app-container` becomes `display: flex; flex-direction: column` on a phone.
- `.top-grid { display: contents }`, so `.upload-card` and `#combined-card` become items of
  `.app-container` instead of items of the grid. Nothing in the DOM moves, so every
  `document.querySelector` / `parentElement` in main.js is unaffected.
- `order`: header 0, `.upload-card` 1, `#gallery-section` 2, `#combined-card` 3,
  `#results-table-section` 4, footer 5.
- `.upload-card { min-height: 0 }` on a phone, and the dropzone lays out as icon-beside-text
  (`flex-direction: row`, `align-items: center`) so the two hint lines sit next to the 📷
  rather than under it.

`display:contents` is safe here: `.top-grid` is a plain `div` with no `role`, no list semantics
and no `aria-*`, so the accessibility quirk (elements with `display:contents` dropping out of the
a11y tree in some engines) has nothing to drop. The cards inside keep their own `class="card …"`
borders, backgrounds and padding, which is what carries the visual grouping.

`display:contents` takes `.top-grid`'s `gap: 16px` and `margin-bottom: 16px` with it. Both are
replaced: every card has its own `margin-bottom: 16px` (`.card`, index.html:83), and the siblings
all have margin-bottom and no margin-top, so block-flow collapsing and flex-column spacing give
the same 16px. No spacing change.

## Measured section order (y offset of the section top, px, full page)

390x844, three photos pooled and checked:

| section | before | after |
|---|---|---|
| dropper | 163 | 163 |
| thumbnail strip | 915 | **446** |
| full photo | 1105 | 636 |
| zoomed crop | 1475 | 1006 |
| species scores | 1846 | 1377 |
| combined result | **475** | **2343** |
| footer | 2828 | 2752 |
| page scrollHeight | 2899 | 2823 |

Empty state at 390x844: dropper 163, combined 475 → 399, footer 884 → 808, scrollHeight
955 → 879. The pooled card is the second thing on the page before; when the gallery is empty
that is unavoidable, and it is now the only thing between the dropper and the end.

1440x900, same harness: every number identical before and after, and the two full-page
screenshots are byte-identical (md5 `b02c612e…` empty, `5765d3da…` with photos). The desktop
`1fr 1fr` two-column top grid and the `align-items: stretch` equal-height row from `edf4e99` are
untouched — none of the new rules is outside the 768px block.

## Dropper

| | before | after |
|---|---|---|
| `.upload-card` height @390 | 280 | 220 |
| `.dropzone` height @390 | 168 | 108 |
| hint text lines @390 | 2 | 2 |
| `.upload-card` height @1440 | 369 | 369 |

The hint renders in full at both sizes — "Drop photos or ZIP · paste images with ⌘V / Ctrl+V",
wrapped to two lines on the phone. The dashed box plus the two full-width buttons below it
(≈110px of button) keep the entry point obvious.

## CLS

`PerformanceObserver` on `layout-shift`, `buffered: true`, summed over the page load and again
after the three photos are injected and pooled, at both viewports:

| | empty | + photos | cumulative |
|---|---|---|---|
| before @390 | 0 | 0 | **0** |
| after @390 | 0 | 0 | **0** |
| before @1440 | 0 | 0 | **0** |
| after @1440 | 0 | 0 | **0** |

Zero throughout. The reorder moves sections as a set — nothing above the moved card changes
height — and `#gallery-section` keeps `display:none` until photos exist, so its slot was already
outside the flow.

## One deviation from the brief

The brief's numbered order ends "…then the species scores". Delivered order is
dropper → thumbnails → full photo → zoomed crop → **species scores** → combined result.

The species scores panel is `.scores-panel`, a child of `.viewer-grid` inside
`#gallery-section` (index.html:1016→989), and on a phone `.viewer-grid` is one column, so it is
stacked with the two photo panels. Putting `#combined-card` between the zoom panel and the scores
panel would require flattening `#gallery-section` (and `.viewer-grid`) with `display: contents`,
which drops the gallery card's background, border and padding on mobile and leaves the thumbnail
strip and its nav floating on the page background — those two have no border of their own. Only
`figure, .scores-panel` are individually bordered. That is a visible regression on the one
viewport the change is for, so I stopped at the brief's concrete instruction ("move
`#combined-card` below `#gallery-section`"). The pooled result still lands after all the photo
work and after the per-photo scores, which reads correctly: per-photo scores belong to the photo
you are looking at, the pooled card belongs to the set.

## Harness

`/workspaces/claude-devcontainer/tmp/verify-mobile/probe.js` — serves `before/` (index.html from
`origin/main`) and the worktree on 8123/8124, aborts `**/*.onnx` and `**://*.r2.dev/**`, injects
three canvas-fabricated photos through `__mosqAsync.previews` and ticks the tiles' own checkboxes
so `updatePooling()` runs on the app's own path. Screenshots in `shots/`.

`node --check main.js` and `node --test tests/gate.test.mjs` (1 pass) green before the push.

The worktree is at `/workspaces/claude-devcontainer/tmp/mobileorder`
(host: `/Users/cr/code/tmp/mobileorder`).

## Note for whoever is next

The new rules had to go *below* the base `.upload-card { min-height: 280px }` and
`.dropzone { padding: 24px 16px }` declarations, which sit at index.html:176+. Putting them in a
media query right after `.top-grid` silently did nothing: same specificity, later rule wins. That
is why the reorder block lives in the phones block at line 703 and not next to `.top-grid`.
