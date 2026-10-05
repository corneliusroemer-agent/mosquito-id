import { boot, errors, expect, populate, test } from "../helpers/app";
import type { Page } from "@playwright/test";

/**
 * Whatever `fullCanvas` holds, the bytes the viewer serves are the bytes that
 * canvas was decoded from.
 *
 * On the local engine the two are the same object by construction: the canvas
 * is the browser's own decode of `p.file`. On `server-gpu` they stop being the
 * same thing, because `commitBatchSlot` assigns the server's decode of
 * `fullDataUrl` over the slot's canvas while `slot.file` stays the upload. If
 * the server re-encoded, rescaled or EXIF-handled the photo differently from the
 * browser, the left panel then shows pixels that were never classified and
 * `cropGeometry` positions the crop box against dimensions the displayed image
 * does not have - no error, a box in the wrong place, and a drag there that cuts
 * the wrong pixels.
 *
 * This drives the real path: the engine dropdown, `processFiles`, and a
 * `/api/predict` that answers with a frame which is deliberately NOT the upload
 * (different size, different colour). Nothing about the server is stubbed except
 * its HTTP.
 */

interface ServerFrame {
  filename: string;
  fullDataUrl: string;
  cropDataUrl: string;
  contextDataUrl: string;
  fullWidth: number;
  fullHeight: number;
  cropBox: [number, number, number, number] | null;
  contextBox: [number, number, number, number] | null;
  is_cropped: boolean;
  crop_rejected: boolean;
  status: string;
  detail: Record<string, number>;
  labels: Record<string, number>;
  logits: Record<string, number>;
  engine_label: string;
  detTime: number;
  clipTime: number;
  totalTime: number;
}

/**
 * Switch to `server-gpu` the way a user does: through the dropdown.
 *
 * The option ships disabled (there is no server behind the static deploy), and
 * `selectable()` refuses the id on load, so `?engine=server-gpu` does not reach
 * it. The change handler does not consult either, which is what makes this a
 * real path rather than a back door.
 */
async function selectServerEngine(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sel = document.getElementById("engine-select") as HTMLSelectElement;
    const opt = document.getElementById("opt-server") as HTMLOptionElement;
    opt.disabled = false;
    sel.value = "server-gpu";
    sel.dispatchEvent(new Event("change"));
  });
  await page.waitForFunction(() => (window as any).__mosqAsync?.modelsReady === true, null, {
    timeout: 5_000,
  });
}

/** Install the `/api/predict` and `/api/health` answers for the switch above. */
async function stubServer(page: Page, frame: ServerFrame): Promise<void> {
  await page.route("**/api/health", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ engine_label: "test-gpu" }) }),
  );
  await page.route("**/api/predict", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify(frame) }),
  );
}

/**
 * Whether each `/api/predict` request carried a `crop_box` part at all.
 *
 * The two requests a batched photo makes are told apart by that, not by the box's
 * value: the first asks the server to detect, and sends no box; the second spans
 * the frame. A server that reads `crop_box` as the STRING "null" gets a box
 * stringified from nothing, which is a different request from no box at all.
 */
async function captureCropBoxes(page: Page, frame: ServerFrame): Promise<string[]> {
  const seen: string[] = [];
  await page.route("**/api/health", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ engine_label: "test-gpu" }) }),
  );
  await page.route("**/api/predict", async (r) => {
    const body = r.request().postData() ?? "";
    const m = body.match(/name="crop_box"\r?\n\r?\n([^\r]*)/);
    seen.push(m ? m[1]! : "<absent>");
    await r.fulfill({ contentType: "application/json", body: JSON.stringify(frame) });
  });
  return seen;
}

test.describe("server-gpu frame", () => {
  test("the viewer serves the frame the server classified, not the upload", async ({ page }) => {
    await boot(page);
    // The head the fused verdict is built from. `populate` with no specs seeds
    // it onto `A.embeds` (which is `EMB`) and draws an empty gallery.
    await populate(page, []);

    // The upload: a red 400x300 JPEG, built here rather than in Node so the
    // bytes are a real encode.
    await page.evaluate(async () => {
      const cv = document.createElement("canvas");
      cv.width = 400; cv.height = 300;
      const g = cv.getContext("2d")!;
      g.fillStyle = "#d22"; g.fillRect(0, 0, 400, 300);
      g.fillStyle = "#fff"; g.fillRect(20, 20, 60, 40);
      const blob = await new Promise<Blob>((r) => cv.toBlob((b) => r(b!), "image/jpeg", 0.95));
      (window as any).__upload = new File([blob], "photo_A.jpg", { type: "image/jpeg" });
    });

    // What the server answers with: a blue 200x150 frame. Different dimensions
    // AND different pixels from the upload, so an assertion cannot pass by both
    // happening to agree.
    const frame: ServerFrame = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      const cv = document.createElement("canvas");
      cv.width = 200; cv.height = 150;
      const g = cv.getContext("2d")!;
      g.fillStyle = "#22d"; g.fillRect(0, 0, 200, 150);
      g.fillStyle = "#000"; g.fillRect(100, 100, 40, 30);
      const dataUrl = cv.toDataURL("image/jpeg", 0.95);
      // A posterior the shipped gate turns into a verdict, from the head the
      // page actually loaded rather than invented.
      const species = A.embeds!.species as string[];
      const detail: Record<string, number> = {};
      const logits: Record<string, number> = {};
      const labels: Record<string, number> = {};
      const top = species.indexOf("Aedes aegypti");
      species.forEach((s, i) => {
        const p = i === top ? 0.86 : (1 - 0.86) / (species.length - 1);
        detail[s] = p;
        logits[s] = Math.log(p);
        const genus = s.split(" ")[0]!;
        labels[genus] = (labels[genus] ?? 0) + p;
      });
      return {
        filename: "photo_A.jpg",
        fullDataUrl: dataUrl,
        cropDataUrl: dataUrl,
        contextDataUrl: dataUrl,
        fullWidth: 200,
        fullHeight: 150,
        cropBox: null,
        contextBox: null,
        is_cropped: false,
        crop_rejected: false,
        status: "whole frame",
        detail,
        labels,
        logits,
        engine_label: "test-gpu",
        detTime: 1,
        clipTime: 2,
        totalTime: 3,
      };
    });
    await stubServer(page, frame);

    await selectServerEngine(page);
    await page.evaluate(() => window.__mosqAsync!.processFiles([(window as any).__upload]));

    // Read what is on screen against what was classified.
    const r = await page.evaluate(async () => {
      const p = window.__mosqAsync!.previews[0];
      const cv = p.fullCanvas as HTMLCanvasElement;
      const img = document.getElementById("full-img") as HTMLImageElement;
      await img.decode();
      const out = document.createElement("canvas");
      out.width = cv.width; out.height = cv.height;
      out.getContext("2d")!.drawImage(img, 0, 0, cv.width, cv.height);
      const a = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
      const b = out.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
      let d = 0;
      for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
      return {
        cvW: cv.width,
        cvH: cv.height,
        natW: img.naturalWidth,
        natH: img.naturalHeight,
        src: img.getAttribute("src")!.slice(0, 5),
        meanAbs: d / a.length,
        scoredBy: p.scoredBy,
        error: p.error,
      };
    });

    // The server's frame is what is displayed, at its own dimensions.
    expect([r.cvW, r.cvH]).toEqual([200, 150]);
    expect([r.natW, r.natH]).toEqual([200, 150]);
    expect(r.src).toBe("blob:");
    expect(r.meanAbs).toBeLessThan(3);
    expect(r.scoredBy).toBe("server-gpu");
    expect(r.error).toBeNull();
    expect(errors(page)).toHaveLength(0);
  });

  test("a cropped photo serves the server's frame, and asks about a real box", async ({ page }) => {
    // The uncropped case above cannot see a crop box at all: with `cropBox` null
    // the app sends one request and lets the server detect. This is the other
    // half - a server that found something - because the crop box is what the
    // overlay is positioned from, so it is the case where serving the wrong
    // bytes puts the outline in the wrong place rather than merely showing the
    // wrong picture.
    await boot(page);
    await populate(page, []);
    await page.evaluate(async () => {
      const cv = document.createElement("canvas");
      cv.width = 400; cv.height = 300;
      const g = cv.getContext("2d")!;
      g.fillStyle = "#d22"; g.fillRect(0, 0, 400, 300);
      const blob = await new Promise<Blob>((r) => cv.toBlob((b) => r(b!), "image/jpeg", 0.95));
      (window as any).__upload = new File([blob], "photo_A.jpg", { type: "image/jpeg" });
    });

    const base = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      const mk = (w: number, h: number, fill: string) => {
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const g = cv.getContext("2d")!;
        g.fillStyle = fill; g.fillRect(0, 0, w, h);
        return cv.toDataURL("image/jpeg", 0.95);
      };
      const species = A.embeds!.species as string[];
      const detail: Record<string, number> = {};
      const logits: Record<string, number> = {};
      const labels: Record<string, number> = {};
      const top = species.indexOf("Aedes aegypti");
      species.forEach((s, i) => {
        const p = i === top ? 0.86 : (1 - 0.86) / (species.length - 1);
        detail[s] = p;
        logits[s] = Math.log(p);
        const genus = s.split(" ")[0]!;
        labels[genus] = (labels[genus] ?? 0) + p;
      });
      return {
        // The server's frame is again neither the upload's size nor its pixels.
        full: mk(200, 150, "#22d"),
        crop: mk(60, 45, "#2d2"),
        context: mk(200, 150, "#22d"),
        detail,
        labels,
        logits,
      };
    });

    // One answer per box, so the second (whole-frame) request cannot be answered
    // with the crop's own box - which would make the app log a divergence.
    const seen = await captureCropBoxes(page, {
      filename: "photo_A.jpg",
      fullDataUrl: base.full,
      cropDataUrl: base.crop,
      contextDataUrl: base.context,
      fullWidth: 200,
      fullHeight: 150,
      cropBox: [50, 40, 130, 100],
      contextBox: [0, 0, 200, 150],
      is_cropped: true,
      crop_rejected: false,
      status: "cropped",
      detail: base.detail,
      labels: base.labels,
      logits: base.logits,
      engine_label: "test-gpu",
      detTime: 1,
      clipTime: 2,
      totalTime: 3,
    });

    await selectServerEngine(page);
    await page.evaluate(() => window.__mosqAsync!.processFiles([(window as any).__upload]));

    const r = await page.evaluate(async () => {
      const p = window.__mosqAsync!.previews[0];
      const cv = p.fullCanvas as HTMLCanvasElement;
      const img = document.getElementById("full-img") as HTMLImageElement;
      await img.decode();
      const out = document.createElement("canvas");
      out.width = cv.width; out.height = cv.height;
      out.getContext("2d")!.drawImage(img, 0, 0, cv.width, cv.height);
      const a = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
      const b = out.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
      let d = 0;
      for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
      // The overlay is positioned from `fullCanvas`'s dimensions, so it can only
      // be right if what is displayed has those dimensions.
      const box = document.getElementById("full-active-crop-box") as HTMLElement;
      return {
        cvW: cv.width,
        cvH: cv.height,
        natW: img.naturalWidth,
        natH: img.naturalHeight,
        isCropped: p.is_cropped,
        cropBox: p.cropBox,
        boxW: box.style.width,
        meanAbs: d / a.length,
      };
    });

    expect(r.isCropped).toBe(true);
    expect(r.cropBox).toEqual([50, 40, 130, 100]);
    expect([r.cvW, r.cvH]).toEqual([200, 150]);
    expect([r.natW, r.natH]).toEqual([200, 150]);
    expect(r.meanAbs).toBeLessThan(3);
    // The detecting request carries NO box - that is how the server is asked to
    // find one - and the second spans the frame. A box stringified from null
    // would be neither, and a server reading it as a request to crop nothing
    // would answer about a zero-area region.
    expect(seen[0]).toBe("<absent>");
    expect(seen[1]).toBe("[0,0,200,150]");
    expect(seen.some((b) => b === "null")).toBe(false);
    expect(errors(page)).toHaveLength(0);
  });
});
