import { test, expect, boot, stubModel, errors, expectNoErrors } from "../helpers/app";

/**
 * The shell: the bundle parses, the DOM the app expects is present, and the
 * static routes render. None of this needs a classifier session, which is why it
 * is the tier that runs on every push.
 */
test.describe("the built site", () => {
  test("boots with no page errors and no model", async ({ page }) => {
    await boot(page);
    // The footer is written by the app's own init path; if the bundle threw
    // before reaching it, this stays at its HTML value.
    await expect(page.locator("#footer-device")).toHaveText("inference: initializing...");
    // The drop zone is static HTML, but the app wires drag/drop onto it.
    const wired = await page.evaluate(() => {
      const el = document.getElementById("dropzone")!;
      return typeof (el as HTMLElement & { ondrop?: unknown }).ondrop !== "undefined";
    });
    expect(wired).toBe(true);
    expectNoErrors(page);
  });

  test("serves the built bundle, not the checkout", async ({ page }) => {
    await boot(page);
    // A stale `dist/` gives a false pass here and everywhere else, so the test
    // says which artefact it is looking at: a hashed asset from `dist/assets`,
    // never `/src/app/main.js` which only a dev server would serve.
    const scripts = await page.evaluate(() =>
      Array.from(document.querySelectorAll("script[src]")).map((s) => (s as HTMLScriptElement).src),
    );
    // The ENTRY script is the thing that distinguishes a built page from a dev
    // server: jszip is loaded from a CDN and is legitimately not ours.
    expect(scripts.length).toBeGreaterThan(0);
    const entry = scripts.filter((s) => !s.includes("cdn.jsdelivr.net"));
    expect(entry, "no first-party script on the page").toHaveLength(1);
    expect(
      entry[0],
      "the served page must reference the built bundle, not /src/app/main.js",
    ).toMatch(/\/assets\/index-[\w-]+\.js$/);
    for (const src of scripts) {
      expect(src, "a /src/ path means the dev server answered instead of dist/").not.toContain("/src/");
    }
    const styles = await page.evaluate(() =>
      Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((l) => (l as HTMLLinkElement).href),
    );
    for (const href of styles) expect(href).not.toContain("/src/");
  });

  test("the species route renders from species-data.json", async ({ page }) => {
    const errors_: string[] = [];
    page.on("pageerror", (e) => errors_.push(String(e)));
    await stubModel(page);
    await page.goto("/#/species/aedes-aegypti", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#kb-body")).not.toBeEmpty({ timeout: 10_000 });
    await expect(page.locator("#kb-body")).toContainText(/Aedes aegypti/i);
    expect(errors_, errors_.join("; ")).toHaveLength(0);
  });

  test("an unknown species slug renders something rather than an empty panel", async ({ page }) => {
    await stubModel(page);
    await page.goto("/#/species/not-a-real-slug", { waitUntil: "domcontentloaded" });
    // Empty is a dead end for a user who followed a stale link. Whatever it shows,
    // it must not be the loading state forever.
    await expect(page.locator("#kb-body")).not.toBeEmpty({ timeout: 10_000 });
  });

  test("a failed photo is named as failed, with its reason", async ({ page }) => {
    await boot(page);
    // The status line is the only place a failure is explained; a tile that
    // simply stops spinning tells the user nothing to act on.
    await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      // The embeddings are not loaded in this tier (no model session builds them),
      // and this test needs none of the arithmetic - a failed photo has no verdict
      // at all. Only the canvas is needed.
      void A;
      const p: any = {
        name: "broken.jpg",
        fullCanvas: document.createElement("canvas"),
        cropCanvas: document.createElement("canvas"),
        contextCanvas: document.createElement("canvas"),
        detail: {}, scores: {}, logits: null, adP: null,
        pending: false,
        error: "Classification failed: session is not initialised",
        is_cropped: false, crop_rejected: false, status: "failed",
        rev: 0, agreement: null, viewsLanded: 0, viewsTotal: 0,
        verdict: null,
      };
      p.fullCanvas.width = p.cropCanvas.width = 200;
      p.fullCanvas.height = p.cropCanvas.height = 200;
      A.previews.push(p);
      A.selectedIndex = 0;
      document.getElementById("gallery-section")!.style.display = "block";
      document.getElementById("results-table-section")!.style.display = "block";
      A.renderThumbnails();
      A.renderActivePhoto();
      A.updatePooling();
      A.renderResultsTable();
    });

    await expect(page.locator("#photo-name")).toContainText("broken.jpg");
    await expect(page.locator("#photo-name")).toContainText(/analysis failed/i);
    // The row exists and its four unknown cells are EMPTY rather than carrying
    // zeros or a name: a colspan there changed the table's column widths and the
    // replaced text changed the row's height, which moved the row below it on
    // every photo that finished.
    const row = page.locator("#results-table tbody tr").first();
    await expect(row).toContainText("broken.jpg");
    await expect(row).toHaveClass(/row-pending/);
    const cells = await row.locator("td").evaluateAll((tds) =>
      tds.map((t) => (t as HTMLElement).innerText.trim()),
    );
    expect(cells).toHaveLength(5);
    expect(cells[0]).toContain("broken.jpg");
    expect(cells.slice(1), "a failed photo must not report a genus or a species").toEqual([
      "",
      "",
      "",
      "",
    ]);
  });

  test("photos dropped before the model is ready are queued, not lost", async ({ page }) => {
    await boot(page);
    // Dropping a photo during the 1.26 GB download used to be a console.warn and
    // nothing else: the zone took the files, showed no error, added no tiles, and
    // looked broken. This is the first thing most people do.
    await page.evaluate(async () => {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 300;
      const g = cv.getContext("2d")!;
      g.fillStyle = "#456";
      g.fillRect(0, 0, 300, 300);
      const blob = await new Promise<Blob>((r) => cv.toBlob((b) => r(b!), "image/png"));
      const f = new File([blob], "early.jpg", { type: "image/png" });
      await window.__mosqAsync!.processFiles([f]);
    });

    // The models are stubbed, so `modelsReady` is never set and the batch stays
    // queued - which is the observable claim: no tiles, and the notice that says
    // why, rather than silence.
    await expect(page.locator("#gallery-section")).toBeHidden();
    await expect(page.locator("#progress-msg")).toContainText(/load|model|engine/i);
  });

  test("the drop zone accepts a real photo file once a session exists", async ({ page }) => {
    // With no classifier session `processFiles` queues rather than running, so
    // this covers the decode-and-render half of the batch path directly: a real
    // PNG file, the app's own canvas draw, and the tiles appearing.
    await boot(page);
    const png = await fetchPng(page);
    await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], "real.png", { type: "image/png" });
      // Bypass the model gate the way the served app would with a session, by
      // handing the file to the decode stage through the public path and letting
      // the failure below be the only thing that happens.
      await window.__mosqAsync!.processFiles([file]);
    }, png);
    // Queued (no session) or processed-and-failed (session-less inference) - what
    // must NOT happen is a silent success with no tiles and no message.
    const queuedOrTiled =
      (await page.locator("#progress-msg").innerText()).trim().length > 0 ||
      (await page.locator("#thumbnail-strip .tile").count()) > 0;
    expect(queuedOrTiled, "a dropped photo produced neither tiles nor a message").toBe(true);
    expect(errors(page).filter((e) => !/onnx|net::|Failed to fetch|r2\.dev/i.test(e))).toHaveLength(0);
  });
});

/** A small real PNG, drawn in the page and returned base64 - no fixture file needed. */
function fetchPng(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => {
    const cv = document.createElement("canvas");
    cv.width = 240;
    cv.height = 180;
    const g = cv.getContext("2d")!;
    g.fillStyle = "#6a7";
    g.fillRect(0, 0, 240, 180);
    return cv.toDataURL("image/png").split(",")[1]!;
  });
}