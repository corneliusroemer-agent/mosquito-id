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

// Models live on HuggingFace. GitHub Releases are not an option: they serve no
// Access-Control-Allow-Origin, so a browser cannot fetch them cross-origin.
// Cloudflare R2 is the intended final host (CORS-configurable, free egress);
// this HF Space is the interim one. It holds 3 of the 4 models - a free HF
// account caps at 1 GB per repository and bioclip_2_5_fp16.onnx is 1207 MB,
// so that one only loads once R2 is live.
const MODEL_BASE_URL =
  "https://huggingface.co/spaces/corneliusroemer-agent/mosquito-id/resolve/main/models/";
const FP16_AVAILABLE = false;

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
let cropVersion = 0; // For async crop cancellation

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
  const defaultEngine = "webgpu-int8";
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

function softmaxJoint(emb) {
  const S = EMB.species.length;
  const N = EMB.nuisance.length;
  const D = EMB.dim;
  const scale = EMB.logit_scale;
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

// The context canvas is painted with object-fit:cover, so a fraction of the
// zoomed surface is only the same fraction of the image when the two aspects
// match. Return the affine map surfaceFraction -> imageFraction for the photo
// currently shown, so the crop-box overlay and the fine-tune drag agree with
// what is on screen (and are the identity in the normal, matching-aspect case).
function zoomedSurfaceMapping() {
  const identity = { k: 1, off: 0 };
  const p = previews[selectedIndex];
  const surface = document.getElementById("crop-surface-zoomed");
  if (!p?.contextCanvas || !surface) return identity;
  const b = surface.getBoundingClientRect();
  if (b.width <= 0 || b.height <= 0) return identity;
  const boxAspect = b.width / b.height;
  const imgAspect = p.contextCanvas.width / p.contextCanvas.height;
  if (!imgAspect) return identity;
  const k = Math.min(boxAspect / imgAspect, imgAspect / boxAspect);
  return { k, off: (1 - k) / 2 };
}

// Aspect ratio (w/h) of the zoomed panel's container, i.e. the box the context
// canvas is displayed in. The container lives inside #gallery-section, which is
// display:none until the first photo has been classified, so on the very first
// photo its clientWidth/clientHeight both read 0 and any aspect measured from it
// is the 1/0 fallback. Measure against real layout instead: give the gallery
// layout for one synchronous read, then restore it. Both style writes land in
// the same frame, so the hidden gallery is never painted.
let cachedViewerAspect = null;

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
  let emb = await clipEmbed(cropCv);
  let { spP, nuP, spCos, logits } = softmaxJoint(emb);

  let fallback = false;
  if (best && Math.max(...spP) < Math.max(...nuP)) {
    cropCv = fullCv;
    cropBox = null;
    emb = await clipEmbed(cropCv);
    const retry = softmaxJoint(emb);
    spP = retry.spP;
    nuP = retry.nuP;
    spCos = retry.spCos;
    logits = retry.logits;
    best = null;
    fallback = true;
  }
  const clipTime = Math.round(performance.now() - tClip0);
  const totalTime = Math.round(performance.now() - t0);

  const { labels, demoted } = complexScores(spP, spCos);
  const detail = {};
  EMB.species.forEach((name, i) => { detail[name] = spP[i]; });

  const status = best
    ? `detector: ${dets.length} box(es), best ${best.conf.toFixed(2)}`
    : `full photo fallback${fallback ? " (nuisance gate triggered)" : ""}`;

  const is_cropped = Boolean(best && !fallback);
  const { contextCanvas, contextBox } = extractContextCrop(fullCv, cropBox);

  const epLabel = clipEP === "webgpu" ? "WEBGPU" : "WASM CPU";
  const devText = `inference: ${WEBGPU_MODELS[currentEngine]?.name || "WebGPU"} (${epLabel}) · ${totalTime}ms/photo (crop: ${detTime}ms · analyze: ${clipTime}ms)`;
  const devElem = document.getElementById("footer-device");
  if (devElem) devElem.textContent = devText;

  return {
    name: filename,
    fullCanvas: fullCv,
    cropCanvas: cropCv,
    contextCanvas,
    cropBox,
    contextBox,
    scores: labels,
    detail,
    logits,
    status,
    fallback,
    is_cropped,
    demoted,
    fingerprint: `${cropCv.width}x${cropCv.height}-${fullCv.width}x${fullCv.height}`,
    manual_full_photo: !best,
    detTime,
    clipTime,
    totalTime
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

  const newPreviews = [];
  for (let i = 0; i < imageFiles.length; i++) {
    if (isBatchAborted) {
      sendLog("batch_aborted", { processed: i, total: imageFiles.length });
      break;
    }
    const file = imageFiles[i];
    const engineLabel = currentEngine === "server-gpu" ? `Server (${serverEngineLabel})` : "WebGPU";
    progressText.textContent = `Analyzing ${i + 1} of ${imageFiles.length} photos on ${engineLabel} (${file.name})…`;
    progressFill.style.width = `${((i + 1) / imageFiles.length) * 100}%`;

    if (currentEngine === "server-gpu") {
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/predict", { method: "POST", body: formData });
        if (!res.ok) throw new Error("Server inference error " + res.status);
        const data = await res.json();
        const fullCv = await dataUrlToCanvas(data.fullDataUrl);
        const cropCv = await dataUrlToCanvas(data.cropDataUrl);
        const contextCv = await dataUrlToCanvas(data.contextDataUrl);

        newPreviews.push({
          name: data.filename,
          fullCanvas: fullCv,
          cropCanvas: cropCv,
          contextCanvas: contextCv,
          cropBox: data.cropBox,
          contextBox: data.contextBox,
          scores: data.labels,
          detail: data.detail,
          logits: data.logits,
          status: data.status,
          fallback: data.fallback,
          is_cropped: data.is_cropped,
          demoted: Boolean(Object.keys(data.labels)[0]?.includes("low confidence")),
          fingerprint: `${cropCv.width}x${cropCv.height}-${fullCv.width}x${fullCv.height}`,
          manual_full_photo: !data.is_cropped,
          detTime: data.detTime,
          clipTime: data.clipTime,
          totalTime: data.totalTime
        });

        const devElem = document.getElementById("footer-device");
        if (devElem) {
          devElem.textContent = `inference: ${data.engine_label} · ${data.totalTime}ms/photo (crop: ${data.detTime}ms · analyze: ${data.clipTime}ms)`;
        }
      } catch (err) {
        console.error("Error processing on server", file.name, err);
      }
    } else {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        const res = await classifyImage(bitmap, file.name);
        newPreviews.push(res);
      } catch (err) {
        console.error("Error processing locally", file.name, err);
      }
    }
  }

  progressWrap.style.display = "none";
  isProcessingBatch = false;

  // Prepend new photos (stack behavior). Keep unselected by default.
  const offset = newPreviews.length;
  const updatedIncluded = new Set();
  for (const i of includedIndices) {
    updatedIncluded.add(i + offset);
  }
  includedIndices = updatedIncluded;
  previews = [...newPreviews, ...previews];
  selectedIndex = 0;

  document.getElementById("gallery-section").style.display = "block";
  document.getElementById("results-table-section").style.display = "block";

  renderThumbnails();
  renderActivePhoto();
  updatePooling();
  renderResultsTable();
  sendLog("process_files_completed", { added: newPreviews.length, total: previews.length });
}

function deletePhoto(idx) {
  if (idx < 0 || idx >= previews.length) return;
  const deletedName = previews[idx].name;
  sendLog("delete_photo", { idx, name: deletedName });
  previews.splice(idx, 1);
  const updated = new Set();
  for (const i of includedIndices) {
    if (i < idx) updated.add(i);
    else if (i > idx) updated.add(i - 1);
  }
  includedIndices = updated;
  if (selectedIndex >= previews.length) {
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
function renderThumbnails() {
  const strip = document.getElementById("thumbnail-strip");
  strip.innerHTML = "";
  document.getElementById("gallery-counter").textContent = `${selectedIndex + 1} / ${previews.length}`;

  previews.forEach((p, idx) => {
    const tile = document.createElement("div");
    tile.className = "tile" + (selectedIndex === idx ? " active" : "") + (!includedIndices.has(idx) ? " excluded" : "");

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
    img.src = (p.cropCanvas || p.fullCanvas).toDataURL("image/jpeg", 0.8);
    img.alt = p.name;
    btn.appendChild(img);

    const num = document.createElement("span");
    num.className = "number";
    num.textContent = `${idx + 1}`;
    btn.appendChild(num);

    const badge = document.createElement("span");
    badge.className = "crop-badge" + (p.is_cropped ? " cropped" : "");
    badge.textContent = p.is_cropped ? "✓" : "✕";
    badge.title = p.is_cropped ? "Mosquito detected & cropped" : "Uncropped / no mosquito detected";
    btn.appendChild(badge);

    tile.appendChild(btn);

    const label = document.createElement("label");
    label.className = "include";
    label.title = !p.fallback ? "Include this photo in pooled result" : "No usable mosquito detection";

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.className = "thumb-optin";
    chk.checked = includedIndices.has(idx);
    chk.disabled = p.fallback;
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

function fitSurface(surface, cv) {
  if (!surface || !cv || !cv.width || !cv.height) return;
  const maxH = 320;
  const aspect = cv.width / cv.height;
  const targetH = maxH;
  const targetW = Math.round(maxH * aspect);
  surface.style.height = `${targetH}px`;
  surface.style.width = `${targetW}px`;
  surface.style.maxWidth = "100%";
}

function renderActivePhoto() {
  if (!previews.length || !previews[selectedIndex]) return;
  const p = previews[selectedIndex];

  // 1. Render Left Panel (Full Photo)
  const surfaceFull = document.getElementById("crop-surface-full");
  fitSurface(surfaceFull, p.fullCanvas);
  const fullImg = document.getElementById("full-img");
  fullImg.src = p.fullCanvas.toDataURL("image/jpeg", 0.9);

  // Active crop outline on full photo (for both manual and automatic crops!)
  const fullActiveBox = document.getElementById("full-active-crop-box");
  if (fullActiveBox) {
    if (p.cropBox && !p.fallback && !p.manual_full_photo) {
      const [bx1, by1, bx2, by2] = p.cropBox;
      const l = (bx1 / p.fullCanvas.width) * 100;
      const t = (by1 / p.fullCanvas.height) * 100;
      const w = ((bx2 - bx1) / p.fullCanvas.width) * 100;
      const h = ((by2 - by1) / p.fullCanvas.height) * 100;
      fullActiveBox.style.left = `${l}%`;
      fullActiveBox.style.top = `${t}%`;
      fullActiveBox.style.width = `${w}%`;
      fullActiveBox.style.height = `${h}%`;
      fullActiveBox.style.display = "block";
    } else {
      fullActiveBox.style.display = "none";
    }
  }

  // 2. Render Center Panel (Zoomed View with extra context)
  const surfaceZoomed = document.getElementById("crop-surface-zoomed");
  const contextImg = document.getElementById("context-img");
  const cropEmpty = document.getElementById("crop-empty");
  const zoomedActiveBox = document.getElementById("zoomed-active-crop-box");

  if (p.cropBox && !p.fallback && !p.manual_full_photo && p.contextCanvas) {
    surfaceZoomed.style.width = "100%";
    surfaceZoomed.style.height = "100%";
    contextImg.src = p.contextCanvas.toDataURL("image/jpeg", 0.9);
    contextImg.style.display = "block";
    contextImg.style.width = "100%";
    contextImg.style.height = "100%";
    contextImg.style.objectFit = "cover";
    cropEmpty.style.display = "none";

    // Draw where the crop sits within the context region
    if (zoomedActiveBox && p.contextBox) {
      const [cx1, cy1, cx2, cy2] = p.cropBox;
      const [ctx_x1, ctx_y1, ctx_x2, ctx_y2] = p.contextBox;
      const ctx_w = ctx_x2 - ctx_x1;
      const ctx_h = ctx_y2 - ctx_y1;
      // image fraction -> surface fraction, through the object-fit:cover window
      const { k, off } = zoomedSurfaceMapping();
      const toSurface = (f) => (f - off) / k;
      const l = toSurface((cx1 - ctx_x1) / ctx_w) * 100;
      const t = toSurface((cy1 - ctx_y1) / ctx_h) * 100;
      const w = (toSurface((cx2 - ctx_x1) / ctx_w) - l / 100) * 100;
      const h = (toSurface((cy2 - ctx_y1) / ctx_h) - t / 100) * 100;
      zoomedActiveBox.style.left = `${l}%`;
      zoomedActiveBox.style.top = `${t}%`;
      zoomedActiveBox.style.width = `${w}%`;
      zoomedActiveBox.style.height = `${h}%`;
      zoomedActiveBox.style.display = "block";
    }
  } else {
    contextImg.style.display = "none";
    cropEmpty.style.display = "block";
    cropEmpty.textContent = p.manual_full_photo ? "Using full photo" : "No mosquito detected";
    if (zoomedActiveBox) zoomedActiveBox.style.display = "none";
  }

  // 3. Render Right Panel (Scores)
  const scoreList = document.getElementById("score-list");
  scoreList.innerHTML = "";
  const sortedScores = Object.entries(p.detail).sort((a, b) => b[1] - a[1]);
  for (const [name, score] of sortedScores) {
    const item = document.createElement("div");
    item.className = "score-item";
    const percent = (score * 100).toFixed(1);
    const meta = SPECIES_META[name];
    const commonLabel = meta ? ` <span class="species-common">(${escapeHtml(meta.common)})</span>` : "";
    const vectorLabel = meta?.vectors ? `<span class="species-vectors">Vector: ${escapeHtml(meta.vectors)}</span>` : "";
    const wikiLink = meta?.wiki ? `<a href="${meta.wiki}" target="_blank" rel="noopener" class="species-wiki" title="Wikipedia">🔗</a>` : "";
    // Species name links out to the standalone KB page for that species.
    // Relative href so it survives the /mosquito-id/ subpath deployment.
    const speciesSlug = name.toLowerCase().replace(/\s+/g, "-");
    const kbLink = meta
      ? `<a class="species-kb-link" href="species.html?s=${encodeURIComponent(speciesSlug)}">${escapeHtml(name)}</a>`
      : `<span>${escapeHtml(name)}</span>`;
    item.innerHTML = `
      <div class="score-item-header">
        <span class="species-name-wrap">${wikiLink}${kbLink}${commonLabel}</span>
        <strong>${percent}%</strong>
      </div>
      ${vectorLabel}
      <div class="score-item-track">
        <div class="score-item-fill" style="width: ${Math.max(0, Math.min(100, score * 100))}%"></div>
      </div>
    `;
    scoreList.appendChild(item);
  }

  document.getElementById("photo-name").textContent = `${p.name} · ${p.status}`;
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

      if (target === "full") {
        await applyCropFromFullSurface(selectedIndex, rect);
      } else if (target === "zoomed") {
        await applyCropFromZoomedSurface(selectedIndex, rect);
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
async function applyCropFromFullSurface(idx, rect) {
  const p = previews[idx];
  const fullCv = p.fullCanvas;
  const x1 = Math.max(0, Math.min(fullCv.width, Math.round(rect[0] * fullCv.width)));
  const y1 = Math.max(0, Math.min(fullCv.height, Math.round(rect[1] * fullCv.height)));
  const x2 = Math.max(0, Math.min(fullCv.width, Math.round(rect[2] * fullCv.width)));
  const y2 = Math.max(0, Math.min(fullCv.height, Math.round(rect[3] * fullCv.height)));

  if (x2 - x1 < 10 || y2 - y1 < 10) return;

  sendLog("manual_crop", { target: "full", rect: [x1, y1, x2, y2] });
  await executeCrop(p, [x1, y1, x2, y2]);
}

// Execute Crop from Zoomed 50% Context surface (fine-tuning)
async function applyCropFromZoomedSurface(idx, rect) {
  const p = previews[idx];
  if (!p.contextBox) return;
  const [ctx_x1, ctx_y1, ctx_x2, ctx_y2] = p.contextBox;
  const ctx_w = ctx_x2 - ctx_x1;
  const ctx_h = ctx_y2 - ctx_y1;

  // Surface fractions -> image fractions, through the object-fit:cover window,
  // so a fine-tune drag lands where the user pointed even if the context canvas
  // and the surface no longer share an aspect (e.g. after a window resize).
  const { k, off } = zoomedSurfaceMapping();
  const r = rect.map((f, i) => k * f + off);

  const x1 = Math.max(0, Math.min(p.fullCanvas.width, Math.round(ctx_x1 + r[0] * ctx_w)));
  const y1 = Math.max(0, Math.min(p.fullCanvas.height, Math.round(ctx_y1 + r[1] * ctx_h)));
  const x2 = Math.max(0, Math.min(p.fullCanvas.width, Math.round(ctx_x1 + r[2] * ctx_w)));
  const y2 = Math.max(0, Math.min(p.fullCanvas.height, Math.round(ctx_y1 + r[3] * ctx_h)));

  if (x2 - x1 < 10 || y2 - y1 < 10) return;

  sendLog("manual_crop", { target: "zoomed", rect: [x1, y1, x2, y2] });
  await executeCrop(p, [x1, y1, x2, y2]);
}

// Core Crop Execution (handles Server and Local WebGPU)
async function executeCrop(p, cropBox) {
  const [bx1, by1, bx2, by2] = cropBox;
  const fullCv = p.fullCanvas;

  const cw = Math.max(1, bx2 - bx1);
  const ch = Math.max(1, by2 - by1);
  const cropCv = document.createElement("canvas");
  cropCv.width = cw;
  cropCv.height = ch;
  cropCv.getContext("2d").drawImage(fullCv, bx1, by1, cw, ch, 0, 0, cw, ch);

  if (currentEngine === "server-gpu") {
    try {
      const blob = await new Promise((r) => fullCv.toBlob(r, "image/jpeg", 0.85));
      const formData = new FormData();
      formData.append("file", blob, p.name);
      formData.append("crop_box", JSON.stringify(cropBox));
      const res = await fetch("/api/predict", { method: "POST", body: formData });
      if (res.ok) {
        const data = await res.json();
        p.cropCanvas = await dataUrlToCanvas(data.cropDataUrl);
        p.contextCanvas = await dataUrlToCanvas(data.contextDataUrl);
        p.cropBox = data.cropBox;
        p.contextBox = data.contextBox;
        p.scores = data.labels;
        p.detail = data.detail;
        p.logits = data.logits;
        p.status = data.status;
        p.is_cropped = true;
        p.demoted = Boolean(Object.keys(data.labels)[0]?.includes("low confidence"));
        p.manual_full_photo = false;
        p.fallback = false;
      }
    } catch (e) {
      console.error("Server crop error:", e);
    }
  } else {
    const emb = await clipEmbed(cropCv);
    const { spP, spCos, logits } = softmaxJoint(emb);
    const { labels, demoted } = complexScores(spP, spCos);

    const detail = {};
    EMB.species.forEach((name, i) => { detail[name] = spP[i]; });
    const { contextCanvas, contextBox } = extractContextCrop(fullCv, cropBox);

    p.cropCanvas = cropCv;
    p.contextCanvas = contextCanvas;
    p.cropBox = cropBox;
    p.contextBox = contextBox;
    p.scores = labels;
    p.detail = detail;
    p.logits = logits;
    p.status = `manual crop: ${cw}x${ch}px`;
    p.is_cropped = true;
    p.demoted = demoted;
    p.manual_full_photo = false;
    p.fallback = false;
  }

  sendLog("crop_executed", {
    engine: currentEngine,
    cropBox,
    cw,
    ch,
    topSpecies: Object.keys(p.scores)[0],
    topScore: Object.values(p.scores)[0]
  });

  const devElem = document.getElementById("footer-device");
  if (devElem) {
    if (currentEngine === "server-gpu") {
      devElem.textContent = `inference: ${serverEngineLabel} · manual crop updated`;
    } else {
      const epLabel = clipEP === "webgpu" ? "WEBGPU" : "WASM CPU";
      devElem.textContent = `inference: ${WEBGPU_MODELS[currentEngine]?.name || "WebGPU"} (${epLabel}) · manual crop updated`;
    }
  }

  renderThumbnails();
  renderActivePhoto();
  updatePooling();
  renderResultsTable();
}

async function revertToFullPhoto(idx) {
  const p = previews[idx];
  const fullCv = p.fullCanvas;
  sendLog("revert_to_full", { name: p.name });

  if (currentEngine === "server-gpu") {
    try {
      const blob = await new Promise((r) => fullCv.toBlob(r, "image/jpeg", 0.85));
      const formData = new FormData();
      formData.append("file", blob, p.name);
      formData.append("crop_box", JSON.stringify([0, 0, fullCv.width, fullCv.height]));
      const res = await fetch("/api/predict", { method: "POST", body: formData });
      if (res.ok) {
        const data = await res.json();
        p.cropCanvas = fullCv;
        p.contextCanvas = fullCv;
        p.cropBox = null;
        p.contextBox = [0, 0, fullCv.width, fullCv.height];
        p.scores = data.labels;
        p.detail = data.detail;
        p.logits = data.logits;
        p.status = "manual full photo";
        p.is_cropped = false;
        p.demoted = Boolean(Object.keys(data.labels)[0]?.includes("low confidence"));
        p.manual_full_photo = true;
      }
    } catch (e) {
      console.error("Server revertToFullPhoto error:", e);
    }
  } else {
    const emb = await clipEmbed(fullCv);
    const { spP, spCos, logits } = softmaxJoint(emb);
    const { labels, demoted } = complexScores(spP, spCos);

    const detail = {};
    EMB.species.forEach((name, i) => { detail[name] = spP[i]; });

    p.cropCanvas = fullCv;
    p.contextCanvas = fullCv;
    p.cropBox = null;
    p.contextBox = [0, 0, fullCv.width, fullCv.height];
    p.scores = labels;
    p.detail = detail;
    p.logits = logits;
    p.status = "manual full photo";
    p.is_cropped = false;
    p.demoted = demoted;
    p.manual_full_photo = true;
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

  const included = Array.from(includedIndices).map(i => previews[i]).filter(Boolean);
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
        <span><strong>${escapeHtml(c.complex)}</strong> <small style="color:var(--body-text-color-subdued);">(${escapeHtml(c.name)})</small></span>
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
    const sortedComp = Object.entries(p.scores).sort((a, b) => b[1] - a[1]);
    const topComp = sortedComp[0] || ["-", 0];
    const sortedSpec = Object.entries(p.detail).sort((a, b) => b[1] - a[1]);
    const topSpec = sortedSpec[0] || ["-", 0];

    tr.innerHTML = `
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(topComp[0])}</td>
      <td style="text-align:right">${(topComp[1] * 100).toFixed(1)}%</td>
      <td>${escapeHtml(topSpec[0])}</td>
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[s]));
}

// ---- Initialization & Event Listeners ----
window.addEventListener("DOMContentLoaded", () => {
  setupCropSurfaces();

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
