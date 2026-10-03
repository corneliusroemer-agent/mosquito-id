/**
 * mosquito-id unified: Complete client-side WebGPU & Cloud GPU application.
 * Dual-stage cropping (rough + fine-grained), CacheStorage persistence, and telemetry.
 */
"use strict";

const DET_SIZE = 640;
const CLIP_SIZE = 224;
const DET_CONF = 0.70;
const NMS_IOU = 0.70;
const CROP_PAD = 0.10;
const COMPLEX_MARGIN = 0.02;
const CACHE_NAME = "mosquito-models-v1";

// Models live on Cloudflare R2, reached through the bucket's public development
// URL. Objects sit at the root of that host - the dev URL serves the one bucket
// directly, with no bucket-name path segment.
//
// Two hosts were ruled out first. GitHub Releases serve no
// Access-Control-Allow-Origin on either redirect hop, so a browser cannot fetch
// them cross-origin at all. HuggingFace works, but a free account caps at 1 GB
// per repository and bioclip_2_5_fp16.onnx is 1207 MB, so it cannot hold the
// full set however the models are split across repos.
const MODEL_BASE_URL =
  "https://pub-2bbf73b4e93d40c9af925724fbd48d51.r2.dev/";
const FP16_AVAILABLE = true;

const COMPLEX_OF = {
  "Aedes albopictus": "Aedes albopictus",
  "Aedes aegypti": "Aedes aegypti",
  "Aedes japonicus": "Aedes japonicus/koreicus",
  "Aedes koreicus": "Aedes japonicus/koreicus",
  "Culex pipiens": "Culex pipiens/torrentium",
  "Culex torrentium": "Culex pipiens/torrentium",
  "Culex quinquefasciatus": "Culex pipiens/torrentium",
  "Culiseta annulata": "Culiseta annulata/morsitans",
  "Culiseta morsitans": "Culiseta annulata/morsitans",
  "Anopheles maculipennis": "Anopheles maculipennis complex",
  "Anopheles claviger": "Anopheles maculipennis complex",
  "Aedes vexans": "Other Aedes",
  "Aedes geniculatus": "Other Aedes",
  "Aedes cinereus": "Other Aedes",
  "Culiseta longiareolata": "Culiseta longiareolata",
  "Anopheles plumbeus": "Anopheles plumbeus",
};


const SPECIES_META = {
  "Aedes albopictus": {
    common: "Asian tiger mosquito", wiki: "https://en.wikipedia.org/wiki/Aedes_albopictus",
    vectors: "Dengue, Chikungunya, Zika",
    range: "Originally East Asia; now globally invasive in tropical and temperate regions",
    activity: "Aggressive daytime biter, peak at dawn and dusk",
    hosts: "Primarily humans, also birds and other mammals",
    notes: "Black-and-white striped legs. Key invasive species spreading through global trade."
  },
  "Aedes aegypti": {
    common: "Yellow fever mosquito", wiki: "https://en.wikipedia.org/wiki/Aedes_aegypti",
    vectors: "Dengue, Zika, Yellow fever, Chikungunya",
    range: "Tropical and subtropical regions worldwide, originated in Africa",
    activity: "Daytime biter, breeds in small artificial containers",
    hosts: "Strongly anthropophilic (prefers humans)",
    notes: "Lyre-shaped white markings on thorax. Primary vector for urban dengue and Zika."
  },
  "Aedes japonicus": {
    common: "Asian bush mosquito", wiki: "https://en.wikipedia.org/wiki/Aedes_japonicus",
    vectors: "West Nile virus, Japanese encephalitis (potential)",
    range: "Native to East Asia; invasive in Europe and North America",
    activity: "Daytime biter, breeds in rock pools and artificial containers",
    hosts: "Mammals and birds",
    notes: "Large dark mosquito with golden-brown scaling. Tolerates cooler climates than most Aedes."
  },
  "Aedes koreicus": {
    common: "Korean mosquito", wiki: "https://en.wikipedia.org/wiki/Aedes_koreicus",
    vectors: "Japanese encephalitis, Dirofilaria (potential)",
    range: "Native to Korea/Japan; invasive in parts of Europe",
    activity: "Daytime biter, similar ecology to Ae. japonicus",
    hosts: "Mammals",
    notes: "Very similar to Ae. japonicus — reliably distinguished only by molecular methods."
  },
  "Aedes vexans": {
    common: "Inland floodwater mosquito", wiki: "https://en.wikipedia.org/wiki/Aedes_vexans",
    vectors: "Rift Valley fever, encephalitides (minor)",
    range: "Cosmopolitan — one of the most widespread mosquitoes globally",
    activity: "Aggressive crepuscular and nocturnal biter after flooding",
    hosts: "Mammals including humans, cattle, horses",
    notes: "Eggs survive desiccation for years. Mass emergence after floods or heavy rain."
  },
  "Aedes geniculatus": {
    common: "Tree-hole mosquito", wiki: "https://en.wikipedia.org/wiki/Aedes_geniculatus",
    vectors: "Potential Zika and Chikungunya vector (lab competence)",
    range: "Europe and parts of western Asia, forest-dwelling",
    activity: "Daytime biter in shaded woodland areas",
    hosts: "Mammals in forested habitats",
    notes: "Breeds in tree holes and natural containers. Large, dark species with banded legs."
  },
  "Aedes cinereus": {
    common: "Woodland mosquito", wiki: "https://en.wikipedia.org/wiki/Aedes_cinereus",
    vectors: "Tularemia, arboviruses (minor)",
    range: "Northern Europe, Asia, and North America",
    activity: "Crepuscular biter in marshy woodland areas",
    hosts: "Mammals and birds",
    notes: "Common in northern latitudes. Breeds in temporary woodland pools in spring."
  },
  "Culex pipiens": {
    common: "Northern house mosquito", wiki: "https://en.wikipedia.org/wiki/Culex_pipiens",
    vectors: "West Nile virus, Usutu virus, lymphatic filariasis",
    range: "Temperate regions worldwide, highly urban-adapted",
    activity: "Nocturnal biter, overwinters as mated females",
    hosts: "Primarily birds (bridge vector to humans for West Nile virus)",
    notes: "Most common mosquito in temperate urban areas. Key bridge vector for West Nile virus."
  },
  "Culex torrentium": {
    common: "Woodland Culex", wiki: "https://en.wikipedia.org/wiki/Culex_torrentium",
    vectors: "West Nile virus, Sindbis virus",
    range: "Europe and parts of Asia",
    activity: "Nocturnal, similar ecology to Cx. pipiens",
    hosts: "Primarily birds",
    notes: "Nearly identical to Cx. pipiens — reliably distinguished only by molecular methods."
  },
  "Culex quinquefasciatus": {
    common: "Southern house mosquito", wiki: "https://en.wikipedia.org/wiki/Culex_quinquefasciatus",
    vectors: "West Nile virus, St. Louis encephalitis, lymphatic filariasis",
    range: "Tropical and subtropical regions worldwide",
    activity: "Nocturnal biter, breeds in polluted water",
    hosts: "Birds and mammals including humans",
    notes: "Major nuisance mosquito in the tropics. Tolerates highly polluted water."
  },
  "Culiseta annulata": {
    common: "Banded mosquito", wiki: "https://en.wikipedia.org/wiki/Culiseta_annulata",
    vectors: "Minor vector for avian malaria",
    range: "Europe, North Africa, western Asia",
    activity: "Year-round in mild climates, bites at dusk/dawn",
    hosts: "Birds and mammals including humans (painful bite)",
    notes: "One of the largest European mosquitoes. Distinctive banded legs and spotted wings."
  },
  "Culiseta morsitans": {
    common: "Northern Culiseta", wiki: "https://en.wikipedia.org/wiki/Culiseta_morsitans",
    vectors: "Eastern equine encephalitis virus (in North America)",
    range: "Northern Europe and North America",
    activity: "Crepuscular, breeds in semi-permanent woodland pools",
    hosts: "Primarily birds and larger mammals",
    notes: "Large mosquito in forested and rural habitats. Early-season species."
  },
  "Culiseta longiareolata": {
    common: "Mediterranean Culiseta", wiki: "https://en.wikipedia.org/wiki/Culiseta_longiareolata",
    vectors: "Not a significant disease vector",
    range: "Mediterranean region, Africa, Middle East, South Asia",
    activity: "Breeds in containers, rarely bites humans",
    hosts: "Primarily birds; very rarely bites mammals",
    notes: "Very common in Mediterranean countries. Often found in neglected swimming pools."
  },
  "Anopheles maculipennis": {
    common: "European malaria mosquito", wiki: "https://en.wikipedia.org/wiki/Anopheles_maculipennis",
    vectors: "Malaria (historical primary vector in Europe)",
    range: "Europe and western Asia",
    activity: "Nocturnal biter, breeds in clean sunlit water",
    hosts: "Mammals including humans and cattle",
    notes: "Species complex of ~11 siblings. Historically responsible for European malaria."
  },
  "Anopheles claviger": {
    common: "European Anopheles", wiki: "https://en.wikipedia.org/wiki/Anopheles_claviger",
    vectors: "Malaria (potential, minor historical role)",
    range: "Europe and western Asia",
    activity: "Nocturnal, breeds in shaded vegetated water",
    hosts: "Mammals",
    notes: "Prefers cooler, shaded habitats unlike An. maculipennis."
  },
  "Anopheles plumbeus": {
    common: "Tree-hole Anopheles", wiki: "https://en.wikipedia.org/wiki/Anopheles_plumbeus",
    vectors: "Malaria (confirmed autochthonous cases in Germany, Netherlands)",
    range: "Europe, from UK to Mediterranean",
    activity: "Aggressive day and night biter near forests",
    hosts: "Mammals including humans",
    notes: "Breeds exclusively in tree holes. Responsible for rare autochthonous malaria in Europe."
  }
};

const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];

let currentEngine = "webgpu-fp16";
let serverAvailable = false;
let serverEngineLabel = "Local Server";
let sessDet = null;
let sessClip = null;
let loadedClipEngine = null;
const clipSessions = {};
let EMB = null;
let detEP = "wasm";
let clipEP = "wasm";
window.modelsReady = false;

// Application State
let previews = [];
let includedIndices = new Set();
let selectedIndex = 0;
let isProcessingBatch = false;

// ---- Crop: displayed state vs. computed state ----
//
// A crop release does two separate things. The geometry - crop canvas, context
// canvas, both boxes, the thumbnail - is written and re-rendered synchronously
// in the pointer-up handler, so the picture the user is looking at is never
// more than one frame behind their hand. The classifier then runs with the
// score panel marked pending, and writes back only if it still owns the photo.
const ASYNC = (window.__mosqAsync = {
  last: null,      // timing of the most recent crop release
  frames: 0,       // bumped every animation frame: a frozen UI stops counting
  longTasks: 0,
  worstLongTaskMs: 0,
  get previews() { return previews; },
  get sessClip() { return sessClip; },
  get sessDet() { return sessDet; },
  get selectedIndex() { return selectedIndex; },
  selectPhoto,
  processFiles,
  deletePhoto
});
(function countFrames() {
  requestAnimationFrame(() => { ASYNC.frames++; countFrames(); });
})();
if (typeof PerformanceObserver === "function") {
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        ASYNC.longTasks++;
        ASYNC.worstLongTaskMs = Math.max(ASYNC.worstLongTaskMs, Math.round(e.duration));
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch (e) { /* longtask unsupported: ASYNC.longTasks stays 0 */ }
}

// Take ownership of a photo's scores for a new crop. Bumping the revision is
// what makes the last release win: every earlier computation still in flight
// for this photo now holds a revision that no longer matches and is dropped.
function beginRecompute(p) {
  p.rev = (p.rev || 0) + 1;
  p.pending = true;
  p.error = null;
  // The agreement on screen described the previous crop's views. It goes with
  // them, rather than sitting there next to a pending recompute claiming to be
  // about the crop now being drawn.
  p.agreement = null;
  p.viewsLanded = 0;
  p.viewsTotal = 0;
  return p.rev;
}

// A result may be written back only by the computation that still owns the
// photo: same revision (no newer release), same object still in previews (not
// deleted, and not replaced by a batch that finished meanwhile), not removed.
function ownsRecompute(p, idx, rev) {
  return p.rev === rev && previews[idx] === p && !p.removed;
}

// Everything a finished computation commits, in one place, so the local and
// server paths cannot drift apart in what they mark current. The multi-view
// paths go through applyViews, which layers the per-view bookkeeping on top.
function commitScores(p, r) {
  p.scores = r.labels;
  p.detail = r.detail;
  p.logits = r.logits;
  p.demoted = r.demoted;
  p.pending = false;
  p.error = null;
}

function markComputeFailed(p, err) {
  p.pending = false;
  p.error = `Classification failed: ${err && err.message ? err.message : err}`;
  sendLog("crop_failed", { name: p.name, error: String(err) });
}

// Thrown when a release is overtaken before its work starts, so the catch block
// can tell "nothing to do" from "the model failed".
class Superseded extends Error {}

// ---- Telemetry Logging ----
function sendLog(action, data = {}) {
  const payload = {
    action,
    engine: currentEngine,
    photo: previews[selectedIndex]?.name || null,
    timestamp: new Date().toISOString(),
    ...data
  };
  console.log(`[CLIENT LOG] ${action}:`, payload);
  // Only the Cloud GPU deployment has an /api/log endpoint. Posting to it from
  // the static site just produces a failed request, which the browser reports as
  // a console error no matter how the promise is handled.
  if (!serverAvailable) return;
  fetch("/api/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

function dataUrlToCanvas(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth || img.width;
      cv.height = img.naturalHeight || img.height;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0);
      resolve(cv);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}


// Resolve a model path: prefix with MODEL_BASE_URL for remote hosting
function resolveModelUrl(path) {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return MODEL_BASE_URL + path;
}

// ---- Model Loading with Persistent CacheStorage ----
async function fetchWithProgress(url, onBytes) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  const total = Number(resp.headers.get("content-length")) || 0;
  const reader = resp.body.getReader();
  const chunks = [];
  let got = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (onBytes) onBytes(got, total);
  }
  const out = new Uint8Array(got);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

async function fetchWithCache(url, onBytes) {
  if ("caches" in window) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url);
      if (cached) {
        console.log(`[CacheStorage] HIT for ${url}`);
        sendLog("cache_hit", { url });
        if (onBytes) onBytes(1, 1);
        return await cached.arrayBuffer();
      }
      console.log(`[CacheStorage] MISS for ${url}, fetching from network...`);
      sendLog("cache_miss", { url });
      const buf = await fetchWithProgress(url, onBytes);
      const toStore = new Response(buf.slice(0), {
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(buf.byteLength) }
      });
      await cache.put(url, toStore);
      return buf;
    } catch (err) {
      console.warn("CacheStorage read/write warning:", err);
    }
  }
  return await fetchWithProgress(url, onBytes);
}

const embedsCache = {};

const WEBGPU_MODELS = {
  "webgpu-b16": {
    path: "bioclip_visual_b16_fp16.onnx",
    embedsPath: "text_embeds_b16.json",
    label: "BioCLIP B/16 (FP16 · 172 MB)",
    name: "BioCLIP B/16 FP16",
    size: 172725427
  },
  "webgpu-fp16": {
    path: "bioclip_2_5_fp16.onnx",
    embedsPath: "text_embeds.json",
    label: "BioCLIP 2.5 H/14 (FP16 · 1.2 GB)",
    name: "BioCLIP 2.5 H/14 FP16",
    size: 1259593728
  },
  "webgpu-int8": {
    path: "bioclip_2_5_int8.onnx",
    embedsPath: "text_embeds.json",
    label: "BioCLIP 2.5 H/14 (INT8 · 609 MB)",
    name: "BioCLIP 2.5 H/14 INT8",
    size: 638205897
  }
};

async function loadWebGPUModels(engineKey = "webgpu-fp16") {
  const loadCard = document.getElementById("load-card");
  const msg = document.getElementById("load-msg");
  const fill = document.getElementById("load-fill");

  loadCard.style.display = "block";
  window.modelsReady = false;

  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;

  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const requiredFeatures = [];
        if (adapter.features.has("shader-f16")) {
          requiredFeatures.push("shader-f16");
        }
        const device = await adapter.requestDevice({ requiredFeatures });
        if (!ort.env.webgpu) ort.env.webgpu = {};
        ort.env.webgpu.device = device;
      }
    } catch (e) {
      console.warn("WebGPU adapter pre-init:", e);
    }
  }

  // 1. Load detector if not loaded
  if (!sessDet) {
    msg.textContent = "Loading detector (YOLO11n)…";
    fill.style.width = "10%";
    const detPath = resolveModelUrl("yolo11n-mosquito-det-640.onnx");
    const detBuf = await fetchWithCache(detPath, (got, total) => {
      fill.style.width = `${Math.min(20, (20 * got) / (total || 10607017))}%`;
    });
    try {
      sessDet = await ort.InferenceSession.create(detBuf, { executionProviders: ["webgpu"] });
      detEP = "webgpu";
    } catch (err) {
      console.warn("WebGPU unavailable for detector, falling back to WASM");
      sessDet = await ort.InferenceSession.create(detBuf, { executionProviders: ["wasm"] });
      detEP = "wasm";
    }
  }

  // 2. Load BioCLIP model with cache
  const clipCfg = WEBGPU_MODELS[engineKey] || WEBGPU_MODELS["webgpu-fp16"];
  if (clipSessions[engineKey]) {
    sessClip = clipSessions[engineKey].sess;
    clipEP = clipSessions[engineKey].ep;
  } else {
    msg.textContent = `Loading ${clipCfg.name}…`;
    fill.style.width = "25%";
    const buf = await fetchWithCache(resolveModelUrl(clipCfg.path), (got, total) => {
      const mb = (x) => (x / 1048576).toFixed(0);
      msg.textContent = `Loading ${clipCfg.name}: ${mb(got)} MB / ${mb(total || clipCfg.size)} MB`;
      const pct = 25 + Math.min(70, (70 * got) / (total || clipCfg.size));
      fill.style.width = `${pct}%`;
    });

    let sess = null;
    let ep = "wasm";
    try {
      sess = await ort.InferenceSession.create(buf, { executionProviders: ["webgpu"] });
      ep = "webgpu";
    } catch (err) {
      console.warn(`WebGPU unavailable for ${clipCfg.name}, falling back to WASM (${err.message})`);
      sess = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
      ep = "wasm";
    }
    clipSessions[engineKey] = { sess, ep };
    sessClip = sess;
    clipEP = ep;
  }
  loadedClipEngine = engineKey;

  // 3. Load text embeddings for this model
  const targetEmbedsPath = clipCfg.embedsPath || "text_embeds.json";
  if (!embedsCache[targetEmbedsPath]) {
    msg.textContent = `Loading species embeddings (${targetEmbedsPath})…`;
    fill.style.width = "95%";
    const r = await fetch(targetEmbedsPath);
    const data = await r.json();
    for (const k of ["species_emb", "nuisance_emb"]) {
      data[k] = Float32Array.from(data[k]);
    }
    embedsCache[targetEmbedsPath] = data;
  }
  EMB = embedsCache[targetEmbedsPath];

  fill.style.width = "100%";
  const deviceLabel = `inference: ${clipCfg.name} (${clipEP.toUpperCase()}) · YOLO11n (${detEP.toUpperCase()})`;
  document.getElementById("footer-device").textContent = deviceLabel;
  loadCard.style.display = "none";
  window.modelsReady = true;
  sendLog("webgpu_models_ready", { engine: engineKey, clipEP, detEP });
}

async function initEngine() {
  const engineSelect = document.getElementById("engine-select");
  const optServer = document.getElementById("opt-server");
  const footerDevice = document.getElementById("footer-device");

  // Probe server /api/health
  try {
    const res = await fetch("/api/health", { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json();
      serverAvailable = true;
      serverEngineLabel = data.engine_label || "Cloud GPU";
      if (optServer) optServer.textContent = `⚡ ${serverEngineLabel} · Instant`;
    }
  } catch (err) {
    serverAvailable = false;
  }

  // Preference: URL query param > localStorage > default. fp16 is skipped while
  // it is unavailable, so a stale saved choice falls through instead of 404ing.
  // fp16 is the default: it stays on the GPU and is the most accurate. INT8 is
  // never the default - onnxruntime-web has no int8 WebGPU kernels, so the session
  // silently falls back to WASM CPU and runs an order of magnitude slower.
  const defaultEngine = "webgpu-fp16";
  const params = new URLSearchParams(window.location.search);
  const requestedEngine = params.get("engine");
  const savedEngine = localStorage.getItem("mosquito_engine");
  const selectable = (e) =>
    (e === "server-gpu" ? false : !!WEBGPU_MODELS[e]) && (e !== "webgpu-fp16" || FP16_AVAILABLE);

  const chosenEngine = selectable(requestedEngine)
    ? requestedEngine
    : selectable(savedEngine)
      ? savedEngine
      : defaultEngine;

  currentEngine = chosenEngine;
  if (engineSelect) {
    engineSelect.value = chosenEngine;
    engineSelect.addEventListener("change", async (e) => {
      const chosen = e.target.value;
      localStorage.setItem("mosquito_engine", chosen);
      sendLog("engine_switched", { from: currentEngine, to: chosen });
      if (chosen === "server-gpu") {
        currentEngine = "server-gpu";
        document.getElementById("load-card").style.display = "none";
        if (footerDevice) {
          footerDevice.textContent = `inference: ${serverEngineLabel} · YOLO11n & BioCLIP 2.5 H/14 (Instant)`;
        }
        window.modelsReady = true;
      } else {
        currentEngine = chosen;
        if (footerDevice) {
          footerDevice.textContent = `inference: ${WEBGPU_MODELS[chosen]?.name || "WebGPU"} · Loading…`;
        }
        await loadWebGPUModels(chosen);
      }
    });
  }

  if (chosenEngine === "server-gpu" && serverAvailable) {
    document.getElementById("load-card").style.display = "none";
    if (footerDevice) {
      footerDevice.textContent = `inference: ${serverEngineLabel} · YOLO11n & BioCLIP 2.5 H/14 (Instant)`;
    }
    window.modelsReady = true;
    sendLog("engine_init", { mode: "server", label: serverEngineLabel });
  } else {
    if (!serverAvailable && optServer) {
      optServer.disabled = true;
      optServer.textContent = "⚡ Server (Offline)";
    }
    await loadWebGPUModels(chosenEngine);
    sendLog("engine_init", { mode: "webgpu", key: chosenEngine });
  }
}

const loadModels = () => initEngine();

// ---- Client-Side Inference Helpers ----
function chwFromCanvas(cv) {
  const d = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
  const n = cv.width * cv.height;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = d[4 * i] / 255;
    out[n + i] = d[4 * i + 1] / 255;
    out[2 * n + i] = d[4 * i + 2] / 255;
  }
  return out;
}

function letterbox(imgCv) {
  const w = imgCv.width;
  const h = imgCv.height;
  const r = Math.min(DET_SIZE / w, DET_SIZE / h);
  const dw = Math.round(w * r);
  const dh = Math.round(h * r);
  const dx = (DET_SIZE - dw) / 2;
  const dy = (DET_SIZE - dh) / 2;

  const cv = document.createElement("canvas");
  cv.width = DET_SIZE;
  cv.height = DET_SIZE;
  const cx = cv.getContext("2d");
  cx.fillStyle = "#727272";
  cx.fillRect(0, 0, DET_SIZE, DET_SIZE);
  cx.drawImage(imgCv, 0, 0, w, h, Math.round(dx), Math.round(dy), dw, dh);

  return { tensor: new ort.Tensor("float32", chwFromCanvas(cv), [1, 3, DET_SIZE, DET_SIZE]), r, dx, dy };
}

function decodeDets(outTensor, r, dx, dy) {
  const data = outTensor.data;
  const dims = outTensor.dims;
  const nc = dims[1] - 4;
  const N = dims[2];
  const cand = [];

  for (let i = 0; i < N; i++) {
    let best = -1;
    let bc = 0;
    for (let c = 0; c < nc; c++) {
      const s = data[(4 + c) * N + i];
      if (s > bc) { bc = s; best = c; }
    }
    if (bc < DET_CONF) continue;
    const cx = data[i];
    const cy = data[N + i];
    const w = data[2 * N + i];
    const h = data[3 * N + i];
    cand.push({
      cls: best,
      conf: bc,
      box: [(cx - w / 2 - dx) / r, (cy - h / 2 - dy) / r, (cx + w / 2 - dx) / r, (cy + h / 2 - dy) / r]
    });
  }
  cand.sort((a, b) => b.conf - a.conf);
  const kept = [];
  for (const c of cand) {
    if (kept.length >= 300) break;
    if (kept.every((k) => k.cls !== c.cls || iou(k.box, c.box) <= NMS_IOU)) kept.push(c);
  }
  return kept;
}

function iou(a, b) {
  const ix1 = Math.max(a[0], b[0]), iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]), iy2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const aa = (a[2] - a[0]) * (a[3] - a[1]);
  const bb = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (aa + bb - inter);
}

function selectDetection(dets) {
  if (!dets || !dets.length) return null;
  const best = dets[0];
  const [x1, y1, x2, y2] = best.box;
  const area = Math.max(1, (x2 - x1) * (y2 - y1));
  const surrounding = [];
  for (const candidate of dets) {
    const [a, b, c, d] = candidate.box;
    const overlap = Math.max(0, Math.min(x2, c) - Math.max(x1, a)) * Math.max(0, Math.min(y2, d) - Math.max(y1, b));
    if (overlap / area >= 0.9 && (c - a) * (d - b) >= 2 * area) {
      surrounding.push(candidate);
    }
  }
  return surrounding.length ? surrounding.reduce((m, c) => (c.conf > m.conf ? c : m), surrounding[0]) : best;
}

async function clipEmbed(sourceCanvas) {
  const cw = sourceCanvas.width;
  const ch = sourceCanvas.height;
  const s = CLIP_SIZE / Math.min(cw, ch);
  const dw = Math.round(cw * s);
  const dh = Math.round(ch * s);

  const cv = document.createElement("canvas");
  cv.width = dw;
  cv.height = dh;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(sourceCanvas, 0, 0, cw, ch, 0, 0, dw, dh);

  const l = (dw - CLIP_SIZE) >> 1;
  const t = (dh - CLIP_SIZE) >> 1;
  const cc = document.createElement("canvas");
  cc.width = CLIP_SIZE;
  cc.height = CLIP_SIZE;
  cc.getContext("2d").drawImage(cv, l, t, CLIP_SIZE, CLIP_SIZE, 0, 0, CLIP_SIZE, CLIP_SIZE);

  const d = cc.getContext("2d").getImageData(0, 0, CLIP_SIZE, CLIP_SIZE).data;
  const n = CLIP_SIZE * CLIP_SIZE;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      out[c * n + i] = (d[4 * i + c] / 255 - CLIP_MEAN[c]) / CLIP_STD[c];
    }
  }

  const inName = sessClip.inputNames[0];
  const res = await sessClip.run({ [inName]: new ort.Tensor("float32", out, [1, 3, CLIP_SIZE, CLIP_SIZE]) });
  const e = res[Object.keys(res)[0]].data;
  let norm = 0;
  for (let i = 0; i < e.length; i++) norm += e[i] * e[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < e.length; i++) e[i] /= norm;
  return e;
}

// Temperature 2.5, applied by dividing the logit scale. Measured on the 112-image
// Mosquito Alert benchmark: as shipped (T=1) the softmax reports 0.940 mean
// confidence against 0.848 true accuracy — overconfident by ~9 points. T=2.5
// cuts NLL by a third and roughly halves ECE, and leaves top-1 unchanged
// because it is monotone, so this buys honesty rather than accuracy.
//
// Hand-set, deliberately. Fitting the temperature by cross-validation at this
// sample size is actively harmful: each fold independently chose T~8.7 and
// held-out NLL got *worse* (2.172 vs 0.966 at T=1). The optimum is not
// identifiable at n=112. Do not "improve" this by fitting it at runtime.
//
// Module scope, not local to softmaxJoint, because multi-view fusion has to put
// two views on this same scale before it can pool them.
const TEMPERATURE = 2.5;

// The scale each path turns a cosine into a logit at. Local scoring applies the
// temperature; the server does not, so its posteriors are on a different scale
// and pooling one of each would be arithmetic on incomparable numbers.
//
// Both views of a photo always come from the same path, so this cannot mismatch
// within a fusion in practice - but the scale is attached to each view when it
// is scored rather than read from the current engine at fuse time, because the
// engine can be switched while a photo's second view is still in flight, and
// the fused result must describe the views that actually produced it.
function localViewScale() {
  return EMB.logit_scale / TEMPERATURE;
}

function serverViewScale() {
  return EMB.logit_scale;
}

function softmaxJoint(emb) {
  const S = EMB.species.length;
  const N = EMB.nuisance.length;
  const D = EMB.dim;
  const scale = localViewScale();
  const spCos = [];
  const nuCos = [];

  let s = 0;
  for (let i = 0; i < S; i++) {
    let d = 0;
    for (let k = 0; k < D; k++) d += EMB.species_emb[s + k] * emb[k];
    s += D;
    spCos.push(d);
  }
  s = 0;
  for (let i = 0; i < N; i++) {
    let d = 0;
    for (let k = 0; k < D; k++) d += EMB.nuisance_emb[s + k] * emb[k];
    s += D;
    nuCos.push(d);
  }

  const sims = spCos.concat(nuCos).map((c) => scale * c);
  const mx = Math.max(...sims);
  const ex = sims.map((v) => Math.exp(v - mx));
  const sum = ex.reduce((a, b) => a + b, 0);
  const p = ex.map((v) => v / sum);

  const logits = {};
  EMB.species.forEach((name, i) => { logits[name] = scale * spCos[i]; });
  return { spP: p.slice(0, S), nuP: p.slice(S), spCos, logits };
}

function complexScores(spP, spCos) {
  const comp = {};
  EMB.species.forEach((name, i) => {
    const k = COMPLEX_OF[name] || name;
    comp[k] = (comp[k] || 0) + spP[i];
  });
  const ranked = Object.entries(comp).sort((a, b) => b[1] - a[1]);

  const topComplex = ranked[0][0];
  const secondComplex = ranked.length > 1 ? ranked[1][0] : null;
  let topCos = -Infinity;
  let secCos = -Infinity;
  EMB.species.forEach((name, i) => {
    const k = COMPLEX_OF[name] || name;
    if (k === topComplex && spCos[i] > topCos) topCos = spCos[i];
    else if (k === secondComplex && spCos[i] > secCos) secCos = spCos[i];
  });

  const demoted = secondComplex !== null && topCos - secCos < COMPLEX_MARGIN;
  const labels = {};
  ranked.forEach(([k, v]) => { labels[k] = v; });
  if (demoted) {
    const winner = ranked[0][0];
    const demotedLabel = winner + " - low confidence, genus-level only";
    const val = labels[winner];
    delete labels[winner];
    return { labels: { [demotedLabel]: val, ...labels }, demoted: true };
  }
  return { labels, demoted: false };
}

// ---- Multi-view fusion ----
//
// One crop is one opinion about what is in the frame, and it is a fallible one:
// a slightly-off box puts background in the picture, or clips the wing pattern
// the classifier actually reads. Classifying the same photo twice - once on the
// detector's crop, once on the whole frame - and combining the two is worth
// +4.5 points of top-1 on the 112-image Mosquito Alert benchmark (84.8% ->
// 89.3%), the largest single win measured in that investigation.
//
// The pooling rule is equal-weight log-linear: log p ∝ Σ_v log p_v. A view that
// is undecided contributes a flat distribution and moves the sum a little; a
// view that is sure moves it a lot. Both views count the same however sure
// either is, which is what "equal weight" means here and is the rule the +4.5
// was measured with. Averaging the probabilities instead would let one confident
// view swamp the other rather than being outvoted by it.
//
// Every view's posteriors come out of the same scoring path at the same 2.5
// temperature, which is what makes them poolable at all: two views scored at
// different temperatures are two different scales, and their sum would be
// arithmetic on incomparable numbers. Each view carries the scale it was scored
// at, and fuseViews refuses to pool across two different ones.
//
// Fusion pools the species posteriors and the nuisance classes separately, then
// normalises once over the two together. The nuisance classes only ever enter as
// their combined mass, never individually: softmaxJoint's nuisance gate has
// already used them per view to decide whether a crop is worth classifying, and
// letting eight nuisance classes vote on which species this is would mix that
// decision into the species verdict. Pooling the mass separately keeps the fused
// species posteriors on the same scale as a single view's - they sum to less than
// 1, by however much the nuisance took - which is what lets one photo's fused
// score be read next to another's un-fused one, and next to the pooled-across-
// photos score.
//
// Every view must carry the same `scale`. The pool itself does not need it - it
// works on probabilities, which are already on whatever scale produced them, and
// two views from the same path always do share a scale. It is needed to recover
// cosines and logits from the fused posterior below.
//
// With one view this is algebraically identical to that view's own softmax, so
// there is no separate single-view path to keep in step.
function fuseViews(viewResults) {
  const S = EMB.species.length;
  const names = EMB.species;
  const V = viewResults.length;
  if (!V) return null;

  const scale = viewResults[0].scale;
  if (viewResults.some((v) => v.scale !== scale)) {
    // Views on different scales cannot be pooled meaningfully, and rather than
    // produce a number that looks like a fused score but is not one, say so.
    console.warn("fuseViews: views on different scales, not pooling", viewResults.map((v) => v.scale));
    return fuseViews([viewResults[0]]);
  }

  const logSum = new Array(S).fill(0);
  let logNu = 0;
  for (const v of viewResults) {
    for (let i = 0; i < S; i++) logSum[i] += Math.log(Math.max(v.spP[i], 1e-12));
    logNu += Math.log(Math.max(v.nuTotal, 1e-12));
  }
  const mx = Math.max(logNu, ...logSum);
  const ex = logSum.map((l) => Math.exp(l - mx));
  const nu = Math.exp(logNu - mx);
  const sum = ex.reduce((a, b) => a + b, 0) + nu;
  const spP = ex.map((e) => e / sum);
  const nuP = [nu / sum];

  // complexScores needs cosine similarities to apply COMPLEX_MARGIN, and
  // updatePooling needs logits. Recovering both from the fused posterior is not
  // an approximation: log p_i = scale * cos_i - logZ, so
  // (log p_i - log p_best) / scale is exactly cos_i - cos_best, and every
  // consumer of these two quantities (COMPLEX_MARGIN's difference, the pooling
  // card's max-relative score) takes differences. The recovered cosines are
  // therefore shifted by a constant - best species at 0 - which no consumer can
  // see, and are otherwise the fused view's real ones.
  const lp = spP.map((p) => Math.log(Math.max(p, 1e-12)));
  const best = Math.max(...lp);
  const spCos = lp.map((l) => (l - best) / scale);

  const detail = {};
  const logits = {};
  names.forEach((n, i) => {
    detail[n] = spP[i];
    logits[n] = lp[i] * scale;
  });

  const c = complexScores(spP, spCos);
  return { labels: c.labels, detail, logits, demoted: c.demoted, spP, nuP, spCos, nViews: V };
}

// Do the views of this photo agree on the species, and if not, by how much do
// the fused top two sit apart? Measured on the benchmark: when the views agree
// the fused answer is right 94.3% of the time, when they disagree 50.0% - so
// this is worth showing, and worth more than the fused number alone.
//
// `views` is the list of per-view spP arrays; `fusedSpP` the pooled posterior.
function viewAgreement(views, fusedSpP) {
  if (!views || views.length < 2) return null;
  const S = EMB.species.length;
  const argmax = (p) => {
    let b = 0;
    for (let i = 1; i < S; i++) if (p[i] > p[b]) b = i;
    return b;
  };
  const winners = views.map(argmax);
  const top = argmax(fusedSpP);
  const ranked = [...fusedSpP].sort((a, b) => b - a);
  // Margin between the fused top two, in percentage points. Below this the
  // photo is not really decidable from the classifier's own output, whatever it
  // reports as its top score.
  const marginPts = views.length >= 2 ? (ranked[0] - ranked[1]) * 100 : 0;

  return {
    agree: winners.every((w) => w === top),
    topSpecies: EMB.species[top],
    runnersUp: EMB.species.filter((_, i) => winners.includes(i) && i !== top),
    marginPts,
    fusedTop: fusedSpP[top]
  };
}

// One-line plain-English rendering of the agreement signal, for the UI. Plain
// because it is a statement about the photograph, not about the model: it says
// what the two views of this picture disagree about and how close the call is.
function agreementSentence(a) {
  if (!a) return "";
  if (a.agree) {
    return `Both views of this photo pick ${a.topSpecies} — the close-up and the whole picture agree.`;
  }
  const other = a.runnersUp.length ? a.runnersUp[0] : null;
  const gap = other
    ? `, with ${other} close behind`
    : "";
  return `The close-up and the whole picture disagree${gap}. The two leading species are within ${a.marginPts.toFixed(1)} points, so treat this one as undecided.`;
}

// Whether there is a crop to draw, and where it sits in each panel, answered in
// one place. Both panels used to gate the outline on their own independent
// conditions, so a state could satisfy one and not the other and show the crop
// on only one panel - the reported "zoom has a crop, the full photo does not".
// Two guards that must agree is the defect; a third caller would reintroduce it.
//
// A crop is real when the photo was classified on a sub-region of itself. A
// fallback, or a photo the user reverted to whole, was classified on the whole
// frame, so drawing an outline over it would claim a crop that was never made.
// `pending` is deliberately not a gate: a recompute in flight still has the
// previous crop on screen, and both panels should keep showing it, dimmed on
// the scores, rather than one panel blanking while the other holds.
function hasCropBox(p) {
  return Boolean(p && p.cropBox && !p.fallback && !p.manual_full_photo);
}

// The same p.cropBox expressed as fractions of each panel's surface. Both take
// p.cropBox in full-image pixels; each panel shows a different image through a
// different object-fit:cover window, so each needs its own map. Returns null
// when the panel cannot place the box (no image, or no context region).
function cropBoxInFullSurface(p) {
  if (!hasCropBox(p) || !p.fullCanvas) return null;
  const surfaceFull = document.getElementById("crop-surface-full");
  const { kx, ox, ky, oy } = coverMapping(surfaceFull, p.fullCanvas);
  const [bx1, by1, bx2, by2] = p.cropBox;
  const l = (bx1 / p.fullCanvas.width - ox) / kx;
  const t = (by1 / p.fullCanvas.height - oy) / ky;
  return {
    left: l * 100,
    top: t * 100,
    width: ((bx2 / p.fullCanvas.width - ox) / kx - l) * 100,
    height: ((by2 / p.fullCanvas.height - oy) / ky - t) * 100,
  };
}

// The zoom panel shows the context region, not the whole photo, so the box has
// to be expressed relative to that region before it goes through the cover map.
// With no context region the panel shows the whole photo instead (zoomSource
// falls back the same way), so the whole photo is the coordinate frame here too
// - which keeps a real crop drawable on both panels in every state.
function cropBoxInZoomSurface(p) {
  if (!hasCropBox(p)) return null;
  const surfaceZoomed = document.getElementById("crop-surface-zoomed");
  const [cx1, cy1, cx2, cy2] = p.cropBox;
  const ctx_x1 = p.contextBox ? p.contextBox[0] : 0;
  const ctx_y1 = p.contextBox ? p.contextBox[1] : 0;
  const ctx_x2 = p.contextBox ? p.contextBox[2] : p.fullCanvas.width;
  const ctx_y2 = p.contextBox ? p.contextBox[3] : p.fullCanvas.height;
  const ctx_w = ctx_x2 - ctx_x1;
  const ctx_h = ctx_y2 - ctx_y1;
  if (!(ctx_w > 0) || !(ctx_h > 0)) return null;
  const { kx, ox, ky, oy } = coverMapping(surfaceZoomed, p.contextCanvas || p.fullCanvas);
  const l = ((cx1 - ctx_x1) / ctx_w - ox) / kx;
  const t = ((cy1 - ctx_y1) / ctx_h - oy) / ky;
  return {
    left: l * 100,
    top: t * 100,
    width: (((cx2 - ctx_x1) / ctx_w - ox) / kx - l) * 100,
    height: (((cy2 - ctx_y1) / ctx_h - oy) / ky - t) * 100,
  };
}

// Place a box returned by one of the helpers above, or hide it.
function applyBox(el, box) {
  if (!el) return;
  if (!box) {
    el.style.display = "none";
    return;
  }
  el.style.left = `${box.left}%`;
  el.style.top = `${box.top}%`;
  el.style.width = `${box.width}%`;
  el.style.height = `${box.height}%`;
  el.style.display = "block";
}

// The context canvas is painted with object-fit:cover, so a fraction of the
// zoomed surface is only the same fraction of the image when the two aspects
// match. Return the affine map surfaceFraction -> imageFraction for the photo
// currently shown, so the crop-box overlay and the fine-tune drag agree with
// what is on screen (and are the identity in the normal, matching-aspect case).
// object-fit:cover shows only a window of the image, and centres it. Returns the
// affine map from image fraction to surface fraction: surface = (image - off) / k.
//
// The scale is per-axis, because cover crops on exactly one axis: the other is
// shown whole and is the identity. A single scalar k for both axes stretched
// that whole axis by 1/k, so a crop outline drawn on the photo came out a
// different shape from the same crop drawn in the zoom panel - the reported
// "one panel's shape is more square, the other's more rectangular".
function coverMapping(surface, img) {
  const identity = { kx: 1, ox: 0, ky: 1, oy: 0 };
  if (!surface || !img) return identity;
  const b = surface.getBoundingClientRect();
  if (b.width <= 0 || b.height <= 0) return identity;
  const boxAspect = b.width / b.height;
  const imgAspect = img.width / img.height;
  if (!imgAspect) return identity;
  const kx = Math.min(1, boxAspect / imgAspect);
  const ky = Math.min(1, imgAspect / boxAspect);
  return { kx, ox: (1 - kx) / 2, ky, oy: (1 - ky) / 2 };
}

function zoomedSurfaceMapping() {
  const p = previews[selectedIndex];
  return coverMapping(document.getElementById("crop-surface-zoomed"), p?.contextCanvas);
}

// Aspect ratio (w/h) of the zoomed panel's container, i.e. the box the context
// canvas is displayed in. The container lives inside #gallery-section, which is
// display:none until the first photo has been classified, so on the very first
// photo its clientWidth/clientHeight both read 0 and any aspect measured from it
// is the 1/0 fallback. Measure against real layout instead: give the gallery
// layout for one synchronous read, then restore it. Both style writes land in
// the same frame, so the hidden gallery is never painted.
let cachedViewerAspect = null;

// The cache is only read while #gallery-section is display:none, i.e. before the
// first photo is classified. A rotate or a window resize changes the panel's
// shape, and a context region cut for the old shape is wider or taller than the
// panel it is shown in, so drop it and let the next photo measure afresh.
window.addEventListener("resize", () => { cachedViewerAspect = null; });
window.addEventListener("orientationchange", () => { cachedViewerAspect = null; });

function measureViewerAspect() {
  const container = document.getElementById("crop-surface-zoomed")?.parentElement;
  if (container && container.clientWidth > 0 && container.clientHeight > 0) {
    return container.clientWidth / container.clientHeight;
  }
  if (cachedViewerAspect) return cachedViewerAspect;

  const gallery = document.getElementById("gallery-section");
  if (gallery && container) {
    const prevDisplay = gallery.style.display;
    const prevVisibility = gallery.style.visibility;
    gallery.style.display = "block";
    gallery.style.visibility = "hidden";
    const w = container.clientWidth;
    const h = container.clientHeight;
    gallery.style.display = prevDisplay;
    gallery.style.visibility = prevVisibility;
    if (w > 0 && h > 0) {
      cachedViewerAspect = w / h;
      return cachedViewerAspect;
    }
  }
  return null;
}

// Compute context crop matching viewer container aspect ratio with 75% border fit along narrower dimension
function extractContextCrop(fullCv, cropBox, targetAspect = null) {
  if (!cropBox) {
    return { contextCanvas: fullCv, contextBox: [0, 0, fullCv.width, fullCv.height] };
  }
  const [bx1, by1, bx2, by2] = cropBox;
  const cw = Math.max(1, bx2 - bx1);
  const ch = Math.max(1, by2 - by1);
  const cx = (bx1 + bx2) / 2;
  const cy = (by1 + by2) / 2;

  // Determine viewer container aspect ratio (width / height)
  if (!targetAspect) {
    targetAspect = measureViewerAspect() ?? 400 / 320;
  }

  // 75% to border along narrower dimension relative to container
  let ctx_w, ctx_h;
  if ((cw / targetAspect) >= ch) {
    ctx_w = cw / 0.75;
    ctx_h = ctx_w / targetAspect;
  } else {
    ctx_h = ch / 0.75;
    ctx_w = ctx_h * targetAspect;
  }

  if (ctx_w > fullCv.width) {
    ctx_w = fullCv.width;
    ctx_h = ctx_w / targetAspect;
  }
  if (ctx_h > fullCv.height) {
    ctx_h = fullCv.height;
    ctx_w = ctx_h * targetAspect;
  }

  let x1 = cx - ctx_w / 2;
  let y1 = cy - ctx_h / 2;
  let x2 = cx + ctx_w / 2;
  let y2 = cy + ctx_h / 2;

  if (x1 < 0) {
    x2 -= x1;
    x1 = 0;
  }
  if (y1 < 0) {
    y2 -= y1;
    y1 = 0;
  }
  if (x2 > fullCv.width) {
    x1 -= (x2 - fullCv.width);
    x2 = fullCv.width;
  }
  if (y2 > fullCv.height) {
    y1 -= (y2 - fullCv.height);
    y2 = fullCv.height;
  }

  x1 = Math.max(0, Math.round(x1));
  y1 = Math.max(0, Math.round(y1));
  x2 = Math.min(fullCv.width, Math.round(x2));
  y2 = Math.min(fullCv.height, Math.round(y2));

  const finalW = Math.max(1, x2 - x1);
  const finalH = Math.max(1, y2 - y1);

  const ctxCv = document.createElement("canvas");
  ctxCv.width = finalW;
  ctxCv.height = finalH;
  ctxCv.getContext("2d").drawImage(fullCv, x1, y1, finalW, finalH, 0, 0, finalW, finalH);

  return { contextCanvas: ctxCv, contextBox: [x1, y1, x2, y2] };
}

// Client-Side Photo Classification Pipeline
//
// Two views of the photo are classified and pooled: the detector's crop and the
// whole frame. Both inferences are done before this returns, so the batch commits
// one result per photo; the crop-release path, where the views run one at a time,
// paints each as it lands.
async function classifyImage(imgBitmap, filename) {
  const t0 = performance.now();
  const fullCv = document.createElement("canvas");
  fullCv.width = imgBitmap.width;
  fullCv.height = imgBitmap.height;
  fullCv.getContext("2d").drawImage(imgBitmap, 0, 0);

  // 1. Detection Stage
  const tDet0 = performance.now();
  const lb = letterbox(fullCv);
  const inName = sessDet.inputNames[0];
  const detRes = await sessDet.run({ [inName]: lb.tensor });
  const dets = decodeDets(detRes[Object.keys(detRes)[0]], lb.r, lb.dx, lb.dy);
  let best = selectDetection(dets);
  const detTime = Math.round(performance.now() - tDet0);

  let cropCv = document.createElement("canvas");
  let cropBox = null;
  if (best) {
    const [x1, y1, x2, y2] = best.box;
    const pw = (x2 - x1) * CROP_PAD;
    const ph = (y2 - y1) * CROP_PAD;
    const bx1 = Math.max(0, x1 - pw);
    const by1 = Math.max(0, y1 - ph);
    const bx2 = Math.min(fullCv.width, x2 + pw);
    const by2 = Math.min(fullCv.height, y2 + ph);
    cropCv.width = Math.max(1, bx2 - bx1);
    cropCv.height = Math.max(1, by2 - by1);
    cropCv.getContext("2d").drawImage(fullCv, bx1, by1, cropCv.width, cropCv.height, 0, 0, cropCv.width, cropCv.height);
    cropBox = [bx1, by1, bx2, by2];
  } else {
    cropCv = fullCv;
  }

  // 2. Classification Stage
  const tClip0 = performance.now();

  // Score the crop first, because the nuisance gate is a statement about the
  // crop: if the best species on it loses to the best nuisance class, this crop
  // is not a mosquito worth a second opinion, and the photo falls back to the
  // whole frame exactly as before. Only a crop that passes the gate is pooled
  // with the whole-frame view.
  let cropView = null;
  let fallback = false;
  if (best) {
    const emb = await clipEmbed(cropCv);
    const j = softmaxJoint(emb);
    if (Math.max(...j.spP) >= Math.max(...j.nuP)) {
      cropView = { spP: j.spP, nuTotal: j.nuP.reduce((a, b) => a + b, 0), scale: localViewScale() };
    } else {
      cropCv = fullCv;
      cropBox = null;
      best = null;
      fallback = true;
    }
  }

  const views = [];
  if (cropView) views.push(cropView);
  // The whole frame is always a view: either the second opinion on a crop that
  // passed the gate, or the only view there is.
  const wholeEmb = await clipEmbed(fullCv);
  const wholeJ = softmaxJoint(wholeEmb);
  views.push({ spP: wholeJ.spP, nuTotal: wholeJ.nuP.reduce((a, b) => a + b, 0), scale: localViewScale() });

  const clipTime = Math.round(performance.now() - tClip0);
  const totalTime = Math.round(performance.now() - t0);

  const status = best
    ? `detector: ${dets.length} box(es), best ${best.conf.toFixed(2)}`
    : `full photo fallback${fallback ? " (nuisance gate triggered)" : ""}`;

  const is_cropped = Boolean(best && !fallback);
  const { contextCanvas, contextBox } = extractContextCrop(fullCv, cropBox);

  const base = {
    name: filename,
    fullCanvas: fullCv,
    cropCanvas: cropCv,
    contextCanvas,
    cropBox,
    contextBox,
    status,
    fallback,
    is_cropped,
    rev: 0,
    error: null,
    fingerprint: `${cropCv.width}x${cropCv.height}-${fullCv.width}x${fullCv.height}`,
    manual_full_photo: !best,
    detTime,
    clipTime,
    totalTime
  };

  const epLabel = clipEP === "webgpu" ? "WEBGPU" : "WASM CPU";
  const devText = `inference: ${WEBGPU_MODELS[currentEngine]?.name || "WebGPU"} (${epLabel}) · ${totalTime}ms/photo (crop: ${detTime}ms · analyze: ${clipTime}ms)`;
  const devElem = document.getElementById("footer-device");
  if (devElem) devElem.textContent = devText;

  const fused = fuseViews(views);
  return {
    ...base,
    scores: fused.labels,
    detail: fused.detail,
    logits: fused.logits,
    demoted: fused.demoted,
    agreement: viewAgreement(views.map((v) => v.spP), fused.spP),
    viewsLanded: views.length,
    viewsTotal: views.length,
    pending: false
  };
}

// ---- Batch Processing ----
async function processFiles(fileList) {
  if (isProcessingBatch) return;
  if (currentEngine !== "server-gpu" && (!sessDet || !sessClip)) {
    console.warn("Models not loaded yet for", currentEngine);
    return;
  }
  isProcessingBatch = true;
  sendLog("process_files_started", { count: fileList.length });

  const progressWrap = document.getElementById("batch-progress");
  const progressText = document.getElementById("batch-progress-text");
  const progressFill = document.getElementById("batch-progress-fill");
  progressWrap.style.display = "block";

  const imageFiles = [];
  for (const f of fileList) {
    if (f.name.toLowerCase().endsWith(".zip")) {
      try {
        const zip = await JSZip.loadAsync(f);
        const entries = Object.keys(zip.files).filter(name => !zip.files[name].dir && /\.(jpe?g|png|webp|bmp)$/i.test(name) && !name.startsWith("__MACOSX/"));
        for (const name of entries) {
          const blob = await zip.files[name].async("blob");
          imageFiles.push(new File([blob], name.split("/").pop(), { type: blob.type }));
        }
      } catch (e) {
        console.warn("Could not read zip:", e);
      }
    } else if (/\.(jpe?g|png|webp|bmp)$/i.test(f.name)) {
      imageFiles.push(f);
    }
  }

  if (!imageFiles.length) {
    progressWrap.style.display = "none";
    isProcessingBatch = false;
    return;
  }

  let isBatchAborted = false;
  const btnCancelBatch = document.getElementById("btn-cancel-batch");
  if (btnCancelBatch) {
    btnCancelBatch.onclick = () => {
      isBatchAborted = true;
      progressText.textContent = "Aborting…";
    };
  }

  // New photos are prepended to the stack (existing behaviour) and stay there
  // for the whole batch, so an index computed here stays valid: a photo's slot
  // never moves while its own inference runs, which is what lets a completion
  // write to previews[i] without a lookup.
  const offset = imageFiles.length;
  const updatedIncluded = new Set();
  for (const i of includedIndices) updatedIncluded.add(i + offset);
  includedIndices = updatedIncluded;

  // Placeholders first, so the gallery shows the whole batch immediately: each
  // tile greyed with a pending badge, then resolved as its own inference
  // finishes rather than all at the end. A placeholder carries the same
  // rev/pending contract as a crop release, so a photo deleted or superseded
  // mid-flight is never painted as finished.
  const slots = imageFiles.map((file) => ({
    name: file.name, file,
    fullCanvas: null, cropCanvas: null, contextCanvas: null,
    cropBox: null, contextBox: null,
    scores: {}, detail: {}, logits: null,
    status: "queued…", fallback: false, is_cropped: false, demoted: false,
    manual_full_photo: false, fingerprint: null,
    rev: 0, pending: true, error: null,
    agreement: null, viewsLanded: 0, viewsTotal: 0,
    detTime: null, clipTime: null, totalTime: null
  }));
  previews = [...slots, ...previews];
  selectedIndex = 0;

  document.getElementById("gallery-section").style.display = "block";
  document.getElementById("results-table-section").style.display = "block";
  renderThumbnails();
  renderActivePhoto();
  updatePooling();
  renderResultsTable();

  // Decode with bounded concurrency, inference effectively serial. Decoding a
  // JPEG is independent per file and releases the GIL-free browser work queue, so
  // overlapping it measurably shortens the wait before the first inference can
  // start; the cap keeps a phone from holding ten full-resolution bitmaps at
  // once. Inference stays serial: onnxruntime-web occupies the main thread for
  // the length of a run, so overlapping runs would not make the batch finish
  // any sooner.
  const DECODE_CONCURRENCY = 3;
  let nextToDecode = 0;
  let decoded = 0;
  async function decodeStage() {
    await Promise.all(Array.from({ length: Math.min(DECODE_CONCURRENCY, slots.length) }, async () => {
      for (;;) {
        const i = nextToDecode++;
        if (i >= slots.length) return;
        const slot = slots[i];
        try {
          slot.bitmap = await createImageBitmap(slot.file, { imageOrientation: "from-image" });
          // Paint the photo as soon as it is decoded, so the tile is the real
          // image (greyed) while its own inference is still to come.
          slot.fullCanvas = document.createElement("canvas");
          slot.fullCanvas.width = slot.bitmap.width;
          slot.fullCanvas.height = slot.bitmap.height;
          slot.fullCanvas.getContext("2d").drawImage(slot.bitmap, 0, 0);
          slot.status = "decoding… detecting…";
        } catch (err) {
          slot.pending = false;
          slot.error = `Could not read image: ${err.message || err}`;
          console.error("Error decoding", slot.name, err);
        }
        decoded++;
        progressText.textContent = `Decoded ${decoded} of ${imageFiles.length} photos…`;
        renderThumbnails();
      }
    }));
  }

  const engineLabel = currentEngine === "server-gpu" ? `Server (${serverEngineLabel})` : "WebGPU";
  let processed = 0;
  async function inferSlot(slot, i) {
    if (isBatchAborted) {
      // Aborted before this photo started: say so rather than leaving a tile
      // greyed forever.
      if (slot.pending) {
        slot.pending = false;
        slot.error = "Batch aborted before this photo was analyzed";
      }
      return;
    }
    progressText.textContent = `Analyzing ${processed + 1} of ${imageFiles.length} photos on ${engineLabel} (${slot.name})…`;
    try {
      if (currentEngine === "server-gpu") {
        const formData = new FormData();
        formData.append("file", slot.file);
        const res = await fetch("/api/predict", { method: "POST", body: formData });
        if (!res.ok) throw new Error("Server inference error " + res.status);
        const data = await res.json();
        const fullCv = await dataUrlToCanvas(data.fullDataUrl);
        const cropCv = await dataUrlToCanvas(data.cropDataUrl);
        const contextCv = await dataUrlToCanvas(data.contextDataUrl);

        // Second view over the same contract, no server change needed: the
        // endpoint already classifies whatever box it is given, so the whole
        // frame is one more request with crop_box spanning it. Skipped when the
        // server's own detection found nothing and it classified the whole frame
        // anyway - then there is only one view to have.
        const views = [serverView(data)];
        if (data.is_cropped) {
          const fd2 = new FormData();
          fd2.append("file", slot.file);
          fd2.append("crop_box", JSON.stringify([0, 0, data.fullWidth, data.fullHeight]));
          const res2 = await fetch("/api/predict", { method: "POST", body: fd2 });
          if (!res2.ok) throw new Error("Server inference error " + res2.status);
          views.push(serverView(await res2.json()));
        }
        const fused = fuseViews(views);

        commitBatchSlot(slots[i], {
          name: data.filename, fullCanvas: fullCv, cropCanvas: cropCv, contextCanvas: contextCv,
          cropBox: data.cropBox, contextBox: data.contextBox, scores: fused.labels,
          detail: fused.detail, logits: fused.logits, status: data.status, fallback: data.fallback,
          is_cropped: data.is_cropped,
          demoted: fused.demoted,
          agreement: viewAgreement(views.map((v) => v.spP), fused.spP),
          viewsLanded: views.length, viewsTotal: views.length,
          fingerprint: `${cropCv.width}x${cropCv.height}-${fullCv.width}x${fullCv.height}`,
          manual_full_photo: !data.is_cropped,
          detTime: data.detTime, clipTime: data.clipTime, totalTime: data.totalTime
        });
        const devElem = document.getElementById("footer-device");
        if (devElem) {
          devElem.textContent = `inference: ${data.engine_label} · ${data.totalTime}ms/photo (crop: ${data.detTime}ms · analyze: ${data.clipTime}ms)`;
        }
      } else {
        const res = await classifyImage(slot.bitmap, slot.name);
        commitBatchSlot(slots[i], res);
      }
    } catch (err) {
      // One unreadable photo must not take the batch down with it.
      if (slots[i].pending) markComputeFailed(slots[i], err);
      else slots[i].error = `Analysis failed: ${err.message || err}`;
      console.error("Error processing", slot.name, err);
    }
    processed++;
    progressFill.style.width = `${(processed / imageFiles.length) * 100}%`;
    renderThumbnails();
    renderActivePhoto();
    updatePooling();
    renderResultsTable();
  }

  // Inference, one photo at a time, each result painted as it lands.
  const decodeDone = decodeStage();
  for (let i = 0; i < slots.length; i++) {
    // Let the decode pool make progress before each inference claims the thread.
    await decodeDone.catch(() => {});
    if (!slots[i].fullCanvas && !slots[i].error) {
      // Still decoding: wait for this slot specifically.
      while (!slots[i].bitmap && !slots[i].error) await new Promise((r) => setTimeout(r, 8));
    }
    await inferSlot(slots[i], i);
  }

  progressWrap.style.display = "none";
  isProcessingBatch = false;

  renderThumbnails();
  renderActivePhoto();
  updatePooling();
  renderResultsTable();
  sendLog("process_files_completed", { added: slots.length, total: previews.length });
}

// A batch result lands on its own slot, under the same guard a crop release
// uses: if the photo was deleted, or a crop release overtook it while its
// inference was in flight, the result is dropped rather than painted.
function commitBatchSlot(slot, res) {
  const rev = slot.rev;
  if (slot.removed || previews.indexOf(slot) < 0 || slot.rev !== rev) {
    sendLog("batch_slot_superseded", { name: slot.name, rev, currentRev: slot.rev });
    return;
  }
  Object.assign(slot, res);
  slot.file = undefined;   // release the File/ImageBitmap once it is not needed
  slot.bitmap = undefined;
  slot.pending = false;
  slot.error = null;
}

function deletePhoto(idx) {
  if (idx < 0 || idx >= previews.length) return;
  const deleted = previews[idx];
  const deletedName = deleted.name;
  sendLog("delete_photo", { idx, name: deletedName });
  // Any computation still running for this photo now has nothing to write to.
  deleted.removed = true;
  previews.splice(idx, 1);
  const updated = new Set();
  for (const i of includedIndices) {
    if (i < idx) updated.add(i);
    else if (i > idx) updated.add(i - 1);
  }
  includedIndices = updated;
  // Follow the photo, not the index. Deleting anything before the selected photo
  // shifts every later photo down one, so the selection has to move with it -
  // otherwise deleting the leftmost tile silently switched the gallery to a
  // different photo while the highlighted tile stayed where it was. The clamp
  // alone only handled the case where the selection fell off the end.
  if (idx < selectedIndex) {
    selectedIndex -= 1;
  } else if (selectedIndex >= previews.length) {
    selectedIndex = Math.max(0, previews.length - 1);
  }
  if (previews.length === 0) {
    document.getElementById("gallery-section").style.display = "none";
    document.getElementById("results-table-section").style.display = "none";
    document.getElementById("combined-card").style.display = "none";
  } else {
    renderThumbnails();
    renderActivePhoto();
    updatePooling();
    renderResultsTable();
  }
}

// ---- UI Rendering & Navigation ----

// A photo can only be pooled if its checkbox is enabled, so the bulk actions use
// the same rule rather than a second one that could drift from it.
function isSelectable(p) {
  return Boolean(p) && !p.fallback && !p.pending && !p.error;
}

function renderThumbnails() {
  const strip = document.getElementById("thumbnail-strip");
  strip.innerHTML = "";
  updateStripActions();
  document.getElementById("gallery-counter").textContent = `${selectedIndex + 1} / ${previews.length}`;

  previews.forEach((p, idx) => {
    const tile = document.createElement("div");
    // A photo still being analyzed is visibly unsettled: greyed tile, pending
    // badge, and it cannot be opted into the pooled result yet.
    tile.className = "tile" + (selectedIndex === idx ? " active" : "") +
      (!includedIndices.has(idx) ? " excluded" : "") + (p.pending ? " pending" : "");

    const delBtn = document.createElement("button");
    delBtn.className = "tile-delete-btn";
    delBtn.innerHTML = "&times;";
    delBtn.title = `Remove ${p.name}`;
    delBtn.onclick = (e) => {
      e.stopPropagation();
      deletePhoto(idx);
    };
    tile.appendChild(delBtn);

    const btn = document.createElement("button");
    btn.className = "tile-btn";
    btn.setAttribute("aria-label", `View photo ${idx + 1}: ${p.name}`);
    btn.onclick = () => selectPhoto(idx);

    const img = document.createElement("img");
    // A queued photo has no canvas yet: it gets a greyed placeholder tile that
    // resolves to the real image as soon as its own decode finishes. The alt is
    // empty in that state, so the filename does not render over the tile.
    const src = p.cropCanvas || p.fullCanvas;
    if (src) {
      img.src = src.toDataURL("image/jpeg", 0.8);
      img.alt = p.name;
    } else {
      img.className = "thumb-placeholder";
      img.alt = "";
    }
    btn.appendChild(img);

    const num = document.createElement("span");
    num.className = "number";
    num.textContent = `${idx + 1}`;
    btn.appendChild(num);

    const badge = document.createElement("span");
    const badgeState = p.error ? "error" : p.pending ? "pending" : p.is_cropped ? "cropped" : "uncropped";
    badge.className = `crop-badge ${badgeState}`;
    badge.textContent = p.error ? "!" : p.pending ? "…" : p.is_cropped ? "✓" : "✕";
    badge.title = p.error
      ? p.error
      : p.pending
        ? "Classifying the current crop…"
        : p.is_cropped ? "Mosquito detected & cropped" : "Uncropped / no mosquito detected";
    btn.appendChild(badge);

    tile.appendChild(btn);

    const label = document.createElement("label");
    label.className = "include";
    label.title = !p.fallback ? "Include this photo in pooled result" : "No usable mosquito detection";

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.className = "thumb-optin";
    chk.checked = includedIndices.has(idx);
    chk.disabled = !isSelectable(p);
    chk.onchange = (e) => {
      if (e.target.checked) includedIndices.add(idx);
      else includedIndices.delete(idx);
      renderThumbnails();
      updatePooling();
    };

    label.appendChild(chk);
    tile.appendChild(label);
    strip.appendChild(tile);
  });
}

function setAllSelected(on) {
  previews.forEach((p, i) => {
    if (isSelectable(p) && on) includedIndices.add(i);
    else includedIndices.delete(i);
  });
  renderThumbnails();
  updatePooling();
  updateStripActions();
}

function deleteAllPhotos() {
  if (!previews.length) return;
  const n = previews.length;
  // Destructive and not undoable, so it asks. The gallery is the user's work:
  // photos may not be re-obtained if the originals are not on the device.
  if (!window.confirm(`Delete all ${n} photo${n > 1 ? "s" : ""}? This cannot be undone.`)) return;
  // Mark first, exactly as deletePhoto does, so every in-flight inference for any
  // photo drops its result rather than writing into a slot that no longer exists.
  previews.forEach((p) => { p.removed = true; });
  previews.length = 0;
  includedIndices = new Set();
  selectedIndex = 0;
  sendLog("delete_all_photos", { count: n });
  renderThumbnails();
  document.getElementById("gallery-section").style.display = "none";
  document.getElementById("results-table-section").style.display = "none";
  // The combined card is not hidden: hiding it shifts the layout under the
  // strip. updatePooling() decides what it shows.
  updatePooling();
}

// Nothing to select, deselect or delete without photos, so the buttons say so
// rather than sitting there as no-ops.
function updateStripActions() {
  const empty = previews.length === 0;
  for (const id of ["btn-select-all", "btn-select-none", "btn-delete-all"]) {
    const el = document.getElementById(id);
    if (el) el.disabled = empty;
  }
}

function wireStripActions() {
  const on = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  };
  on("btn-select-all", () => setAllSelected(true));
  on("btn-select-none", () => setAllSelected(false));
  on("btn-delete-all", deleteAllPhotos);
  updateStripActions();
}

function selectPhoto(idx) {
  selectedIndex = Math.max(0, Math.min(idx, previews.length - 1));
  isDragging = false;
  currentDragTarget = null;
  dragStartPt = null;
  dragCurrentRect = null;
  const rectFull = document.getElementById("full-drag-rect");
  if (rectFull) rectFull.style.display = "none";
  const rectZoomed = document.getElementById("zoomed-drag-rect");
  if (rectZoomed) rectZoomed.style.display = "none";

  renderThumbnails();
  renderActivePhoto();
  sendLog("select_photo", { index: selectedIndex, name: previews[selectedIndex]?.name });
}

// The crop surfaces take their box from the container, never from the photo.
//
// They used to be sized here in px from the canvas's own aspect ratio, which
// closed a loop with the grid: a grid item's default `min-width: auto` lets its
// content widen its track, so canvas aspect -> px width -> track min-content ->
// container width. Every arrival of a photo therefore resized the page, and the
// resize landed again on every selection change and every re-crop.
//
// The photo's aspect is not lost, it is delegated: `.crop-surface img` is
// object-fit:cover, and coverMapping() reads the surface's box at paint time, so
// crop overlays stay aligned whatever shape the box is.
function fitSurface(surface, cv) {
  if (!surface) return;
  // A fixed percentage box, so the surface has its final geometry from the first
  // paint and no photo state can change it.
  surface.style.width = "100%";
  surface.style.height = "100%";
}

function renderActivePhoto() {
  if (!previews.length || !previews[selectedIndex]) return;
  const p = previews[selectedIndex];

  // 1. Render Left Panel (Full Photo)
  const surfaceFull = document.getElementById("crop-surface-full");
  fitSurface(surfaceFull, p.fullCanvas);
  const fullImg = document.getElementById("full-img");
  // A photo whose decode has not finished has no canvas to show yet. Hide the
  // image rather than leaving a broken-icon with alt text over an empty panel;
  // the pending notice beside it says what is happening.
  if (p.fullCanvas) {
    fullImg.src = p.fullCanvas.toDataURL("image/jpeg", 0.9);
    fullImg.style.visibility = "visible";
  } else {
    fullImg.removeAttribute("src");
    fullImg.style.visibility = "hidden";
  }

  // Active crop outline on full photo (for both manual and automatic crops!)
  const fullActiveBox = document.getElementById("full-active-crop-box");
  applyBox(fullActiveBox, cropBoxInFullSurface(p));

  // 2. Render Center Panel (Zoomed View with extra context)
  const surfaceZoomed = document.getElementById("crop-surface-zoomed");
  const contextImg = document.getElementById("context-img");
  const cropEmpty = document.getElementById("crop-empty");
  const zoomedActiveBox = document.getElementById("zoomed-active-crop-box");

  // The panel shows the mosquito, or it shows nothing. It does not narrate our
  // processing state: `pending` means the verdict is stale, not that there is
  // nothing to look at, so a pending photo keeps the last good crop on screen
  // instead of blanking and snapping back. A failure is the same case - show the
  // photo we have rather than a message about a crop. Only a photo with no image
  // at all (decode not finished) leaves the panel empty, which is honest.
  //
  // Gating on `!p.pending && !p.error` is what caused the blank-then-flicker:
  // the panel emptied the instant a re-crop was released and refilled when the
  // numbers landed.
  const zoomSource = p.contextCanvas || p.fullCanvas;
  if (zoomSource) {
    surfaceZoomed.style.width = "100%";
    surfaceZoomed.style.height = "100%";
    contextImg.src = zoomSource.toDataURL("image/jpeg", 0.9);
    contextImg.style.display = "block";
    contextImg.style.width = "100%";
    contextImg.style.height = "100%";
    contextImg.style.objectFit = "cover";
    cropEmpty.style.display = "none";

    // Draw where the crop sits within the context region
    applyBox(zoomedActiveBox, cropBoxInZoomSurface(p));
  } else {
    contextImg.style.display = "none";
    cropEmpty.style.display = "block";
    // Only ever a statement about the photo, never about our machinery. There is
    // deliberately no "Crop unavailable" here: a failed classification is not a
    // missing photo, and the panel already has an image in that case.
    cropEmpty.textContent = p.manual_full_photo ? "Using full photo" : "No mosquito detected";
    if (zoomedActiveBox) zoomedActiveBox.style.display = "none";
  }

  // 3. Render Right Panel (Scores)
  const scoreList = document.getElementById("score-list");
  const scoreNotice = document.getElementById("score-pending");
  const unsettled = Boolean(p.pending) || Boolean(p.error);
  scoreList.innerHTML = "";
  // The numbers below still describe the previous crop while a new one is being
  // classified, so they are dimmed and labelled rather than presented as the
  // verdict for what is on screen.
  scoreList.classList.toggle("stale", unsettled);
  if (scoreNotice) {
    // The notice keeps its box and only changes visibility: it sits above the
    // score list, so showing or hiding it used to push every score already on
    // screen up or down. The reserved height is in CSS and is sized for two
    // lines, so the text length never changes the box either.
    let noticeClass = "";
    let noticeText = "";
    if (p.error) {
      noticeClass = " error";
      noticeText = p.error;
    } else if (p.pending) {
      noticeText = p.cropBox === null && !p.fullCanvas ? "Reading photo…" : "Classifying…";
    }
    scoreNotice.textContent = noticeText;
    scoreNotice.className = `pending-notice${noticeClass}${noticeText ? " shown" : ""}`;
    // A failed classification is worth reading in full, so it goes in the
    // tooltip rather than being cut off at the panel's edge.
    scoreNotice.title = noticeText;
  }

  // Whether the photo's two views back each other up. Shown whenever there is
  // something to say and hidden otherwise, in a box that is always the same
  // height, so its arrival seconds into a photo's classification moves nothing.
  const agreeBox = document.getElementById("view-agreement");
  if (agreeBox) {
    const a = p.agreement;
    // While a second view is still to come, the scores below are one view's
    // alone, so there is no agreement to report yet.
    const text = (a && !p.pending) ? agreementSentence(a) : "";
    agreeBox.textContent = text;
    agreeBox.className = `pending-notice${text ? " shown" : ""}${text && !a.agree ? " disagree" : ""}`;
    agreeBox.title = text;
  }
  const sortedScores = Object.entries(p.detail).sort((a, b) => b[1] - a[1]);
  for (const [name, score] of sortedScores) {
    const item = document.createElement("div");
    item.className = "score-item";
    const percent = (score * 100).toFixed(1);
    item.innerHTML = `
      <div class="score-item-header">
        <span class="species-name-wrap">${speciesLabelHtml(name)}</span>
        <strong>${percent}%</strong>
      </div>
      <div class="score-item-track">
        <div class="score-item-fill" style="width: ${Math.max(0, Math.min(100, score * 100))}%"></div>
      </div>
    `;
    scoreList.appendChild(item);
  }

  // The status line is the other place a stale verdict would show: while a
  // recompute is in flight, or after one failed, say so rather than repeating
  // the crop size as though it were a result.
  const statusText = p.error
    ? `analysis failed: ${p.error.replace(/^Classification failed: /, "")}`
    : p.status;
  document.getElementById("photo-name").textContent = `${p.name} · ${statusText}`;
  const btnFull = document.getElementById("btn-full-photo");
  if (p.is_cropped) {
    btnFull.style.display = "inline-block";
    btnFull.onclick = () => revertToFullPhoto(selectedIndex);
  } else {
    btnFull.style.display = "none";
  }
}

// ---- Decoupled Dual-Stage Cropping Engine ----
let isDragging = false;
let currentDragTarget = null; // 'full' or 'zoomed'
let dragStartPt = null;
let dragCurrentRect = null;

function setupCropSurfaces() {
  const surfaceFull = document.getElementById("crop-surface-full");
  const rectFull = document.getElementById("full-drag-rect");
  const surfaceZoomed = document.getElementById("crop-surface-zoomed");
  const rectZoomed = document.getElementById("zoomed-drag-rect");

  function getSurfacePoint(surface, clientX, clientY) {
    const b = surface.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) return [0, 0];
    return [
      Math.max(0, Math.min(1, (clientX - b.left) / b.width)),
      Math.max(0, Math.min(1, (clientY - b.top) / b.height))
    ];
  }

  function startDrag(target, surface, rectEl, e) {
    if (e.button !== 0 || !previews.length || !previews[selectedIndex]) return;
    e.preventDefault();
    e.stopPropagation();

    if (isDragging) {
      if (rectFull) rectFull.style.display = "none";
      if (rectZoomed) rectZoomed.style.display = "none";
    }

    isDragging = true;
    currentDragTarget = target;
    dragStartPt = getSurfacePoint(surface, e.clientX, e.clientY);
    dragCurrentRect = null;
    rectEl.style.display = "none";

    sendLog("drag_start", { target, startPt: dragStartPt });

    function onPointerMove(ev) {
      if (!isDragging || currentDragTarget !== target || !dragStartPt) return;
      const pt = getSurfacePoint(surface, ev.clientX, ev.clientY);
      dragCurrentRect = [
        Math.min(dragStartPt[0], pt[0]),
        Math.min(dragStartPt[1], pt[1]),
        Math.max(dragStartPt[0], pt[0]),
        Math.max(dragStartPt[1], pt[1])
      ];
      rectEl.style.display = "block";
      rectEl.style.left = `${dragCurrentRect[0] * 100}%`;
      rectEl.style.top = `${dragCurrentRect[1] * 100}%`;
      rectEl.style.width = `${(dragCurrentRect[2] - dragCurrentRect[0]) * 100}%`;
      rectEl.style.height = `${(dragCurrentRect[3] - dragCurrentRect[1]) * 100}%`;
    }

    async function onPointerUp(ev) {
      // Stamped first, before any bookkeeping: this is the "the user let go"
      // instant the displayed-picture latency is measured from.
      const releasedAt = performance.now();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);

      if (!isDragging || currentDragTarget !== target) return;
      isDragging = false;
      currentDragTarget = null;
      rectEl.style.display = "none";

      const rect = dragCurrentRect;
      dragCurrentRect = null;
      dragStartPt = null;

      if (!rect) {
        sendLog("drag_cancel", { target, reason: "no_rect" });
        return;
      }
      const w = rect[2] - rect[0];
      const h = rect[3] - rect[1];
      if (w < 0.015 || h < 0.015) {
        sendLog("drag_cancel", { target, reason: "too_small", w, h });
        return;
      }

      sendLog("drag_end", { target, rect, w, h });

      const idx = selectedIndex;
      if (target === "full") {
        applyCropFromFullSurface(idx, rect, releasedAt);
      } else if (target === "zoomed") {
        applyCropFromZoomedSurface(idx, rect, releasedAt);
      }
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }

  surfaceFull.addEventListener("pointerdown", (e) => startDrag("full", surfaceFull, rectFull, e));
  surfaceZoomed.addEventListener("pointerdown", (e) => startDrag("zoomed", surfaceZoomed, rectZoomed, e));
}

// Execute Crop from Full Photo surface
async function applyCropFromFullSurface(idx, rect, t0) {
  const p = previews[idx];
  const fullCv = p.fullCanvas;
  // Surface fractions -> image fractions through the same cover window
  // cropBoxInFullSurface() draws through, so a drag lands on the pixels the
  // user pointed at rather than on the same fraction of a wider photo.
  const { kx, ox, ky, oy } = coverMapping(
    document.getElementById("crop-surface-full"), fullCv
  );
  const r = [kx * rect[0] + ox, ky * rect[1] + oy, kx * rect[2] + ox, ky * rect[3] + oy];
  const x1 = Math.max(0, Math.min(fullCv.width, Math.round(r[0] * fullCv.width)));
  const y1 = Math.max(0, Math.min(fullCv.height, Math.round(r[1] * fullCv.height)));
  const x2 = Math.max(0, Math.min(fullCv.width, Math.round(r[2] * fullCv.width)));
  const y2 = Math.max(0, Math.min(fullCv.height, Math.round(r[3] * fullCv.height)));

  if (x2 - x1 < 10 || y2 - y1 < 10) return;

  sendLog("manual_crop", { target: "full", rect: [x1, y1, x2, y2] });
  return executeCrop(p, idx, [x1, y1, x2, y2], t0);
}

// Execute Crop from Zoomed 50% Context surface (fine-tuning)
async function applyCropFromZoomedSurface(idx, rect, t0) {
  const p = previews[idx];
  if (!p.contextBox) return;
  const [ctx_x1, ctx_y1, ctx_x2, ctx_y2] = p.contextBox;
  const ctx_w = ctx_x2 - ctx_x1;
  const ctx_h = ctx_y2 - ctx_y1;

  // Surface fractions -> image fractions, through the object-fit:cover window,
  // so a fine-tune drag lands where the user pointed even if the context canvas
  // and the surface no longer share an aspect (e.g. after a window resize).
  const { kx, ox, ky, oy } = zoomedSurfaceMapping();
  const r = [kx * rect[0] + ox, ky * rect[1] + oy, kx * rect[2] + ox, ky * rect[3] + oy];

  const x1 = Math.max(0, Math.min(p.fullCanvas.width, Math.round(ctx_x1 + r[0] * ctx_w)));
  const y1 = Math.max(0, Math.min(p.fullCanvas.height, Math.round(ctx_y1 + r[1] * ctx_h)));
  const x2 = Math.max(0, Math.min(p.fullCanvas.width, Math.round(ctx_x1 + r[2] * ctx_w)));
  const y2 = Math.max(0, Math.min(p.fullCanvas.height, Math.round(ctx_y1 + r[3] * ctx_h)));

  if (x2 - x1 < 10 || y2 - y1 < 10) return;

  sendLog("manual_crop", { target: "zoomed", rect: [x1, y1, x2, y2] });
  return executeCrop(p, idx, [x1, y1, x2, y2], t0);
}

// One view of one photo, scored. Returns the pieces fusion needs (the species
// posteriors and the nuisance mass they were normalised against) rather than a
// finished verdict, because the verdict is the fused one.
async function classifyViewLocal(canvas) {
  const emb = await clipEmbed(canvas);
  const { spP, nuP } = softmaxJoint(emb);
  return { spP, nuTotal: nuP.reduce((a, b) => a + b, 0), scale: localViewScale() };
}

// The server's answer for one crop box, in the same shape. `detail` is the
// species posterior already normalised against the nuisance classes by the
// server's own joint softmax, so the nuisance mass is whatever the species did
// not take.
async function classifyViewServer(p, cropBox) {
  return serverView(await classifyCanvasServer(p, cropBox));
}

// The same conversion from a /api/predict response, for the batch path which
// holds the response rather than a canvas.
function serverView(data) {
  const spP = EMB.species.map((name) => data.detail[name] || 0);
  const speciesMass = spP.reduce((a, b) => a + b, 0);
  return { spP, nuTotal: Math.max(1 - speciesMass, 1e-12), scale: serverViewScale() };
}

// Server path: the server owns no geometry decision we need for display, only
// the scores for a crop box we send it. If it answers with a different box
// than the one it was given, its labels describe a crop the user is not looking
// at, so the box is logged and ignored rather than silently re-displayed.
async function classifyCanvasServer(p, cropBox) {
  const blob = await new Promise((r) => p.fullCanvas.toBlob(r, "image/jpeg", 0.85));
  const formData = new FormData();
  formData.append("file", blob, p.name);
  formData.append("crop_box", JSON.stringify(cropBox));
  const res = await fetch("/api/predict", { method: "POST", body: formData });
  if (!res.ok) throw new Error(`Server inference error ${res.status}`);
  const data = await res.json();
  if (JSON.stringify(data.cropBox) !== JSON.stringify(cropBox)) {
    sendLog("server_crop_box_diverged", { requested: cropBox, returned: data.cropBox });
  }
  return {
    labels: data.labels,
    detail: data.detail,
    logits: data.logits,
    demoted: Boolean(Object.keys(data.labels)[0]?.includes("low confidence"))
  };
}

// The views of one photo that get classified and pooled: the crop on screen and
// the whole frame. Two views of the same specimen, because one view of it is
// fallible - see fuseViews for what the second buy is worth.
//
// A photo already showing the whole frame has only one view to offer, and
// running the same pixels through the model twice would fuse a view with itself.
// That covers both a photo the detector found nothing in and one the user
// reverted to whole. Each view carries its crop box because the server path
// takes a box where the local path takes the already-cut pixels.
function viewsFor(p, cropCv, cropBox) {
  const whole = { canvas: p.fullCanvas, box: [0, 0, p.fullCanvas.width, p.fullCanvas.height] };
  if (!cropCv || cropCv === p.fullCanvas) return [whole];
  return [{ canvas: cropCv, box: cropBox }, whole];
}

// Classify every view of one photo and commit the fused verdict, once per view
// as each lands so a photo shows progress rather than sitting blank until its
// last inference is done.
//
// The rev guard is the same one a single-view commit used, checked before and
// after every view: a photo deleted mid-flight, or superseded by a newer crop
// release, must not be painted by an inference that started before either. With
// two views per photo that check runs twice as often, which is the point - the
// second view has strictly more opportunity to arrive late and stale.
async function classifyViews(p, idx, rev, cropCv, cropBox) {
  const views = viewsFor(p, cropCv, cropBox);
  const landed = [];
  let dropped = false;

  for (const view of views) {
    await afterNextPaint();
    if (!ownsRecompute(p, idx, rev)) { dropped = true; break; }
    const v = currentEngine === "server-gpu"
      ? await classifyViewServer(p, view.box)
      : await classifyViewLocal(view.canvas);
    if (!ownsRecompute(p, idx, rev)) { dropped = true; break; }
    landed.push(v);
    // Paint what is known so far. The fused verdict is recomputed from the views
    // that have landed, so the first view's paint is that view's own softmax
    // unchanged, and the second replaces it with the pool of the two.
    applyViews(p, landed, views.length);
    renderThumbnails();
    renderActivePhoto();
    updatePooling();
    renderResultsTable();
  }

  if (dropped) {
    sendLog("views_superseded", { name: p.name, rev, currentRev: p.rev, landed: landed.length });
    return { dropped: true };
  }
  sendLog("views_fused", { name: p.name, rev, views: landed.length });
  return { dropped: false };
}

// Write the fused verdict for the views that have landed: commitScores for the
// verdict itself, then the multi-view bookkeeping on top. The photo stays
// pending until every view is in, so a tile is never shown as settled on a
// partial pool that is about to be replaced by the full one.
function applyViews(p, landed, total) {
  const fused = fuseViews(landed);
  commitScores(p, fused);
  p.agreement = viewAgreement(landed.map((v) => v.spP), fused.spP);
  p.viewsLanded = landed.length;
  p.viewsTotal = total;
  p.pending = landed.length < total;
  return fused;
}

// Hand the thread back to the browser for one painted frame before the model
// starts. Without this the synchronous geometry update and the inference share
// a single task: the browser gets no chance to composite in between, so the
// first frame showing the new crop is delayed by the whole inference. Measured
// 844 ms with a 46 ms update; with the yield, the frame lands in ~50 ms.
function afterNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

// Core Crop Execution (handles Server and Local WebGPU)
//
// Two phases. Phase one is synchronous and touches no model: cut the crop,
// re-cut the context around it, and repaint. That is what the user asked for
// by releasing. Phase two asks the model what the new crop is and commits the
// answer only if this is still the newest release for this photo.
async function executeCrop(p, idx, cropBox, t0) {
  const [bx1, by1, bx2, by2] = cropBox;
  const fullCv = p.fullCanvas;
  const started = t0 ?? performance.now();

  const cw = Math.max(1, bx2 - bx1);
  const ch = Math.max(1, by2 - by1);
  const cropCv = document.createElement("canvas");
  cropCv.width = cw;
  cropCv.height = ch;
  cropCv.getContext("2d").drawImage(fullCv, bx1, by1, cw, ch, 0, 0, cw, ch);
  const { contextCanvas, contextBox } = extractContextCrop(fullCv, cropBox);

  // Phase one: geometry and pixels, now. The scores on screen no longer belong
  // to what is on screen, so they are marked pending rather than left looking
  // current.
  const rev = beginRecompute(p);
  p.cropCanvas = cropCv;
  p.contextCanvas = contextCanvas;
  p.cropBox = cropBox;
  p.contextBox = contextBox;
  p.status = `manual crop: ${cw}x${ch}px`;
  p.is_cropped = true;
  p.manual_full_photo = false;
  p.fallback = false;

  renderThumbnails();
  renderActivePhoto();
  updatePooling();
  renderResultsTable();

  const rec = {
    what: "crop", cropBox, cw, ch, rev,
    applyMs: Math.round((performance.now() - started) * 10) / 10,
    cropFrameMs: null, cropPaintMs: null, scoresMs: null, topSpecies: null,
    dropped: false, failed: null
  };
  ASYNC.last = rec;
  // cropFrameMs is the next frame boundary after the DOM was updated;
  // cropPaintMs is the frame after that, i.e. the first callback that runs once
  // the frame containing the new crop has actually been painted.
  requestAnimationFrame(() => {
    rec.cropFrameMs = Math.round((performance.now() - started) * 10) / 10;
    requestAnimationFrame(() => {
      rec.cropPaintMs = Math.round((performance.now() - started) * 10) / 10;
    });
  });
  sendLog("crop_released", { engine: currentEngine, cropBox, cw, ch, rev });

  // Phase two: the model, off the critical path. Both views of the photo - the
  // crop just drawn and the whole frame - are classified and pooled.
  try {
    const r = await classifyViews(p, idx, rev, cropCv, cropBox);
    if (r.dropped) {
      rec.dropped = true;
      sendLog("crop_superseded", { name: p.name, rev, currentRev: p.rev });
      return;
    }
    p.status = `manual crop: ${cw}x${ch}px`;
    rec.scoresMs = Math.round(performance.now() - started);
    rec.topSpecies = Object.keys(p.scores)[0];
  } catch (err) {
    if (err instanceof Superseded || !ownsRecompute(p, idx, rev)) {
      rec.dropped = true;
      return;
    }
    console.error("Crop classification failed:", err);
    markComputeFailed(p, err);
    p.status = `manual crop: ${cw}x${ch}px · analysis failed`;
    rec.failed = p.error;
    rec.scoresMs = Math.round(performance.now() - started);
  }

  const devElem = document.getElementById("footer-device");
  if (devElem) {
    const engine = currentEngine === "server-gpu"
      ? serverEngineLabel
      : `${WEBGPU_MODELS[currentEngine]?.name || "WebGPU"} (${clipEP === "webgpu" ? "WEBGPU" : "WASM CPU"})`;
    devElem.textContent = `inference: ${engine} · manual crop`;
  }

  renderThumbnails();
  renderActivePhoto();
  updatePooling();
  renderResultsTable();
  sendLog("crop_executed", {
    engine: currentEngine, cropBox, cw, ch,
    topSpecies: Object.keys(p.scores)[0] || null
  });
}

async function revertToFullPhoto(idx) {
  const p = previews[idx];
  const fullCv = p.fullCanvas;
  const started = performance.now();
  sendLog("revert_to_full", { name: p.name });

  // Phase one, as in executeCrop: the full photo is displayed immediately.
  const rev = beginRecompute(p);
  p.cropCanvas = fullCv;
  p.contextCanvas = fullCv;
  p.cropBox = null;
  p.contextBox = [0, 0, fullCv.width, fullCv.height];
  p.status = "manual full photo";
  p.is_cropped = false;
  p.manual_full_photo = true;
  p.fallback = false;

  renderThumbnails();
  renderActivePhoto();
  updatePooling();
  renderResultsTable();

  const rec = {
    what: "revert", rev,
    applyMs: Math.round((performance.now() - started) * 10) / 10,
    cropFrameMs: null, cropPaintMs: null, scoresMs: null, topSpecies: null,
    dropped: false, failed: null
  };
  ASYNC.last = rec;
  requestAnimationFrame(() => {
    rec.cropFrameMs = Math.round((performance.now() - started) * 10) / 10;
    requestAnimationFrame(() => {
      rec.cropPaintMs = Math.round((performance.now() - started) * 10) / 10;
    });
  });

  try {
    // Reverting shows the whole frame, which is the one view there is: the crop
    // the user just gave up is not a second opinion on this photo any more, it is
    // a different picture of it.
    const r = await classifyViews(p, idx, rev, fullCv, null);
    if (r.dropped) {
      rec.dropped = true;
      sendLog("revert_superseded", { name: p.name, rev, currentRev: p.rev });
      return;
    }
    p.status = "manual full photo";
    rec.scoresMs = Math.round(performance.now() - started);
    rec.topSpecies = Object.keys(p.scores)[0];
  } catch (err) {
    if (err instanceof Superseded || !ownsRecompute(p, idx, rev)) {
      rec.dropped = true;
      return;
    }
    console.error("Revert classification failed:", err);
    markComputeFailed(p, err);
    p.status = "manual full photo · analysis failed";
    rec.failed = p.error;
    rec.scoresMs = Math.round(performance.now() - started);
  }

  renderThumbnails();
  renderActivePhoto();
  updatePooling();
  renderResultsTable();
}

// ---- Pooling / Evidence Aggregation ----
function updatePooling() {
  const poolCard = document.getElementById("combined-card");
  const poolScores = document.getElementById("combined-scores");
  const contribTable = document.getElementById("contribution-table").querySelector("tbody");

  const checked = Array.from(includedIndices).map(i => previews[i]).filter(Boolean);
  // A photo whose crop is being re-classified, or whose classification failed,
  // has no verdict that matches its pixels. Pooling it would fold the previous
  // crop's evidence into the combined result, so it is left out. Its own row in
  // the results table stays empty until it has a verdict, which is where the
  // card's header count and the table agree with each other.
  const included = checked.filter(p => !p.pending && !p.error);
  if (included.length <= 1) {
    poolCard.style.display = "none";
    return;
  }
  poolCard.style.display = "block";

  const selectedMethod = document.querySelector('input[name="pooling-method"]:checked')?.value || "Dependent evidence";
  const r = parseFloat(document.getElementById("corr-slider").value) || 0.5;

  const N = included.length;
  const weights = [];
  const leads = included.map(p => {
    const sorted = Object.values(p.scores).sort((a, b) => b - a);
    return (sorted[0] || 0) - (sorted[1] || 0);
  });

  if (selectedMethod === "Equal weight") {
    for (let i = 0; i < N; i++) weights.push(1 / N);
  } else if (selectedMethod === "Weight by lead") {
    const sumLead = leads.reduce((a, b) => a + b, 0) || 1e-6;
    for (let i = 0; i < N; i++) weights.push(leads[i] / sumLead);
  } else if (selectedMethod === "Accumulate evidence") {
    for (let i = 0; i < N; i++) weights.push(1);
  } else {
    // Dependent evidence: de-duplicate identical crops
    const seen = new Set();
    const effectiveWeights = [];
    included.forEach(p => {
      if (seen.has(p.fingerprint)) {
        effectiveWeights.push(0);
      } else {
        seen.add(p.fingerprint);
        effectiveWeights.push(1);
      }
    });
    const denom = 1 + (seen.size - 1) * r;
    for (let i = 0; i < N; i++) {
      weights.push(effectiveWeights[i] / denom);
    }
  }

  // Aggregate Logits
  const aggLogits = {};
  EMB.species.forEach(sp => { aggLogits[sp] = 0; });

  included.forEach((p, idx) => {
    const w = weights[idx];
    if (w > 0 && p.logits) {
      EMB.species.forEach(sp => {
        aggLogits[sp] += (p.logits[sp] || 0) * w;
      });
    }
  });

  // Relative Log Scores (Axis: -20 to 0)
  const maxLogit = Math.max(...Object.values(aggLogits));
  const candidates = EMB.species.map(sp => ({
    name: sp,
    complex: COMPLEX_OF[sp] || sp,
    relScore: aggLogits[sp] - maxLogit
  })).sort((a, b) => b.relScore - a.relScore);

  poolScores.innerHTML = "";
  candidates.slice(0, 10).forEach(c => {
    const row = document.createElement("div");
    row.className = "combined-candidate";
    const widthPct = Math.max(0, Math.min(100, ((c.relScore + 20) / 20) * 100));
    row.innerHTML = `
      <div class="combined-score-row">
        <span class="species-name-wrap">${speciesLabelHtml(c.name)}</span>
        <span>${c.relScore.toFixed(1)}</span>
      </div>
      <div class="combined-bar-track">
        <div class="combined-bar" style="width: ${widthPct}%"></div>
      </div>
    `;
    poolScores.appendChild(row);
  });

  // Contribution Table
  contribTable.innerHTML = "";
  const sumW = weights.reduce((a, b) => a + b, 0) || 1e-6;
  included.forEach((p, idx) => {
    const tr = document.createElement("tr");
    const share = ((weights[idx] / sumW) * 100).toFixed(1);
    tr.innerHTML = `<td>${escapeHtml(p.name)}</td><td style="text-align:right">${share}%</td>`;
    contribTable.appendChild(tr);
  });
}

// ---- Results Table & CSV Export ----
function renderResultsTable() {
  const tbody = document.getElementById("results-table").querySelector("tbody");
  tbody.innerHTML = "";
  document.getElementById("table-summary").textContent = `Processed ${previews.length} images.`;

  previews.forEach(p => {
    const tr = document.createElement("tr");
    // Every row is five cells wide, whatever state its photo is in. A pending
    // or failed row leaves the four unknown cells empty rather than filling
    // them with a word: a colspan here changed the table's column widths, and
    // the replaced text changed the row's height, so the row below it moved
    // twice over as each photo finished. The photo's own state is already
    // visible as its tile and its entry in the score panel; a third copy of it
    // in this table was the layout cost of saying it again.
    if (p.pending || p.error) {
      tr.className = "row-pending";
      tr.innerHTML = `
        <td title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</td>
        <td></td>
        <td></td>
        <td></td>
        <td></td>
      `;
      tbody.appendChild(tr);
      return;
    }
    const sortedComp = Object.entries(p.scores).sort((a, b) => b[1] - a[1]);
    const topComp = sortedComp[0] || ["-", 0];
    const sortedSpec = Object.entries(p.detail).sort((a, b) => b[1] - a[1]);
    const topSpec = sortedSpec[0] || ["-", 0];

    tr.innerHTML = `
      <td title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</td>
      <td title="${escapeHtml(topComp[0])}">${escapeHtml(topComp[0])}</td>
      <td style="text-align:right">${(topComp[1] * 100).toFixed(1)}%</td>
      <td title="${escapeHtml(topSpec[0])}">${escapeHtml(topSpec[0])}</td>
      <td style="text-align:right">${(topSpec[1] * 100).toFixed(1)}%</td>
    `;
    tbody.appendChild(tr);
  });
}

function downloadCSV() {
  if (!previews.length) return;
  sendLog("download_csv");
  let csv = "Filename,Status,Cropped,Top Complex,Complex Score (%),Top Species,Species Score (%)\n";
  previews.forEach(p => {
    if (p.pending || p.error) {
      // Exporting the previous crop's numbers under the new crop's name would be
      // a wrong result, not a stale one.
      csv += `"${p.name}","${(p.error || "classifying").replace(/"/g, "'")}",${p.is_cropped},"-","-","-","-"\n`;
      return;
    }
    const sortedComp = Object.entries(p.scores).sort((a, b) => b[1] - a[1]);
    const topComp = sortedComp[0] || ["-", 0];
    const sortedSpec = Object.entries(p.detail).sort((a, b) => b[1] - a[1]);
    const topSpec = sortedSpec[0] || ["-", 0];
    csv += `"${p.name}","${p.status}",${p.is_cropped},"${topComp[0]}",${(topComp[1] * 100).toFixed(1)},"${topSpec[0]}",${(topSpec[1] * 100).toFixed(1)}\n`;
  });

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mosquito_identification_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Sample Photos Loader
async function loadSamplePhotos() {
  sendLog("sample_photos_clicked");
  const sampleNames = [
    "IMG-20261002-WA0007.jpeg",
    "PXL_20261002_182523087.jpg",
    "PXL_20261002_182614990.jpg",
    "PXL_20261002_182628741.jpg",
    "PXL_20261002_182632161.jpg",
    "PXL_20261002_182639488.jpg",
    "PXL_20261002_182720758.jpg",
    "PXL_20261002_182737596.jpg",
    "PXL_20261002_182741226.jpg",
    "PXL_20261002_182754446.jpg"
  ];
  const files = [];
  for (const name of sampleNames) {
    try {
      const resp = await fetch(`samples/${name}`);
      if (resp.ok) {
        const blob = await resp.blob();
        files.push(new File([blob], name, { type: blob.type || "image/jpeg" }));
      }
    } catch (e) {
      console.warn("Could not fetch sample:", name, e);
    }
  }
  if (files.length) {
    processFiles(files);
  }
}

// One species label, used everywhere a species is named.
//
// This existed as two divergent copies: the per-photo score list rendered the
// guide link and the common name, the pooled card rendered a bare <strong> of
// the binomial - so the same species read differently depending on which panel
// it appeared in. Anything added to a species label from here on (a vector
// status, a thumbnail, a range note) has to be added once.
//
// The guide link is a hash route of this same document, so following it and
// coming back preserves the photo, the crop and the scores instead of re-running
// the model.
function speciesLabelHtml(name) {
  const meta = SPECIES_META[name];
  const wikiLink = meta?.wiki
    ? `<a href="${meta.wiki}" target="_blank" rel="noopener" class="species-wiki" title="Wikipedia">\u{1F517}</a>`
    : "";
  const nameHtml = meta
    ? `<a class="species-kb-link" href="#/species/${encodeURIComponent(speciesSlug(name))}">${escapeHtml(name)}</a>`
    : `<span>${escapeHtml(name)}</span>`;
  const common = meta?.common ? ` <span class="species-common">(${escapeHtml(meta.common)})</span>` : "";
  return `${wikiLink}${nameHtml}${common}`;
}

function speciesSlug(name) {
  return name.toLowerCase().replace(/\s+/g, "-");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[s]));
}

// ---- Router ----
//
// Hash routes, not history.pushState with clean paths. The site is deployed at
// /mosquito-id/ as plain static files on GitHub Pages, with no rewrite rules:
// a clean path such as /mosquito-id/species/aedes-albopictus is a 404 on
// refresh and for anyone the link is shared with, because Pages looks for a
// file of that name. Everything the router needs is after the '#', which the
// server never sees, so deep links and reloads work with no server config.
//
// The classifier's DOM is never rebuilt, only hidden. That is the whole of the
// state preservation: previews[], selectedIndex, the crop boxes, the rendered
// scores and the loaded ONNX sessions all keep living in memory and in the
// document across a navigation, so nothing has to be serialised or restored.

const CLASSIFIER_TITLE = document.title;

function parseRoute() {
  const hash = location.hash.replace(/^#/, "");
  const m = hash.match(/^\/species(?:\/(.*))?$/);
  if (!m) return { view: "classifier" };
  return { view: "species", slug: m[1] ? decodeURIComponent(m[1]) : "" };
}

function showClassifier() {
  document.querySelector(".app-container").classList.remove("route-off");
  document.getElementById("kb-view").classList.add("route-off");
  document.title = CLASSIFIER_TITLE;
}

function applyRoute() {
  const route = parseRoute();
  if (route.view === "classifier") {
    showClassifier();
    return;
  }
  const app = document.querySelector(".app-container");
  const kb = document.getElementById("kb-view");
  app.classList.add("route-off");
  kb.classList.remove("route-off");
  window.scrollTo(0, 0);
  // species.js fetches species-data.json once and caches the promise, so
  // repeated navigations cost nothing beyond the render.
  window.SpeciesPage.render(route.slug, document.getElementById("kb-body"));
}

// ---- Initialization & Event Listeners ----
window.addEventListener("DOMContentLoaded", () => {
  setupCropSurfaces();
  wireStripActions();

  window.addEventListener("hashchange", applyRoute);
  applyRoute();

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");

  dropzone.onclick = () => fileInput.click();
  fileInput.onchange = (e) => {
    if (e.target.files?.length) processFiles(Array.from(e.target.files));
  };

  // Phone camera capture. `capture` makes iOS/Android open the camera directly,
  // with no permission prompt and no getUserMedia stream to manage, and the
  // chosen photo arrives as an ordinary File - so it reuses processFiles() and
  // the rest of the pipeline unchanged. Without `capture` the same input would
  // offer the photo library instead, which is the wrong primary path here.
  const cameraInput = document.getElementById("camera-input");
  const btnCamera = document.getElementById("btn-camera");
  if (cameraInput && btnCamera) {
    // The input lives inside #dropzone, and a programmatic .click() bubbles -
    // without this the dropzone handler would open the file browser as well.
    cameraInput.addEventListener("click", (e) => e.stopPropagation());
    btnCamera.onclick = () => cameraInput.click();
    cameraInput.onchange = (e) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // let the same photo be taken again
      if (!file) return;
      const name = file.name || `camera-${Date.now()}.jpg`;
      sendLog("camera_capture", { name, type: file.type, bytes: file.size });
      processFiles([new File([file], name, { type: file.type || "image/jpeg" })]);
    };
  }

  dropzone.ondragover = (e) => { e.preventDefault(); dropzone.classList.add("dragover"); };
  dropzone.ondragleave = () => dropzone.classList.remove("dragover");
  dropzone.ondrop = (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer.files?.length) processFiles(Array.from(e.dataTransfer.files));
  };

  // Clipboard Paste (⌘V / Ctrl+V)
  document.addEventListener("paste", (e) => {
    const target = e.target;
    if (target instanceof Element && target.closest("input, textarea, [contenteditable=true]")) return;
    const images = Array.from(e.clipboardData?.items || [])
      .filter(item => item.kind === "file" && item.type.startsWith("image/"))
      .map(item => item.getAsFile()).filter(Boolean);
    if (images.length) {
      e.preventDefault();
      const files = images.map((img, i) => new File([img], `clipboard-${Date.now()}-${i + 1}.${img.type.split("/")[1] || "jpg"}`, { type: img.type }));
      processFiles(files);
    }
  });

  // Buttons & Controls
  document.getElementById("btn-samples").onclick = loadSamplePhotos;
  document.getElementById("btn-prev").onclick = () => selectPhoto(selectedIndex - 1);
  document.getElementById("btn-next").onclick = () => selectPhoto(selectedIndex + 1);
  document.getElementById("btn-csv").onclick = downloadCSV;

  const savedPooling = localStorage.getItem("mosquito_pooling");
  if (savedPooling) {
    const radio = document.querySelector(`input[name="pooling-method"][value="${savedPooling}"]`);
    if (radio) radio.checked = true;
  }
  document.querySelectorAll('input[name="pooling-method"]').forEach(r => {
    r.onchange = (e) => {
      localStorage.setItem("mosquito_pooling", e.target.value);
      updatePooling();
    };
  });

  const corrSlider = document.getElementById("corr-slider");
  const savedCorr = localStorage.getItem("mosquito_corr");
  if (savedCorr && corrSlider) {
    corrSlider.value = savedCorr;
    document.getElementById("corr-val").textContent = parseFloat(savedCorr).toFixed(2);
  }
  corrSlider.oninput = (e) => {
    localStorage.setItem("mosquito_corr", e.target.value);
    document.getElementById("corr-val").textContent = parseFloat(e.target.value).toFixed(2);
    updatePooling();
  };

  // Arrow Key Navigation
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      selectPhoto(selectedIndex + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      selectPhoto(selectedIndex - 1);
    }
  });

  // Init Engine
  initEngine().catch(err => {
    console.error("Engine initialization error:", err);
    document.getElementById("load-msg").textContent = `Error: ${err.message}`;
  });
});
