import { test, expect } from "@playwright/test";
import type { Page, Request } from "@playwright/test";

/**
 * Does the page fetch exactly ONE classifier's ONNX?
 *
 * Adding culico-net as a second classifier is only worth anything if a phone
 * still pulls 81 MB rather than 81 MB + 1.2 GB. Both models sit on the same R2
 * host and both end in `.onnx`, so nothing in the URL distinguishes them and a
 * smoke test that only checks "the shell boots" cannot tell one model from two:
 * both requests are issued, both succeed, and the page works. Only a count of
 * the ONNX requests catches it.
 *
 * The models are aborted, never downloaded - this counts requests, not bytes.
 *
 * The embeddings JSON is deliberately NOT aborted. Aborting it would make the
 * render path bail before it classified anything, so the assertions below would
 * hold for a page that never got as far as running a model. (The ONNX abort
 * stops the app earlier than that anyway, since the session is created from the
 * model buffer; the point is that the embeddings are not what is failing.)
 *
 * A stale `dist/` gives false passes: playwright.config.ts reuses an already
 * running preview server when one is up (`reuseExistingServer: !process.env.CI`),
 * so a server left serving a build from before this change is never rebuilt and
 * the test measures the old bundle. Delete `dist/` before believing a green run.
 */

const DETECTOR = "yolo11n-mosquito-det-640.onnx";
const CULICO = "culico-net-cls-v1-17-embed.onnx";
const H14_FP16 = "bioclip_2_5_fp16.onnx";

/** Every classifier ONNX the app knows how to ask for, by filename. */
const CLASSIFIERS = [
  "culico-net-cls-v1-17-embed.onnx",
  "bioclip_visual_b16_fp16.onnx",
  "bioclip_2_5_fp16.onnx",
  "bioclip_2_5_int8.onnx",
];

type OnnxLog = {
  /** Requested filenames, in order, duplicates included. */
  seen: string[];
  /** How many distinct classifier filenames were requested so far. */
  classifiers: () => string[];
  /** Highest number of distinct classifiers requested at the same instant. */
  maxConcurrentClassifiers: () => number;
  /** Whether the embeddings JSON was fetched rather than blocked. */
  embedsFetched: () => boolean;
};

/**
 * Records every `.onnx` request and aborts it. Registered before the catch-all
 * `*.r2.dev` route so the ONNX handler is the one that sees these URLs, which
 * keeps the request log and the abort in one place.
 */
async function watchOnnx(page: Page): Promise<OnnxLog> {
  const seen: string[] = [];
  const live = new Set<string>();
  let maxConcurrent = 0;
  let embedsFetched = false;

  const name = (url: string): string => url.split("/").pop() ?? url.split("?")[0] ?? url;
  const note = (url: string) => {
    const f = name(url);
    seen.push(f);
    if (CLASSIFIERS.includes(f)) {
      live.add(f);
      maxConcurrent = Math.max(maxConcurrent, live.size);
    }
  };

  page.on("request", (r) => {
    if (r.url().endsWith(".onnx")) note(r.url());
    if (r.url().includes("text_embeds")) embedsFetched = true;
  });
  const settle = (r: Request) => {
    if (!r.url().endsWith(".onnx")) return;
    const f = name(r.url());
    if (CLASSIFIERS.includes(f)) live.delete(f);
  };
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);

  // One route, registered before the listeners matter: Playwright runs the most
  // recently registered matching route FIRST, so a `**/*.onnx` handler stacked
  // under a `**/*.r2.dev/**` handler means the .onnx one never runs -- and, worse,
  // the aborted request never reaches the `request` listener either, so the log
  // this test is built on comes back empty and the assertions pass or fail for
  // the wrong reason. Aborting every R2 URL covers the models and leaves
  // text_embeds*.json alone, because it is served from `public/` not R2.
  await page.route("**/*.r2.dev/**", (r) => r.abort());
  // text_embeds*.json is left alone on purpose - see the file comment.

  return {
    seen,
    classifiers: () => [...new Set(seen.filter((f) => CLASSIFIERS.includes(f)))],
    maxConcurrentClassifiers: () => maxConcurrent,
    embedsFetched: () => embedsFetched,
  };
}

test("only culico's ONNX is fetched, not culico and H/14 together", async ({ page }) => {
  const onnx = await watchOnnx(page);

  await page.goto("/");

  // Wait for the fetch rather than sleeping: model loading is async and its
  // timing is not something to assert on.
  await expect
    .poll(() => onnx.classifiers().length, { timeout: 30_000, message: `onnx seen: ${onnx.seen.join(", ")}` })
    .toBeGreaterThan(0);

  // The detector, plus culico and nothing else. A phone pays 81 MB, not 81 MB
  // + 1.2 GB.
  expect(onnx.seen).toContain(DETECTOR);
  expect(onnx.classifiers()).toEqual([CULICO]);
  expect(onnx.maxConcurrentClassifiers()).toBe(1);

  // culico is the default, and its embeddings are the ones it asks for.
  await expect(page.locator("#engine-select")).toHaveValue("webgpu-culico");
  await expect(page.locator("#pipeline-sub")).toContainText("culico-net-cls-v1");
  // Its known limitation is on the page, not only in the dropdown text.
  await expect(page.locator("#engine-caveat")).toBeVisible();
  await expect(page.locator("#engine-caveat")).toContainText("cannot tell a photo with no mosquito in it");
});

test("switching engines fetches the second classifier, and only that one", async ({ page }) => {
  const onnx = await watchOnnx(page);

  await page.goto("/");
  await expect
    .poll(() => onnx.classifiers().length, { timeout: 30_000, message: `onnx seen: ${onnx.seen.join(", ")}` })
    .toBe(1);
  expect(onnx.classifiers()).toEqual([CULICO]);

  // A/B: pick H/14 FP16. The change handler loads that model, so a second,
  // different classifier ONNX must appear.
  await page.selectOption("#engine-select", "webgpu-fp16");
  await expect
    .poll(() => onnx.classifiers().length, { timeout: 30_000, message: `onnx seen: ${onnx.seen.join(", ")}` })
    .toBe(2);

  expect(onnx.classifiers()).toEqual([CULICO, H14_FP16]);
  // Still one classifier at a time - a regression that eagerly loads both
  // would put two in this set at once, and would also have fetched H/14 before
  // the switch, which the `toEqual([CULICO])` above already rules out.
  expect(onnx.maxConcurrentClassifiers()).toBe(1);
  // culico is not pulled a second time on the way to the other model.
  expect(onnx.seen.filter((f) => f === CULICO).length).toBe(1);

  await expect(page.locator("#pipeline-sub")).toContainText("BioCLIP 2.5 H/14");
});
