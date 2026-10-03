# 01 — Specimen and images

One specimen, ten photographs. Driving script: `01-exif/prepare.py` (EXIF + downscale),
`01-exif/crop.py` / `01-exif/crop2.py` (auto-crop).

## Source images

`/Users/cr/code/claude-devcontainer/tmp/mosquitoes/` — all JPEG from a Pixel 10 Pro XL.
Full table with GPS per image: `01-exif/exif.tsv`.

| Fact | Value |
|---|---|
| Taken | 2026-10-02, 20:24–20:27 local (CEST), dusk; indoor desk-lamp shots |
| Location | 47.56448 N, 7.57717 E — Basel (all PXL frames identical to ~3 m; the WhatsApp frame has no GPS) |
| Specimen | one mosquito, dead, on white paper/wall; one frame in a plastic cup (`IMG-…-WA0007`) |
| Resolution | 4080×3072 to 8160×6144 (50 MP frames) |

The WhatsApp image (`IMG-20261002-WA0007.jpeg`) is time-stamped 20:24, a minute before the PXL
series, and carries no GPS — likely forwarded from another phone; treated as the same specimen
per Cornelius.

## Prepared derivatives

Under `/Users/cr/code/claude-devcontainer/investigations/2026-10-02-mosquito-id/02-images/`:

- `small/` — long edge 1600 px, EXIF-rotated (API-sized inputs)
- `tiny/` — long edge 800 px (overview)
- `crops/` — 10 auto-cropped mosquito details at up to 1400 px, cut from the full-resolution
  originals (blob detection: compact dark component nearest frame centre; `crop2.py`)
- `scutum/` — two hand-placed full-resolution zooms on head/thorax of the two sharpest frames
  (`PXL_20261002_182741226`, `PXL_20261002_182720758`)

Blur note: the four 50 MP lamp frames (182614990, 182628741, 182632161, 182639488) are
motion-blurred; the sharpest frames are 182720758 (50 MP→4080 macro?), 182741226 and 182754446.
Auto-crop on `PXL_20261002_182628741` grabbed the lamp, not the insect (blob touches frame top) —
exclude that one crop from classification inputs.

## Examiner morphological read (one data point, low weight)

From the crops: dark mosquito; abdomen dark with **white scale spots** (spot pattern, not pale
basal bands); legs with **pale bands**; wings dark-edged. This rules the specimen away from
Culex-type markings and marks it as Aedes-type; species call (albopictus vs aegypti vs
japonicus/koreicus) needs the scutum pattern, which the side-lit crops only partially show.
Recorded for comparison against the dedicated models — not as an answer.
