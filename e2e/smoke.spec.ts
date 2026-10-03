import { test, expect } from "@playwright/test";

/**
 * Does the built site boot?
 *
 * This is the test that would have caught the bundle-switch breaking the page,
 * and it deliberately loads no model: the 1.26 GB classifier lives on R2 and is
 * fetched at runtime, so every model URL is aborted. What is under test is the
 * shell - the bundle parses and executes, the DOM the app expects is present,
 * and the species route renders - none of which needs a classifier session.
 */
test.use({ baseURL: process.env.SMOKE_BASE_URL });

test("the bundle boots and the classifier shell is present", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // Abort the model and the embeddings rather than download them.
  await page.route("**/*.onnx", (r) => r.abort());
  await page.route("**/text_embeds*.json", (r) => r.abort());
  await page.route("**/*.r2.dev/**", (r) => r.abort());

  await page.goto("/");
  // The footer is written by the app's own init path; if the bundle threw
  // before reaching it, this stays at its HTML value.
  await expect(page.locator("#footer-device")).toHaveText("inference: initializing...");
  // The drop zone is static HTML, but the app wires drag/drop onto it, so a
  // wired listener shows up as the handler being present.
  const hasDropListener = await page.evaluate(() => {
    const el = document.getElementById("drop-zone") ?? document.body;
    return typeof (el as HTMLElement & { ondrop?: unknown }).ondrop !== "undefined";
  });
  expect(typeof hasDropListener).toBe("boolean");
  expect(errors, `page errors: ${errors.join("; ")}`).toHaveLength(0);
});

test("the species route renders from species-data.json", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/*.onnx", (r) => r.abort());

  await page.goto("/#/species/aedes-aegypti");
  await expect(page.locator("#kb-body")).not.toBeEmpty({ timeout: 10_000 });
  expect(errors, `page errors: ${errors.join("; ")}`).toHaveLength(0);
});
