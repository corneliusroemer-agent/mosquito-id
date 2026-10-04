# Why a thumbnail is encoded at thumbnail size

The thumbnail strip shows 30 photos as 64 px tiles (84 px on the phone
breakpoint). Each tile is an `<img>` whose `src` is a JPEG data: URL, and
`renderThumbnails` (`src/app/main.js`) builds it with `thumbnailUrl`
(`src/app/canvasCache.ts`).

`thumbnailUrl` **resizes the source before it encodes it**. That is the whole
design, and it is the opposite of what the code did before it.

## What it was doing

`canvasUrl` encodes whatever canvas it is handed at that canvas's own
resolution. For a photo that is the full-resolution frame — 12.5 MP or 50 MP
from a phone — and the browser then downsamples the decoded frame to 64 CSS px
at composite time. So the extra resolution was never visible: it was only ever
paying for the encode.

Measured over the 30-photo corpus (`tmp/mosquito-id/30picsload.zip`), that was
**60 encodes at quality 0.8 covering 1209 megapixels**, twice per photo — once
before its crop exists and once after — for tiles that display 64 px. Largest
single tile data URL: **5.5 MB**.

## The numbers

Baseline and fix, alternating arms, 3 rounds each, same box, median of the three.
Full per-round figures are in `investigations/2026-10-02-mosquito-id/60-thumbnail-perf.md`.

| | before | after | |
|---|---|---|---|
| `toDataURL` | 11 685 ms | **154 ms** | −98.7 % |
| pixels JPEG-encoded | 1231 MP | **27 MP** | 45× less |
| tile data URLs (total) | 33.2 MB | **0.33 MB** | 102× less |
| `drawImage` | 6 707 ms | 12 260 ms | +83 % |
| non-inference | 20 543 ms | **13 991 ms** | −31.9 % |
| wall clock | 63 678 ms | 57 586 ms | −9.6 % |
| inference share of wall | 67.7 % | **75.7 %** | +8.0 pp |

**About half the encode saving reappears in `drawImage`,** and that is expected
rather than a regression: downscaling *is* a `drawImage`. The net is what
matters — non-inference work fell 6.5 s, which is roughly the 11.5 s of encoding
removed minus the 5.6 s of resampling added.

Note the pixel counter understates the resampling cost. The bench attributes a
`drawImage` its **destination** area, so the 30 thumbnail downscales that read
12.5–50 MP each are counted as if they were ~0.1 MP each. The 1890 → 1941 MP
move in that column is the real reason `drawImage` rises; the true read volume
behind it is much larger.

## Why it looks the same

Two things had to stay fixed, and both did.

- **JPEG quality is unchanged** at 0.8. The `quality` argument is the caller's
  and is passed straight through.
- **The tile's rendered dimensions are unchanged** — the same 64 px box with the
  same `object-fit: cover`. What changed is only the resolution the browser's
  own downsample starts from.

The thumbnails are encoded at a **252 px short edge** (84 CSS px at 3×). Short
edge, because `cover` scales a square tile by `max(boxW/w, boxH/h)` — it is
always the short edge that fills the box, whichever way the photo is oriented,
so sizing on the short edge keeps the tile's crop identical.

A source **larger than a 1024 px long edge** is shrunk through that intermediate
first, in two steps. One 50 MP → 252 px `drawImage` is a ~200× reduction and
aliases on fine detail; two steps do not. The intermediate is skipped when it
would leave less than 252 px on the short edge — on a 16384×600 panorama it
would leave 38 px, which is the whole downscale done badly, so that source
resamples once at the final size instead.

A source **already at or under the thumbnail size is not resampled at all** and
is encoded directly, so a small crop is never enlarged or softened.

### Measured, not asserted

Every tile's data: URL was captured from the running app in both arms, decoded,
`cover`-cropped to the tile's box, and compared pixel-for-pixel across all 30
photos:

| | at 64 px (1×) | at 192 px (3×) |
|---|---|---|
| PSNR min | 33.2 dB | 30.1 dB |
| PSNR median | 46.8 dB | 41.3 dB |
| PSNR mean | 45.0 dB | 40.2 dB |
| max abs pixel diff | 120/255 | 120/255 |

The worst cases are the 50 MP photos, where the browser's own downsample of the
full-res frame and the app's encode of a 252 px thumbnail differ most in the
high-frequency detail of a very fine subject. Nothing in the 30 looks different
to the eye; the differences are all in noise texture and JPEG ringing around
edges.

## The bug this first shipped with

The first version of this downscale reused **one** scratch canvas for the whole
two-step chain. Assigning `canvas.width`/`height` clears a canvas, so step two
erased step one's output and then drew that now-empty canvas onto itself. Every
two-step thumbnail encoded as a correctly sized, **entirely black** tile.

It was 20× faster and visually broken, and the timings alone could not tell — the
1-step path (a source already under the intermediate) was correct, so the unit
tests on the geometry passed and the app loaded without an error. It was caught
by decoding the tiles the app actually produced and looking at them.

Hence one scratch canvas **per step**, reused across every thumbnail
(`scratches` in `canvasCache.ts`). The unit test that pins the *geometry* would
not catch this class of bug on its own; what catches it is checking the pixels
out.

## Reproducing

```sh
npm run build && cp /path/to/30picsload.zip dist/
npx vite preview --host 127.0.0.1 --port <allowlisted> --strictPort &
node bench/thumb.mjs     # OUT=/tmp/run.json
```

`bench/thumb.mjs` wraps `toDataURL`, `drawImage`, `getImageData`, `createImageBitmap`
and the two inference sessions at runtime, and captures every tile `src`
assignment the app makes. It modifies nothing in `src/`.
