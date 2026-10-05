import { boot, errors, expect, populate, settle, test } from "../helpers/app";
import type { Page } from "@playwright/test";

/**
 * The selected photo's viewer shows the original File through an object URL.
 *
 * It used to show `toDataURL("image/jpeg", 0.9)` of the full-resolution canvas: a
 * synchronous 12-50 MP JPEG encode on the click that selects a photo.
 */

const TWO = [
  { name: "photo_A.jpg", state: "species" as const },
  { name: "photo_B.jpg", state: "species" as const },
];

/**
 * Give each populated photo a real File (and a full-size canvas to go with it),
 * and record every toDataURL call with the size of the canvas it was made on.
 */
async function attachFiles(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const A = window.__mosqAsync!;
    const w = window as any;
    w.__encodes = [] as number[];
    const orig = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...a: any[]) {
      w.__encodes.push(this.width * this.height);
      return (orig as any).apply(this, a);
    };
    w.__revoked = [] as string[];
    const rev = URL.revokeObjectURL;
    URL.revokeObjectURL = (u: string) => { w.__revoked.push(u); rev.call(URL, u); };
    for (const p of A.previews) {
      const blob: Blob = await new Promise((r) => p.fullCanvas.toBlob((b: Blob | null) => r(b!), "image/jpeg", 0.9));
      p.file = new File([blob], p.name, { type: "image/jpeg" });
    }
  });
}

test.describe("active photo viewer", () => {
  test("selecting a photo shows its File by object URL and encodes no full-resolution canvas", async ({ page }) => {
    await boot(page);
    await populate(page, TWO);
    await attachFiles(page);
    await page.evaluate(() => { (window as any).__encodes.length = 0; });

    const r = await page.evaluate(() => {
      const A = window.__mosqAsync!;
      A.selectPhoto(1);
      A.selectPhoto(0);
      const full = document.getElementById("full-img") as HTMLImageElement;
      const ctx = document.getElementById("context-img") as HTMLImageElement;
      return {
        full: full.getAttribute("src")!.slice(0, 5),
        ctx: ctx.getAttribute("src")!.slice(0, 5),
        // The 2400x1800 fixture canvas is 4.3 MP; a tile thumbnail is ~0.06 MP.
        bigEncodes: ((window as any).__encodes as number[]).filter((n) => n > 1_000_000).length,
      };
    });
    expect(r.full).toBe("blob:");
    expect(r.bigEncodes).toBe(0);
    expect(errors(page)).toHaveLength(0);
  });

  test("a photo without a File still renders, from its canvas", async ({ page }) => {
    await boot(page);
    await populate(page, TWO);
    const src = await page.evaluate(() => {
      window.__mosqAsync!.selectPhoto(1);
      return document.getElementById("full-img")!.getAttribute("src")!.slice(0, 11);
    });
    expect(src).toBe("data:image/");
  });

  test("deleting a photo revokes its URL and only its URL", async ({ page }) => {
    await boot(page);
    await populate(page, TWO);
    await attachFiles(page);
    const r = await page.evaluate(() => {
      const A = window.__mosqAsync!;
      A.selectPhoto(0);
      const urlA = document.getElementById("full-img")!.getAttribute("src")!;
      A.selectPhoto(1);
      const urlB = document.getElementById("full-img")!.getAttribute("src")!;
      A.deletePhoto(0);
      return { urlA, urlB, revoked: [...(window as any).__revoked] };
    });
    expect(r.urlA).not.toBe(r.urlB);
    expect(r.revoked).toContain(r.urlA);
    expect(r.revoked).not.toContain(r.urlB);
    // the survivor is still showing, with its URL intact
    const after = await page.evaluate(() => document.getElementById("full-img")!.getAttribute("src"));
    expect(after).toBe(r.urlB);
  });

  test("an EXIF-rotated photo shows the same pixels as the decoded canvas", async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(async () => {
      // 400x200 JPEG, red left / blue right, tagged EXIF orientation 6 (rotate 90 CW).
      const cv = document.createElement("canvas");
      cv.width = 400; cv.height = 200;
      const g = cv.getContext("2d")!;
      g.fillStyle = "#d22"; g.fillRect(0, 0, 200, 200);
      g.fillStyle = "#22d"; g.fillRect(200, 0, 200, 200);
      g.fillStyle = "#fff"; g.fillRect(10, 10, 40, 20);
      const jblob = await new Promise<Blob>((res) => cv.toBlob((b) => res(b!), "image/jpeg", 0.95));
      const jpg = new Uint8Array(await jblob.arrayBuffer());
      const exif = [0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0,
        0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0,
        0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
      const bytes = new Uint8Array(jpg.length + exif.length);
      bytes.set(jpg.subarray(0, 2), 0); bytes.set(exif, 2); bytes.set(jpg.subarray(2), 2 + exif.length);
      const file = new File([bytes], "rot.jpg", { type: "image/jpeg" });

      // What the app's decode path makes.
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const ref = document.createElement("canvas");
      ref.width = bmp.width; ref.height = bmp.height;
      ref.getContext("2d")!.drawImage(bmp, 0, 0);

      const A = window.__mosqAsync!;
      A.previews.length = 0;
      A.previews.push({ name: "rot.jpg", file, fullCanvas: ref, cropCanvas: ref, contextCanvas: ref,
        scores: {}, detail: {}, logits: null, adP: null, verdict: null, pending: false, error: null,
        is_cropped: false, rev: 0, fingerprint: null });
      A.selectedIndex = 0;
      document.getElementById("gallery-section")!.style.display = "block";
      A.renderActivePhoto();
      const img = document.getElementById("full-img") as HTMLImageElement;
      await img.decode();
      const out = document.createElement("canvas");
      out.width = ref.width; out.height = ref.height;
      out.getContext("2d")!.drawImage(img, 0, 0, ref.width, ref.height);
      const a = ref.getContext("2d")!.getImageData(0, 0, ref.width, ref.height).data;
      const b = out.getContext("2d")!.getImageData(0, 0, ref.width, ref.height).data;
      let d = 0;
      for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
      return { w: ref.width, h: ref.height, natW: img.naturalWidth, natH: img.naturalHeight,
        src: img.getAttribute("src")!.slice(0, 5), meanAbs: d / a.length };
    });
    expect([r.w, r.h]).toEqual([200, 400]);      // rotated: the EXIF tag was honoured
    expect([r.natW, r.natH]).toEqual([200, 400]);
    expect(r.src).toBe("blob:");
    expect(r.meanAbs).toBeLessThan(3);             // same pixels, up to JPEG re-encode noise
    await settle(page);
  });
});
