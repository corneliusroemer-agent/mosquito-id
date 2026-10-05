# EXIF orientation fixtures

One 2400x1800 photograph, written four times, differing only in EXIF
Orientation (`0x0112`, tag 274). No pixel of the stored image differs between
them; only the tag does, so any difference in what the app produces comes from
the orientation handling and from nothing else.

| file | orientation | what it does to the stored pixels |
|---|---|---|
| `exif1.jpg` | 1 | none - the identity, and the control |
| `exif3.jpg` | 3 | 180 degrees |
| `exif6.jpg` | 6 | 90 degrees clockwise, **transposing width and height** |
| `exif8.jpg` | 8 | 90 degrees counter-clockwise, transposing like 6 |

2400x1800 is deliberate: past `DISPLAY_MAX_EDGE` (2048), so the display-cap
resample in `displayCanvasFrom` is part of every path these exercise. A fixture
under the cap would return the source canvas and skip the resample that an
orientation change could disagree about.

The image is not a photograph and does not need to be. It is four flat
quadrants (red / green / blue / yellow) with two markers that no rotation or
flip leaves in the same place:

- a **white diagonal** along the stored top-left, and
- a **black block** in the stored bottom-right, off the diagonal.

Both a rotation and a 180-degree flip move them, so an unoriented decode and an
oriented one cannot produce the same pixels, and an orientation that is applied
but applied wrongly (3 where 6 belongs, say) is distinguishable from one that is
ignored. `e2e/tier1/exif-orientation.spec.ts` reads the pixels back and asserts
on them; the expected quadrants are stated there rather than stored here, so the
assertion is readable without decoding a JPEG by hand.

Regenerate with the `pattern()` in this directory's generator, or rebuild with
any tool that writes EXIF tag 274.
