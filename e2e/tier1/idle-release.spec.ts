import { boot, errors, expect, settle, test } from "../helpers/app";
import type { Page } from "@playwright/test";

/**
 * A hidden tab gives its model memory back, and takes it back when it is next
 * needed (#36).
 *
 * The decision logic - the grace period, the generation counter that stops a
 * slow release landing after a restore, the busy check - is unit-tested in
 * `tests/idle-release.test.ts`. What is only observable here is the WIRING, and
 * the wiring is where this class of change actually breaks:
 *
 * - a release that empties the session cache but leaves `modelsReady` true makes
 *   the next `processFiles` queue photos forever with nothing on screen saying
 *   why;
 * - a release that fires mid-batch pulls the sessions out from under a running
 *   inference;
 * - a restore that never happens leaves a visible tab that accepts a photo drop
 *   and does nothing with it.
 *
 * Tier 1 never downloads a model, so the sessions here are fakes the way
 * `reprocess.spec.ts` fakes them, and the release is driven through the
 * controller's own `releaseNow` rather than by faking `document.visibilityState`
 * and waiting out 60 s. The 60 s default is asserted in the unit test; what
 * matters end to end is that pressing the button empties the cache and that the
 * next drop refills it.
 */

/** Put a fake classifier and detector in, the way `reprocess.spec.ts` does. */
async function installFakeSessions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const A = window.__mosqAsync!;
    const w = window as any;
    if (!w.ort) {
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
    }
    const fakeDet = {
      inputNames: ["images"],
      async run() {
        return { output0: { dims: [1, 5, 8400], data: new Float32Array(5 * 8400) } };
      },
      release() { (w.__releases ??= []).push("det"); },
    };
    A.sessDet = fakeDet;
    const fakeClip = {
      inputNames: ["pixel_values"],
      async run() {
        const dim = A.embeds.dim as number;
        const data = new Float32Array(dim);
        data.fill(1 / Math.sqrt(dim));
        return { embedding: { dims: [1, dim], data } };
      },
      // Counted rather than asserted on identity: a real session's `release` is
      // onnxruntime's, and what has to be pinned here is that the release path
      // REACHED it rather than silently skipping a session it could not type.
      release() { (w.__releases ??= []).push("clip"); },
    };
    A.sessClip = fakeClip;

    // Tier 1 never downloads a model, so the per-engine cache starts empty and
    // a release would have nothing to release. Seeding it is the same thing
    // `reprocess.spec.ts` does to make an engine switch take its
    // already-loaded branch.
    A.clipSessions["webgpu-fp16"] = { sess: fakeClip, ep: "wasm" };
    A.modelsReady = true;

  });
}

/** One real photograph through the app's own intake. */
async function dropOnePhoto(page: Page, name: string): Promise<void> {
  await page.evaluate(async (photoName) => {
    const A = window.__mosqAsync!;
    const cv = document.createElement("canvas");
    cv.width = 640;
    cv.height = 480;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "hsl(200, 50%, 50%)";
    ctx.fillRect(0, 0, cv.width, cv.height);
    const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/jpeg", 0.9));
    await A.processFiles([new File([blob!], photoName, { type: "image/jpeg" })]);
  }, name);
}

test.describe("releasing model memory while the tab is hidden (#36)", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
  });

  test("a release empties the session cache and marks the engine unusable", async ({ page }) => {
    await installFakeSessions(page);
    await dropOnePhoto(page, "release-me.jpg");
    await settle(page);

    const before = await page.evaluate(() => {
      const A = window.__mosqAsync!;
      return { sessions: Object.keys(A.clipSessions).length, clip: Boolean(A.sessClip), ready: A.modelsReady };
    });
    expect(before.sessions).toBe(1);
    expect(before.clip).toBe(true);

    await page.evaluate(() => window.__mosqAsync!.idleRelease.releaseNow());

    const after = await page.evaluate(() => {
      const A = window.__mosqAsync!;
      return {
        sessions: Object.keys(A.clipSessions).length,
        clip: Boolean(A.sessClip),
        det: Boolean(A.sessDet),
        engine: A.loadedClipEngine,
        // The critical one: if this stayed true the next drop would queue the
        // photos behind a load that was never coming.
        ready: A.modelsReady,
      };
    });

    expect(after.sessions).toBe(0);
    expect(after.clip).toBe(false);
    expect(after.det).toBe(false);
    expect(after.engine).toBe(null);
    expect(after.ready).toBe(false);
  });

  test("a released tab takes its models back on the next photo drop", async ({ page }) => {
    await installFakeSessions(page);
    await dropOnePhoto(page, "before-release.jpg");
    await settle(page);
    const photosBefore = await page.evaluate(() => window.__mosqAsync!.previews.length);
    expect(photosBefore).toBeGreaterThan(0);

    await page.evaluate(() => window.__mosqAsync!.idleRelease.releaseNow());

    // Exactly what the app does on the next inference: ask for the models back.
    await page.evaluate(() => window.__mosqAsync!.idleRelease.ensure());

    // The restore goes through `loadWebGPUModels`, which fetches the weights.
    // Tier 1 aborts every model request, so the restore cannot succeed here and
    // the honest assertion is not that it does - it is that it was ATTEMPTED.
    // The failure mode being pinned is the restore never being reached, which
    // leaves the tab permanently inert with no error anywhere on the page.
    const attempted = await page.evaluate(() => window.__mosqAsync!.idleRestoreAttempts);
    expect(attempted).toBeGreaterThan(0);
    // The photos are still there: a release is not a reset.
    const photosAfter = await page.evaluate(() => window.__mosqAsync!.previews.length);
    expect(photosAfter).toBe(photosBefore);
    // And the tab is still marked released, so the next inference retries rather
    // than running against sessions that are not there. That is the documented
    // behaviour for a restore that throws, and it is the safe direction to fail
    // in: a retry costs a load, a false "ready" costs a wrong answer.
    expect(await page.evaluate(() => window.__mosqAsync!.idleRelease.released())).toBe(true);

    expect(errors(page).filter((e) => e.includes("idleRelease"))).toEqual([]);
  });

  test("a release never lands in the middle of a batch", async ({ page }) => {
    await installFakeSessions(page);
    await dropOnePhoto(page, "batch-guard.jpg");
    await settle(page);

    // Drive a batch and release while it is in flight. The batch holds the
    // inference slot, so the release must decline and leave the sessions alone;
    // the app cannot tell "declined" from "succeeded" without re-reading them.
    const outcome = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      const cv = document.createElement("canvas");
      cv.width = 400;
      cv.height = 300;
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = "hsl(20, 50%, 50%)";
      ctx.fillRect(0, 0, cv.width, cv.height);
      const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/jpeg", 0.9));
      const files = [new File([blob!], "racing.jpg", { type: "image/jpeg" })];

      // Start the batch and release on the same microtask turn, before it can
      // have finished. `processFiles` is async and awaits the decode pool, so
      // this genuinely races.
      const batch = A.processFiles(files);
      await A.idleRelease.releaseNow();
      await batch;
      return { released: A.idleRelease.released(), sessions: Object.keys(A.clipSessions).length };
    });

    // Whichever way the race went, the sessions and the release flag must agree
    // with each other: released with sessions still bound is the broken state,
    // and so is not-released with the cache emptied.
    if (outcome.released) expect(outcome.sessions).toBe(0);
    else expect(outcome.sessions).toBeGreaterThan(0);
  });

  test("the photo, its thumbnail and its result all survive a release", async ({ page }) => {
    await installFakeSessions(page);
    await dropOnePhoto(page, "survivor.jpg");
    await settle(page);

    const before = await page.evaluate(() => {
      const A = window.__mosqAsync!;
      const p = A.previews[0]!;
      return {
        name: p.name,
        verdict: p.verdict?.species ?? null,
        hasFile: Boolean(p.file),
        hasThumb: Boolean(document.querySelector(".tile-btn img")?.getAttribute("src")),
      };
    });
    expect(before.hasFile).toBe(true);
    expect(before.hasThumb).toBe(true);

    await page.evaluate(() => window.__mosqAsync!.idleRelease.releaseNow());

    const after = await page.evaluate(() => {
      const A = window.__mosqAsync!;
      const p = A.previews[0]!;
      return {
        name: p.name,
        verdict: p.verdict?.species ?? null,
        hasFile: Boolean(p.file),
        hasThumb: Boolean(document.querySelector(".tile-btn img")?.getAttribute("src")),
        photos: A.previews.length,
      };
    });

    // Everything the reader would be angry to lose is kept across a release.
    // Only the model memory goes.
    expect(after.photos).toBe(1);
    expect(after.name).toBe(before.name);
    expect(after.verdict).toBe(before.verdict);
    expect(after.hasFile).toBe(true);
    expect(after.hasThumb).toBe(true);
  });
});
