// Live probe: does a CacheStorage HIT ever move the progress bar?
// Uses only the 10.6 MB YOLO detector - never the 1.26 GB classifier.
import { chromium } from "playwright";

const URL = "https://corneliusroemer-agent.github.io/mosquito-id/";
const EXEC = process.env.PW_EXEC ||
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome`;

const probe = async (page, label) => page.evaluate(async (label) => {
  const detPath = resolveModelUrl("yolo11n-mosquito-det-640.onnx");
  const samples = [];
  const t0 = performance.now();
  const timer = setInterval(() => {
    const fill = document.getElementById("progress-fill");
    const slot = document.getElementById("progress-slot");
    samples.push({
      t: Math.round(performance.now() - t0),
      w: fill ? fill.style.width : null,
      indeterminate: slot ? slot.classList.contains("indeterminate") : null,
      msg: (document.getElementById("progress-msg") || {}).textContent,
      meter: (document.getElementById("progress-meter") || {}).textContent,
    });
  }, 25);
  const buf = await fetchWithCache(detPath, makeTransferProgress("Detector (YOLO11n)"));
  clearInterval(timer);
  const distinct = [...new Set(samples.map((s) => `${s.w}|${s.indeterminate}`))];
  return {
    label,
    bytes: buf.byteLength,
    samples: samples.length,
    distinctStates: distinct,
    first: samples[0],
    last: samples[samples.length - 1],
  };
}, label);

const browser = await chromium.launch({ executablePath: EXEC, args: ["--enable-unsafe-webgpu"] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof window.fetchWithCache === "function");

console.log(JSON.stringify(await probe(page, "MISS (cold)"), null, 1));
console.log(JSON.stringify(await probe(page, "HIT (warm)"), null, 1));
await browser.close();
