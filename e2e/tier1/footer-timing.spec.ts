import { test, expect, boot, settle, resetCls, readCls } from "../helpers/app";
import type { Page } from "@playwright/test";

/**
 * The footer's per-step timing line moves nothing as it is rewritten.
 *
 * The line is written once per analysed photo and carries three timings whose
 * digit counts differ from photo to photo, so its width changed on every photo
 * of a batch. The footer is a centred flex row, so that width change pushed the
 * text on both sides of it - a cumulative layout shift across a whole run.
 *
 * The reservations the fix relies on are in CSS, so this drives the line through
 * digit counts from one to four on all three timings and asserts nothing moves.
 * Four digits is what the reservation covers; beyond it the number would still
 * shift, which is why the sizes here stop there.
 *
 * The counter is zeroed after the first write, because that write is not the
 * churn: it replaces the placeholder `inference: initializing...` with the named
 * engine, a one-time change of what the line says rather than a per-photo
 * rewrite, and it happens while the 1.26 GB engine is still loading. What a batch
 * does is rewrite a line that is already established, and that is what is
 * measured - the same split the layout-shift spec makes when it zeroes after the
 * gallery unhide.
 */

const LABEL = "culico-net-cls-v1 (WEBGPU)";

/** What `main.js` writes for one photo, digit counts deliberately all over. */
const ROWS: [number, number, number][] = [
  [9, 4, 5],
  [81, 33, 48],
  [224, 81, 144],
  [1063, 421, 642],
  [224, 81, 144],
  [9999, 4999, 5000],
  [7, 3, 4],
];

async function writeTiming(page: Page, total: number, crop: number, analyze: number) {
  await page.evaluate(
    ([label, t, c, a]) => {
      const slot = document.getElementById("footer-device")!;
      const num = (ms: number) => {
        const s = document.createElement("span");
        s.className = "timing-num";
        s.textContent = String(ms);
        return s;
      };
      slot.replaceChildren(
        `inference: ${label} · `,
        num(t as number), "ms/photo (crop: ",
        num(c as number), "ms · analyze: ",
        num(a as number), "ms",
      );
    },
    [LABEL, total, crop, analyze] as const,
  );
  await settle(page);
}

test.describe("footer timing line", () => {
  test("rewriting the timings through digit changes moves nothing", async ({ page }) => {
    await boot(page);
    // The line is established first, then the counter zeroed, so what is measured
    // is the rewrites and not the placeholder being replaced.
    await writeTiming(page, ...ROWS[0]!);
    await resetCls(page);

    for (const [total, crop, analyze] of ROWS) {
      await writeTiming(page, total, crop, analyze);
    }

    expect(await readCls(page), await describeShifts(page)).toBe(0);
  });

  test("the reservations are wide enough for every digit count the app emits", async ({ page }) => {
    await boot(page);

    // The defect has two halves and a reservation that only covers the string
    // length fixes one of them: in a proportional font a digit is a different
    // width from the next, so `81` and `144` re-flow even inside a box wide
    // enough for both. Each timing's box has to be the same width for every
    // digit count, which is what `tabular-nums` buys.
    const widths: number[][] = [];
    for (const [total, crop, analyze] of ROWS) {
      await writeTiming(page, total, crop, analyze);
      widths.push(
        await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>("#footer-device .timing-num"), (n) =>
            Math.round(n.getBoundingClientRect().width * 100) / 100,
          ),
        ),
      );
    }

    for (const w of widths) expect(w).toHaveLength(3);
    // Every column is constant width across every row above.
    for (let col = 0; col < 3; col++) {
      const seen = widths.map((w) => w[col]!);
      // Sub-pixel, not exact: `4ch` lands on a fractional CSS pixel, so two rows
      // can differ by 0.01px of rounding without a digit having moved. A digit
      // changing is a whole digit's width, several px.
      const spread = Math.max(...seen) - Math.min(...seen);
      expect(spread, `timing column ${col} changed width: ${seen.join(", ")}`).toBeLessThan(0.5);
    }
    // And wide enough for the four digits the app's slowest realistic photo
    // reports, so the box is a reservation rather than a minimum.
    const fourDigits = await page.evaluate(() => {
      const slot = document.getElementById("footer-device")!;
      const s = document.createElement("span");
      s.className = "timing-num";
      s.textContent = "9999";
      slot.replaceChildren(s);
      return Math.round(s.getBoundingClientRect().width * 100) / 100;
    });
    expect(widths[0]![0]! + 0.5).toBeGreaterThanOrEqual(fourDigits);
  });
});

/** Names the offending elements when CLS is nonzero, so a failure is diagnosable. */
async function describeShifts(page: Page): Promise<string> {
  const log = await page.evaluate(() => (window as any).__mosqShiftLog ?? []);
  return log.length ? `shifts: ${log.join(" | ")}` : "";
}
