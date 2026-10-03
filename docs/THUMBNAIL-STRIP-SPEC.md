# Thumbnail strip — behavioural spec

What the strip under the photo viewer is required to do, per state and per
element. Every rule here is stated so a test can check it; the rationale section
at the end carries the rules that are not.

This document is the target, not a description. Entries marked **WRONG IN CODE**
are places where the implementation currently does something else. `e2e/tier1/
tile-states.spec.ts` and `e2e/tier1/strip-index-stability.spec.ts` encode the
tables below as assertions; a change to the strip that breaks a rule here fails
those tests rather than passing review.

## 1. What a tile is

One tile per photo in `previews`, in index order. The tile is the only place a
user can act on a photo without opening it: select it, remove it, or include it
in the combined result.

A tile contains exactly these four interactive elements, and no more:

| Element | Selector | Purpose |
| --- | --- | --- |
| Select button | `.tile-btn` | Make this the photo shown in the viewer |
| Delete button | `.tile-delete-btn` | Remove this photo from the strip |
| Include checkbox | `.thumb-optin` | Add or remove this photo from the pooled result |
| Status badge | `.crop-badge` | Report the photo's analysis state (not interactive) |

**R1.1** No control may be a descendant of another control. In particular the
`<button class="tile-btn">` must not contain the checkbox or the delete button,
and the `<label class="include">` must not contain a button.

**R1.2** No absolutely-positioned control may overlap a neighbouring tile's hit
area. The delete button and the badge must stay within their own tile's box.

## 2. The states a photo can be in

This is the part every recorded bug lived in: the gaps between these rows.

| State | `fallback` | `pending` | `error` | `verdict.state` | `is_cropped` | Badge | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Queued / pending | any | `true` | — | — | any | `…` | Decode or inference in flight |
| Cropped, decided | `false` | `false` | — | `species` \| `genus` | `true` | `✓` | A mosquito was found and named, or named to genus |
| Cropped, unsure | `false` | `false` | — | `unsure` | `true` | `✓` | Valid photo, classifier would not name a genus |
| Cropped, non-mosquito | `false` | `false` | — | `non-mosquito` | `true` | `✓` | Valid photo, the gate says it is not a mosquito |
| **Uncropped, no detection** | `true` | `false` | — | — | `false` | `✕` | The detector found no mosquito in this photo |
| Uncropped, no flag | `false` | `false` | — | — | `false` | `✕` | As above, without the fallback flag set |
| Error | any | `false` | set | — | any | `!` | The photo is readable; classification failed |

## 3. Selection and inclusion are different decisions

> **R3.1** A photo the user cannot *include* in the pooled result must still be
> *viewable*, and the reason it cannot be included must be stated where the
> checkbox is.

`canView(p)` and `contributesToPool(p)` answer different questions and must never
be one predicate. Conflating them is what made a `fallback` photo behave as
though it did not exist.

**R3.2** `contributesToPool(p)` is false for `pending`, `error`, `fallback`, and
`verdict.state === "non-mosquito"`. A `fallback` photo must not enter a mosquito
pool — the pooled card fuses evidence about a mosquito, and a photo with no
mosquito in it is not that evidence.

**R3.3** `canView(p)` is true for every photo the app holds, including `fallback`
and `error` ones. A failed classification is not a missing photo; the full frame
is on screen beside the failure message.

## 4. What each element does, per state

**R4.1 Selecting.** Clicking `.tile-btn` on any tile selects that photo. This
holds in **every** state in §2 including pending and error.

**R4.2 Selecting is visible.** After a click, all of the following must hold, in
the same frame:

- exactly one tile carries the `active` class, and it is the clicked one;
- `#photo-name` names the selected photo's file;
- `window.__mosqAsync.selectedIndex` is the clicked photo's index;
- the viewer shows the photo — `#context-img` is visible with a `data:` source.

A selection that satisfies only the third of these is a defect: a user cannot see
`selectedIndex`, so an invisible selection is indistinguishable from a dead
thumbnail. **WRONG IN CODE** — an uncropped photo selects, but the zoomed panel
falls back to the same full frame for every uncropped photo, so switching between
two of them shows no visible change.

**R4.3 The badge states the photo's analysis state** as in §2, and its `title`
carries a full sentence. A badge reading `✕` alone is not sufficient — it must
also say that no mosquito was detected.

**R4.4 The delete button is enabled in every state.** Removing a photo must
always be possible, including mid-inference.

**R4.5 The checkbox is enabled exactly when `contributesToPool(p)`.** Per §2 that
means disabled for: pending, error, `fallback`, and non-mosquito. Enabled for:
cropped-and-decided, cropped-unsure, and uncropped-without-fallback.

**R4.6 A disabled checkbox explains itself.** Its own `title`, the wrapping
label's `title`, and the badge's `title` must each name the reason — the cause,
not a restatement of the state. A disabled control whose tooltips are empty or
say only "excluded" is a defect, because a control that silently ignores clicks
is indistinguishable from a broken one. **WRONG IN CODE** — the checkbox was
disabled with no reason anywhere on the tile.

**R4.7 A disabled checkbox does not offer a pointer cursor.** It must compute to
`not-allowed`, or the CSS default for disabled inputs, never `pointer`.

**R4.8 A checkbox click toggles exactly one photo.** The photo whose tile was
clicked, and no other. `includedIndices` must change by at most one entry, and
that entry must be the clicked photo's. **WRONG IN CODE** — see §5.

**R4.9 The combined card reflects inclusion immediately.** Toggling a checkbox
updates `#combined-scores` and `#contribution-table` within the same frame as the
checkbox's own checked state.

## 5. Index stability

A tile's index changes whenever a photo before it is deleted. Tile *nodes* are
keyed by the photo object and reused across renders, which is what keeps the
encode cache warm and the layout still — so a node outlives the index it was
built with.

> **R5.1** Every handler on a tile must resolve the clicked photo's index at
> click time. No handler may capture an index in a closure at build time.

Concretely: `delBtn.onclick`, `btn.onclick`, and `chk.onchange` must all be
(re)assigned on every render, in the same place, for the same reason. The index
used must be the index of `previews.indexOf(the photo this node is showing)`.

**R5.2** A tile's `aria-label` names the photo it currently shows, by its
current position: `View photo N: <filename>`. **WRONG IN CODE** — the label was
correct while the handler behind it was not, which is why the bug presented as
"clicking one gets another".

**R5.3** After any deletion, each remaining tile's delete button, select button
and checkbox must act on the photo that tile's own label names.

**R5.4** `includedIndices` is renumbered on deletion: an index below the deleted
one is unchanged, an index above it decrements.

**R5.5** Selection follows the photo, not the number. Deleting a photo *before*
the selected one moves the selection down by one; deleting the selected one
selects the photo now at that position.

## 6. Accessibility

**R6.1** The checkbox has an accessible name naming the photo and the action —
it must not be an unnamed box. The tile's `.include` label currently carries a
tooltip; the accessible name must be reachable by a screen reader.

**R6.2** The select button and the delete button each have an accessible name.
The select button's is the `aria-label` from R5.2; the delete button's names the
photo it removes.

**R6.3** Tab order within a tile is: select button, delete button, checkbox. All
three are reachable by keyboard, and each is operable by keyboard alone.

**R6.4** The badge's state is exposed in text, not only in its `title`. The
select button's `aria-label` and the badge together let a screen reader user
distinguish a cropped photo from an uncropped one.

**R6.5** The `active` class is the visual selection indicator and must have a
programmatic equivalent — `aria-current` on the select button, or equivalent.

## 7. Non-goals

The strip is not:

- a place to name a species. Verdicts live in the score panel and the results
  table; the strip shows state, not conclusions;
- draggable or reorderable. Photos are added by drop and removed by delete; there
  is no manual ordering;
- a place to edit a photo. Cropping happens in the viewer surfaces;
- virtualised. A ten-photo batch is the expected size and the strip scrolls
  horizontally;
- animated beyond CSS transitions on tile state. No reordering animation is
  wanted; the strip must not move when a photo is deleted.

## 8. Rationale

Why the rules that are not directly observable:

- **Tile nodes are reused** (keyed by photo) so a re-render costs ~1.3 ms instead
  of ~1216 ms. The re-render re-encodes every thumbnail as a JPEG if the nodes
  are rebuilt, which is the frozen UI. `npm run test:render` guards the budget.
- **A disabled control must say why.** This is the whole of R4.6. The reason a
  tile cannot be pooled is genuinely interesting to the person looking at it — a
  photo they photographed has nothing in it the detector could find — and hiding
  that converts an informative result into a broken-looking one.
- **`fallback` must not contribute to a pool** (R3.2) because the fusion step sums
  a photo's evidence into a claim about a mosquito. This is the invariant that
  matters most on this strip, and it is why the checkbox is disabled rather than
  silently ignored.
- **Ablation, not refinement:** a photo that is neither cropped nor classified has
  no verdict, so the pool has nothing to gate on. Rather than inventing a default,
  it is excluded and named.