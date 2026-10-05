import { boot, errors, expect, populate, settle, test } from "../helpers/app";
import type { Page } from "@playwright/test";

/**
 * Switching the engine while a batch is in flight.
 *
 * `inferSlot` reads `currentEngine` once per photo, so a batch whose engine
 * changes partway through leaves the gallery holding two: the photos already
 * scored carry the old engine's `scoredBy` and the ones after the switch carry
 * the new one's, with nothing on the page saying so. Measured before the fix:
 * `scoredBy = ["webgpu-fp16", "webgpu-culico", "webgpu-culico"]`.
 *
 * The selector is the control that permits it, so the selector is what is
 * tested. It is blocked for the length of the pass with the reason attached -
 * the same rule, and the same wording, as the re-run button's
 * `REPROCESS_BLOCKED_BATCH`: a temporarily unavailable control says why.
 *
 * Tier 1 never downloads a model. Both ends of the switch are seeded into the
 * app's own session cache, so `loadWebGPUModels` takes its already-loaded branch
 * and rebinds head, session and footer through the shipped code with no fetch.
 *
 * The batch is held open by a gate inside the fake classifier rather than by
 * timing: the switch has to land while a photo is genuinely mid-inference, and
 * a sleep would make "which engine scored this" a race rather than a fact.
 */

/** The engine the page boots into, and the one a mid-batch switch attempts. */
const FROM = "webgpu-fp16";
const TO = "webgpu-culico";

const THREE = ["a_01.jpg", "b_02.jpg", "c_03.jpg"];

/**
 * `ort.Tensor` when the CDN bundle did not load, and nothing at all when it did.
 * The only thing tier 1 needs from onnxruntime is the tensor the detector's
 * `letterbox` builds.
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
 * Two fake sessions and three real photographs, with the classifier GATED.
 *
 * The detector answers with an all-zero tensor, so the shipped
 * letterbox/decodeDets/selectDetection chain runs for real and finds no box:
 * every photo is analysed whole, one classifier run each.
 *
 * `sessClip.run` parks on a promise the test holds open, one per call, pushed
 * onto `__clipGate`. That is what keeps the batch in flight across the switch
 * instead of racing it, and it is why the run below can release the first photo
 * only after the switch has been attempted.
 */
async function startGatedBatch(page: Page, names: string[] = THREE): Promise<void> {
  await page.evaluate(async (photos) => {
    const A = window.__mosqAsync!;
    const w = window as any;

    w.__clipGate = [];
    A.sessDet = {
      inputNames: ["images"],
      async run() {
        return { output0: { dims: [1, 5, 8400], data: new Float32Array(5 * 8400) } };
      },
    };
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run() {
        const dim = A.embeds.dim as number;
        // Read at call time: the head's dimension is what a switch rebinds.
        await new Promise((r) => w.__clipGate.push(r));
        const data = new Float32Array(dim);
        data.fill(1 / Math.sqrt(dim));
        return { embedding: { dims: [1, dim], data } };
      },
    };
    // Both ends seeded, so the switch completes through the shipped code and the
    // red case really does produce a two-engine gallery rather than a load error.
    A.clipSessions[photos.to] = { sess: A.sessClip, ep: "wasm" };
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
    // Deliberately NOT awaited: the batch has to still be running when the
    // switch is attempted, which is the whole condition under test.
    w.__batch = A.processFiles(files);
  }, { names, to: TO, from: FROM });
}

/** How many photos are on screen, and what each one carries. */
function state(page: Page): Promise<{ scoredBy: (string | null)[]; engines: string[] }> {
  return page.evaluate(() => {
    const scoredBy = window.__mosqAsync!.previews.map((p: any) => p.scoredBy ?? null);
    return { scoredBy, engines: [...new Set(scoredBy.filter(Boolean) as string[])] };
  });
}

/** The engine `<select>` as the page presents it: usable, and what it says. */
function selector(page: Page): Promise<{ disabled: boolean; title: string; name: string }> {
  return page.evaluate(() => {
    const el = document.getElementById("engine-select") as HTMLSelectElement;
    return { disabled: el.disabled, title: el.title, name: el.getAttribute("aria-label") ?? "" };
  });
}

/**
 * Release every classifier call parked on the gate, and wait for the batch.
 *
 * The loop is because the batch runs its photos one at a time: each release
 * unblocks the current photo, whose commit is what schedules the next one onto
 * the gate. The bound is a failure mode made explicit - a batch that never
 * settles would otherwise hang the test on the `waitForFunction` below with no
 * indication of which half hung.
 */
async function drainBatch(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as any;
    for (let i = 0; i < 50; i++) {
      w.__clipGate.splice(0).forEach((r: () => void) => r());
      await new Promise((r) => setTimeout(r, 5));
    }
    // Whatever is still parked after that is a batch that stopped asking for
    // work, so the awaits below are what reports it.
    w.__clipGate.splice(0).forEach((r: () => void) => r());
  });
  await page.evaluate(() => (window as any).__batch);
  await page.waitForFunction(
    () => {
      const A = window.__mosqAsync!;
      return A.previews.length === 3 && !A.previews.some((p: any) => p.pending);
    },
    null,
    { timeout: 30_000 },
  );
  await settle(page);
}

/** Boot the app with the shipped head bound and a gated batch in flight. */
async function midBatch(page: Page): Promise<void> {
  await boot(page);
  await populate(page, []);
  await ensureTensor(page);
  await startGatedBatch(page);
  // The first photo is inside the classifier, so the batch is genuinely running
  // and the photos behind it have not been touched.
  await page.waitForFunction(() => (window as any).__clipGate.length >= 1, null, { timeout: 30_000 });
}

/**
 * Attempt the switch the way a user would, without going through Playwright's
 * actionability check.
 *
 * `selectOption` waits for the element to become enabled, so on a blocked
 * selector it would time out rather than report the state under test. A real
 * user cannot pick an option from a disabled `<select>` either - which is why the
 * blocked state is asserted separately - and dispatching the event directly is
 * what checks the second half: that a change arriving from anywhere while a
 * pass is in flight cannot leave the gallery holding two engines.
 */
async function attemptSwitch(page: Page, to: string): Promise<void> {
  await page.evaluate((engine) => {
    const sel = document.getElementById("engine-select") as HTMLSelectElement;
    sel.value = engine;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, to);
  await settle(page);
}

test.describe("switching the engine mid-batch", () => {
  test("the selector is blocked for the pass and says why", async ({ page }) => {
    await midBatch(page);

    const during = await selector(page);
    expect(during.disabled, "the engine selector stays usable during a batch").toBe(true);
    // A disabled control that does not say why is indistinguishable from a broken
    // one, which is the rule the re-run button already follows.
    expect(during.title, "a blocked selector carries no reason").not.toBe("");
    expect(during.name, "a blocked selector's accessible name carries no reason").not.toBe("");
    expect(`${during.title} ${during.name}`, "the reason names the wait")
      .toMatch(/analys|analyz|analysed|analyzed/i);

    await drainBatch(page);

    // And it comes back: a control left disabled after the pass would be a
    // second, quieter version of the same defect.
    const after = await selector(page);
    expect(after.disabled, "the selector stayed blocked after the batch finished").toBe(false);
    expect(errors(page)).toHaveLength(0);
  });

  test("a switch during the pass cannot leave the gallery holding two engines", async ({ page }) => {
    await midBatch(page);

    await attemptSwitch(page, TO);
    await drainBatch(page);

    const after = await state(page);
    expect(after.scoredBy, "a photo carries no engine").not.toContain(null);
    expect(
      after.engines,
      "the gallery ended up holding more than one engine's scores",
    ).toHaveLength(1);
    // Every photo holds the one engine that was selected for the whole pass, not
    // merely that they agree with each other.
    expect(after.scoredBy).toEqual([FROM, FROM, FROM]);
    expect(await page.evaluate(() => (document.getElementById("engine-select") as HTMLSelectElement).value))
      .toBe(FROM);
    expect(errors(page)).toHaveLength(0);
  });
});
