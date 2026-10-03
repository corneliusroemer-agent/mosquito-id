# Thumbnail strip — behaviour specification

The strip is the row of tiles under the gallery: one tile per photo, each with a
select button, an include checkbox and a delete button. This document states what
each of those does in every state a photo can be in, so a change to the strip can
be checked against a written target rather than against whatever it did last.

It is a specification, not a description. Where current behaviour is wrong, the
line says so and the wrongness is marked **[wrong today]**. The tests in
`tests/thumbnail-strip.test.ts` and `e2e/thumbnail-strip.spec.ts` are written
against this document; a test and this document disagreeing means one of them is
out of date, and that is the bug to fix first.

Terminology used throughout:

- **photo** — one uploaded image and everything derived from it (crops, verdict,
  error). Identified by its record object, never by its position.
- **index** — a photo's current position in `previews`, 0-based. Valid only at the
  instant it is read.
- **tile** — the DOM for one photo, cached across renders and keyed by the photo
  record.

---

## 1. Photo states

A photo is in exactly one of these states. `state` is derived, never stored.

| # | State | `pending` | `error` | `fallback` | `verdict.state` | Has pixels? |
|---|-------|-----------|---------|-----------|-----------------|-------------|
| S1 | **queued** | `true` | `null` | `false` | `null` | no |
| S2 | **cropped** — analysed, a mosquito was found and cropped | `false` | `null` | `false` | `species` \| `genus` | yes |
| S3 | **uncropped** — analysed, no crop was made (no detection, or the nuisance gate fired) | `false` | `null` | `true` | `null` | yes |
| S4 | **error** | `false` | truthy | `false` | `null` | maybe |
| S5 | **non-mosquito** — analysed, the gate says this is not a mosquito | `false` | `null` | `false` | `non-mosquito` | yes |
| S6 | **unsure** — analysed, too weak to name a genus | `false` | `null` | `false` | `unsure` | yes |

S3 and S5 are not the same. S3 means *no crop was made*; the photo may still be
pooled on its whole frame only if the crop engine did not fire the nuisance gate.
S5 means *the photo was analysed and it is not a mosquito*, and it never pools.

### 1.1 The three predicates

Every enabled/disabled decision in the strip is one of exactly three predicates.
They are separate functions, they are named for the question they answer, and no
call site is allowed to use one in place of another. **[wrong today: a single
`isSelectable()` answers "can this be viewed?" and "may this be pooled?" at once,
which is why a fallback photo cannot be toggled and why a non-mosquito photo is
described as includable.]**

| Predicate | Question | Answer |
|---|---|---|
| `canView(p)` | May the user select this photo? | **Always `true`.** Every photo is viewable. A photo that failed or has not been analysed is exactly the one whose state the user needs to see. |
| `canCheck(p)` | Is the include checkbox enabled? | `!p.fallback && !p.pending && !p.error && p.verdict?.state !== "non-mosquito"` |
| `contributesToPool(p)` | If checked, does this photo enter the pooled sum? | `!p.pending && !p.error && (p.verdict?.state === "species" \|\| p.verdict?.state === "genus")` — that is, whatever `splitPoolable` does. |

`canCheck` is deliberately the *looser* of the two pooling predicates: a photo
whose verdict is `unsure` (S6) may be checked, because deciding not to trust it is
the user's call, and is then listed in the contribution table as excluded with its
reason. `canCheck` is a permission, not a promise.

**Must never happen:** a photo for which `canView` is false. There is no such
photo. **[wrong today: `chk.disabled = !isSelectable(p)` makes the include
checkbox the only place the "can this be viewed" question is answered, and a
fallback photo therefore reads as unviewable even though its tile button works.]**

**Must never happen:** `canCheck` and `contributesToPool` drifting apart silently.
Where they differ (S6) the difference is stated on the checkbox's own tooltip, in
its accessible name, and in the contribution table.

---

## 2. Selection and inclusion are two different decisions

> **Selecting** a photo is how you look at one. **Checking** a photo is how you let
> it contribute to the combined result. They are independent: a photo can be
> selected without being checked, a checked photo need not be selected, and a
> photo that cannot be checked is still selectable.

Consequences, all of which are checked by tests:

- Selecting a tile never changes `includedIndices`.
- Toggling a checkbox never changes `selectedIndex`.
- `Select all` / `Select none` / `Delete all` never change `selectedIndex`
  (`Delete all` resets it to 0, because there is nothing left to be on).
- A photo's checked state survives selecting another photo, and survives an
  unrelated re-render.

---

## 3. Per-state, per-element behaviour

`enabled` = accepts a click. `visible` = rendered. "why" is the string that must
appear in **both** the `title` attribute and the element's accessible name.

### 3.1 Tile

| State | Thumbnail image | `aria-label` on select button | Selectable | Why (title) |
|---|---|---|---|---|
| S1 queued | grey placeholder block, no `src`, empty `alt` | `View photo N: name` | yes | — |
| S2 cropped | the crop | `View photo N: name` | yes | — |
| S3 uncropped | the full frame | `View photo N: name` | yes | — |
| S4 error | placeholder if no pixels, else the full frame | `View photo N: name` | yes | — |
| S5 non-mosquito | the full frame or the rejected crop | `View photo N: name` | yes | — |
| S6 unsure | the crop | `View photo N: name` | yes | — |

The select button is **never** `disabled`, in any state. It carries
`aria-current="true"` when this photo is the selected one and no `aria-current`
otherwise, so a screen reader announces the selection without relying on the
border. The index in the label and the number badge are both 1-based and both
track the photo's current position.

**Must never happen:** a tile whose visible number, `aria-label` and bound index
disagree.

**Must never happen:** a click on a tile selecting a different photo than the one
whose tile was clicked. **[wrong today: the select button's handler closes over
the index captured when the tile was built, so a tile reused after an earlier
deletion selects the wrong photo — clicking the tile labelled "View photo 2:
photo_C.jpg" selects `photo_D`.]**

### 3.2 Select button — what a click does

1. Set `selectedIndex` to **this photo's current index**, read at event time.
2. Re-render the strip, the viewer and the pooled card.
3. Scroll this tile into view inside the strip (see §5).
4. **Must never** change `includedIndices`.

### 3.3 Include checkbox

| State | `enabled` | `checked` | Why (title + accessible name) |
|---|---|---|---|
| S1 queued | no | no | `Waiting for this photo to be analysed` |
| S2 cropped | **yes** | as set by the user | `Include photo N (name) in the pooled result` |
| S3 uncropped | no | no, and any existing check is dropped | `No usable crop was found, so this photo cannot be pooled` |
| S4 error | no | no, and any existing check is dropped | `This photo failed: <error>` |
| S5 non-mosquito | no | no, and any existing check is dropped | `The classifier found no mosquito in this photo` |
| S6 unsure | **yes** | as set by the user | `Include photo N (name) in the pooled result — it will be listed as not confident enough to name a genus` |

The checkbox always has an accessible name, in every state, whether enabled or
not. **[wrong today: the checkbox is a bare `<input>` inside a `<label>` that
contains no text, so it has no accessible name at all, in any state.]**

**Must never happen:** a disabled checkbox whose tooltip says it can be included.
**[wrong today: queued, errored and non-mosquito photos all carry the title
"Include this photo in pooled result" while being disabled.]**

**Must never happen:** a badge whose `title` is empty. **[wrong today: the queued
badge's title is the empty string, so hovering it explains nothing.]**

A click on the checkbox must change **this** checkbox's state and no other.
**[wrong today: the checkbox's `change` handler closes over the build-time index
too, so after a deletion clicking one box toggles a different tile's box.]**

### 3.4 Delete button

| State | `enabled` | Accessible name | Effect |
|---|---|---|---|
| any, with photos | **yes** | `Remove photo N: name` | delete **this** photo, no confirmation |
| any, no photos | the tile does not exist | — | — |

**Must never happen:** a delete button bound to a stale index.
**[wrong today: the delete handler is re-pointed on every render, so it happens
to be correct — this is the asymmetry that let the other two handlers go
unnoticed, and it must stay re-pointed or become index-free like them.]**

Deleting a photo:
- removes it from `previews` and from the DOM;
- removes its index from `includedIndices` and decrements every index greater than
  the deleted one, by exactly one;
- moves `selectedIndex` by −1 if the deleted photo was before it, clamps it to the
  last photo if the deleted photo was the last one, and leaves it alone otherwise
  (the deleted photo was the selected one, so the next photo takes its place);
- re-renders the strip, the viewer, the pooled card and the results table.

**Must never happen:** `includedIndices` holding an index that is not a valid
index after a delete. `renderThumbnails` re-validates the set on every render and
drops anything out of range, so no other code path can leave a dangling index for
the pooled card to trip over.

### 3.5 Badge

The badge is the only place a photo's own verdict is visible without selecting it.
Its `title` is never empty, and it distinguishes *the photo is not a mosquito*
from *no crop was made*, which the current badge does not.

| State | Glyph | `title` |
|---|---|---|
| S1 queued | `…` | `Waiting for this photo to be analysed` |
| S2 cropped | `✓` | `Mosquito detected and cropped` |
| S3 uncropped | `✕` | `No crop was made — the whole photo is used` |
| S4 error | `!` | the error text |
| S5 non-mosquito | `✕` | `No mosquito detected in this photo` |
| S6 unsure | `?` | `Detected, but not confidently enough to name a genus` |

**[wrong today: S5 gets the green cropped `✓` and the title "Mosquito detected &
cropped", which asserts the opposite of what happened.]**

### 3.6 Bulk actions

| Button | Enabled when | Effect | Accessible name |
|---|---|---|---|
| `Select all` | ≥1 photo | check every photo where `canCheck`, uncheck the rest | `Check all photos that can be pooled` |
| `Select none` | ≥1 photo | uncheck every photo | `Uncheck all photos` |
| `Delete all` | ≥1 photo | delete every photo, clear `includedIndices`, reset `selectedIndex` to 0 | `Delete all photos` |

All three are `disabled` with the gallery hidden when there are no photos. When
disabled, each states why in its `title`: `No photos to act on`. **[wrong today:
they are disabled and say nothing.]**

`Select all` uses `canCheck`, so a queued or non-mosquito photo is left unchecked
rather than being checked and then refused by the pooled card.

---

## 4. Index stability

**The invariant.** A tile's DOM is keyed by the photo record and outlives any
particular index. Every handler that needs an index reads the tile's *current*
index at event time. No index is ever captured in a closure.

Concretely, `renderThumbnails` writes the current index onto the cached tile node
on every render, and each of the three handlers reads that field when it fires.
Handlers are therefore bound exactly once, when the tile is built, and are never
re-bound. This is what makes the reuse invisible and the index correct at the same
time.

**What is captured at build time:** only things that cannot change for a given
photo record — the element references themselves.

**What is written on every render:** the photo's current index; the class list;
every `title`, `aria-label`, `aria-current`, `textContent` and `src`; the
checkbox's `checked` and `disabled`; the strip's child order.

**Why keying by index is wrong:** `deletePhoto(0)` shifts every later photo down
one, so a tile cached under index 1 now shows the photo that was at index 0.

**What must never happen:** an index surviving in a closure across a render. This
invariant's absence caused three of the six bugs in the July audit (wrong tile
selected, one checkbox toggling another, the pooled card counting fewer photos
than were checked).

**What must never happen:** `includedIndices` naming a photo other than the one
whose checkbox is checked. The e2e suite asserts the two agree after every delete.

---

## 5. Layout

- The strip is `overflow-x: auto` and its tiles are `flex-shrink: 0`. The strip
  never wraps and never changes height.
- **Selecting a tile scrolls it into view within the strip** — by adjusting the
  strip's own `scrollLeft` and nothing else. A selected tile that is off-screen
  gives the user no evidence that anything happened, which is the same defect as
  a click that visibly does nothing. **[wrong today: `selectPhoto(13)` on a
  14-photo strip leaves the selected tile at `offsetLeft` 996 in a 866px-wide
  strip with `scrollLeft` 0 — entirely off-screen.]**
- **Cumulative Layout Shift stays 0** across: adding photos, every selection
  change, every checkbox toggle, every single delete, and delete-all. The
  viewer's "nothing to show" area has a reserved height, so swapping the message
  it carries never resizes the panel.
- No element is absolutely positioned over a neighbour. The delete button sits
  within its own tile and, in the tab order, comes after the two controls that
  are not destructive.

---

## 6. Accessibility

- **Focus order** within a tile: select button → include checkbox → delete
  button, matching the visual top-to-bottom order and putting the destructive
  action last. **[wrong today: the delete button is the first child of the tile
  and so the first thing Tab reaches.]**
- **Accessible names.** The select button's name is `View photo N: name`; the
  delete button's is `Remove photo N: name`; the checkbox's is
  `Include photo N (name) in the pooled result`, extended with the reason when
  the checkbox is disabled. Every control has a name in every state.
- **The checkbox is labelled by an explicit `<label for>`/`<input id>` pair**,
  with the label's text present in the accessibility tree. There is no
  `<button>` inside a `<label>`, and the tile is not a label's ancestor.
- **Keyboard.** The strip is a single tab stop: `Tab` moves into and out of it,
  and `←`/`→` move the selection between tiles (with `Home`/`End` for the first
  and last). `Enter` or `Space` on a focused tile selects it; `Space` on a
  focused checkbox toggles it. Every action reachable by mouse is reachable by
  keyboard.
- **Announcement.** The selected tile carries `aria-current="true"`; no state is
  communicated by colour or border alone.

---

## 7. What the strip deliberately does not do

These are not gaps. A later change that adds one of them is a different feature
and needs its own decision.

1. **No drag-to-reorder.** Order is upload order, newest batch first. Reordering
   would make indices unstable in a way the app has no other reason to be.
2. **No multi-select of tiles.** One photo is viewed at a time.
3. **No swipe, no long-press, no context menu.** Pointer and keyboard only.
4. **No per-tile zoom, rotate or crop handle.** Cropping happens on the viewer
   surfaces.
5. **No persistence.** Nothing about the strip is stored; a reload starts empty.
6. **No virtualisation.** Tiles are cached and reused, never recycled out of a
   window — a strip of a few hundred photos is not a case this app has.
7. **No change to the pooling arithmetic.** `splitPoolable`, the weights and the
   pooled gate are the confidence module's, and the strip does not second-guess
   them. Where the strip disagrees with the pooled card it is because a photo is
   checked but not contributing, and it says so.
8. **No change to the results table, the crop engine or the classifier.**
9. **No new colour.** State is carried by glyph, class and text.

---

## 8. Marked: current behaviour that this document declares wrong

| # | Current behaviour | Declared |
|---|---|---|
| 1 | `isSelectable(p)` answers "can be viewed" and "may be pooled" at once; a fallback photo's checkbox is disabled as a side effect | §1.1 — three predicates, `canView` always true |
| 2 | The select button closes over its build-time index; a reused tile selects the wrong photo | §3.2, §4 — read the index at event time |
| 3 | Selecting a photo that is not visible in the strip changes nothing on screen; a queued photo's viewer says "No mosquito detected" when nothing has been detected | §3.1, §5 — scroll into view, truthful message |
| 4 | Clicking one checkbox toggles a different tile's checkbox | §3.3, §4 — same root as 2 |
| 5 | Three checked boxes, pooled card counts fewer photos: the strip writes indices the pooled card cannot resolve, and `updatePooling` silently drops the unresolvable ones | §3.4, §4 — indices re-validated every render; the card states how many checked photos contribute |
| 6 | A disabled checkbox advertises inclusion; the queued badge's title is empty; a non-mosquito photo shows a green "Mosquito detected & cropped" | §3.3, §3.5 — every disabled control says why |
| 7 | The checkbox has no accessible name in any state | §6 |
| 8 | The delete button is the tile's first child, so it is the first tab stop | §6 |
| 9 | The bulk-action buttons are disabled with no explanation | §3.6 |
| 10 | A selected tile is not scrolled into view | §5 |

---

## 9. Rationale — the parts that are not testable, and why they are stated

**Why the strip owns index validity rather than the pooled card.** `updatePooling`
takes indices and maps them to photos. It cannot tell an index that was stale from
one that is simply wrong, and it must not throw when it meets either, because it
runs on a timer-driven re-render. The strip is the only writer of
`includedIndices`, so the strip is where an index is made valid: it re-validates
the set on every render. `updatePooling` keeps its existing silent filter as a
defence, but nothing should ever reach it.

**Why `canView` is unconditionally true.** A photo that cannot be viewed is a
photo whose state the user cannot inspect, and the states that are hardest to
reason about — failed, not yet analysed, not a mosquito — are precisely the ones
that need inspecting. Costing a rendering of the panel for those is the right
trade; there is no photo state in which an empty panel is more useful than a
panel that says what happened.

**Why a checked-but-not-contributing photo stays checkable.** The pooling rule
that a photo with no nameable genus does not enter the sum is the confidence
module's and is not the strip's to relax. But the user's decision to include a
photo is theirs, and silently unchecking a box they ticked is worse than
accepting a photo and saying so. Hence the checkbox is enabled, the contribution
table lists the photo as excluded with its reason, and the pooled card states
both counts.

**Why the delete button keeps no confirmation.** One press removes one photo
without asking, and the bulk action matches it. This is recorded because the
asymmetry is the kind of thing that reads as an oversight, and a strip where
deleting one asks but deleting all does not is not cautious, it is inconsistent.

**What the tests cannot reach.** The classifier and the detector are fetched from
R2 at runtime and are not available to the test suite, so a tile cannot be driven
into S2 through the real pipeline in CI. The e2e suite therefore injects photo
records covering every state in §1 and drives the *strip*, which is what this
document specifies; the confidence arithmetic behind `contributesToPool` is
covered by `tests/pooling-equivalence.test.ts` and `tests/gate.test.ts`. The
`text_embeds*.json` files are deliberately **not** aborted in the strip e2e: the
pooled card needs a head, and aborting them means the render path under test
never runs.
