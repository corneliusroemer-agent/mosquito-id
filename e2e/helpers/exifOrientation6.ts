/**
 * A JPEG whose EXIF orientation tag is 6 ("rotate 90 CW to display").
 *
 * WHY THIS FILE EXISTS: the classifier's decode path is `createImageBitmap` and a
 * `drawImage`, and EXIF orientation is the one part of that path which changes
 * the PIXELS rather than only the sampling. A phone photo shot in portrait is
 * stored landscape with tag 6, so a decode that skips orientation hands the head
 * a sideways picture. This fixture is the only thing in the suite that pins that.
 *
 * It is built in the page rather than committed as a binary because the EXIF has
 * to be spliced in by hand: `canvas.toBlob` writes no EXIF at all, so a JPEG made
 * that way is tag-less and every orientation assertion would pass vacuously.
 * `ORIENTATION_TAG_6` below is a real APP1/Exif block, little-endian (`II`, 42,
 * one IFD entry, tag 0x0112 = Orientation, type SHORT, count 1, value 6) and
 * inserted immediately after the SOI marker, which is where the spec requires it.
 *
 * The picture itself is deliberately asymmetric so a rotation is UNAMBIGUOUS:
 * the stored LEFT half is red, the stored RIGHT half is blue, and the stored TOP
 * strip is white. After a 90 CW display rotation the stored-left (red) half is on
 * TOP, so a correct decode reads red-on-top and blue-on-bottom. A decode that
 * ignored orientation reads red-on-LEFT; a double rotation reads blue-on-top.
 * A half-grey symmetric image cannot tell these apart.
 */
export const ORIENTATION_TAG_6 = [
  0xff, 0xe1, 0x00, 0x22,             // APP1, Exif, payload length 34
  0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
  0x49, 0x49, 0x2a, 0x00,             // little-endian TIFF header, magic 42
  0x08, 0x00, 0x00, 0x00,             // offset of IFD0
  0x01, 0x00,                         // one directory entry
  0x12, 0x01,                         // tag 0x0112 = Orientation
  0x03, 0x00,                         // type 3 = SHORT
  0x01, 0x00, 0x00, 0x00,             // count 1
  0x06, 0x00, 0x00, 0x00,             // value 6 = rotate 90 CW
] as const;

/** In the page: an 1800x1200 JPEG (stored landscape) carrying EXIF orientation 6. */
export const MAKE_EXIF6_FILE = `
(async () => {
  const cv = document.createElement("canvas");
  cv.width = 1800; cv.height = 1200;
  const g = cv.getContext("2d");
  g.fillStyle = "#d22"; g.fillRect(0, 0, 900, 1200);      // stored LEFT  = red
  g.fillStyle = "#22d"; g.fillRect(900, 0, 900, 1200);     // stored RIGHT = blue
  g.fillStyle = "#fff"; g.fillRect(0, 0, 1800, 120);       // stored TOP   = white
  const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", 0.95));
  const jpg = new Uint8Array(await blob.arrayBuffer());
  const exif = ${JSON.stringify(Array.from(ORIENTATION_TAG_6))};
  const bytes = new Uint8Array(jpg.length + exif.length);
  // Splice after the 2-byte SOI, which is where APP1 must sit.
  bytes.set(jpg.subarray(0, 2), 0);
  bytes.set(exif, 2);
  bytes.set(jpg.subarray(2), 2 + exif.length);
  return new File([bytes], "exif-orientation-6.jpg", { type: "image/jpeg" });
})()
`;
