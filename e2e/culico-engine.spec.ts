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
 * The models are not downloaded. Each `*.onnx` is answered with the 125-byte
 * stub graph below, which onnxruntime can build a session from, so the app
 * boots all the way to `window.modelsReady` and this is a real run - it counts
 * requests, not bytes. The stub cannot be an abort: init loads the detector
 * FIRST and `loadWebGPUModels` awaits its session, so a failed detector fetch
 * throws out of init before any classifier is ever asked for. A test that
 * aborted every ONNX would then watch an empty request list and pass for the
 * wrong reason.
 *
 * `text_embeds*.json` is deliberately left alone. It is served from `public/`
 * and has to load, or the render path bails before it classifies anything and
 * the assertions below would hold for a page that never ran a model.
 *
 * Two things this needs from the harness, both easy to get wrong:
 *
 * - `node_modules` in this worktree is a symlink into the shared app checkout.
 *   Replacing it with a real `npm ci` install puts a second @playwright/test on
 *   disk; the spec then binds `test()` from a different instance than the
 *   runner, and collection fails with "Playwright Test did not expect test() to
 *   be called here".
 * - Playwright matches the LAST registered route first, so the specific ONNX
 *   handler must be registered AFTER the catch-all R2 handler. In the other
 *   order the abort wins, nothing loads, and the test passes on an empty
 *   request list.
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
const CLASSIFIERS = [CULICO, "bioclip_visual_b16_fp16.onnx", H14_FP16, "bioclip_2_5_int8.onnx"];

/**
 * A minimal but genuine ONNX graph: one Identity node, input -> output. 125
 * bytes, embedded rather than kept as a fixture file so that a `git clean`
 * cannot leave this test quietly answering every model request with nothing.
 *
 * Regenerate with:
 *   uv run --with onnx python -c "from onnx import helper, TensorProto as T; \
 *     x=helper.make_tensor_value_info('input',T.FLOAT,[1,3,8,8]); \
 *     y=helper.make_tensor_value_info('output',T.FLOAT,[1,3,8,8]); \
 *     g=helper.make_graph([helper.make_node('Identity',['input'],['output'])],'stub',[x],[y], \
 *       [helper.make_tensor('v',T.FLOAT,[1],[0.0])]); \
 *     m=helper.make_model(g,opset_imports=[helper.make_opsetid('',18)],ir_version=8); \
 *     onnx.save(m,'stub.onnx')"
 */
const STUB = Buffer.from(
  "CAg6cwoZCgVpbnB1dBIGb3V0cHV0IghJZGVudGl0eRIEc3R1YioNCAEQASIEAAAAAEIBdlofCgVpbnB1dBIWChQIARIQCgII" +
    "AQoCCAMKAggICgIICGIgCgZvdXRwdXQSFgoUCAESEAoCCAEKAggDCgIICAoCCAhCBAoAEBI=",
  "base64",
);

type OnnxLog = {
  /** Requested filenames, in order, duplicates included. */
  readonly seen: string[];
  /** Distinct classifier filenames requested so far, in first-seen order. */
  classifiers: () => string[];
  /** Highest number of distinct classifiers requested at the same instant. */
  maxConcurrentClassifiers: () => number;
};

const filename = (url: string): string => url.split("/").pop() ?? url;

/**
 * Records every `.onnx` request and answers it with the stub. Model loading is
 * async and its timing is not something to assert on, so tests wait for the
 * requests to appear rather than sleeping for a fixed time.
 */
async function watchOnnx(page: Page): Promise<OnnxLog> {
  const seen: string[] = [];
  const inFlight = new Set<string>();
  let maxConcurrent = 0;

  page.on("request", (r) => {
    if (!r.url().endsWith(".onnx")) return;
    const f = filename(r.url());
    seen.push(f);
    if (CLASSIFIERS.includes(f)) {
      inFlight.add(f);
      maxConcurrent = Math.max(maxConcurrent, inFlight.size);
    }
  });
  const settle = (r: Request) => {
    if (r.url().endsWith(".onnx")) inFlight.delete(filename(r.url()));
  };
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);

  // Order matters - see the file comment.
  await page.route("**/*.r2.dev/**", (r) => r.abort());
  await page.route("**/*.onnx", (r) =>
    r.fulfill({ status: 200, contentType: "application/octet-stream", body: STUB }),
  );

  return {
    seen,
    classifiers: () => [...new Set(seen.filter((f) => CLASSIFIERS.includes(f)))],
    maxConcurrentClassifiers: () => maxConcurrent,
  };
}

/** True once init has finished, which is when the classifier request is made. */
const modelsReady = (page: Page) =>
  page.waitForFunction(() => (window as { modelsReady?: boolean }).modelsReady === true, null, {
    timeout: 60_000,
  });

test("only culico's ONNX is fetched, not culico and H/14 together", async ({ page }) => {
  const onnx = await watchOnnx(page);

  await page.goto("/");
  await modelsReady(page);

  // The detector, plus culico and nothing else. A phone pays 81 MB, not 81 MB
  // + 1.2 GB.
  expect(onnx.seen, "every .onnx requested").toContain(DETECTOR);
  expect(onnx.classifiers(), "classifiers requested").toEqual([CULICO]);
  expect(onnx.maxConcurrentClassifiers()).toBe(1);

  // culico is the default, it is what the page says is running, and its known
  // limitation is on the page rather than only in the dropdown text.
  await expect(page.locator("#engine-select")).toHaveValue("webgpu-culico");
  await expect(page.locator("#pipeline-sub")).toContainText("culico-net-cls-v1");
  await expect(page.locator("#footer-device")).toContainText("culico-net-cls-v1");
  await expect(page.locator("#engine-caveat")).toBeVisible();
  // The caveat carries the measured limitation, not just a label: a user has to
  // be able to tell how much to trust this engine before they point it at a photo.
  await expect(page.locator("#engine-caveat")).toContainText("no mosquito in it");
  await expect(page.locator("#engine-caveat")).toContainText("73%");
});

test("switching engines fetches the second classifier, and only that one", async ({ page }) => {
  const onnx = await watchOnnx(page);

  await page.goto("/");
  await modelsReady(page);
  expect(onnx.classifiers(), "before the switch").toEqual([CULICO]);

  // A/B: pick H/14 FP16. The change handler loads that model, so a second,
  // different classifier ONNX must appear - and culico must not be asked for
  // again on the way.
  await page.selectOption("#engine-select", "webgpu-fp16");
  await expect
    .poll(() => onnx.classifiers().length, { timeout: 60_000, message: `onnx seen: ${onnx.seen.join(", ")}` })
    .toBe(2);

  expect(onnx.classifiers()).toEqual([CULICO, H14_FP16]);
  // Still one classifier at a time. A regression that eagerly loads both would
  // put two in this set at once, and would also have fetched H/14 before the
  // switch - which the `toEqual([CULICO])` above already rules out.
  expect(onnx.maxConcurrentClassifiers()).toBe(1);
  // culico's session is already built and cached, so switching does not refetch it.
  expect(onnx.seen.filter((f) => f === CULICO), "culico request count").toHaveLength(1);

  await modelsReady(page);
  await expect(page.locator("#pipeline-sub")).toContainText("BioCLIP 2.5 H/14");
  // H/14 has no caveat, so the notice is CLEARED rather than left stale. The line
  // itself keeps its box on purpose -- showing and hiding it moved everything below
  // it, which is a layout shift -- so the assertion is on the text being empty,
  // not on the element being hidden.
  await expect(page.locator("#engine-caveat")).toHaveText("");
});
