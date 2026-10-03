# The verdict line never rendered: an inline `display:none` outranked the class that shows it

Repo: `/Users/cr/code/claude-devcontainer/tmp/mosq-merge` (worktree `tmp/verdictfix`), branch `agent/verdict-line` off `origin/main` @ `5f1edc8`. Commit `19c99e5`, pushed.

## The bug

`index.html:1018` carried an inline style on the verdict element:

```html
<p id="score-uncertain" class="uncertain" style="display:none;"></p>
```

The CSS for that element never used `display` — it reserves space and toggles visibility:

```css
/* index.html:545 */
#score-uncertain {
  visibility: hidden;
  min-height: 44px;
  max-height: 44px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/* index.html:553 */
#score-uncertain.shown { visibility: visible; }
```

An inline style outranks any class rule, so `display: none` applied unconditionally and `visibility: visible` could never take effect. The element had a box reserved inside the panel but rendered nothing.

Writer: `main.js:2064-2070`, inside `renderActivePhoto()`, sets `verdictEl.textContent` and `verdictEl.className = \`uncertain${vText ? " shown" : ""}\`` for every classified photo. The `.shown` class was correct and always applied; the markup defeated it.

Consequence: `verdictSentence()` (`main.js:1098`) was evaluated per photo and its output discarded. The "Definitely Aedes - maybe aegypti or albopictus" / "Not confident enough to name a genus" line has never appeared on the live site.

## The fix

One line: the inline `style="display:none"` is removed from `index.html:1018`. The stylesheet is now the only thing that decides whether the element is seen — no competing mechanism is left, and `main.js` is unchanged.

Layout is not touched. The 44px `min-height`/`max-height` reservation is in the same rule as `visibility: hidden`, so the space is present whether or not there is a sentence.

## Verification

`tests/verdict-line-probe.mjs` (new). It serves the app locally, aborts `**/*.onnx` and `**/*.r2.dev` via a Playwright route, sets `__mosqAsync.embeds` through the app's own test seam, and pushes three synthetic photos into `previews` so the real `renderActivePhoto()` draws them. The verdict objects are produced by `verdictFrom()` read out of the *served* `main.js` source with the served floor constants — not reimplemented — so a change to the thresholds or to the derivation fails the probe rather than passing against a copy.

Measured at 1280×1400, three photos in one page, `selectPhoto()` between reads:

| case | posterior shape | rendered sentence | verdict visible |
|---|---|---|---|
| torn | 0.36 aegypti / 0.35 albopictus / 0.14 japonicus / 0.15 Culex pipiens | `Definitely Aedes - maybe albopictus or japonicus` | yes |
| flat | uniform over 8 species | `Not confident enough to name a genus` | yes |
| sure | 0.96 aegypti / 0.02 albopictus / 0.01 / 0.01 | *(empty)* | no |

Layout, measured per state:

| measurement | torn | flat | sure |
|---|---|---|---|
| `.scores-panel` height | 430.5 | 430.5 | 430.5 |
| `.scores-panel` top | 633 | 633 | 633 |
| `#score-list` top | 730.5 | 730.5 | 730.5 |
| first score row top | 738.5 | 738.5 | 738.5 |
| `#score-uncertain` box height | 44 | 44 | 44 |
| score rows | 16 | 16 | 16 |

Identical to the pixel across shown and hidden, which is the no-layout-shift requirement, asserted in the probe rather than eyeballed. `#score-uncertain` reports `display: block, visibility: hidden` with empty text on the confident photo — absent to the user, space still reserved.

`node --check main.js` clean; `node --test tests/gate.test.mjs` 1 pass / 0 fail (unchanged, so the gate arithmetic is not disturbed).

## Same bug elsewhere

Swept every element in `index.html` carrying an inline `display:none` — 11 of them: `file-input`, `camera-input`, `gallery-section`, `full-active-crop-box`, `full-drag-rect`, `context-img`, `zoomed-active-crop-box`, `zoomed-drag-rect`, `crop-empty`, `btn-full-photo`, `results-table-section`.

Every one is driven by a direct `el.style.display = ...` write in `main.js` (lines 1231, 1238, 1301-1307, 1584-1585, 1766-1767, 1896-1897, 1931-1933, 2003-2018, 2105-2108, 2139-2147, 2160, 2178) — the inline style *is* their mechanism, so they are consistent. `grep` for `shown` against all eleven ids returns 0 hits.

The reverse case is fine too: `#score-pending` and `#view-agreement` are the other `.shown` users (`main.js:2045`), and they get `display: none` from a stylesheet rule (`index.html:834`) that `.shown` (`index.html:838`) overrides at the same specificity tier — a class rule beats a plain id-less element rule by later declaration, so those two work as intended. No second instance to fix.

## Note for whoever picks this up next

`tests/verdict-line-probe.mjs` needs `playwright` resolvable. The worktree has `node_modules` symlinked to `/workspaces/claude-devcontainer/tmp/progressfix/node_modules` (untracked, not committed). There is no `package.json` in this repo; the other probes in `tests/` have the same dependency on wherever playwright happens to be installed.
