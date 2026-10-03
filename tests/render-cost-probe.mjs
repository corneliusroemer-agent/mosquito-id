// Local verification of render cost and strip behaviour: no R2, no classifier,
// no CORS. Serves the app with every .onnx aborted, drives the real render path
// with synthetic canvases, and asserts two things a screenshot cannot show.
//
//   1. A re-render costs what a re-render should cost. The strip used to be
//      torn down and rebuilt - `innerHTML = ""`, then a fresh `toDataURL` per
//      tile - which put ~118 ms of synchronous JPEG encoding on the thread that
//      also paints, once per photo. That is the frozen UI.
//
//   2. Reusing tile nodes changed nothing a user or a screen reader can observe.
//      The whole point of the cache is that it is invisible; if it were not, the
//      performance win would not be worth taking.
//
// Run: node tests/render-cost-probe.mjs
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// The BUILT site, not the checkout: index.html loads a Vite bundle from
// /src/app/main.js, so serving the repo root 404s on the entry script. This
// probe needs the build to be current - run `npm run build` first, which is also
// why a stale bundle would give a false pass here.
const ROOT = path.resolve(import.meta.dirname, "..", "dist");
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(ROOT, rel === "/" ? "index.html" : rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await page.route("**/*.onnx", (r) => r.abort());
await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
// The app's own test seam. The render path is module-scoped, so the probe cannot
// reach these by bare name the way it could when main.js was a classic script -
// and it must not eval them out of the bundle, or it would be measuring a
// different copy of the code than the one that ships.
await page.waitForFunction(() => window.__mosqAsync?.renderThumbnails);

// Photos at the size a phone actually produces. The cost of the thing being
// measured is proportional to pixel count, so a small canvas would measure the
// mechanism rather than the problem.
const result = await page.evaluate(async () => {
  const A = window.__mosqAsync;
  const emb = await fetch("text_embeds.json").then((r) => r.json());
  for (const k of ["species_emb", "nuisance_emb"]) emb[k] = Float32Array.from(emb[k]);
  A.embeds = emb;
  const EMB = emb;

  const canvas = (w, h, colour) => {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#fff";
    ctx.font = "40px sans-serif";
    ctx.fillText("PHOTO", 30, 80);
    return cv;
  };
  const photo = (i) => {
    const full = canvas(4000, 3000, `hsl(${i * 60}, 50%, 60%)`);
    return {
      name: `photo_${i}.jpg`, fullCanvas: full, cropCanvas: canvas(1200, 1200, `hsl(${i * 60}, 60%, 40%)`),
      contextCanvas: full, is_cropped: true, crop_rejected: false, pending: false, error: null,
      rev: 0, status: "ok",
      detail: { "Aedes aegypti": 0.4, "Aedes albopictus": 0.3, "Culex pipiens": 0.1,
                "Culex quinquefasciatus": 0.1, "Aedes communis": 0.1 },
      scores: { "Aedes aegypti": 0.6 }, verdict: { state: "species", genus: "Aedes" },
      logits: Object.fromEntries(EMB.species.map((s, j) => [s, EMB.species_emb[j][0] * 10 + 0.1 * j])),
    };
  };

  A.previews.length = 0;
  A.includedIndices.clear();
  for (let i = 0; i < 10; i++) { A.previews.push(photo(i)); A.includedIndices.add(i); }
  A.selectedIndex = 0;
  document.getElementById("gallery-section").style.display = "block";
  document.getElementById("results-table-section").style.display = "block";
  A.renderThumbnails(); A.renderActivePhoto(); A.updatePooling(); A.renderResultsTable();
  await new Promise((r) => setTimeout(r, 400));

  // What a batch does: re-render after every photo that lands.
  const time = (fn, n) => { const t0 = performance.now(); for (let k = 0; k < n; k++) fn(); return (performance.now() - t0) / n; };
  const renderMs = time(() => { A.renderThumbnails(); A.renderActivePhoto(); }, 10);

  // Tile identity across a re-render: the mechanism the cost saving rests on.
  const strip = document.getElementById("thumbnail-strip");
  const before = strip.children[0];
  A.renderThumbnails();
  const reused = strip.children[0] === before;

  // Behaviour. Every one of these passed before the change and must still.
  const strip3 = strip.children[2].querySelector(".tile-btn");
  strip3.click();
  await new Promise((r) => setTimeout(r, 200));
  const selection = { selected: A.selectedIndex, active: strip.children[2].className.includes("active") };

  const chk = strip.children[0].querySelector(".thumb-optin");
  const wasIn = A.includedIndices.has(0);
  chk.click();
  await new Promise((r) => setTimeout(r, 200));
  const checkbox = { flipped: A.includedIndices.has(0) !== wasIn, excluded: strip.children[0].className.includes("excluded") };
  chk.click();
  await new Promise((r) => setTimeout(r, 200));

  // Deleting the leftmost tile must remove the right photo and renumber the
  // rest, and must not leave a detached node behind in the strip.
  strip.children[1].querySelector(".tile-delete-btn").click();
  await new Promise((r) => setTimeout(r, 250));
  const afterDelete = {
    names: A.previews.map((p) => p.name).join(","),
    numbers: [...strip.querySelectorAll(".number")].map((n) => n.textContent).join(","),
    labels: strip.children[0].querySelector(".tile-btn").getAttribute("aria-label"),
    tiles: strip.children.length,
    previews: A.previews.length,
  };

  return { renderMs: +renderMs.toFixed(2), reused, selection, checkbox, afterDelete };
});

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

// The old path cost ~118 ms. A budget rather than an exact number: what this
// asserts is that a re-render is not doing per-tile JPEG encoding any more.
check("a re-render costs under 8ms", result.renderMs < 8, `${result.renderMs} ms`);
check("tiles are reused across a re-render", result.reused);
check("clicking a tile selects it", result.selection.selected === 2 && result.selection.active,
  `selectedIndex=${result.selection.selected}`);
check("the opt-in checkbox still excludes", result.checkbox.flipped && result.checkbox.excluded);
check("deleting tile 2 removes photo_1", result.afterDelete.names === "photo_0.jpg,photo_2.jpg,photo_3.jpg,photo_4.jpg,photo_5.jpg,photo_6.jpg,photo_7.jpg,photo_8.jpg,photo_9.jpg",
  result.afterDelete.names);
check("the remaining tiles renumber", result.afterDelete.numbers === "1,2,3,4,5,6,7,8,9", result.afterDelete.numbers);
check("the aria-label follows the renumber", result.afterDelete.labels === "View photo 1: photo_0.jpg", result.afterDelete.labels);
check("no detached tiles are left in the DOM", result.afterDelete.tiles === result.afterDelete.previews,
  `${result.afterDelete.tiles} tiles / ${result.afterDelete.previews} photos`);

await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
