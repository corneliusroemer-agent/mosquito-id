import {
  boot, errors, expect, populate, resetCls, readCls, settle, settleDecoded, test,
} from "../helpers/app";
import type { Page } from "@playwright/test";

/**
 * The engine re-run button: it appears exactly when the photos on screen were
 * scored by an engine other than the selected one, and pressing it puts every
 * loaded photo back through the batch a fresh drop takes.
 *
 * The defect it fixes is that switching the engine left the loaded photos
 * holding the previous engine's scores with nothing on the page saying so: a
 * user who went from H/14 to culico read H/14's verdicts under culico's name in
 * the footer. Re-running is minutes of inference and a lot of battery on the
 * phone this is mostly used on, so it is not automatic - which makes both halves
 * of that contract observable here. It must appear on the switch, it must not
 * appear at any other time, and pressing it must actually re-run the photos.
 *
 * Tier 1 never downloads a model. The engine switch is made real by putting an
 * entry in the app's own session cache, so `loadWebGPUModels` takes its
 * already-loaded branch and rebinds the head, the session and the footer with
 * the shipped code and no fetch. The re-run itself is then the real batch over
 * real decoded photos - `processFiles`, the detector's letterbox and decode, the
 * classifier, the fusion - with the two sessions faked.
 */

/** The engine the page boots into, and the one it is switched to. */
const FROM = "webgpu-fp16";
const TO = "webgpu-culico";

const THREE = ["a_01.jpg", "b_02.jpg", "c_03.jpg"];

/**
 * `ort.Tensor` when the CDN bundle did not load, and nothing at all when it did.
 *
 * The only thing tier 1 needs from onnxruntime is the tensor the detector's
 * `letterbox` builds, and `decodeDets` reads two fields off it - which is the
 * whole surface `src/app/ort.ts` declares. Installing this only when `ort` is
 * absent means the real runtime is used wherever there is one; the stub exists so
 * this spec does not need the CDN to reach the detector.
 */
async function ensureTensor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (w.ort) return;
    w.ort = {
      Tensor: class {
        data: Float32Array;
        dims: number[];
        constructor(_type: string, data: Float32Array, dims: number[]) {
          this.data = data;
          this.dims = dims;
        }
      },
    };
  });
}

/**
 * Two fakes, and `count` real photographs put through the app's own intake.
 *
 * `sessDet` answers with an all-zero detection tensor, so the shipped
 * letterbox/decodeDets/selectDetection chain runs for real and finds no box:
 * every photo is analysed whole, which is one classifier run per photo and makes
 * the run counts below exact.
 *
 * `sessClip` returns a fixed direction, so the softmax is the shipped arithmetic
 * over a real-shaped embedding and each photo ends up with a real verdict rather
 * than a hand-written one.
 *
 * The Files are built in the page from real canvases and handed to
 * `processFiles`, so the gallery is populated the way a drop populates it - which
 * is what gives each photo the File a re-run re-drops it from.
 */
async function loadPhotos(page: Page, names: string[] = THREE): Promise<void> {
  await page.evaluate(async (photos) => {
    const A = window.__mosqAsync!;
    const w = window as any;

    w.__detRuns = 0;
    A.sessDet = {
      inputNames: ["images"],
      async run() {
        w.__detRuns++;
        return { output0: { dims: [1, 5, 8400], data: new Float32Array(5 * 8400) } };
      },
    };
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run() {
        // The dim is read at call time, so the fake follows the head the app has
        // bound - which changes when the engine does.
        const dim = A.embeds.dim as number;
        const data = new Float32Array(dim);
        data.fill(1 / Math.sqrt(dim));
        return { embedding: { dims: [1, dim], data } };
      },
    };
    // The entries that make the switches below complete without a download:
    // keyed by engine, which is what `loadWebGPUModels` looks up before it
    // fetches anything. Both ends are seeded - the engine being switched TO and
    // the one switched back to - so switching away and back again is as real as
    // switching away.
    A.clipSessions[photos.engine] = { sess: A.sessClip, ep: "wasm" };
    A.clipSessions[photos.from] = { sess: A.sessClip, ep: "wasm" };

    const files: File[] = [];
    for (let i = 0; i < photos.names.length; i++) {
      const cv = document.createElement("canvas");
      cv.width = 1200;
      cv.height = 900;
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = `hsl(${i * 60}, 45%, 55%)`;
      ctx.fillRect(0, 0, cv.width, cv.height);
      const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/jpeg", 0.9));
      files.push(new File([blob!], photos.names[i]!, { type: "image/jpeg" }));
    }
    await A.processFiles(files);
  }, { names, engine: TO, from: FROM });
}

/**
 * As `loadPhotos`, but the fake detector FINDS a box.
 *
 * An all-zero detection tensor makes `selectDetection` find nothing, which is
 * right for the staleness cases and useless here: every photo then has no crop,
 * every photo takes the detection path, and a re-run that skipped detection
 * could not be told apart from one that did not. So the detector answers with a
 * confident box in the middle of the frame, and the photos end up cropped.
 *
 * The tensor is the shipped `[1, 5, 8400]` layout `decodeDets` reads: four box
 * coordinates in letterboxed pixels plus a confidence per anchor, one anchor
 * written and the rest left at zero.
 */
async function loadPhotosWithDetection(page: Page, names: string[]): Promise<void> {
  await page.evaluate(async (photos) => {
    const A = window.__mosqAsync!;
    const w = window as any;

    w.__detRuns = 0;
    w.__clipRuns = 0;
    A.sessDet = {
      inputNames: ["images"],
      async run() {
        w.__detRuns++;
        const N = 8400;
        const data = new Float32Array(5 * N);
        // One anchor, at the centre, in the 640px letterboxed space `letterbox`
        // reports back as `r`: cx, cy, w, h at offsets 0..3 of row `i`, and the
        // class score at row 4 - `decodeDets` reads `(4 + c) * N + i`.
        data[0] = 260; data[N] = 230; data[2 * N] = 380; data[3 * N] = 410;
        data[4 * N] = 0.9;
        return { output0: { dims: [1, 5, N], data } };
      },
    };
    // A real species embedding, not a uniform direction. The uniform fake this
    // file uses elsewhere is deliberate for the staleness cases - any verdict
    // will do there - but a crop also has to PASS the nuisance gate to stay
    // cropped, and a direction equidistant from every species loses that gate.
    // One species' own embedding makes the gate a decision about arithmetic
    // rather than about the fake.
    //
    // `A.embeds.species_emb` is FLATTENED - `populate` runs the nested rows
    // through `Float32Array.from`, which concatenates them - so the first
    // species is a slice of it, not an element. Read at call time because the
    // engine switch rebinds the head and with it the dimension.
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run() {
        w.__clipRuns++;
        const dim = A.embeds.dim as number;
        return { embedding: { dims: [1, dim], data: Float32Array.from(A.embeds.species_emb.slice(0, dim) as Float32Array) } };
      },
    };
    A.clipSessions[photos.engine] = { sess: A.sessClip, ep: "wasm" };
    A.clipSessions[photos.from] = { sess: A.sessClip, ep: "wasm" };

    const files: File[] = [];
    for (let i = 0; i < photos.names.length; i++) {
      const cv = document.createElement("canvas");
      cv.width = 1200;
      cv.height = 900;
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = `hsl(${i * 60}, 45%, 55%)`;
      ctx.fillRect(0, 0, cv.width, cv.height);
      const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/jpeg", 0.9));
      files.push(new File([blob!], photos.names[i]!, { type: "image/jpeg" }));
    }
    await A.processFiles(files);
  }, { names, engine: TO, from: FROM });
}

/** How many times the fake classifier has been asked for an embedding. */
function clipRuns(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__clipRuns ?? 0);
}

/** The box each photo is currently cropped to, in gallery order. */
function cropBoxes(page: Page): Promise<unknown[]> {
  return page.evaluate(() => window.__mosqAsync!.previews.map((p: any) => p.cropBox ?? null));
}

/** Boot the app, seed the shipped head, and put `names` on screen. */
async function gallery(page: Page, names: string[] = THREE): Promise<void> {
  await boot(page);
  // With no specs this seeds `A.embeds` and draws an empty gallery, which is the
  // head the batch needs without a second fetch.
  await populate(page, []);
  await ensureTensor(page);
  await loadPhotos(page, names);
  await expect.poll(() => photoCount(page), { timeout: 30_000 }).toBe(names.length);
  await settled(page, names.length);
}

/** How many times the fake detector has been asked for a detection. */
function detectorRuns(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__detRuns ?? 0);
}

/** How many photos are on screen, and whether every one has finished. */
function photoCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__mosqAsync!.previews.length);
}

/**
 * Wait for the gallery to be `count` photos with none still being analysed.
 *
 * Both halves matter: a count alone is true while the gallery is empty between a
 * re-run clearing it and the batch refilling it, which is the one moment the test
 * must not sample.
 */
async function settled(page: Page, count = 0): Promise<void> {
  await page.waitForFunction(
    (n) => {
      const A = window.__mosqAsync!;
      return A.previews.length === n && !A.previews.some((p: any) => p.pending);
    },
    count,
    { timeout: 30_000 },
  );
}

/** What the gallery is carrying, read as facts rather than as names. */
async function state(page: Page) {
  return page.evaluate(() => {
    const A = window.__mosqAsync!;
    return {
      names: A.previews.map((p: any) => p.name).sort(),
      scoredBy: A.previews.map((p: any) => p.scoredBy ?? null),
      isCropped: A.previews.map((p: any) => Boolean(p.is_cropped)),
      pending: A.previews.filter((p: any) => p.pending).length,
      errored: A.previews.filter((p: any) => p.error).length,
    };
  });
}

/** Switch the engine through the real `<select>` and wait for the rebind. */
async function switchEngine(page: Page, to: string): Promise<void> {
  await page.evaluate((engine) => {
    const sel = document.getElementById("engine-select") as HTMLSelectElement;
    sel.value = engine;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, to);
  await page.waitForFunction(
    (engine) => {
      const sel = document.getElementById("engine-select") as HTMLSelectElement;
      return sel.value === engine && window.modelsReady === true;
    },
    to,
    { timeout: 30_000 },
  );
  await settle(page);
}

const button = (page: Page) => page.locator("#btn-reprocess");

test.describe("re-running the loaded photos on another engine", () => {
  test("nothing is offered while the photos on screen are current", async ({ page }) => {
    await gallery(page);

    const before = await state(page);
    expect(before.names).toEqual(THREE);
    // Every photo carries the engine that is selected, which is the whole of
    // "nothing is stale": no score on screen came from anywhere else.
    expect(before.scoredBy).toEqual([FROM, FROM, FROM]);
    expect(before.pending).toBe(0);
    expect(before.errored).toBe(0);

    await expect(button(page)).toBeHidden();
    expect(errors(page)).toHaveLength(0);
  });

  test("switching the engine offers the re-run, and switching back withdraws it", async ({ page }) => {
    await gallery(page);

    await switchEngine(page, TO);
    await expect(button(page)).toBeVisible();
    await expect(button(page)).toBeEnabled();
    await expect(button(page)).toHaveAttribute("aria-label", /3 photos/);
    // The name says which engine will do the work, so the button cannot be read
    // as "re-run the same thing again".
    await expect(button(page)).toHaveAttribute("aria-label", /culico/);

    // Back to the engine that produced these scores and they are current again,
    // so the button withdraws rather than offering to re-run work already done.
    await switchEngine(page, FROM);
    await expect(button(page)).toBeHidden();
    expect(errors(page)).toHaveLength(0);
  });

  test("a switch whose weights cannot be fetched leaves the button visible and unusable", async ({ page }) => {
    await gallery(page);
    // B/16 has no session cached, so this switch cannot complete: the download
    // is what tier 1 aborts. This is the window the button exists to refuse -
    // the dropdown already says B/16 while `sessClip` still holds H/14's session,
    // so a press here would re-run the PREVIOUS engine and label the result B/16.
    await page.evaluate(() => {
      const sel = document.getElementById("engine-select") as HTMLSelectElement;
      sel.value = "webgpu-b16";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await expect(button(page)).toBeVisible();
    await expect(button(page)).toBeDisabled();
    // It says which of the reasons this is, and not the reassuring one: a failed
    // load is not a load still in progress.
    await expect(button(page)).toHaveAttribute("title", /could not load/i);

    // A click must change nothing at all. `force` because the button is
    // disabled and Playwright would otherwise refuse to dispatch it, which is
    // the point being checked - nothing behind the disabled attribute runs.
    const before = await state(page);
    await button(page).click({ force: true });
    await page.waitForTimeout(500);
    expect(await state(page)).toEqual(before);
    expect(errors(page)).toHaveLength(0);
  });

  test("a photo dropped after the switch is not counted as stale", async ({ page }) => {
    await gallery(page);
    await switchEngine(page, TO);
    await expect(button(page)).toHaveAttribute("aria-label", /3 photos/);

    await loadPhotos(page, ["new.jpg"]);
    await settled(page, 4);
    await expect(button(page)).toHaveAttribute("aria-label", /3 photos/);

    // Deleting the three the switch left behind takes the button with them,
    // leaving only a photo the selected engine has already scored. `last`, not
    // `first`: the strip is newest-first, and the photo dropped after the switch
    // is the newest one - deleting from the front would take the photo that is
    // NOT stale and leave the three that are.
    for (let i = 0; i < 3; i++) {
      await page.locator("#thumbnail-strip .tile").last().locator(".tile-delete-btn").click();
      await settle(page);
    }
    await expect(button(page)).toBeHidden();
    expect(errors(page)).toHaveLength(0);
  });

  test("pressing it re-runs every loaded photo through the batch", async ({ page }) => {
    await gallery(page);
    await switchEngine(page, TO);
    await expect(button(page)).toBeVisible();
    expect((await state(page)).pending).toBe(0);

    await button(page).click();
    await settled(page, 3);

    const after = await state(page);
    // The same photographs, not a second copy: a re-run that appended would
    // double the gallery and leave the stale verdicts underneath.
    expect(after.names).toEqual(THREE);
    expect(after.scoredBy, "every photo is now scored by the selected engine").toEqual([
      TO, TO, TO,
    ]);
    expect(after.errored, "a photo failed to be re-run").toBe(0);

    // Detection ran again, once per photo, on top of the batch that filled the
    // gallery. Counting the fake's runs is what makes this falsifiable: asserting
    // on the photos' `is_cropped` would compare `false` with `false`, because the
    // fake detector finds no box either way, and would pass whether or not
    // detection re-ran at all.
    expect(await detectorRuns(page), "detection did not re-run for every photo").toBe(6);

    // Nothing is stale any more, so the button withdraws itself.
    await expect(button(page)).toBeHidden();
    expect(errors(page)).toHaveLength(0);
  });

  test("a photo that already has a crop is re-scored without being re-detected", async ({ page }) => {
    // The cost asymmetry, measured. `loadPhotos` with detection that FINDS a box
    // gives every photo a crop, and a re-run must then classify those crops
    // rather than run YOLO over photos it has already cropped correctly.
    await boot(page);
    await populate(page, []);
    await ensureTensor(page);
    await loadPhotosWithDetection(page, THREE);
    await expect.poll(() => photoCount(page), { timeout: 30_000 }).toBe(3);
    await settled(page, 3);

    const before = await state(page);
    expect(before.isCropped, "the photos start with a detector's crop").toEqual([true, true, true]);
    // Three detections, one per photo, at intake.
    expect(await detectorRuns(page)).toBe(3);
    const cropsBefore = await cropBoxes(page);

    await switchEngine(page, TO);
    await expect(button(page)).toBeVisible();
    await button(page).click();
    await settled(page, 3);

    const after = await state(page);
    expect(after.names).toEqual(THREE);
    expect(after.scoredBy, "every photo is now scored by the selected engine").toEqual([TO, TO, TO]);
    expect(after.errored).toBe(0);
    // The whole point: no detection ran a second time.
    expect(await detectorRuns(page), "detection re-ran over photos that already had a crop").toBe(3);
    // And the classifier did run, on every photo - a re-run that skipped both
    // stages would leave the scores on the old engine.
    expect(await clipRuns(page)).toBeGreaterThan(3);
    // Nothing moved: the crop each photo was scored from is the one it keeps.
    expect(await cropBoxes(page)).toEqual(cropsBefore);
    await expect(button(page)).toBeHidden();
    expect(errors(page)).toHaveLength(0);
  });

  test("a manual crop survives a re-run", async ({ page }) => {
    // A crop the user drew is their work, and a re-run used to destroy it by
    // re-detecting over the photo. Here the photo has a crop already, so the
    // detector is not consulted at all and the drawn box is still the box.
    await boot(page);
    await populate(page, []);
    await ensureTensor(page);
    await loadPhotosWithDetection(page, ["a_01.jpg"]);
    await expect.poll(() => photoCount(page), { timeout: 30_000 }).toBe(1);
    await settled(page, 1);

    // A box of the user's own, nowhere near the detector's, so a re-detect could
    // not reproduce it by accident.
    const drawn = [137, 211, 640, 702];
    await page.evaluate((box) => {
      const A = window.__mosqAsync!;
      const p = A.previews[0];
      p.cropBox = box;
      const cv = document.createElement("canvas");
      cv.width = box[2]! - box[0]!;
      cv.height = box[3]! - box[1]!;
      p.cropCanvas = cv;
      p.fullCanvas.getContext("2d")!.drawImage(p.fullCanvas, box[0]!, box[1]!, cv.width, cv.height, 0, 0, cv.width, cv.height);
    }, drawn);
    const detsBefore = await detectorRuns(page);

    await switchEngine(page, TO);
    await expect(button(page)).toBeVisible();
    await button(page).click();
    await settled(page, 1);

    expect(await page.evaluate(() => window.__mosqAsync!.previews[0].cropBox), "the drawn box is intact").toEqual(drawn);
    expect(await detectorRuns(page), "the detector was not consulted over a manual crop").toBe(detsBefore);
    expect((await state(page)).scoredBy, "the manual crop's photo was re-scored").toEqual([TO]);
    expect(errors(page)).toHaveLength(0);
  });

  test("a second press re-runs again rather than appending", async ({ page }) => {
    await gallery(page);
    await switchEngine(page, TO);
    await button(page).click();
    await settled(page, 3);

    // Switching back and forth puts the gallery in the mixed state the button
    // exists for, and pressing twice more must still leave three photos.
    await switchEngine(page, FROM);
    await expect(button(page)).toBeVisible();
    await button(page).click();
    await settled(page, 3);
    await switchEngine(page, TO);
    await expect(button(page)).toBeVisible();
    await button(page).click();
    await settled(page, 3);

    const after = await state(page);
    expect(after.names, "three presses, three photos").toEqual(THREE);
    expect(after.scoredBy).toEqual([TO, TO, TO]);
    expect(await photoCount(page)).toBe(3);
    expect(errors(page)).toHaveLength(0);
  });

  test("the button appearing moves nothing on the page", async ({ page }) => {
    // The layout half of the requirement. The button sits in the header's
    // top-right row, so appearing there shifts the ENGINE label, the selector and
    // everything below them unless its space is reserved from first paint.
    await gallery(page);
    await settleDecoded(page);
    await resetCls(page);

    const before = await geometry(page);
    // The reservation is a real box, not an absence: a button that is
    // `display: none` in both states would also leave the selector unmoved.
    expect(before.button[2], "the hidden button reserves no width").toBeGreaterThan(0);

    await switchEngine(page, TO);
    await expect(button(page)).toBeVisible();
    const after = await geometry(page);

    expect(
      after.selector,
      "the engine selector moved when the button appeared",
    ).toEqual(before.selector);
    expect(
      after.button,
      "the button changed size between its hidden and shown states",
    ).toEqual(before.button);
    expect(await readCls(page), await describeShifts(page)).toBe(0);
    expect(errors(page)).toHaveLength(0);
  });

  test("a re-run on a phone fits the row it shares with the engine selector", async ({ page }) => {
    // 390x844, the viewport the app is actually used in. The button's space is
    // reserved there too, so a row holding a 472px-wide <select> has to hold
    // both without pushing the page sideways - and the reservation is paid
    // whether or not the button is showing.
    await page.setViewportSize({ width: 390, height: 844 });
    await gallery(page);

    const fits = async () => page.evaluate(() => {
      const btn = document.getElementById("btn-reprocess") as HTMLButtonElement;
      const sel = document.getElementById("engine-select") as HTMLSelectElement;
      const b = btn.getBoundingClientRect();
      const s = sel.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        btnRight: Math.round(b.right),
        btnWidth: Math.round(b.width),
        selLeft: Math.round(s.left),
        selWidth: Math.round(s.width),
      };
    });

    const idle = await fits();
    expect(idle.overflow, "the reserved button pushes the page sideways").toBe(false);
    // Reserved, not absent: a button absent in both states leaves the row the
    // same width and would pass the width comparison below for the wrong reason.
    expect(idle.btnWidth, "the button reserves no width while hidden").toBeGreaterThan(0);

    await switchEngine(page, TO);
    const stale = await fits();
    expect(stale.overflow, "showing the button pushes the page sideways").toBe(false);
    // Beside the ENGINE label, on its left: the button ends where the selector
    // begins.
    expect(stale.btnRight).toBeLessThanOrEqual(stale.selLeft);
    // And the reservation is genuinely reserved - the selector is exactly as
    // wide showing the button as with it hidden.
    expect(stale.selWidth).toBe(idle.selWidth);
    expect(errors(page)).toHaveLength(0);
  });
});

/**
 * Where the engine row's pieces sit, for the no-shift assertion.
 *
 * The selector's box is what is compared: any change to the button's width moves
 * it, so an unchanged box is an unchanged reservation. The button's own box is
 * measured too, and asserted to be non-zero in the test, so a build where the
 * button is `display: none` in both states cannot pass by measuring nothing.
 */
function geometry(page: Page) {
  return page.evaluate(() => {
    const sel = document.getElementById("engine-select") as HTMLSelectElement;
    const btn = document.getElementById("btn-reprocess") as HTMLButtonElement;
    const at = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    };
    return { selector: at(sel), button: at(btn) };
  });
}

/** Names the offending elements when CLS is nonzero, so a failure is diagnosable. */
async function describeShifts(page: Page): Promise<string> {
  const log = await page.evaluate(() => window.__mosqShiftLog ?? []);
  return log.length ? `shifts: ${log.join(" | ")}` : "";
}
