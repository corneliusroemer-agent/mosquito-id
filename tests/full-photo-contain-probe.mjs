// The full-photo panel must show every pixel of the photograph, at whatever
// aspect the photo happens to be, and a drag on it must land on the pixels the
// pointer was over. Both are geometry claims, so they are measured off the live
// layout rather than read out of the source: object-fit decides where the photo's
// edges land and the crop overlay is positioned through fitMapping(), and either
// can be wrong in a way that still looks right in the code.
//
// No classifier and no model host: the classifier and the model host are never
// fetched. The photos are synthetic canvases at three aspects, because the bug
// is aspect-dependent and one fixture hides it - landscape in a squarer panel,
// square, and portrait in a wider panel each disagree under cover and must agree
// under contain.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
                ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png" };

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

const fail = [];
const note = (s) => console.log(s);
const check = (ok, msg) => { if (!ok) fail.push(msg); };

// The three fixtures, named for the axis they are meant to catch: a landscape
// photo in a panel that is squarer than it is, and a portrait in a panel wider
// than it is. Both are the cases cover crops on the axis a viewer reads as
// "the edge of the photo".
const ASPECTS = [
  { name: "landscape 16:9", w: 1280, h: 720 },
  { name: "square 1:1", w: 800, h: 800 },
  { name: "portrait 3:4", w: 720, h: 960 },
];

// What the CSS spec says object-fit:contain paints, computed here from the
// photo's own pixel size and the surface's real box rather than from anything
// main.js believes. Under cover this is wrong by the cropped margin, which is
// what makes it a check rather than a restatement.
const containRect = (nw, nh, box) => {
  const s = Math.min(box.width / nw, box.height / nh);
  const w = nw * s, h = nh * s;
  return { width: w, height: h, left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2 };
};
// And the inverse: where on the photo a point on the surface sits.
const containUnmap = (nw, nh, box, px, py) => {
  const r = containRect(nw, nh, box);
  return [(px - r.left) / r.width, (py - r.top) / r.height];
};

async function run(label, viewport) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (e) => note(`PAGEERROR: ${e.message}`));
  await page.route(/(\.onnx|\.r2\.dev)/, (r) => r.abort());

  // Cumulative layout shift, read from the entries the page actually produced.
  await page.addInitScript(() => {
    window.__cls = 0;
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
      }).observe({ type: "layout-shift", buffered: true });
    } catch (e) { /* layout-shift unsupported */ }
  });

  await page.goto(base);
  await page.waitForFunction(() => window.__mosqAsync && window.__mosqAsync.embeds !== undefined);

  await page.evaluate(async (aspects) => {
    // EMB is only assigned once a classifier session is built, which would
    // download the 1.26 GB model. The real label list comes from the same
    // file the app loads, so the shipped species set is exercised.
    const emb0 = JSON.parse(await (await fetch("text_embeds.json")).text());
    window.__mosqAsync.embeds = { species: emb0.species, logit_scale: 100 };
    const SP = emb0.species;
    const post = (over) => {
      const v = SP.map((n) => over[n] || 0);
      const s = v.reduce((a, b) => a + b, 0);
      return v.map((x) => x / s);
    };
    const arr = window.__mosqAsync.previews;
    arr.length = 0;
    for (const a of aspects) {
      // A synthetic photo: a flat colour plus a marker in each corner, so the
      // rendered pixels can be told apart from the panel background.
      const cv = document.createElement("canvas");
      cv.width = a.w; cv.height = a.h;
      const c = cv.getContext("2d");
      c.fillStyle = "#7c3aed"; c.fillRect(0, 0, a.w, a.h);
      c.fillStyle = "#facc15";
      c.fillRect(0, 0, Math.round(a.w * 0.1), Math.round(a.h * 0.1));
      const detail = Object.fromEntries(SP.map((n, i) => [n, i === 0 ? 1 / SP.length : 0]));
      arr.push({
        name: `${a.w}x${a.h}.png`, scores: SP, logits: null, demoted: false, verdict: null,
        pending: false, error: null, rev: 0, status: "", detail, adjacentDetail: null,
        fullCanvas: cv, contextCanvas: null, cropCanvas: null,
        cropBox: null, contextBox: null, is_cropped: false,
        manual_full_photo: false, fallback: false, selected: true,
      });
    }
    void post;
    document.getElementById("gallery-section").style.display = "block";
  }, ASPECTS);

  // Cumulative layout shift, measured on its own and on the path that matters:
  // photos arriving into an already-open gallery. Revealing a display:none
  // gallery is one large shift that belongs to the harness, so the counter is
  // zeroed only after the gallery is up and laid out, and the drags are done
  // after the reading is taken. A panel that resized to its photo's aspect would
  // show up here and nowhere else.
  const settle = () => page.evaluate(() => new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r))));
  await settle();
  await page.evaluate(() => { window.__cls = 0; });

  const out = [];
  let clsArrival = 0;
  // The photo painted into the surface, measured from the rendered pixels rather
  // than computed. Every fixture is a flat violet field with a yellow corner
  // block, so the photo's own extent inside the panel is recoverable: scan for
  // the bounding box of non-background pixels. That box is ground truth for
  // where the photo's edges landed, which is what both the clipping check and
  // the drag check need - and it cannot agree with a bug in main.js, because
  // main.js is not in the measurement.
  const paintedBox = async () => {
    // The crop overlays are drawn over the photo and are neither background nor
    // photo, so they would be read as photo pixels. Hidden for the shot only.
    await page.evaluate(() => {
      for (const id of ["full-active-crop-box", "full-drag-rect"]) {
        const e = document.getElementById(id);
        if (e) { e.dataset.prevDisplay = e.style.display; e.style.display = "none"; }
      }
    });
    const shot = await page.locator("#crop-surface-full").screenshot();
    await page.evaluate(() => {
      for (const id of ["full-active-crop-box", "full-drag-rect"]) {
        const e = document.getElementById(id);
        if (e) e.style.display = e.dataset.prevDisplay || "";
      }
    });
    return page.evaluate(async (b64) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej;
        img.src = "data:image/png;base64," + b64; });
      const cv = document.createElement("canvas");
      cv.width = img.width; cv.height = img.height;
      const c = cv.getContext("2d");
      c.drawImage(img, 0, 0);
      const d = c.getImageData(0, 0, cv.width, cv.height).data;
      // "Is this the photo?" by the photo's own two fill colours, not by
      // guessing the background: the panel fill, its 1px border and its
      // drop shadow are all near-whites and greys, and calling any of them
      // photo would report the whole surface as covered.
      const isPhoto = (x, y) => {
        const o = (y * cv.width + x) * 4;
        const [r, g, b] = [d[o], d[o + 1], d[o + 2]];
        const violet = Math.abs(r - 124) < 24 && Math.abs(g - 58) < 24 && Math.abs(b - 237) < 24;
        const yellow = Math.abs(r - 250) < 24 && Math.abs(g - 204) < 24 && Math.abs(b - 21) < 40;
        return violet || yellow;
      };
      let minX = cv.width, minY = cv.height, maxX = -1, maxY = -1;
      for (let y = 0; y < cv.height; y++) {
        for (let x = 0; x < cv.width; x++) {
          if (isPhoto(x, y)) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return null;
      return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1,
               shotW: cv.width, shotH: cv.height };
    }, shot.toString("base64"));
  };

  for (let i = 0; i < ASPECTS.length; i++) {
    await settle();
    // The whole photo as a crop box: under contain this must land exactly on
    // the painted photo; under cover it overruns the surface on the cropped
    // axis, which overflow:hidden then eats.
    await page.evaluate((idx) => {
      const p = window.__mosqAsync.previews[idx];
      p.cropBox = [0, 0, p.fullCanvas.width, p.fullCanvas.height];
      p.fallback = false; p.manual_full_photo = false;
      window.__mosqAsync.selectPhoto(idx);
    }, i);
    await page.waitForFunction(() => {
      const i = document.getElementById("full-img");
      return i.complete && i.naturalWidth > 0;
    });

    const m = await page.evaluate(() => {
      const p = window.__mosqAsync.previews[window.__mosqAsync.selectedIndex];
      const img = document.getElementById("full-img");
      const surface = document.getElementById("crop-surface-full");
      const zoomImg = document.getElementById("context-img");
      const box = document.getElementById("full-active-crop-box");
      const b = surface.getBoundingClientRect();
      const bb = box.getBoundingClientRect();
      return {
        natural: [img.naturalWidth, img.naturalHeight],
        fitCss: getComputedStyle(img).objectFit,
        imgRect: [img.getBoundingClientRect().width, img.getBoundingClientRect().height],
        surface: { width: b.width, height: b.height, left: b.left, top: b.top },
        surfaceScroll: [surface.scrollWidth, surface.clientWidth, surface.scrollHeight, surface.clientHeight],
        zoomFitCss: getComputedStyle(zoomImg).objectFit,
        zoomFitInline: zoomImg.style.objectFit,
        wholePhotoOverlay: { width: bb.width, height: bb.height, left: bb.left, top: bb.top },
        imgLeft: img.getBoundingClientRect().left, imgTop: img.getBoundingClientRect().top,
      };
    });

    const pb = await paintedBox();
    check(!!pb, `[${label}] ${ASPECTS[i].name}: no photo pixels found in the surface`);

    const box = { width: m.surface.width, height: m.surface.height, left: m.surface.left, top: m.surface.top };
    // Measured, not computed: the surface-relative box of photo pixels the
    // browser actually painted, in surface-local coordinates.
    const painted = pb ? { width: pb.width, height: pb.height,
                          left: box.left + pb.left, top: box.top + pb.top } : { width: 0, height: 0 };
    // Two independent signals that an axis of the photo is not all visible. The
    // scan alone cannot tell: under cover the photo is larger than the surface,
    // so what lands inside the surface fills it exactly and the excess is hidden
    // by overflow:hidden. The scroll overflow is the other half - it is the
    // measured size of what did not fit.
    const clippedW = !pb || painted.width > box.width + 1 || m.surfaceScroll[0] > m.surfaceScroll[1];
    const clippedH = !pb || painted.height > box.height + 1 || m.surfaceScroll[2] > m.surfaceScroll[3];
    const aspectErr = pb ? Math.abs(painted.width / painted.height - m.natural[0] / m.natural[1]) : Infinity;

    note(`\n[${label}] ${ASPECTS[i].name}`);
    note(`  natural ${m.natural[0]}x${m.natural[1]}  surface ${box.width.toFixed(1)}x${box.height.toFixed(1)}  object-fit: ${m.fitCss}`);
    note(`  painted (contain) ${painted.width.toFixed(1)}x${painted.height.toFixed(1)}  aspect err ${aspectErr.toExponential(2)}`);
    note(`  clipped: width=${clippedW} height=${clippedH}`);
    note(`  surface scrollWidth/clientWidth ${m.surfaceScroll[0]}/${m.surfaceScroll[1]}  scrollHeight/clientHeight ${m.surfaceScroll[2]}/${m.surfaceScroll[3]}`);
    note(`  zoom panel object-fit: ${m.zoomFitCss} (inline ${m.zoomFitInline || "-"})`);

    check(m.fitCss === "contain", `[${label}] ${ASPECTS[i].name}: full panel object-fit is ${m.fitCss}, want contain`);
    check(!clippedW && !clippedH, `[${label}] ${ASPECTS[i].name}: photo clipped (w=${clippedW} h=${clippedH})`);
    // The painted box is recovered from a screenshot, so its edges carry a pixel of
    // resampling. 3% separates "the photo's aspect is preserved" from the
    // 30-300% error a cover-cropped axis produces.
    check(aspectErr < 0.03, `[${label}] ${ASPECTS[i].name}: painted aspect off by ${aspectErr} (not preserved)`);
    check(m.surfaceScroll[0] <= m.surfaceScroll[1], `[${label}] ${ASPECTS[i].name}: surface scrollWidth ${m.surfaceScroll[0]} > clientWidth ${m.surfaceScroll[1]}`);
    check(m.surfaceScroll[2] <= m.surfaceScroll[3], `[${label}] ${ASPECTS[i].name}: surface scrollHeight ${m.surfaceScroll[2]} > clientHeight ${m.surfaceScroll[3]}`);
    check(m.zoomFitCss === "cover", `[${label}] ${ASPECTS[i].name}: zoom panel object-fit is ${m.zoomFitCss}, want cover`);
    // The overlay for the whole photo must sit exactly on the painted photo.
    const o = m.wholePhotoOverlay;
    check(Math.abs(o.width - painted.width) < 1.5 && Math.abs(o.height - painted.height) < 1.5,
      `[${label}] ${ASPECTS[i].name}: whole-photo overlay ${o.width.toFixed(1)}x${o.height.toFixed(1)} != painted ${painted.width.toFixed(1)}x${painted.height.toFixed(1)}`);
    check(Math.abs(o.left - painted.left) < 1.5 && Math.abs(o.top - painted.top) < 1.5,
      `[${label}] ${ASPECTS[i].name}: whole-photo overlay at ${o.left.toFixed(1)},${o.top.toFixed(1)} != painted at ${painted.left.toFixed(1)},${painted.top.toFixed(1)}`);

    // Read before the drag, so the drags (which legitimately restyle the score
    // list) are not counted against the photo-arrival shift.
    clsArrival = Math.max(clsArrival, await page.evaluate(() => window.__cls));

    // A drag: press and release over a sub-rectangle of the panel and check the
    // crop that comes back is the image pixels under those two points. The
    // expectation is derived from the measured painted box, not from the
    // mapping under test, so a wrong mapping cannot agree with it.
    // painted.left/top are page-absolute (surface rect + surface-local offset).
    // On the 390px layout the panel sits below the fold, and getBoundingClientRect
    // is viewport-relative, so it is re-read after scrolling rather than trusted
    // across a scroll.
    await page.locator("#crop-surface-full").scrollIntoViewIfNeeded();
    const view = await page.evaluate(() => {
      const b = document.getElementById("crop-surface-full").getBoundingClientRect();
      return { left: b.left, top: b.top };
    });
    const pbv = await paintedBox();
    const pv = { width: pbv.width, height: pbv.height, left: view.left + pbv.left, top: view.top + pbv.top };
    const from = { x: pv.left + pv.width * 0.2, y: pv.top + pv.height * 0.25 };
    const to = { x: pv.left + pv.width * 0.7, y: pv.top + pv.height * 0.6 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    const drag = await page.evaluate(() => {
      const p = window.__mosqAsync.previews[window.__mosqAsync.selectedIndex];
      const surface = document.getElementById("crop-surface-full");
      const b = surface.getBoundingClientRect();
      return { cropBox: p.cropBox, surface: { width: b.width, height: b.height, left: b.left, top: b.top },
               nw: p.fullCanvas.width, nh: p.fullCanvas.height };
    });
    if (!drag.cropBox) {
      check(false, `[${label}] ${ASPECTS[i].name}: drag produced no crop box`);
    } else {
      const f = containUnmap(drag.nw, drag.nh, pv, from.x, from.y);
      const t = containUnmap(drag.nw, drag.nh, pv, to.x, to.y);
      const want = [Math.round(f[0] * drag.nw), Math.round(f[1] * drag.nh),
                    Math.round(t[0] * drag.nw), Math.round(t[1] * drag.nh)];
      note(`  drag -> cropBox [${drag.cropBox}]  want ~[${want}]`);
      // One pixel of measurement error on the painted box is up to 1/height of
      // the photo in y, so the tolerance is proportional rather than a constant.
      const tol = Math.max(3, Math.ceil(Math.max(drag.nw, drag.nh) * 0.02));
      check(drag.cropBox.every((v, k) => Math.abs(v - want[k]) <= tol),
        `[${label}] ${ASPECTS[i].name}: drag landed on ${JSON.stringify(drag.cropBox)}, pointer was on ~${JSON.stringify(want)}`);
    }
    out.push({ name: ASPECTS[i].name, natural: m.natural, surface: [box.width, box.height],
               painted: [painted.width, painted.height], clipped: clippedW || clippedH,
               drag: drag.cropBox });
  }

  const cls = clsArrival;
  const overflow = await page.evaluate(() => ({
    docScroll: document.documentElement.scrollWidth, docClient: document.documentElement.clientWidth,
  }));
  note(`\n[${label}] CLS (photos arriving into the open gallery) ${cls.toFixed(5)}   doc scrollWidth/clientWidth ${overflow.docScroll}/${overflow.docClient}`);
  check(overflow.docScroll <= overflow.docClient + 1,
    `[${label}] page scrolls horizontally: ${overflow.docScroll} > ${overflow.docClient}`);
  await page.close();
  return { cls, out };
}

const desktop = await run("desktop 1280", { width: 1280, height: 1400 });
const mobile = await run("mobile 390", { width: 390, height: 900 });

console.log("\n" + JSON.stringify({ desktop, mobile }, null, 1));
console.log(fail.length ? "FAIL\n" + fail.join("\n") : "PASS");
await browser.close();
process.exit(fail.length ? 1 : 0);