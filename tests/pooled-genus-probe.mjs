// The pooled genus headline, end to end through the real updatePooling() path:
// no classifier, no R2. Fabricated posteriors go in through the same window the
// app itself uses, and what the user would see is read back off the page.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

const server = http.createServer((req, res) => {
  const f = path.join(ROOT, req.url.split("?")[0].replace(/^\//, "") || "index.html");
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "text/plain" });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome`,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
await page.route(/(\.onnx|\.r2\.dev)/, (r) => r.abort());
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
await page.goto(base);
await page.waitForFunction(() => window.__mosqAsync && window.__mosqAsync.embeds !== undefined);

// Build photos with a fabricated fused posterior. updatePooling() reads p.logits,
// which the app stores as scale*cos = log p + logZ, so logits[sp] = log(p[sp]) is
// a consistent fabrication: the pooled softmax then recovers the pooled posterior
// exactly, which is the property the feature rests on.
await page.evaluate(async () => {
  const EMB0 = await (await fetch("text_embeds.json")).json();
  const SP = EMB0.species;
  window.__mosqAsync.embeds = { species: SP, logit_scale: 100 };
  const post = (over) => {
    const v = SP.map((n) => over[n] || 0);
    const s = v.reduce((a, b) => a + b, 0);
    return v.map((x) => x / s);
  };
  const mk = (name, sp, state) => ({
    name, scores: SP, pending: false, error: null, rev: 0, fullCanvas: null,
    contextCanvas: null, fingerprint: name, detail: Object.fromEntries(SP.map((n, i) => [n, sp[i]])),
    logits: Object.fromEntries(SP.map((n, i) => [n, Math.log(Math.max(sp[i], 1e-12))])),
    verdict: { state, genus: null, species: null, topGenusP: 0, topSpeciesP: 0, runnersUp: [] },
  });

  const arr = window.__mosqAsync.previews;
  arr.length = 0;
  // torn.jpg: no species clears the floor, but the genus is clear -> pooled headline.
  const torn = post({ "Aedes aegypti": 0.30, "Aedes albopictus": 0.29, "Aedes japonicus": 0.19, "Culex pipiens": 0.22 });
  // sure.jpg: one species dominates -> the pool reaches the species state.
  const sure = post({ "Aedes aegypti": 0.93, "Aedes albopictus": 0.03, "Culex pipiens": 0.02, "Anopheles claviger": 0.02 });
  arr.push(mk("torn.jpg", torn, "genus"));
  arr.push(mk("torn2.jpg", post({ "Aedes aegypti": 0.31, "Aedes albopictus": 0.30, "Aedes japonicus": 0.20, "Culex pipiens": 0.19 }), "genus"));
  arr.push(mk("torn3.jpg", post({ "Aedes albopictus": 0.34, "Aedes aegypti": 0.30, "Culex pipiens": 0.20, "Aedes japonicus": 0.16 }), "genus"));
  arr.push(mk("torn4.jpg", post({ "Aedes aegypti": 0.33, "Aedes japonicus": 0.28, "Aedes albopictus": 0.24, "Culex pipiens": 0.15 }), "genus"));
  arr.push(mk("torn5.jpg", post({ "Aedes albopictus": 0.33, "Aedes aegypti": 0.32, "Aedes japonicus": 0.19, "Culex pipiens": 0.16 }), "genus"));
  arr.push(mk("sure.jpg", sure, "species"));
  arr.push(mk("sure2.jpg", post({ "Aedes aegypti": 0.90, "Culex pipiens": 0.06, "Aedes albopictus": 0.04 }), "species"));
  arr.push(mk("sure3.jpg", post({ "Aedes aegypti": 0.88, "Aedes albopictus": 0.07, "Culex pipiens": 0.05 }), "species"));
  arr.push(mk("sure4.jpg", post({ "Aedes aegypti": 0.91, "Culex pipiens": 0.05, "Aedes albopictus": 0.04 }), "species"));
  arr.push(mk("sure5.jpg", post({ "Aedes aegypti": 0.89, "Culex pipiens": 0.06, "Aedes japonicus": 0.05 }), "species"));
  window.__SP = SP;
});

// Check the first n photos through the app's own checkbox, the way a user does,
// so the pool is populated by the real path rather than by a test-only seam.
const read = (want) => page.evaluate((want) => {
  const set = new Set(want);
  const boxes = Array.from(document.querySelectorAll("#thumbnail-strip .thumb-optin"));
  boxes.forEach((b, i) => {
    const on = set.has(i);
    if (b.checked !== on) { b.checked = on; b.dispatchEvent(new Event("change")); }
  });
  const card = document.getElementById("combined-card");
  const box = document.getElementById("combined-scores");
  const head = box.querySelector(".combined-genus-headline");
  const row = box.querySelector(".combined-candidate");
  return {
    cardH: +card.getBoundingClientRect().height.toFixed(2),
    cardTop: +card.getBoundingClientRect().top.toFixed(2),
    boxH: +box.getBoundingClientRect().height.toFixed(2),
    headText: head ? head.textContent : null,
    headH: head ? +head.getBoundingClientRect().height.toFixed(2) : null,
    firstRowTop: row ? +row.getBoundingClientRect().top.toFixed(2) : null,
    rows: box.querySelectorAll(".combined-candidate").length,
    checkedCount: boxes.filter((b)=>b.checked).length,
    nBoxes: boxes.length,
  };
}, want);

await page.evaluate(() => {
  document.getElementById("gallery-section").style.display = "block";
  // The thumbnails are the app's own render of previews; selecting photo 0 is
  // the public entry point that draws them, so the checkboxes the probe toggles
  // are the ones a user would click.
  window.__mosqAsync.selectPhoto(0);
});
await read([]);

// Photos 0-4 are torn, 5-9 confident. n5 and n5torn are the control pair: the
// same pool size and the same code path, differing only in the pooled posterior,
// so the headline's presence tracks that posterior and nothing else.
const POOLS = {
  n0: [],
  n1: [0],
  n2: [0, 1],
  n3: [0, 1, 2],
  n5: [5, 6, 7, 8, 9],
  n5torn: [0, 1, 2, 3, 4],
};
const heights = {};
const out = {};
for (const [k, ids] of Object.entries(POOLS)) {
  out[k] = await read(ids);
  heights[k] = out[k].cardH;
  if (k === "n3") out.sticky = await page.evaluate(() => {
    const h = document.querySelector(".combined-genus-headline");
    const box = document.getElementById("combined-scores");
    return { position: getComputedStyle(h).position, insideBox: box.contains(h) };
  });
}
console.log(JSON.stringify(out, null, 1));

const fail = [];
// Height invariance across pool sizes - the hard requirement.
const uniq = [...new Set(Object.values(heights))];
if (uniq.length !== 1) fail.push(`card height varies with pool size: ${JSON.stringify(heights)}`);
// A torn pool must get the genus headline.
if (!out.n3.headText || !/^Definitely Aedes\b/.test(out.n3.headText)) {
  fail.push(`torn pool: unexpected headline ${JSON.stringify(out.n3.headText)}`);
}
// Every torn pool at two or more photos gets the genus headline; the pools that
// reach the species state do not, because the ranking below already leads with
// the binomial and a headline repeating it would say nothing new.
for (const k of ["n2", "n3", "n5torn"]) {
  if (!/^Definitely Aedes\b/.test(out[k].headText || "")) {
    fail.push(`${k}: expected the genus headline, got ${JSON.stringify(out[k].headText)}`);
  }
}
if (out.n5.headText !== null) fail.push(`confident species pool: spurious headline ${JSON.stringify(out.n5.headText)}`);
// Fewer than two photos never reaches the aggregation, so the card shows its
// prompt and there is no pooled posterior to report on.
for (const k of ["n0", "n1"]) {
  if (out[k].headText !== null) fail.push(`${k}: headline present ${JSON.stringify(out[k].headText)}`);
}
// No placeholder text anywhere.
for (const k of Object.keys(out)) {
  const t = out[k].headText;
  if (t && /—|--|\.\.\.|…/.test(t)) fail.push(`${k}: placeholder-looking headline ${JSON.stringify(t)}`);
}
// The headline must be inside the fixed box, not above it: sticky, in flow.
if (out.sticky.position !== "sticky" || !out.sticky.insideBox) {
  fail.push(`headline not sticky inside #combined-scores: ${JSON.stringify(out.sticky)}`);
}

console.log(fail.length ? "FAIL\n" + fail.join("\n") : "PASS");
await browser.close();
process.exit(fail.length ? 1 : 0);