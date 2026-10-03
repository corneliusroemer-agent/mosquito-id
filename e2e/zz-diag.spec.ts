import { test } from "@playwright/test";
import { readFileSync } from "node:fs";
test("diag", async ({ page }) => {
  test.setTimeout(120_000);
  const stub = readFileSync("e2e/fixtures/stub.onnx");
  const onnx: string[] = [];
  page.on("request", (r) => { if (r.url().endsWith(".onnx")) onnx.push(r.url().split("/").pop()!); });
  page.on("console", (m) => console.log("[c]", m.type(), m.text().slice(0, 150)));
  page.on("pageerror", (e) => console.log("[E]", String(e).slice(0, 200)));
  await page.route("**/*.r2.dev/**", (r) => r.abort());
  await page.route("**/*.onnx", (r) => r.fulfill({ status: 200, contentType: "application/octet-stream", body: stub }));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as any).modelsReady === true, null, { timeout: 60000 }).catch(() => console.log("NOT READY"));
  console.log("ONNX:", JSON.stringify(onnx));
  console.log("FOOTER:", await page.locator("#footer-device").textContent().catch(() => "ERR"));
  console.log("SUB:", await page.locator("#pipeline-sub").textContent().catch(() => "ERR"));
});
