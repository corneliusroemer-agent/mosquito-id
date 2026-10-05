import { boot, errors, expect, test } from "../helpers/app";
import type { Page } from "@playwright/test";

/**
 * The global arrow/Home/End handler must not take keys away from a control the
 * user is operating.
 *
 * The shipped guard was `e.target instanceof HTMLInputElement`, which is a list
 * of one. A `<select>` is not an `HTMLInputElement`, so with the engine dropdown
 * focused ArrowDown and ArrowUp changed the ENGINE instead of moving through
 * its options, and Home/End jumped the dropdown to its first and last option.
 *
 * The unit test in `tests/storage-and-keys.test.ts` pins the predicate. What only
 * a browser can show is the consequence: that the selection really does move
 * when the page has focus, and really does not when the dropdown does. A
 * predicate test alone would still pass if `main.js` stopped calling it.
 */

async function dropTwoPhotos(page: Page): Promise<void> {
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
    A.sessDet = {
      inputNames: ["images"],
      async run() {
        return { output0: { dims: [1, 5, 8400], data: new Float32Array(5 * 8400) } };
      },
    } as any;
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run() {
        const dim = A.embeds.dim as number;
        const d = new Float32Array(dim);
        d.fill(1 / Math.sqrt(dim));
        return { embedding: { dims: [1, dim], data: d } };
      },
    } as any;

    const files: File[] = [];
    for (let i = 0; i < 2; i++) {
      const cv = document.createElement("canvas");
      cv.width = 320;
      cv.height = 240;
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = `hsl(${i * 120}, 50%, 50%)`;
      ctx.fillRect(0, 0, cv.width, cv.height);
      const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/jpeg", 0.9));
      files.push(new File([blob!], `p${i}.jpg`, { type: "image/jpeg" }));
    }
    await A.processFiles(files);
  });
}

test.describe("the keyboard belongs to whatever the user is focused on", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
  });

  test("ArrowRight on the page moves the selection", async ({ page }) => {
    await dropTwoPhotos(page);
    const select = page.locator("#engine-select");
    await select.focus();
    // Move focus off the control and onto the page body, which is the case the
    // handler exists for.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const before = await page.evaluate(() => window.__mosqAsync!.selectedIndex);
    await page.keyboard.press("ArrowRight");
    const after = await page.evaluate(() => window.__mosqAsync!.selectedIndex);
    expect(after).toBe(before + 1);
  });

  test("ArrowRight on the engine dropdown does not move the selection", async ({ page }) => {
    await dropTwoPhotos(page);
    const select = page.locator("#engine-select");
    await select.focus();
    const focused = await page.evaluate(() => document.activeElement?.id);
    expect(focused).toBe("engine-select");

    const before = await page.evaluate(() => window.__mosqAsync!.selectedIndex);
    await page.keyboard.press("ArrowRight");
    const after = await page.evaluate(() => window.__mosqAsync!.selectedIndex);
    // The regression: this used to move the photo selection while the user was
    // operating the engine dropdown.
    expect(after).toBe(before);
  });

  test("Home on the engine dropdown does not jump to the first photo", async ({ page }) => {
    await dropTwoPhotos(page);
    await page.locator("#engine-select").focus();
    // Put the selection on the LAST photo, so a handler that fired would be
    // visible as a change. `previews.length - 1` is 1 with two photos.
    const atEnd = await page.evaluate(() => {
      const last = window.__mosqAsync!.previews.length - 1;
      window.__mosqAsync!.selectedIndex = last;
      return last;
    });
    expect(atEnd).toBeGreaterThan(0);
    await page.keyboard.press("Home");
    const after = await page.evaluate(() => window.__mosqAsync!.selectedIndex);
    expect(after).toBe(atEnd);
  });

  test("Alt+ArrowLeft is the browser's Back, not the app's selection change", async ({ page }) => {
    await dropTwoPhotos(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // Start on the LAST photo, so a handler that fired would move the selection
    // visibly. At index 0, ArrowLeft clamps back to 0 and the assertion would
    // pass whatever the code did - which is how this test was vacuous at first.
    const atEnd = await page.evaluate(() => {
      const last = window.__mosqAsync!.previews.length - 1;
      window.__mosqAsync!.selectedIndex = last;
      return last;
    });
    expect(atEnd).toBeGreaterThan(0);
    await page.keyboard.press("Alt+ArrowLeft");
    const after = await page.evaluate(() => window.__mosqAsync!.selectedIndex);
    expect(after).toBe(atEnd);
  });

  test("Cmd+ArrowLeft is the browser's Back on macOS, not the app's selection", async ({ page }) => {
    // A removal rather than a guard, and the one cost of routing every modifier
    // to the browser: `Cmd+Left`/`Cmd+Right` used to drive the selection, because
    // macOS browsers report them as Home/End. They no longer do. Deliberate -
    // stealing Back/Forward in a photo browser is worse - but pinned, so it is
    // a decision on the record rather than something a user discovers.
    await dropTwoPhotos(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const atEnd = await page.evaluate(() => {
      const last = window.__mosqAsync!.previews.length - 1;
      window.__mosqAsync!.selectedIndex = last;
      return last;
    });
    expect(atEnd).toBeGreaterThan(0);
    await page.keyboard.press("Meta+ArrowLeft");
    const after = await page.evaluate(() => window.__mosqAsync!.selectedIndex);
    expect(after).toBe(atEnd);
  });

  test("ArrowLeft on the page DOES move the selection, so the tests above can fail", async ({ page }) => {
    // The control on the Alt test. Without it, every "the selection did not
    // move" assertion passes for the wrong reason whenever the selection is
    // already where the key would have put it.
    await dropTwoPhotos(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.evaluate(() => {
      window.__mosqAsync!.selectedIndex = window.__mosqAsync!.previews.length - 1;
    });
    const before = await page.evaluate(() => window.__mosqAsync!.selectedIndex);
    expect(before).toBeGreaterThan(0);
    await page.keyboard.press("ArrowLeft");
    const after = await page.evaluate(() => window.__mosqAsync!.selectedIndex);
    expect(after).toBe(before - 1);
  });

  test("a browser with localStorage disabled still boots the app", async ({ page }) => {
    // The shape of the original bug: a throw inside DOMContentLoaded before
    // anything is wired, so the page renders its shell and then does nothing.
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw new DOMException("storage disabled for this origin", "SecurityError");
        },
      });
    });
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__mosqAsync), null, { timeout: 15000 });
    const wired = await page.evaluate(() => {
      const A = window.__mosqAsync!;
      return {
        hasSeam: Boolean(A),
        // Wired AFTER the preference reads, so these are the canary for "init
        // threw partway through". Measured, not assumed: reverting `readPref`'s
        // guard leaves all three of these true, because the samples and CSV
        // buttons are wired a few lines BEFORE the first throwing read — so they
        // are the canary for the correlation slider and the keydown listener
        // below, which are wired after it. `hasSeam` is not a canary at all:
        // `__mosqAsync` is assigned at module scope, long before this.
        samplesButton: Boolean(document.getElementById("btn-samples")?.onclick),
        csvButton: Boolean(document.getElementById("btn-csv")?.onclick),
        corrSlider: Boolean(
          (document.getElementById("corr-slider") as HTMLInputElement | null)?.oninput,
        ),
      };
    });
    expect(wired.hasSeam).toBe(true);
    expect(wired.samplesButton).toBe(true);
    expect(wired.csvButton).toBe(true);
    expect(wired.corrSlider).toBe(true);
    // And no preference read escaped as an uncaught error. Reverting the guard
    // fails HERE, not on the canaries above - measured by doing exactly that.
    expect(errors(page).filter((e) => e.includes("SecurityError"))).toEqual([]);
  });
});
