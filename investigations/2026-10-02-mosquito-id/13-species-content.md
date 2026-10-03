# Species guide content: distinguish, lookFor, blurb

Filled the empty prose in `10-github-pages/site/species-data.json` for the 13
species that had none. Data-only change; `main.js`, `index.html` and `species.js`
untouched. Live at `https://corneliusroemer-agent.github.io/mosquito-id/#/species/<slug>`.

## What the renderer actually consumes

`species.js` `render()` reads, in order: `genus`, `name`, `common`, `blurb`,
`images[]`, then a four-row `At a glance` block from `vectors` / `range` /
`activity` / `hosts`, then `distinguish`, `lookFor`, `notes`, `local`, `wiki`,
`seeAlso`.

Two things this settles:

- **`distinguish` and `lookFor` each render as a single `<p class="kb-lead">`.**
  There is no list markup and no `\n` handling — `esc()` runs but the browser
  collapses whitespace, so **a bulleted or numbered string would come out as one
  run-on line.** I wrote both as prose with sentence-per-character, in field
  order, for that reason. If you ever want a scannable checklist here, that needs
  markup in `species.js` (routing request below).
- **`notes` is a separate later section and already populated on all 16.** I did
  not touch it.

`blurb` was empty on 14 of 16 (only Ae. albopictus, Cx. pipiens and An. plumbeus
had one). It renders as the lead paragraph directly under the title, so it was
part of "the empty species content" and I filled it too.

## Size is not rendered — routing request

**There is no `size` rendering anywhere in the app.** `grep -n size` on `main.js`
returns only model-file byte counts (the 172 MB / 1.2 GB / 638 MB clip tensors in
the asset table) and JS `Set.size`; `index.html` hits are all CSS `font-size`.
No `mm`, no measurement row.

So I did **not** add a `size` field — nothing would consume it, and the renderer
ignores unknown keys silently, so it would ship 16 unused strings to every visitor.
Adding the data later is then a one-line JSON change; adding it now and rendering
it later is two. Your call, but the render path has to be built either way.

Suggested shape if you route it, since `fact(label, value)` already exists in
`species.js` and takes a plain string:

```
h.push(fact("Size", sp.size));
```

with `size` as a short honest string. The numbers I would use, at
**adult body length, proboscis excluded**, all of them broad on purpose because
sex, blood-fed state and temperature all move them:

| Species | mm | confidence |
|---|---|---|
| Ae. aegypti | 4–6 | high |
| Ae. albopictus | 4–6 | high |
| Ae. cinereus | 6–7 | **low** |
| Ae. geniculatus | 6–7 | medium |
| Ae. japonicus | 4.5–6 | **low** — see below |
| Ae. koreicus | 4–5 | **low** |
| Ae. vexans | 5–7 | high |
| An. claviger | 4–6 | high |
| An. maculipennis | 4–6 | high |
| An. plumbeus | 4–6 | high |
| Cx. pipiens | 4–6 | high |
| Cx. quinquefasciatus | 4–6 | high |
| Cx. torrentium | 3–6 | medium |
| Cs. annulata | 6–7 | high |
| Cs. longiareolata | 4–6 | medium |
| Cs. morsitans | 5–6 | medium |

Wingspan I would leave out — for mosquitoes it is not independently measured in
field guides, and it is almost entirely a function of the body length already
listed, so it would add precision without adding information.

**Ae. japonicus is the one to be careful with.** The existing `notes` field calls
it "Large dark mosquito", but ECDC and the European literature describe it as
roughly the size of A. albopictus, which is 4–6 mm. "Large" there means large
*relative to albopictus and aegypti*, not large in absolute terms. If you add a
size row, that species will read as contradictory next to its own notes field, and
it would be worth reconciling the two at the same time.

## Which species are genuinely hard to separate

Three pairs, and they are hard in different ways. This matters for how much the
guide should claim:

**Cx. pipiens / Cx. torrentium — not separable by eye, at all.** Both plain brown,
no banding, same resting behaviour, same legs. The literature separates them on
wing-scale pattern and male terminalia, neither of which a photograph resolves.
The classifier collapsing them onto one label is therefore correct on the
merits, not a model limitation. I wrote both pages to say so. This is also why
I did *not* invent a field character to paper over it.

**Ae. japonicus / Ae. koreicus — same problem, and worse because it matters.** Both
are dark, bronze-scaled, thoracic-unmarked, leg-unbanded. Every coarse character
used elsewhere on this list is useless here. They are kept apart in the literature
by fine leg scaling and male terminalia. I wrote both to decline the call rather
than guess, and to point at what would actually settle it.

**Ae. cinereus / Ae. vexans — separable, but not from a thumbnail.** Both plain
brown Aedes of wetland habitat. The thoracic stripes on vexans are the real
character; cinereus genuinely lacks them. That is a defensible difference, but it
needs the thorax resolved.

Contrast with the pairs that *are* cleanly separable, because these are what make
the guide worth reading: **Ae. aegypti vs Ae. albopictus** (lyre mark vs single
stripe; hind legs banded in one and plain in the other) and
**An. claviger vs An. maculipennis** (unspotted vs black-patched wings). Those
are two-character calls anyone can make from a decent photograph.

**Cs. morsitans** is the awkward one: its real rival is **Cs. annulifera**, which is
not in the 16-species list at all. Morsitans belongs to the annulifera species
group and cannot be separated from it on anything visible. Its own page only makes
easy calls (size vs longiareolata, leg rings vs annulata); against annulifera it
has nothing going for it, and I said that rather than inventing a character.

## Where the field guides disagree, or where I hedged

- **Cx. quinquefasciatus vs Cx. pipiens.** The abdominal and tarsal band characters
  do exist in the literature, but their reliability is contested and they are the
  kind of thing field guides state inconsistently. I gave the bands as the stated
  difference and then said plainly that in temperate Europe the call is academic —
  quinquefasciatus is not going to be the right answer to a European photograph.
  That framing protects a user more than a confident band rule would.
- **Ae. japonicus "appears earlier in the season".** I kept this, it is
  well-supported and follows from its cold tolerance, but phrased as a
  consequence of the temperature ecology rather than as a free-standing fact.
- **Ae. cinereus thoracic pattern.** I described it as bland and unbanded, which is
  safe, and explicitly declined to give a fine character against Ae. vexans. There
  is a real published separation but it rests on scale pattern and male terminalia.
- **Sources.** I did not add a `_sources` key to the JSON. The renderer ignores
  unknown keys, so it would ship to every visitor and never display — and the
  sources are recorded here instead. If you want per-species attribution visible
  to readers, that is a markup change too.

## Two things I found that are not mine to fix

1. **Photo credits are not rendering.** `species.js` reads `im.licenceUrl` and
   `im.sourceUrl`, but `species-data.json` stores **`licence_url`** and
   **`source_url`** (snake_case). The licence and source links are therefore
   silently absent from all 40 captions. This is a live CC BY / CC BY-SA
   attribution problem, not just cosmetic: several of those images require naming
   the author, licence and source. Either rename the JSON keys or the renderer
   reads. The JSON is mine so I could do it, but the cleanest fix is probably in
   `species.js` since the snake_case keys are what the extraction script wrote —
   your call, and I did not want to guess which convention the other work expects.

2. **Five species have no photographs at all**, contrary to the brief I was given
   ("images populated for all 16"). In fact 40 images cover 11 species;
   `Ae. cinereus`, `Ae. koreicus`, `Cx. torrentium`, `Cs. longiareolata` and
   `Cs. morsitans` have no `images` key at all, and their pages render no gallery.
   Worth noting the awkward overlap: the three species I found hardest to write
   honestly about (koreicus, torrentium, morsitans) are three of the five with no
   picture, so those pages lean entirely on prose. `species.js` handles the
   no-image case cleanly by design, so nothing breaks — the pages are just thinner.

## Verification

- `species-data.json` round-trips byte-identically through
  `json.dumps(indent=2, ensure_ascii=False)`, so the edit moved only content.
- `git diff --stat`: **39 insertions, 39 deletions** in one file, exactly
  3 fields × 13 species.
- `images`, `name`, `slug`, `common`, `genus`, `wiki`, `vectors`, `range`,
  `activity`, `hosts`, `notes`, `seeAlso`, `local` all confirmed identical to
  HEAD, and key order preserved.
- All 16 species now have non-empty `blurb`, `distinguish` and `lookFor`.
- Parses under `node`; no `<`, `>`, `&` or newlines in any prose field. The only
  escaped character is the apostrophe, which renders correctly as `&#39;`.

## If you want it further

Not done, and deliberately: no numbers in the prose itself (a guide that says
"4–6 mm" in a sentence readers cannot act on is worse than one that points at the
size row), and no list markup, because the renderer would flatten it.
