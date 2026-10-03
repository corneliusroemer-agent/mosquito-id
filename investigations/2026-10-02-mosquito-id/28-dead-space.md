# Dead space in the pooled card and the species scores panel

Branch `agent/dead-space-fix`, pushed at `deff442`. Two black regions, one defect:
a box sized by a reservation rather than by its content, in each of two panels.

Reproduced in Playwright against the worktree served on `127.0.0.1:8899`, with
`.onnx` and `r2.dev` aborted so the 1.26 GB classifier never downloads. Photos
are fabricated as canvas previews pushed into `previews`, rendered by the app's
own `selectPhoto()` path and pooled by clicking the app's own checkboxes — no
model, real panels, real DOM.

## Measurements

`deadA` = bottom of the "Check two or more photos…" hint to the top of the
`▶ Aggregation options` divider. `deadB` = bottom of the "Species scores" header
to the top of the first score row. Both in CSS px, at both viewports.

| | | 1440×900 | 390×844 |
|---|---|---|---|
| **A** pooled card, dead space | before | **234** | **216** |
| | after | **0** | **0** |
| **B** scores panel, dead space | before | **124** | **124** |
| | after | **8** | **8** |
| pooled card height, empty | before → after | 369 → **129** | 361 → **121** |
| pooled card height, populated | before → after | 369 → **449** | 361 → **441** |
| scores panel height, **empty** | before → after | 487 → **371** | 167 → **51** |
| scores panel height, **populated** | before → after | 487 → **371** | 386 → **270** |
| page height (scrollHeight), empty | before → after | 1241 → **1036** | 2056 → **1700** |

The 8px left in `deadB` is the first row's own `margin: 8px 0`.

### The assertion that matters

**Scores panel: the box does not change size between empty and populated.**
487 → 371 px at 1440, empty and populated alike — a fixed box, now 116 px
shorter. At 390 it grows 51 → 270 px, which is the score *list* filling: the
phone media query already sets `.score-list { height: auto }`, so the panel is
as tall as its sixteen rows. That behaviour predates this change; the two
reserved notices no longer contribute to it (they were 100 px of the 219 px
before, and are 0 px now).

**Pooled card: the box still changes size, 129 → 449 px.** This is the one
requirement not met, and it is a genuine trade, not an oversight.

## The pooled card (A)

`.combined-scores` was `height: 240px; overflow-y: auto`. It reserved 240px
whether or not anything was pooled, and the ten candidates it holds need 320px,
so the populated card scrolled its own results *and* kept 234px empty when it
had none.

The fix is that the pooled list is always exactly ten rows —
`candidates.slice(0, 10)` over 16 species — so its content height *is* its
settled height. Sizing the box by its content gives exactly the settled size,
with no scrollbar and no void:

```css
.combined-scores {
  max-height: 320px;      /* where a very long species name starts to scroll */
  overflow-y: auto;
}
```

Every populated state of the card is now 449px, and every re-pooling is the
same height as the last, which is what the reservation was for.

**Why the card still resizes.** 129 → 449px when the second photo is checked.
A 240px reservation that is *not* re-applied per state was hiding a shift that
was always there: the populated content needs 320px where the reservation
offered 240, so the card grew 80px anyway the moment anything was pooled. The
reservation bought a 234px void in exchange for suppressing 80px of a shift
that content-appearing causes regardless. Removing it makes the empty card
flush, as asked, and enlarges the one shift that was already unavoidable —
triggered by an explicit user action (checking a second photo), which is
excluded from CLS by definition. If you would rather keep the card inert and
eat the void, the revert is one line: restore `height: 320px` on
`.combined-scores` and drop `max-height`.

## The scores panel (B)

Not the band inside a row — that was `justify-content` on
`.score-item-header` and is untouched. This is the space *above* the rows.

Two boxes sat between the panel header and the first row, each permanently
50px:

- `#score-pending` — written **only** when classification fails
  (`noticeText` is set from `p.error` and nowhere else; the pending state
  deliberately writes no text). On error there is no score list to displace, so
  a reservation protects nothing.
- `#view-agreement` — never written to at all. `main.js` empties it and clears
  its class on every render, with a comment saying the two-view agreement is
  no longer reported as a sentence. It was 50px of dead element.

Both now reserve their two-line box only while shown:

```css
#score-pending, #view-agreement { display: none; min-height: 50px; max-height: 50px; ... }
#score-pending.shown, #view-agreement.shown { display: block; }
```

Verified in the browser: an error photo renders the notice at its full 50px with
the text in it; a classified photo renders it at 0px. The two-line box is still
pinned while shown, so a one-line and a two-line message are the same height and
the text length still cannot resize the panel.

`#score-uncertain` (the verdict line above the ranking) was left alone. It
carries `style="display:none"` inline in the HTML, which beats the CSS rule, so
it already collapses to 0 and is not part of this dead space. Note for whoever
owns it: **the verdict line never renders** — `main.js` sets `.shown` on it and
nothing clears the inline `display:none`, so `verdictSentence()` is computed for
every photo and never shown. Separate bug, not touched here.

## The bars

`score * 100` went straight into `width: ${…}%`. `Math.min`/`Math.max`
propagate NaN, and `width: NaN%` is an invalid declaration the browser drops,
so the fill fell back to its default and drew **full width**. Measured in a
clean page: a `NaN%` fill inside a 500px track renders 500px, against 481px
for a real 96.1% and 0px for 0% — indistinguishable from the top species.

Both bar sites (`.score-item-fill`, `.combined-bar`) now take the value only if
it is finite, and draw nothing otherwise. Verified with `NaN` and `undefined`
scores in the detail map: both fills are `width: 0%`, rendering 0px. The NaN
itself is not chased — another agent owns that — only the guard.

## Notes

- **The test seam.** `window.__mosqAsync` gained `get/set embeds`. `EMB` is
  module-scoped and is only assigned after a classifier session is built, so
  without it the pooled card cannot be reached in a browser that will not
  download 1.26 GB. Production never writes it. If you would rather not carry
  it, the pooling side of this measurement goes with it.
- **`main.js?v=20261003_5` was not bumped.** It has never been bumped since the
  initial commit, so it is not acting as a per-change cache buster and I did not
  change that convention — but `main.js` changed here, so a client holding a
  cached copy will need a hard refresh to see the bar guard.
- The harness is at `/workspaces/claude-devcontainer/tmp/deadspace/pw/`
  (`measure.mjs`, `guard.mjs`, `cssproof.mjs`, plus `before.json`/`after.json`),
  uncommitted: it needs Playwright, which the repo does not depend on.
