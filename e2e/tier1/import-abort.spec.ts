import { boot, expect, test } from "../helpers/app";
import type { Page } from "@playwright/test";

/**
 * #70: switching engines mid-load leaves the old load running, and the old load
 * wins.
 *
 * `loadWebGPUModels` publishes by assignment at the END - `sessClip`, `EMB`,
 * `window.modelsReady`, the footer - after several awaits. An engine switch
 * re-enters it without cancelling the first call, so two loads run to
 * completion and whichever finishes LAST publishes, whatever engine the user is
 * actually looking at.
 *
 * What makes the stale publish observable is that the two engines differ in
 * something a test can read. `EMB` is the head: fp16's is 1024-dimensional,
 * culico's 1153. And `sessClip` is the session, seeded per engine here so a
 * switch takes `loadWebGPUModels`'s already-loaded branch with no download.
 * So after a switch away from an engine and back, the head and the session
 * must be the ones belonging to the engine the user selected LAST - which is
 * the invariant the issue names, and which nothing currently enforces.
 *
 * Tier 1 downloads no model. The abandoned load is parked on the head JSON -
 * the one artefact `stubModel` does not abort - by a delayed `page.route`.
 */

const FROM = "webgpu-fp16";
const TO = "webgpu-culico";

/** The two shipped heads, which differ in width so a stale publish is visible. */
const DIM: Record<string, number> = { [FROM]: 1024, [TO]: 1153 };

/**
 * A fake classifier and detector per engine, and both engines seeded into the
 * app's session cache.
 *
 * Each engine's session is tagged with its own key, so `sessClip` says WHICH
 * engine's session is bound rather than merely that some session is. Without a
 * cached session each switch tries to fetch 1.26 GB, which tier 1 aborts - the
 * switch then fails instead of racing and nothing is under test.
 */
async function seedSessions(page: Page): Promise<void> {
  await page.evaluate((keys: string[]) => {
    const A = window.__mosqAsync!;
    const make = (engine: string) => ({
      engine,
      inputNames: ["pixel_values"],
      async run() {
        const dim = A.embeds.dim as number;
        const data = new Float32Array(dim);
        data.fill(1 / Math.sqrt(dim));
        return { embedding: { dims: [1, dim], data } };
      },
    });
    const det = {
      inputNames: ["images"],
      async run() {
        return { output0: { dims: [1, 5, 8400], data: new Float32Array(5 * 8400) } };
      },
    };
    A.sessDet = det;
    for (const k of keys as string[]) {
      const s = make(k);
      A.clipSessions[k] = { sess: s, ep: "wasm" };
    }
    A.sessClip = A.clipSessions[keys[0]!]!.sess;
  }, [FROM, TO] as string[]);
}

/**
 * Hold one head fetch open for `ms`, and report when it has been reached.
 *
 * The head is the LAST await in a load, so a load parked here has already built
 * its session and is one await from publishing - which is the window the defect
 * lives in. The signal is the request itself rather than anything the app
 * publishes: `loadedClipEngine` is assigned BEFORE the head, so waiting on it
 * would race, and `EMB` is null on a tier-1 boot whose own load failed.
 */
async function delayHead(page: Page, file: string, ms: number): Promise<() => Promise<boolean>> {
  let reached = false;
  await page.route(`**/${file}`, async (route) => {
    reached = true;
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
  return async () => {
    for (let i = 0; i < 200 && !reached; i++) await page.waitForTimeout(50);
    return reached;
  };
}

/** What the app is actually running: which head, and which engine's session. */
function readBound(page: Page): Promise<{ headDim: number | null; sessionEngine: string | null; ready: boolean }> {
  return page.evaluate(() => {
    const A = window.__mosqAsync!;
    const s = A.sessClip as unknown as { engine?: string } | null;
    const e = A.embeds as unknown as { dim?: number } | null;
    return {
      headDim: e?.dim ?? null,
      sessionEngine: s?.engine ?? null,
      ready: A.modelsReady,
    };
  });
}

test.describe("engine switch mid-load (#70)", () => {
  test("a load the user switched away from must not publish", async ({ page }) => {
    await boot(page);
    await seedSessions(page);

    // The abandoned load: switch INTO culico and park it on its head fetch.
    const culicoHeld = await delayHead(page, "text_embeds_culico.json", 4_000);
    await page.selectOption("#engine-select", TO);
    expect(await culicoHeld(), "the culico load never reached its held head fetch").toBe(true);

    // Change of mind while culico is still loading. fp16's head is not held, so
    // this load runs straight through and publishes first.
    await page.selectOption("#engine-select", FROM);
    await page.waitForFunction(
      (d) => (window.__mosqAsync!.embeds as unknown as { dim?: number } | null)?.dim === d,
      DIM[FROM],
      { timeout: 10_000 },
    );

    // Now let the abandoned culico load finish its held fetch and reach the
    // publish it was always going to reach.
    await page.waitForTimeout(5_000);

    // The invariant: the engine actually in use is the one selected last.
    const bound = await readBound(page);
    expect(
      bound.headDim,
      "the abandoned culico load published its head over the selected engine's",
    ).toBe(DIM[FROM]);
    expect(
      bound.sessionEngine,
      "the abandoned culico load published its session over the selected engine's",
    ).toBe(FROM);
    expect(bound.ready, "the app is not ready on the engine the user selected").toBe(true);
  });
});