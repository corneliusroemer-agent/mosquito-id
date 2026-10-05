import { boot, errors, expect, settle, test } from "../helpers/app";
import type { Page } from "@playwright/test";

/**
 * A hidden tab hands its GPU memory back, not just its references.
 *
 * `tests/gpu-release.test.ts` unit-tests the release step; `e2e/tier1/idle-release.spec.ts`
 * already covers the wiring of the controller. What is left is the thing neither
 * can see: that the app's OWN release path, running for real in a browser, awaits
 * the sessions it releases and leaves nothing pointing at a device that is gone.
 *
 * Tier 1 cannot measure GPU memory - it aborts every model fetch, and headless
 * Chromium here has a SwiftShader adapter with no `shader-f16`. So nothing below
 * asserts a byte count, and the honest contract asserted is the observable one:
 * every session's `release()` was entered and RESOLVED, the device slot was
 * cleared rather than left dangling, and a photo classifies again afterwards.
 */

/**
 * Fake sessions whose `release` resolves on a later turn, so a release that did
 * not await them is visible: the counters are still zero when the release
 * returns.
 *
 * `releaseGpuResources` awaits each one, and onnxruntime-web destroys the weight
 * `GPUBuffer`s when the promise resolves - so an unawaited release frees nothing.
 */
async function installReleasableSessions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const A = window.__mosqAsync!;
    const w = window as any;
    w.__releaseCalls = [];
    w.__releaseResolved = 0;

    const makeSession = (tag: string) => ({
      inputNames: ["pixel_values"],
      async run() {
        const dim = A.embeds.dim as number;
        const data = new Float32Array(dim);
        data.fill(1 / Math.sqrt(dim));
        return { embedding: { dims: [1, dim], data } };
      },
      async release() {
        w.__releaseCalls.push(tag);
        // A macrotask, not a microtask. onnxruntime-web's `release()` resolves
        // through the WASM boundary, which is not a microtask, and a fake that
        // settles in two ticks would let an unawaited release look identical to
        // an awaited one - the assertion below would pass against the old code
        // for the wrong reason.
        await new Promise((r) => setTimeout(r, 5));
        w.__releaseResolved++;
      },
    });

    const fakeDet = {
      inputNames: ["images"],
      async run() {
        return { output0: { dims: [1, 5, 8400], data: new Float32Array(5 * 8400) } };
      },
      async release() {
        w.__releaseCalls.push("det");
        await new Promise((r) => setTimeout(r, 5));
        w.__releaseResolved++;
      },
    };

    A.sessDet = fakeDet;
    const fakeClip = makeSession("clip");
    A.sessClip = fakeClip;
    A.clipSessions["webgpu-fp16"] = { sess: fakeClip, ep: "wasm" };
    A.modelsReady = true;
  });
}

/** A device the app owns, installed the way `loadWebGPUModels` installs it. */
async function installOwnedDevice(page: Page): Promise<void> {
  await page.evaluate(() => {
    const A = window.__mosqAsync!;
    const w = window as any;
    if (!w.ort) w.ort = { env: { wasm: {}, webgpu: {} } };
    if (!w.ort.env.webgpu) w.ort.env.webgpu = {};
    w.__destroyed = 0;
    const ownedDevice = {
      destroy() {
        w.__destroyed++;
        // A real GPUDevice rejects `destroy()` on a lost device; the release
        // path has to tolerate that without taking the sessions down with it.
        if (w.__destroyed > 1) throw new Error("device already destroyed");
      },
    };
    w.__ownedDevice = ownedDevice;
    // Through the app's own seam, so the release finds the device the same way
    // it would find the one `loadWebGPUModels` installs. Tier 1 never runs that
    // load - it aborts every model fetch - so this stands in for it.
    A.appOwnedDevice = ownedDevice;
  });
}

async function dropOnePhoto(page: Page, name: string): Promise<void> {
  await page.evaluate(async (photoName) => {
    const A = window.__mosqAsync!;
    const cv = document.createElement("canvas");
    cv.width = 640;
    cv.height = 480;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "hsl(120, 50%, 50%)";
    ctx.fillRect(0, 0, cv.width, cv.height);
    const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/jpeg", 0.9));
    await A.processFiles([new File([blob!], photoName, { type: "image/jpeg" })]);
  }, name);
}

test.describe("releasing GPU memory for real (#36)", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
  });

  test("a release awaits every session's release, not just calls it", async ({ page }) => {
    await installReleasableSessions(page);
    await dropOnePhoto(page, "awaited.jpg");
    await settle(page);

    await page.evaluate(() => window.__mosqAsync!.idleRelease.releaseNow());

    const after = await page.evaluate(() => {
      const w = window as any;
      return {
        called: (w.__releaseCalls as string[]).slice().sort(),
        resolved: w.__releaseResolved as number,
        ready: window.__mosqAsync!.modelsReady,
        sessions: Object.keys(window.__mosqAsync!.clipSessions).length,
      };
    });

    // The load-bearing assertion. `called` without `resolved` is the old
    // behaviour: the release dropped the references and returned while the
    // sessions were still alive, so onnxruntime had not destroyed a single
    // weight buffer - which is the memory this path exists to give back.
    expect(after.called).toEqual(["clip", "det"]);
    expect(after.resolved).toBe(2);
    expect(after.ready).toBe(false);
    expect(after.sessions).toBe(0);
  });

  test("a release destroys the app's own device and clears the device slot", async ({ page }) => {
    await installReleasableSessions(page);
    await installOwnedDevice(page);
    await dropOnePhoto(page, "device.jpg");
    await settle(page);

    await page.evaluate(() => window.__mosqAsync!.idleRelease.releaseNow());

    const after = await page.evaluate(() => {
      const w = window as any;
      return {
        destroyed: w.__destroyed as number,
        // The slot must be empty, not merely unreadable: a restore installs its
        // own device here, and onnxruntime-web defines the property
        // `writable: false`, so anything left here cannot be replaced by
        // assignment.
        device: w.ort.env.webgpu.device,
        stillReleased: window.__mosqAsync!.idleRelease.released(),
      };
    });

    expect(after.destroyed).toBe(1);
    expect(after.device).toBeUndefined();
    expect(after.stillReleased).toBe(true);
  });

  test("a second release does not re-destroy a device it already destroyed", async ({ page }) => {
    await installReleasableSessions(page);
    await installOwnedDevice(page);

    await page.evaluate(async () => {
      await window.__mosqAsync!.idleRelease.releaseNow();
      // The release path can fire more than once (the 60 s timer, then
      // `releaseNow` at teardown), and the fake device rejects a second
      // `destroy()`. A double destroy that threw here would abort the release.
      await window.__mosqAsync!.idleRelease.releaseNow();
    });

    expect(await page.evaluate(() => (window as any).__destroyed as number)).toBe(1);
    expect(errors(page).filter((e) => !e.includes("already destroyed"))).toEqual([]);
  });

  test("a release that cannot destroy its device still frees the sessions", async ({ page }) => {
    await page.evaluate(() => {
      const w = window as any;
      if (!w.ort) w.ort = { env: { wasm: {}, webgpu: {} } };
      window.__mosqAsync!.appOwnedDevice = {
        destroy() {
          throw new Error("device already lost");
        },
      };
    });
    await installReleasableSessions(page);
    await dropOnePhoto(page, "lost-device.jpg");
    await settle(page);

    const outcome = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      await A.idleRelease.releaseNow();
      return {
        released: A.idleRelease.released(),
        sessions: Object.keys(A.clipSessions).length,
        ready: A.modelsReady,
      };
    });

    // A device that will not be destroyed is not a reason to keep the weights.
    expect(outcome.sessions).toBe(0);
    expect(outcome.ready).toBe(false);
    expect(outcome.released).toBe(true);
  });

  test("repeated hide and show cycles free every cycle and never wedge", async ({ page }) => {
    await installOwnedDevice(page);
    await page.evaluate(() => {
      // Ten cycles against the real controller. Each one restores the fake
      // sessions the way `loadWebGPUModels` would install them, so a cycle that
      // left the previous cycle's state behind shows up as a growing count.
      const w = window as any;
      w.__cycleFrees = [];
      w.__installForCycle = (i: number) => {
        const A = window.__mosqAsync!;
        const tag = `clip-${i}`;
        const sess = {
          inputNames: ["pixel_values"],
          async run() {
            return { embedding: { dims: [1, 1], data: new Float32Array([1]) } };
          },
          async release() {
            await new Promise((r) => setTimeout(r, 5));
            w.__cycleFrees.push(tag);
          },
        };
        A.sessClip = sess;
        A.clipSessions["webgpu-fp16"] = { sess, ep: "wasm" };
        A.modelsReady = true;
        A.appOwnedDevice = { destroy() { w.__destroyed++; } };
      };
    });

    const cycles = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      const w = window as any;
      const seen: number[] = [];
      for (let i = 0; i < 10; i++) {
        w.__installForCycle(i);
        // The controller's own cycle: hidden -> release -> visible -> restore.
        A.idleRelease.hidden();
        await A.idleRelease.releaseNow();
        seen.push(Object.keys(A.clipSessions).length);
        A.idleRelease.visible();
        await A.idleRelease.ensure();
      }
      return { seen, freed: w.__cycleFrees.length, destroyed: w.__destroyed };
    });

    // Every cycle emptied the cache: a cycle that skipped one is the leak,
    // because onnxruntime only frees the weight cache when the last session goes.
    expect(cycles.seen).toEqual(new Array(10).fill(0));
    // Ten cycles, ten frees, ten destroys - nothing accumulating, nothing short.
    expect(cycles.freed).toBe(10);
    expect(cycles.destroyed).toBe(10);
    // And the tab is usable: a restore after the last cycle really happened.
    expect(await page.evaluate(() => (window.__mosqAsync as any).idleRestoreAttempts)).toBeGreaterThan(0);
    expect(errors(page).filter((e) => e.includes("idleRelease"))).toEqual([]);
  });

  test("a photo classifies again after a release and a restore", async ({ page }) => {
    await installReleasableSessions(page);
    await installOwnedDevice(page);
    await dropOnePhoto(page, "before.jpg");
    await settle(page);

    const before = await page.evaluate(() => {
      const p = window.__mosqAsync!.previews[0]!;
      return { name: p.name, scored: Boolean(p.scores) };
    });
    expect(before.scored).toBe(true);

    await page.evaluate(() => window.__mosqAsync!.idleRelease.releaseNow());
    // Exactly what the app does on the next inference. Tier 1 aborts the weights
    // fetch so `loadWebGPUModels` cannot complete, which means the honest
    // assertion is that the restore was ATTEMPTED - the failure this pins is a
    // restore never being reached, which leaves the tab inert with nothing on
    // the page saying why.
    await page.evaluate(() => window.__mosqAsync!.idleRelease.ensure());

    const after = await page.evaluate(() => ({
      attempts: window.__mosqAsync!.idleRestoreAttempts,
      photos: window.__mosqAsync!.previews.length,
      name: window.__mosqAsync!.previews[0]!.name,
    }));

    expect(after.attempts).toBeGreaterThan(0);
    // A release is not a reset: the reader keeps their photo and its result.
    expect(after.photos).toBe(1);
    expect(after.name).toBe(before.name);
    // Nothing points at the device that was destroyed.
    expect(await page.evaluate(() => (window as any).ort.env.webgpu.device)).toBeUndefined();
    expect(errors(page).filter((e) => e.includes("idleRelease"))).toEqual([]);
  });
});
