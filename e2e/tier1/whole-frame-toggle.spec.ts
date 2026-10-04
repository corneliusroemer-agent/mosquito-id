import { test, expect, boot, populate, settle, errors } from "../helpers/app";
import type { Page } from "@playwright/test";
import type { PhotoSpec } from "../helpers/app";

/**
 * Toggling the whole-frame view must not freeze the page.
 *
 * The reported failure was ten sample photos classified normally, the checkboxes
 * usable, and then unchecking `#chk-whole-frame` freezing the whole page. The
 * re-classification that toggle fires started every photo's inference in one
 * synchronous loop, so ten photos meant ten concurrent runs on the one
 * onnxruntime session - the very thing the batch path avoids by running its
 * inference one photo at a time. Re-checking crashed the same way, which is why
 * this is pinned in both directions.
 *
 * The classifier here is a fake that answers instantly. That is the point of
 * tier 1: the model is 1.26 GB, and the freeze was never about how long a run
 * takes but about how many were in flight at once. So the fake records the
 * concurrency it was asked for, and the assertions are about the number - which
 * is exactly the number the real model would reproduce at any cost per run.
 */

/** Ten photos, all settled, all classified under a two-view setting. */
const TEN: PhotoSpec[] = Array.from({ length: 10 }, (_, i) => ({
  name: `photo_${i}.jpg`,
  state: "species",
}));

/**
 * Install a classifier that returns a real-shaped embedding without downloading
 * anything, and record how many runs it ever had in flight at once.
 *
 * `sessClip.run` is the whole of the local inference path above the softmax, so
 * a fake here means the rest of `classifyViews` - the view list, the fusion, the
 * per-view commit, the render after each view - all runs for real.
 */
async function installFakeClassifier(page: Page): Promise<void> {
  await page.evaluate(() => {
    const A = window.__mosqAsync!;
    const emb = A.embeds as { dim: number };
    const w = window as any;
    w.__fakeClip = { started: 0, inFlight: 0, peakConcurrency: 0 };
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run() {
        const f = w.__fakeClip;
        f.started++;
        f.inFlight++;
        f.peakConcurrency = Math.max(f.peakConcurrency, f.inFlight);
        try {
          // A macrotask, so a second run has a chance to start if the caller is
          // going to let one. A fake that resolved synchronously would hide
          // overlap rather than reveal it.
          await new Promise((r) => setTimeout(r, 0));
          const data = new Float32Array(emb.dim);
          // A fixed direction L2-normalises to itself, so the softmax is real
          // arithmetic over a real embedding and the photo gets a real verdict.
          data.fill(1 / Math.sqrt(emb.dim));
          return { embedding: { dims: [1, emb.dim], data } };
        } finally {
          f.inFlight--;
        }
      },
    };
  });
}

/** The fake's counters, plus whether every photo came back settled. */
async function classifierState(page: Page) {
  return page.evaluate(() => {
    const A = window.__mosqAsync!;
    const f = (window as any).__fakeClip;
    return {
      started: f.started,
      peakConcurrency: f.peakConcurrency,
      inFlight: f.inFlight,
      pending: A.previews.filter((p: any) => p.pending).length,
      errors: A.previews.filter((p: any) => p.error).length,
      viewsTotal: A.previews.map((p: any) => p.viewsTotal),
    };
  });
}

/** Click the checkbox and wait for the re-classification it triggers to settle. */
async function toggleAndSettle(page: Page, checked: boolean, budgetMs = 5000) {
  const before = await page.evaluate(() => window.__mosqAsync!.frames);
  await page.locator("#chk-whole-frame").setChecked(checked);
  await page.waitForFunction(
    (n) => {
      const A = window.__mosqAsync!;
      return !A.previews.some((p: any) => p.pending);
    },
    before,
    { timeout: budgetMs },
  );
  return page.evaluate((b) => window.__mosqAsync!.frames - b, before);
}

test.describe("toggling the whole-frame view", () => {
  test("re-classifies the photos on screen without freezing the page", async ({ page }) => {
    await boot(page);
    await populate(page, TEN);
    await installFakeClassifier(page);
    await settle(page);

    await expect(page.locator("#chk-whole-frame")).toBeChecked();

    // Frames presented while the toggle ran, counted by an observer inside the
    // page that is independent of the app's own counter. A frozen main thread
    // presents none, which is what the report looked like from the outside.
    const painted = await page.evaluate(async () => {
      let n = 0;
      let running = true;
      const tick = () => {
        if (!running) return;
        n++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const before = n;

      const box = document.getElementById("chk-whole-frame") as HTMLInputElement;
      box.checked = false;
      box.dispatchEvent(new Event("change", { bubbles: true }));

      // Bounded, so a regression fails instead of hanging the suite. The budget
      // is a settle deadline, not a performance claim: it is four orders of
      // magnitude above what ten instant fake runs need and nowhere near enough
      // for a stall to look like slowness.
      const deadline = performance.now() + 5000;
      const A = window.__mosqAsync!;
      while (A.previews.some((p: any) => p.pending) && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      running = false;
      return { painted: n - before, timedOut: performance.now() >= deadline };
    });

    expect(painted.timedOut, "the re-classification never settled").toBe(false);
    expect(
      painted.painted,
      "no animation frame was presented while the toggle ran: the page froze",
    ).toBeGreaterThanOrEqual(1);

    const after = await classifierState(page);
    expect(after.started, "the toggle did not re-run any inference").toBeGreaterThan(0);
    // The freeze: every photo's inference was launched at once. One at a time is
    // the invariant the batch path already holds and this path did not.
    expect(
      after.peakConcurrency,
      `${after.peakConcurrency} classifications ran at once; onnxruntime-web takes one at a time`,
    ).toBe(1);
    expect(after.inFlight, "a classification was still in flight after the pass").toBe(0);
    expect(after.pending, "a photo was left pending").toBe(0);
    expect(after.errors, "a photo failed to re-classify").toBe(0);
    // Crop-only is one view per photo, so every photo ends up agreeing with the
    // setting the checkbox now shows.
    expect(after.viewsTotal.every((v: number) => v === 1)).toBe(true);

    expect(errors(page)).toHaveLength(0);
  });

  test("toggling back on settles too, and re-runs both views", async ({ page }) => {
    // The other direction. The report was not symmetric in its symptom - one way
    // froze and the other crashed - but it was one mechanism, and a fix that only
    // holds in one direction is not a fix.
    await boot(page);
    await populate(page, TEN);
    await installFakeClassifier(page);
    await settle(page);

    await toggleAndSettle(page, false);
    const off = await classifierState(page);

    await toggleAndSettle(page, true);
    const on = await classifierState(page);

    expect(off.peakConcurrency).toBe(1);
    expect(on.peakConcurrency).toBe(1);
    expect(on.pending).toBe(0);
    expect(on.errors).toBe(0);
    expect(on.viewsTotal.every((v: number) => v === 2)).toBe(true);
    // The second pass is more work than the first, so it must have run.
    expect(on.started).toBeGreaterThan(off.started);

    expect(errors(page)).toHaveLength(0);
  });

  test("a toggle during a pass leaves every photo under the setting that is current", async ({ page }) => {
    // Three toggles inside one pass. The answer is one follow-up pass under the
    // setting that is current when it starts - not a photo left holding a verdict
    // fused from views the checkbox no longer includes.
    await boot(page);
    await populate(page, TEN);
    await installFakeClassifier(page);
    await settle(page);

    const painted = await page.evaluate(async () => {
      const A = window.__mosqAsync!;
      const box = document.getElementById("chk-whole-frame") as HTMLInputElement;
      let n = 0;
      let running = true;
      const tick = () => {
        if (!running) return;
        n++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const before = n;

      const flip = (v: boolean) => {
        box.checked = v;
        box.dispatchEvent(new Event("change", { bubbles: true }));
      };
      flip(false);
      // Inside the pass, while photos are still being re-classified.
      await new Promise((r) => setTimeout(r, 2));
      flip(true);
      flip(false);

      const deadline = performance.now() + 5000;
      while (A.previews.some((p: any) => p.pending) && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      running = false;
      return { painted: n - before, timedOut: performance.now() >= deadline };
    });

    expect(painted.timedOut, "the pass never settled after three toggles").toBe(false);
    expect(painted.painted).toBeGreaterThanOrEqual(1);

    await expect(page.locator("#chk-whole-frame")).not.toBeChecked();
    const after = await classifierState(page);
    expect(after.peakConcurrency).toBe(1);
    expect(after.pending).toBe(0);
    expect(after.errors).toBe(0);
    expect(after.viewsTotal.every((v: number) => v === 1)).toBe(true);

    expect(errors(page)).toHaveLength(0);
  });

  test("a persisted unchecked setting boots without running anything", async ({ page }) => {
    // The reload half of the report: the value lives in localStorage, so the same
    // browser came back up in the same configuration. Booting into it has to be
    // free - reading the preference sets a variable and a checkbox, and starts no
    // inference, because nothing is classified yet.
    await page.addInitScript(() => {
      window.localStorage.setItem("mosquito_include_whole_frame", "false");
    });
    await boot(page);
    await populate(page, TEN);
    await installFakeClassifier(page);
    await settle(page);

    await expect(page.locator("#chk-whole-frame")).not.toBeChecked();

    const after = await classifierState(page);
    expect(after.started, "booting into a stored setting ran inference").toBe(0);
    expect(after.pending, "booting left a photo pending").toBe(0);
    expect(errors(page)).toHaveLength(0);
  });

  test("a stored value that is neither true nor false boots as the default", async ({ page }) => {
    // A hand-edited or stale key must not be able to produce a third state the
    // app has no handling for. Anything that is not exactly "false" is the
    // default, which is the setting every existing user gets.
    for (const raw of ["", "1", "0", "TRUE", "maybe"]) {
      const p = await page.context().newPage();
      await p.addInitScript((v) => {
        window.localStorage.setItem("mosquito_include_whole_frame", v);
      }, raw);
      await boot(p);
      await expect(p.locator("#chk-whole-frame")).toBeChecked();
      await p.close();
    }
  });
});
