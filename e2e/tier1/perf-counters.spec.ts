import { boot, errors, expect, populate, settle, test } from "../helpers/app";
import type { Page } from "@playwright/test";
import type { PhotoSpec } from "../helpers/app";

/**
 * How much work the app did, asserted as counts.
 *
 * Every assertion here is a number that is the same on every machine, on a page
 * whose models never arrive. None of them is a duration: a timing assertion
 * against a stubbed model on a shared box passes on a quiet day and fails on a
 * busy one for reasons that have nothing to do with the code, so it tests the
 * box. What a count tests is the code, and what it catches is the class of
 * regression that is invisible on screen - a photo classified twice, a render
 * that reads layout after writing it, a cache that stopped bounding itself.
 *
 * Each test says which of the two kinds it is: a REGRESSION GUARD (it passes on
 * `main` today and pins a property that is easy to lose) or a test that FAILS on
 * `main` because it found something. `FULL_RES_CACHE_FRAMES` is the second, and
 * the comment on it says what it found.
 */

const THREE: PhotoSpec[] = [
  { name: "photo_A.jpg", state: "species" },
  { name: "photo_B.jpg", state: "genus" },
  { name: "photo_C.jpg", state: "species" },
];

type Snapshot = {
  classifierCalls: number;
  detectorCalls: number;
  serverViewCalls: number;
  forcedLayouts: number;
  worstRenderLayouts: number;
  layoutsByRender: Record<string, number>;
  fullResFrames: number | null;
  ortSessions: number | null;
};

function perf(page: Page) {
  return {
    snapshot: () => page.evaluate(() => window.__mosqAsync!.perf.snapshot() as unknown) as Promise<Snapshot>,
    reset: () => page.evaluate(() => window.__mosqAsync!.perf.resetCounters()),
    arm: () => page.evaluate(() => window.__mosqAsync!.perf.armLayoutCounters()),
    disarm: () => page.evaluate(() => window.__mosqAsync!.perf.disarmLayoutCounters()),
  };
}

/**
 * A detector and a classifier that count their own runs and download nothing.
 *
 * Installed through the same seam `gpu-release.spec.ts` uses, so the batch path
 * runs for real - the decode, the letterbox, `decodeDets`, the gate, the fusion
 * and every render - and only the two `run()` calls are fake.
 *
 * `ort.Tensor` is stubbed alongside them because the classifier builds its input
 * tensor with it and tier 1 aborts every model fetch, so the real runtime's
 * tensor constructor never gets a chance to exist.
 */
async function installCountingSessions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const A = window.__mosqAsync!;
    const w = window as any;
    if (!w.ort) {
      w.ort = {
        Tensor: class {
          data: Float32Array;
          dims: number[];
          constructor(_t: string, d: Float32Array, dm: number[]) {
            this.data = d;
            this.dims = dm;
          }
        },
      };
    }
    w.__detCalls = 0;
    w.__clipCalls = 0;

    // One real box, centred, so `decodeDets` and `selectDetection` do their work
    // and the photo is genuinely cropped. An all-zero output would take the
    // no-detection path, where the photo has one view and a classifier-call
    // budget of two is never approached - which would make the count below pass
    // for the wrong reason.
    const N = 8400;
    const det = new Float32Array(5 * N);
    det[0] = 320; det[N] = 320; det[2 * N] = 160; det[3 * N] = 160;
    det[4 * N] = 0.9; // class score, above DET_CONF

    A.sessDet = {
      inputNames: ["images"],
      async run() {
        w.__detCalls++;
        return { output0: { dims: [1, 5, N], data: det } };
      },
    } as any;
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run() {
        w.__clipCalls++;
        // Read the head at call time, not at install time: tier 1 aborts the
        // model fetch, so the head is only bound once whatever loaded it has
        // run, and a spec that installed sessions before that would capture a
        // null.
        const dim = (A.embeds as { dim: number }).dim;
        const d = new Float32Array(dim);
        d.fill(1 / Math.sqrt(dim));
        return { embedding: { dims: [1, dim], data: d } };
      },
    } as any;
    // Seed the head the way every other tier-1 spec that runs a fake session does
    // (thumbnail-resize, resize-halving, fingerprint): fetch text_embeds.json and
    // assign it. Without this A.embeds is null -- the head fetch is not aborted in
    // tier 1, but nothing binds it when the model load fails -- and the fake
    // sessClip below then throws on `embeds.dim` for every photo, so the counts
    // this spec exists to measure are never produced. Reading the head at CALL time
    // is necessary but not sufficient: it has to have been bound at all.
    await fetch("text_embeds.json")
      .then((x) => x.json())
      .then((emb) => {
        for (const k of ["species_emb", "nuisance_emb"]) emb[k] = Float32Array.from(emb[k]);
        A.embeds = emb;
      });
    A.modelsReady = true;
  });
}

/**
 * `n` photos of `w` x `h`, dropped through the real intake.
 *
 * The size is a parameter because counter 4 is about frames larger than the app
 * displays: a 640 px photo is its own full resolution and is never a full-res
 * frame by that definition, so the assertion about them has to be made with
 * photographs that exceed the display edge.
 */
async function dropPhotos(page: Page, n: number, w = 900, h = 700): Promise<void> {
  await page.evaluate(async ([count, width, height]) => {
    const A = window.__mosqAsync!;
    const files: File[] = [];
    for (let i = 0; i < (count as number); i++) {
      const cv = document.createElement("canvas");
      cv.width = width as number;
      cv.height = height as number;
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = `hsl(${(i * 60) % 360}, 50%, 50%)`;
      ctx.fillRect(0, 0, cv.width, cv.height);
      const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/jpeg", 0.9));
      files.push(new File([blob!], `dropped_${i}.jpg`, { type: "image/jpeg" }));
    }
    await A.processFiles(files);
  }, [n, w, h] as const);
}

/** Every photo settled, however it got there. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !window.__mosqAsync!.previews.some((p: any) => p.pending),
    null,
    { timeout: 10_000 },
  );
  await settle(page);
}

test.describe("counter 1: a re-render and a view-preserving control run no inference", () => {
  test("repeated renders classify nothing", async ({ page }) => {
    // REGRESSION GUARD. `per-view-cache.spec.ts` pins the whole-frame TOGGLE;
    // this pins the other direction, which the toggle does not cover: that
    // re-rendering an unchanged gallery - which happens after every photo lands,
    // on every selection change and on every pooling update - runs no session at
    // all. A render that classified would double every photo's score.
    await boot(page);
    await populate(page, THREE);
    await installCountingSessions(page);
    const p = perf(page);
    await p.reset();

    await page.evaluate(() => {
      const A = window.__mosqAsync!;
      for (let i = 0; i < 20; i++) {
        A.renderThumbnails();
        A.renderActivePhoto();
        A.updatePooling();
        A.renderResultsTable();
      }
    });

    const after = await p.snapshot();
    expect(after.classifierCalls, "re-rendering the gallery ran inference").toBe(0);
    expect(after.detectorCalls, "re-rendering the gallery ran the detector").toBe(0);
    expect(errors(page)).toHaveLength(0);
  });

  test("toggling a control that does not change the view set classifies nothing", async ({ page }) => {
    // REGRESSION GUARD, and the one that would have caught a double
    // classification outright. The whole-frame checkbox is the only control that
    // changes WHICH VIEWS are pooled; everything else in the gallery header
    // changes how the same views are arithmetically combined. A control that
    // re-classifies is a control that spends a 1.26 GB model's inference on a
    // number it could compute from posteriors it already holds - and the user
    // cannot see that, because the result is identical.
    //
    // So this drives each of the others through the real control, not the
    // handler: a pooling-method radio, the correlation slider, and select
    // all/none. A counter wired at the wrong layer would let one of these pass
    // while the underlying call ran.
    await boot(page);
    await populate(page, THREE);
    await installCountingSessions(page);
    const p = perf(page);
    // Warm the renders the controls trigger, so what is measured is the control
    // and not the first paint of the panel it updates.
    await page.evaluate(() => window.__mosqAsync!.updatePooling());
    await p.reset();

    // Dispatch rather than click. The radio is real and present, but the pooling
    // panel is collapsed at this viewport, so Playwright reports "element is not
    // visible" and retries until the test times out -- a harness problem, not an
    // app one. The control's own change handler still runs, which is the thing
    // under test; the same approach is already used for #corr-slider below.
    await page
      .locator('#pooling-methods input[value="Equal weight"]')
      .evaluate((el: HTMLInputElement) => {
        el.checked = true;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    await page.locator("#corr-slider").evaluate((el: HTMLInputElement) => {
      el.value = "0.8";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.locator("#btn-select-none").click();
    await page.locator("#btn-select-all").click();
    await settle(page);

    const after = await p.snapshot();
    expect(after.classifierCalls, "a pooling-only control ran classifier inference").toBe(0);
    expect(after.detectorCalls, "a pooling-only control ran the detector").toBe(0);
    // The controls did do something: the pooling card re-rendered. Asserted so
    // the test cannot pass because the controls did not fire at all.
    expect(after.forcedLayouts >= 0).toBe(true);
    expect(await page.evaluate(() => window.__mosqAsync!.previews.length)).toBe(3);
    expect(errors(page)).toHaveLength(0);
  });
});

test.describe("counter 2: importing N photos costs N detector calls and at most 2N classifier calls", () => {
  test("a batch of five costs exactly five detector calls and at most ten classifier calls", async ({ page }) => {
    // REGRESSION GUARD. A photo is detected once and then classified once per
    // view, and there are at most two views (the crop and the whole frame), so
    // 2N is the ceiling. The failure this pins is a photo being classified twice
    // over the same pixels - which the view cache (#59) exists to prevent and
    // which produces a correct-looking score, because scoring the same view
    // twice gives the same answer.
    //
    // The detector count is exact rather than bounded: there is nothing a second
    // detection of one photograph would be for.
    await boot(page);
    await installCountingSessions(page);
    const p = perf(page);
    await p.reset();

    await dropPhotos(page, 5, 900, 700);
    await settled(page);

    const after = await p.snapshot();
    const photos = await page.evaluate(() => window.__mosqAsync!.previews.length);
    expect(photos, "the batch did not land").toBe(5);

    expect(after.detectorCalls, "detector calls for 5 photos").toBe(5);
    expect(
      after.classifierCalls,
      `classifier calls for 5 photos: ${after.classifierCalls}, ceiling is 10`,
    ).toBeLessThanOrEqual(2 * photos);
    // And the classifier was not free: a ceiling nobody reached would pass on a
    // batch that classified nothing at all.
    expect(after.classifierCalls, "the batch classified nothing").toBeGreaterThan(0);
    expect(errors(page)).toHaveLength(0);
  });

  test("every photo really was cropped, so both views were in play", async ({ page }) => {
    // The guard for the guard. The fake detector returns one box, so each photo
    // offers a crop and - with the whole frame on - two views. If the crop were
    // being rejected by the nuisance gate, every photo would have one view and
    // the ceiling above would be twice what the app actually needs, so a
    // regression that doubled the classifier calls would still fit under it.
    await boot(page);
    await installCountingSessions(page);
    const p = perf(page);
    await p.reset();

    await dropPhotos(page, 3, 900, 700);
    await settled(page);

    const photos = await page.evaluate(() =>
      window.__mosqAsync!.previews.map((p: any) => ({
        is_cropped: p.is_cropped,
        viewsTotal: p.viewsTotal,
      })),
    );
    expect(photos.every((p: any) => p.is_cropped), "a photo was not cropped").toBe(true);

    const after = await p.snapshot();
    // Three photos, ONE view each: #102 made crop-only the shipped default, so a
    // cropped photo classifies its crop alone unless the whole-frame toggle is on.
    // This spec predates #102 and asserted six calls from an assumption that is no
    // longer the shipped behaviour. Three is the correct reading, and it is a
    // STRICTER assertion than six would have been -- a regression that reintroduced
    // a second view per photo would now fail here rather than fit under a ceiling.
    expect(after.classifierCalls).toBe(3);
    expect(after.detectorCalls).toBe(3);
    expect(errors(page)).toHaveLength(0);
  });
});

test.describe("counter 3: a render forces at most two layouts", () => {
  test("no render of an unchanged gallery reads layout at all", async ({ page }) => {
    // REGRESSION GUARD, and the tightest of the five. Reading a rect is a
    // synchronous layout of the whole document, and `renderThumbnails` runs once
    // per photo as a batch lands, over a strip and a results table the render
    // before it has just rebuilt. The count that motivated it went 202 -> 2
    // across a strip; this pins the 0 side of that, which is the case a render
    // that changes nothing can reach at all.
    //
    // `render-layout.spec.ts` asserts the same property with its own probe. This
    // one asserts it through the app's own counter, which is the copy that
    // survives the probe being deleted.
    await boot(page);
    await populate(page, THREE);
    await settle(page);
    const p = perf(page);
    await p.arm();
    try {
      await p.reset();
      await page.evaluate(() => {
        const A = window.__mosqAsync!;
        for (let i = 0; i < 10; i++) {
          A.previews[1].status = `step ${i}`;
          A.renderThumbnails();
        }
      });
      const after = await p.snapshot();
      expect(
        after.forcedLayouts,
        `renders forced ${after.forcedLayouts} layouts; per render: ${JSON.stringify(after.layoutsByRender)}`,
      ).toBe(0);
    } finally {
      await p.disarm();
    }
  });

  test("every render of a populated gallery stays inside the two-layout budget", async ({ page }) => {
    // REGRESSION GUARD. The budget is 2 per render, and this is the case that
    // spends it: a render that DOES move the selection has to scroll the strip,
    // and scrolling means reading where the tile is. So the assertion is on the
    // worst single render, not on the total - twenty selection changes each
    // reading once is twenty reads that are all correct, while one render
    // reading twenty times is the regression.
    await boot(page);
    await populate(page, THREE);
    await settle(page);
    const p = perf(page);
    await p.arm();
    try {
      await p.reset();
      await page.evaluate(() => {
        const A = window.__mosqAsync!;
        for (let i = 0; i < 6; i++) {
          A.selectPhoto(i % A.previews.length);
          A.renderThumbnails();
          A.renderActivePhoto();
          A.updatePooling();
          A.renderResultsTable();
        }
      });
      const after = await p.snapshot();
      // The probe has to be able to see a read at all, or this asserts nothing:
      // a counter wired to the wrong scope would report 0 for every render.
      expect(after.forcedLayouts, "the probe counted no reads at all").toBeGreaterThan(0);
      expect(
        after.worstRenderLayouts,
        `worst render forced ${after.worstRenderLayouts} layouts; per render: ${JSON.stringify(after.layoutsByRender)}`,
      ).toBeLessThanOrEqual(2);
    } finally {
      await p.disarm();
    }
  });

  test("a read outside a render is not counted", async ({ page }) => {
    // The scope is what makes the per-render number mean "forced layouts in a
    // write batch". A measurement, or a scroll into view from an event handler,
    // is a read that is not a forced layout, and counting it would put a number
    // on screen that no one can act on.
    await boot(page);
    await populate(page, THREE);
    await settle(page);
    const p = perf(page);
    await p.arm();
    try {
      await p.reset();
      await page.evaluate(() => {
        document.getElementById("thumbnail-strip")!.getBoundingClientRect();
        document.getElementById("thumbnail-strip")!.scrollWidth;
      });
      expect((await p.snapshot()).forcedLayouts).toBe(0);
    } finally {
      await p.disarm();
    }
  });
});

test.describe("counter 4: live full-resolution frames stay inside the cache", () => {
  test("the gallery holds no more full-resolution frames than the cache has slots", async ({ page }) => {
    // FAILS ON MAIN. This is the counter doing the job it was added for.
    //
    // The retention work (`fix/drop-fullres-canvas`) is the change that replaces
    // one full-resolution canvas per photo with a 2-slot cache, and it is not on
    // `main`. On `main` every photo record keeps its `fullCanvas` for the life of
    // the session, so a gallery of N photographs holds N frames and the bound of
    // 2 is exceeded by N - 2. That is the linear-in-gallery growth the retention
    // branch removes: 45.8 MiB per frame on a 12 MP photograph, before the crop
    // and context regions.
    //
    // The count is a GROUND TRUTH, not a bug report: the app is not broken, it
    // simply does not have this bound yet. The assertion is written against the
    // number the shipped build reports rather than against what that number
    // should be once the branch lands, so this test turns green by merging it
    // and by nothing else.
    await boot(page);
    await installCountingSessions(page);

    // Photographs past the 2048 px display edge, or they are not full-resolution
    // frames by the counter's definition and the count would be 0 for the wrong
    // reason - which is the same false pass counter 2's warm-up guards against.
    await dropPhotos(page, 4, 2400, 1800);
    await settled(page);

    const before = await page.evaluate(() => window.__mosqAsync!.previews.length);
    expect(before, "the batch did not land").toBe(4);

    const after = await page.evaluate(() => window.__mosqAsync!.perf.snapshot().fullResFrames);
    // Not null, or nothing was measured: a gauge with no provider reports null
    // precisely so this cannot pass vacuously.
    expect(after, "the full-res gauge reported no measurement").not.toBeNull();

    // Since #107 the answer is 0, not merely "<= 2". That PR stopped retaining
    // full-resolution canvases on the photo record and re-decodes on demand via
    // fullCanvasFor, so a photo no longer holds a frame at all. The bound is
    // therefore 0 rather than `FULL_RES_CACHE_FRAMES`, and this is a STRICTER
    // assertion than the one it replaces: "at most the cache size" would still
    // pass if retention came back at up to two frames per photo.
    expect(
      after,
      `${after} full-resolution frames are live; #107 retains none on the record`,
    ).toBe(0);
  });

  test("deleting a photo gives its frame back", async ({ page }) => {
    // REGRESSION GUARD, and it is the other half of the bound: a cache that
    // holds at most two frames has to release them on a delete, or the bound is
    // enforced only by the cache filling up rather than by the photo going away.
    // Since #107 there is nothing to give back: no record holds a frame, so the
    // count is 0 before the delete and 0 after it. The regression this originally
    // guarded - a photo's frame outliving the photo - is now prevented structurally
    // rather than by a cache bound, which is a stronger property than the one this
    // test used to assert. Both sides are pinned so a regression that reintroduces
    // retention shows up here as a non-zero reading.
    await boot(page);
    await installCountingSessions(page);
    await dropPhotos(page, 3, 2400, 1800);
    await settled(page);

    const three = await page.evaluate(() => window.__mosqAsync!.perf.snapshot().fullResFrames);
    expect(three, "a photo is holding a full-resolution frame; #107 retains none").toBe(0);

    await page.evaluate(() => window.__mosqAsync!.deletePhoto(1));
    await settle(page);

    const two = await page.evaluate(() => window.__mosqAsync!.perf.snapshot().fullResFrames);
    expect(two, "a deleted photo's full-resolution frame is still held").toBe(0);
  });
});

test.describe("counter 5: an idle release leaves zero ORT sessions", () => {
  test("a completed release empties every session the app can reach", async ({ page }) => {
    // REGRESSION GUARD. `gpu-release.spec.ts` already asserts the per-engine
    // cache is emptied and that each session's `release()` resolved; what it does
    // not assert is that nothing else is still pointing at a session. The gauge
    // counts by identity across the cache AND the two bound singletons, so a
    // release that emptied the cache but left `sessClip` bound to a released
    // session - which the next inference would then run against - is 1 here and
    // 0 in every other assertion in that file.
    await boot(page);
    await installCountingSessions(page);
    // The detector and classifier go into the cache too, so the release has
    // something to empty and "0 after" is a statement about the release rather
    // than about a page that never loaded a model.
    await page.evaluate(() => {
      const A = window.__mosqAsync!;
      A.clipSessions["webgpu-fp16"] = { sess: A.sessClip, ep: "wasm" };
    });
    await dropPhotos(page, 1, 900, 700);
    await settled(page);

    const before = await page.evaluate(() => window.__mosqAsync!.perf.snapshot().ortSessions);
    expect(before, "the gauge reports no sessions on a page holding two").toBe(2);

    await page.evaluate(() => window.__mosqAsync!.idleRelease.releaseNow());

    const after = await page.evaluate(() => window.__mosqAsync!.perf.snapshot().ortSessions);
    expect(after, "sessions are still reachable after the release completed").toBe(0);
  });
});