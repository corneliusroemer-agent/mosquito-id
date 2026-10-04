// What the model bar actually shows, against a real model load.
//
// The question this answers is the one a unit test structurally cannot: does the
// browser ever render 100% while `window.modelsReady` is false? That needs a
// real download and a real `InferenceSession.create`, because the gap the bar
// used to paper over only exists in the time between them.
//
// Not part of `npm test` - it pays for a model download, so it is run by hand
// against a served build, and it is the evidence behind the invariant the unit
// tests pin.
//
//   npx vite preview --host 127.0.0.1 --port 4173 --strictPort &
//   node tests/progress-bar-probe.mjs http://127.0.0.1:4173 [engineKey]
//
// Cold and warm are measured in ONE browser context, so the second pass is a
// genuine CacheStorage hit rather than a cold repeat.
import { chromium } from "playwright";

const BASE = process.argv[2] || "http://127.0.0.1:4173";
const ENGINE = process.argv[3] || "webgpu-culico";
const EXEC = process.env.CHROMIUM_PATH ||
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome`;

const browser = await chromium.launch({ executablePath: EXEC, args: ["--no-sandbox"] });
const ctx = await browser.newContext();
const page = await ctx.newPage();

await page.addInitScript((engine) => {
  try { localStorage.setItem("mosquito_engine", engine); } catch { /* private mode */ }
}, ENGINE);

/**
 * One load, sampled every animation frame.
 *
 * `readyAt` is captured from inside the page rather than polled afterwards: the
 * claim under test is about the bar at the instant the model becomes usable, and
 * polling can only ever observe it afterwards.
 */
await page.addInitScript(() => {
  window.__samples = [];
  window.__t0 = performance.now();
  window.__readyAt = null;
  const tick = () => {
    if (window.modelsReady === true && window.__readyAt === null) {
      window.__readyAt = performance.now() - window.__t0;
    }
    const slot = document.getElementById("progress-slot");
    if (slot && slot.style.visibility === "visible") {
      const fill = document.getElementById("progress-fill");
      window.__samples.push({
        t: performance.now() - window.__t0,
        w: fill ? fill.style.width : null,
        indeterminate: slot.classList.contains("indeterminate"),
        meter: (document.getElementById("progress-meter") || {}).textContent,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

async function pass(label) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.modelsReady === true, null, { timeout: 600_000 });
  const samples = await page.evaluate(() => window.__samples);
  const readyAt = await page.evaluate(() => window.__readyAt);

  console.log(`\n=== ${label} === ready at ${Math.round(readyAt)} ms, ${samples.length} visible samples`);
  let prev = null;
  for (const s of samples) {
    const key = `${s.w}|${s.meter}`;
    if (key === prev) continue;
    prev = key;
    console.log(String(Math.round(s.t)).padStart(8), (s.indeterminate ? "INDET" : s.w).padStart(13),
      JSON.stringify(s.meter || ""));
  }

  // The invariant: a full bar means an inference can run. Anything else is the
  // defect this module exists to prevent.
  const unearned = samples.filter((s) => s.w === "100%" && (readyAt === null || s.t < readyAt));
  if (unearned.length === 0) {
    console.log("OK: the bar never read 100% before modelsReady");
  } else {
    console.log(`FAIL: the bar read 100% ${unearned.length}x before modelsReady`);
    process.exitCode = 1;
  }
}

await pass("COLD");
await pass("WARM (CacheStorage)");
await browser.close();