/**
 * mosquito-id unified: Complete client-side WebGPU & Cloud GPU application.
 * Dual-stage cropping (rough + fine-grained), CacheStorage persistence, and telemetry.
 */
"use strict";

/*
 * The app shell. Everything the classifier's arithmetic needs now lives in
 * src/confidence/ as tested modules; what is left here is the DOM, the model
 * plumbing and the worker boundary, none of which is unit-testable.
 *
 * The adapters below re-bind those modules to this file's EMB, so the call sites
 * below keep their existing one-argument shape. EMB is still assigned in one
 * place (model loading), and because every adapter reads it at CALL time rather
 * than binding it, a reloaded embeddings file is picked up.
 */
import { localViewScale as _localViewScale, serverViewScale as _serverViewScale,
         DEFAULT_FLOORS } from "../confidence/types";
import { adjacentNames as _adjacentNames, softmaxJoint } from "../confidence/softmax";
import { genusScores as _genusScores } from "../confidence/genusScores";
import { fuseViews as _fuseViews } from "../confidence/fuseViews";
import { genusOf, speciesGenusIndex } from "../confidence/genus";
import { verdictFrom as _verdictFrom, verdictSentence } from "../confidence/verdict";
import { pooledPosterior as _pooledPosterior,
         splitPoolable, poolingWeights, aggregateLogits, aggregateAdjacent,
         pooledCandidates, pooledVerdict as _pooledVerdictOf } from "../confidence/pooling";
import { escapeHtml, speciesLabelHtml } from "./speciesLabels";
import { CACHE_NAME, CLIP_MEAN, CLIP_SIZE, CLIP_STD, CROP_PAD, DET_CONF, DET_SIZE,
         FP16_AVAILABLE, NMS_IOU, TEMPERATURE, WEBGPU_MODELS, cosineOffsetsFor,
         resolveModelUrl } from "./modelConfig";
import { clearProgress, makeTransferProgress, setProgress, setProgressError } from "./progress";
import { createLogger } from "./telemetry";
import { canvasUrl, dataUrlToCanvas, setImgSrc } from "./canvasCache";
import { decodeDets, letterbox, selectDetection } from "./detector";
import { applyBox, cropBoxInFullSurface, cropBoxInZoomSurface, extractContextCrop,
         fitMapping, invalidateViewerAspectCache, zoomedSurfaceMapping } from "./cropGeometry";
import { downloadCSV, renderResultsTable } from "./resultsTable";
import { fetchWithCache } from "./modelFetch";
import { loadSamplePhotos, prefetchSamples } from "./samples";
import { initRouter } from "./router";
import { updatePooling } from "./poolingPanel";

// The floors moved to src/confidence/types.ts with their derivations. These four
// names are kept so the app reads the same as before, and nothing else reads
// them - a change to a floor is a change in exactly one file.
const SPECIES_CONFIDENCE_FLOOR = DEFAULT_FLOORS.species;
const GENUS_CONFIDENCE_FLOOR = DEFAULT_FLOORS.genus;
const NON_MOSQUITO_FLOOR = DEFAULT_FLOORS.nonMosquito;
const VIEW_DISAGREEMENT_VETOES_SPECIES = DEFAULT_FLOORS.viewDisagreementVetoesSpecies;

const localViewScale = () => _localViewScale(EMB);
const serverViewScale = () => _serverViewScale(EMB);
const adjacentNames = () => _adjacentNames(EMB);
const genusScores = (spP) => _genusScores(EMB, spP);
const fuseViews = (viewResults) => _fuseViews(EMB, viewResults);
const verdictFrom = (spP, agreement, adP) => _verdictFrom(EMB, spP, agreement, adP);
const pooledPosterior = (aggLogits) => _pooledPosterior(EMB, aggLogits);
const pooledVerdictOf = (aggLogits, included, aggAdjLogits) => _pooledVerdictOf(EMB, aggLogits, included, aggAdjLogits);


// ---- Confidence gating ----
//
// What the classifier will claim about a photo, and nothing below it: at
// SPECIES_CONFIDENCE_FLOOR and above it names a species; below that but with a
// genus whose summed posterior clears GENUS_CONFIDENCE_FLOOR it names the genus
// and the species it leaned toward; below both it says it is not confident. The
// per-species ranking is shown in every one of those states.
//
// Both floors are empirical, and both were fitted on the validation split of the
// 659-row corpus and read once on test
// (investigations/2026-10-03-rewrite/40-precision/40-calibration, extended for
// the genus floor by tmp/gate/genus_gate.py):
//
//   SPECIES_CONFIDENCE_FLOOR 0.373 - the 90%-coverage point. Answers 88% of test
//     images at 96.6% accuracy (95% CI 93.2-99.1) against the shipped argmax's
//     88.0% on the same rows.
//
//   GENUS_CONFIDENCE_FLOOR 0.80 - a genus is easier to get right than a species,
//     so the floor for naming one is higher. Refit on the 6,264-image cache: the
//     previous 0.54 was right on only 76% of the rows it answered, and the
//     failures were concentrated rather than diffuse - naming Anopheles on
//     Culiseta photos, 1 of 13 correct. At 0.80 (val-fitted, 100% bar, 28 val
//     rows) genus-only answers are 93% correct and whole-set accuracy rises
//     86.10% -> 87.16% for 5.3pp less coverage. The direction is solid; the
//     value is not sharply identified, since the bar choice moves it (a 95% bar
//     gives 0.766).
//
// THE VAL->TEST TRANSFER GAP IS NO LONGER BINDING. On the earlier 74-row cache a
// threshold picked on val at 5% FPR got 60.0% recall on test against an 86.0%
// oracle. On the 6,264-image cache the gap between a val-fitted threshold and the
// test oracle is at most 0.41pp across seven coverage levels. More labelled data
// closed it, which is what these constants were waiting for.

// Whether two views of one photo naming different species costs that photo its
// species claim.
//
// Both floors read one number - the FUSED posterior - and that is the right
// single view of a photo, but it is an average of two opinions. When the two
// disagree the average is of two contradictory things, and an average of a wrong
// answer and a different wrong answer is still wrong while carrying a
// plausible-looking number: the gate passes it and a species is named. Measured
// on the only labelled two-view cache there is (180 rows, the 07-benchmark's
// detector crop and whole frame, same H/14 head), split 60/20/20 by class group
// exactly as the floors above were (investigations/2026-10-03-mosquito-id/
// 35-view-disagreement.md):
//
//   views agree     genus correct 93.8% val / 95.2% test
//   views disagree  genus correct 63.6% val / 65.2% test
//
// and the species claims made on disagreeing rows are right 18.2% of the time on
// val, 33.3% on test - so the floor above is answering exactly the photos it was
// fitted to decline.
//
// The constant is BOOLEAN because that is what the data identifies. The obvious
// graded form - abstain only when a disagreement is also narrow in the fused
// margin - was fitted the same way and is not identified: accuracy on
// disagreeing rows is flat in marginPts across 1..30 points on val (62% to 64%),
// so the val optimum for "demote every disagreeing species claim" sits at the
// boundary of the grid rather than in it, which is a boundary-limited fit, not a
// result. Grading it would be inventing a number the corpus does not contain.
//
// So the rule is the whole of what was measured: a disagreement costs the
// species claim, and the genus floor then decides the rest on its own. That is
// not free abstention - coverage is unchanged, because a demoted photo still
// clears GENUS_CONFIDENCE_FLOOR on the rows that earned it - and it is not
// uniform hesitation, because photos whose views agree answer exactly as before.

// ---- "This is not a mosquito" ----
//
// The adjacent classes (biting midges, blackflies, hoverflies and the rest of
// the confusable Diptera) plus the eight nuisance classes are scored in the SAME
// softmax as the sixteen species, so the total posterior on everything that is
// not a mosquito is already on the same axis as a species posterior. That total
// is what this gate reads; it is not a second score derived from the first.
//
// CHOSEN FOR BEHAVIOUR, NOT FITTED. This is the honest description of the number
// and it matters more than the number. The evidence available when it was set:
//
//   - On the 6,264-row in-domain mosquito cache, the adjacent classes take more
//     mass than the best mosquito in 0.67% of rows, at ANY floor - a mosquito
//     photo misreads as a biting midge that often enough to be a real cost, and
//     this floor is what keeps most of those photos on the species side.
//   - The false-positive side could NOT be measured from that cache, because the
//     cache contains no non-mosquito images at all. The benchmark that would fit
//     this number is
//     investigations/2026-10-02-mosquito-id/36-adjacent-taxa.md (in-domain
//     background crops, detector-verified); it measures the FLY class only, and
//     it is not part of the shipped text embeddings, so it cannot be run by a
//     user.
//
// So this constant is a starting point chosen to make the reported defect go
// away without costing mosquitoes, and the two numbers above are the only things
// actually measured. What would fit it: a labelled set of real non-mosquito
// phone photos (plain paper, skin, fabric, a table, a wall, a hand, plus the
// ones with a small mosquito present) scored through this same path, which would
// give the missing half - the false-positive rate - and turn this into a
// measured threshold. Until then, treat a "not a mosquito" result as a
// well-founded guess and the FLOOR as a guess inside it.




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

// Bound here rather than at each call site: `currentEngine`, `serverAvailable`
// and the selection are all read at event time, so the logger takes them as
// thunks and stays correct across an engine switch mid-session.
const sendLog = createLogger({
  engine: () => currentEngine,
  photo: () => previews[selectedIndex]?.name || null,
  serverAvailable: () => serverAvailable
});

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
  set selectedIndex(v) { selectedIndex = v; },
  get includedIndices() { return includedIndices; },
  // Test seam. EMB is otherwise only assigned once a classifier session has been
  // built, so a layout test cannot reach the pooled card without downloading the
  // 1.26 GB model. Production never writes it.
  get embeds() { return EMB; },
  set embeds(v) { EMB = v; },
  // The verdict functions are already bound to this file's EMB by the adapters
  // above, so a test can drive a layout case with the SHIPPED arithmetic rather
  // than re-reading the bundle and eval-ing it out - which is what this seam's
  // predecessor did, and what made it break the moment the source was bundled.
  verdictFrom,
  verdictSentence,
  selectPhoto,
  processFiles,
  deletePhoto,
  // The render entry points, so a probe can time and inspect a render with the
  // same functions the app calls rather than a re-implementation of them. These
  // are the functions the encode cache exists for, so a probe that did not call
  // them would not be measuring it.
  renderThumbnails,
  renderActivePhoto,
  updatePooling: () => updatePooling(EMB, previews, includedIndices),
  renderResultsTable: () => renderResultsTable(previews)
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
  // The adjacent posteriors, index-aligned with EMB.adjacent, so the pooled card
  // can carry the pool's non-mosquito evidence through its own softmax. Absent
  // where the scoring path reports none - the server path has no adjacent
  // classes - and then the pool has no non-mosquito evidence to speak of.
  p.adP = r.adP || null;
  // A verdict that claims nothing must not keep the one it had: pooling reads it.
  p.verdict = r.verdict || null;
  // The per-class non-mosquito posteriors, for the score panel to name the winner
  // from. Cleared with the verdict so a stale one cannot outlive the claim.
  p.adjacentDetail = r.adjacentDetail || null;
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







const embedsCache = {};

async function loadWebGPUModels(engineKey = "webgpu-fp16") {
  window.modelsReady = false;
  setProgress("model", "Initializing engine…", null);

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
    setProgress("model", "Loading detector (YOLO11n)…", 0);
    const detPath = resolveModelUrl("yolo11n-mosquito-det-640.onnx");
    const detBuf = await fetchWithCache(detPath, makeTransferProgress("Detector (YOLO11n)"), sendLog);
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
    setProgress("model", `Loading ${clipCfg.name}…`, 0);
    const buf = await fetchWithCache(resolveModelUrl(clipCfg.path), makeTransferProgress(clipCfg.name), sendLog);

    let sess = null;
    let ep = "wasm";
    setProgress("model", `Preparing ${clipCfg.name}…`, null);
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
    setProgress("model", "Loading species embeddings…", null);
    const r = await fetch(targetEmbedsPath);
    const data = await r.json();
    for (const k of ["species_emb", "nuisance_emb"]) {
      data[k] = Float32Array.from(data[k]);
    }
    embedsCache[targetEmbedsPath] = data;
  }
  EMB = embedsCache[targetEmbedsPath];

  const deviceLabel = `inference: ${clipCfg.name} (${clipEP.toUpperCase()}) · YOLO11n (${detEP.toUpperCase()})`;
  document.getElementById("footer-device").textContent = deviceLabel;
  clearProgress("model");
  window.modelsReady = true;
  sendLog("webgpu_models_ready", { engine: engineKey, clipEP, detEP });
  // Photos dropped while this download was running start now.
  drainQueuedBatches();
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
//
// H/14 is the default, and it is the default because culico's head cannot yet be
// made to serve this app: its species argmax sits at 22% because the ten species
// the corpus never labels carry the GENUS weight row, so on a correctly-identified
// Aedes photo those three rows outscore the species probe. Pinning them instead
// lifts species to 71% but drops genus from 83% to 57%, and the app's default
// read is a genus, so the honest position is that the head needs fitting that
// treats a genus-only label as evidence about the genus rather than copying it
// into every species column. That is analysis, not a UI default.
//
// INT8 is never the default: onnxruntime-web has no int8 WebGPU kernels, so the
// session silently falls back to WASM CPU and runs an order of magnitude slower.
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
  applyEngineNotices(chosenEngine);
  if (engineSelect) {
    engineSelect.value = chosenEngine;
    engineSelect.addEventListener("change", async (e) => {
      const chosen = e.target.value;
      localStorage.setItem("mosquito_engine", chosen);
      sendLog("engine_switched", { from: currentEngine, to: chosen });
      applyEngineNotices(chosen);
      if (chosen === "server-gpu") {
        currentEngine = "server-gpu";
        clearProgress("model");
        if (footerDevice) {
          footerDevice.textContent = `inference: ${serverEngineLabel} · YOLO11n & BioCLIP 2.5 H/14 (Instant)`;
        }
        window.modelsReady = true;
        drainQueuedBatches();
      } else {
        currentEngine = chosen;
        if (footerDevice) {
          footerDevice.textContent = `inference: ${WEBGPU_MODELS[chosen]?.name || "WebGPU"}`;
        }
        await loadWebGPUModels(chosen);
      }
    });
  }

  if (chosenEngine === "server-gpu" && serverAvailable) {
    clearProgress("model");
    if (footerDevice) {
      footerDevice.textContent = `inference: ${serverEngineLabel} · YOLO11n & BioCLIP 2.5 H/14 (Instant)`;
    }
    window.modelsReady = true;
    sendLog("engine_init", { mode: "server", label: serverEngineLabel });
    drainQueuedBatches();
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

/**
 * Name the classifier that is actually running, under the title.
 *
 * It used to also render a per-model caveat line here. That is gone: it was a
 * block above the content whose visibility moved with the model, which cost 0.27
 * of Cumulative Layout Shift on desktop before the line was given a reserved box,
 * and a permanent header paragraph about one engine's limitations is not worth a
 * reserved box. The engine is labelled "experimental" in the dropdown instead,
 * which is where someone chooses it and therefore the only place the label has to
 * be seen.
 */
function applyEngineNotices(engineKey) {
  const cfg = WEBGPU_MODELS[engineKey];
  const sub = document.getElementById("pipeline-sub");
  if (sub) {
    sub.textContent =
      engineKey === "server-gpu"
        ? "Cascade: YOLO11n crop → BioCLIP 2.5 H/14 analysis (server)"
        : `Cascade: YOLO11n crop → ${cfg?.name || "classifier"} analysis`;
  }
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
  const e = pickEmbedding(res).data;
  // L2-normalise the feature coordinates only. The last one is a constant `1.0`
  // appended to the model's output to carry the probe's bias term, and dividing
  // it by the feature norm shrinks it by that same factor (~40x here), which
  // throws away most of the bias.
  const feats = EMB ? EMB.dim : e.length;
  let norm = 0;
  for (let i = 0; i < feats && i < e.length; i++) norm += e[i] * e[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < feats && i < e.length; i++) e[i] /= norm;
  return e;
}

/**
 * Which of a model's outputs is the embedding.
 *
 * Selected by width, checked against the head's dimension, then by name - never
 * by position. `Object.keys()` sorts integer-like keys ahead of string keys, so
 * a graph whose outputs are `1747` and `culico_embedding` yields `1747` first
 * regardless of the order the graph declares them in. Reading positionally would
 * hand an 18-element probe-logit vector to a softmax whose rows are 1153 wide,
 * every product past index 17 becomes `undefined * number` = NaN, and the
 * non-finite guard in `verdictFrom` returns "not confident" for every photo.
 * H/14 and B/16 have a single output, which is why this only ever bit culico.
 */
function pickEmbedding(res) {
  const want = EMB ? EMB.dim : null;
  const keys = Object.keys(res);
  if (want) {
    for (const k of keys) {
      const t = res[k];
      if (t && t.dims && t.dims.length === 2 && t.dims[1] === want) return t;
    }
  }
  for (const k of keys) {
    if (/embedding|embed/i.test(k) && res[k]?.data) return res[k];
  }
  throw new Error(
    `No embedding among the model's outputs (${keys.join(", ")}); none is ${want} wide. ` +
    `The app reads features, not classifier logits.`
  );
}

// Temperature 2.5, applied by dividing the logit scale. Measured on the 112-image
// Mosquito Alert benchmark: as shipped (T=1) the softmax reports 0.940 mean
// confidence against 0.848 true accuracy — overconfident by ~9 points. T=2.5
// cuts NLL by a third and roughly halves ECE, and leaves top-1 unchanged
// because it is monotone, so this buys honesty rather than accuracy.
//

// The scale each path turns a cosine into a logit at. Local scoring applies the
// temperature; the server does not, so its posteriors are on a different scale
// and pooling one of each would be arithmetic on incomparable numbers.
//
// Both views of a photo always come from the same path, so this cannot mismatch
// within a fusion in practice - but the scale is attached to each view when it
// is scored rather than read from the current engine at fuse time, because the
// engine can be switched while a photo's second view is still in flight, and
// the fused result must describe the views that actually produced it.
// Group the species posteriors by genus - the first whitespace-delimited word of
// the label - and report the summed posterior per genus.
//
// The split is on whitespace, not on the second word, because the label set
// carries compound names ("Culiseta annulata/morsitans",
// "Aedes japonicus/koreicus") where the slash joins two epithets inside one
// genus. Splitting anywhere else would put half of Culiseta under Culiseta and
// half under "annulata/morsitans".
//
// This replaced a species-complex grouping, which reported the same number twice
// whenever a complex held a single species - the common case, since most of the
// label set is one species per complex - and offered no column that said
// anything the species column did not.
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
// ---- Genus, and the three-state verdict ----
//
// The genus is the first word of the species name, and nothing else. It has to
// come from EMB.species rather than a hardcoded list so that adding a species
// cannot leave the gate reasoning about a genus that no longer exists, and so
// that a name carrying a compound epithet - "Culiseta annulata/morsitans",
// "Anopheles maculipennis complex" - stays inside its genus. Splitting on
// whitespace first and only then taking the remainder handles that: the epithet
// keeps its slash and its "complex", and neither is mistaken for a genus.
// What the classifier will claim about one photo, from a single posterior.
//
// `spP` is the FUSED species posterior - never a single view's. Gating per view
// would abstain far more often than the photo deserves, because fusion is what
// turns two undecided views into a decided one, and it would make the two views
// disagree about the same photo's verdict.
//
// `agreement` is viewAgreement()'s object for those same views, or null where
// there are no two views to disagree (a pool of photos is one claim, not a
// photo). It carries no posterior of its own: it only says whether the two views
// that produced `spP` named the same species. See
// VIEW_DISAGREEMENT_VETOES_SPECIES for what that is worth - without it the gate
// reads a fused posterior alone, which cannot see that the average it is reading
// is an average of a contradiction.
//
// The genus posterior is its species' posteriors summed, so it is larger than any
// single species posterior by construction: that is why it clears a higher floor
// rather than the same one.
//
// Returns null-ish fields rather than throwing on an empty posterior, so a
// malformed score array degrades to "not confident" instead of taking the page
// down.
// The species posterior a set of aggregated logits describes, or null if the
// aggregate carries no usable signal.
//
// The aggregated logits ARE log-probabilities up to a per-photo constant (a
// photo's logits are scale*cos, and log p = scale*cos - logZ), so a softmax over
// their weighted sum is the pooled posterior. Max-subtracted for overflow: raw
// logits run to hundreds and exp() of that is Infinity on every species, which
// would silently turn the whole pool into NaN.
// The sentence the score panel leads with. It is a claim about the photograph,
// never about our machinery: there is deliberately no "analysing" state here.


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
    const j = softmaxJoint(EMB, emb, { offsets: cosineOffsetsFor(currentEngine) });
    if (Math.max(...j.spP) >= Math.max(...j.nuP)) {
      cropView = { spP: j.spP, nuTotal: j.nuP.reduce((a, b) => a + b, 0), adP: j.adP,
                   scale: localViewScale() };
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
  const wholeJ = softmaxJoint(EMB, wholeEmb, { offsets: cosineOffsetsFor(currentEngine) });
  views.push({ spP: wholeJ.spP, nuTotal: wholeJ.nuP.reduce((a, b) => a + b, 0),
               adP: wholeJ.adP, scale: localViewScale() });

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
    adP: fused.adP,
    verdict: fused.verdict,
    adjacentDetail: fused.adjacentDetail,
    agreement: fused.agreement,
    viewsLanded: views.length,
    viewsTotal: views.length,
    pending: false
  };
}

// ---- Batch Processing ----
// Photos accepted before the engine was ready, or while a batch was running.
// Draining is driven by the engine-finished path and by the end of a batch, so
// a queue is a queue rather than a promise nobody keeps.
let queuedBatches = [];

// The one bit of state worth saying out loud when a drop has to wait: the
// photos are safe, and what they are waiting for. It lives in the shared
// progress slot, which is already always present and already the only place
// transient progress is drawn, so it adds no new element to look at.
function showEngineLoadingNotice(count) {
  const slot = document.getElementById("progress-slot");
  if (!slot) return;
  slot.style.visibility = "visible";
  const msg = document.getElementById("progress-msg");
  if (msg) msg.textContent = `${count} photo${count === 1 ? "" : "s"} queued - waiting for the model to finish loading`;
  const fill = document.getElementById("progress-fill");
  if (fill) fill.style.width = "0%";
}

// Called once the engine is usable. Anything dropped while it was loading starts
// now, so the queue never needs the user to click a second time.
function drainQueuedBatches() {
  if (!queuedBatches.length) return;
  if (isProcessingBatch) return;
  if (currentEngine !== "server-gpu" && (!sessDet || !sessClip)) return;
  const next = queuedBatches.shift();
  sendLog("process_files_drain", { count: next.length });
  processFiles(next);
}

async function processFiles(fileList) {
  if (isProcessingBatch) {
    // A drop during a batch is not nothing: the photos have to run, so they
    // queue behind the batch rather than being dropped on the floor. Silently
    // refusing them is the same "clicks that go nowhere" as any other.
    queuedBatches.push(Array.from(fileList));
    sendLog("process_files_queued", { count: fileList.length });
    setProgress("batch", `Queued ${queuedBatches.reduce((n, b) => n + b.length, 0)} more photos…`, null);
    return;
  }
  if (currentEngine !== "server-gpu" && (!sessDet || !sessClip)) {
    // Dropping photos before the model is ready used to be a console.warn and
    // nothing else: the drop zone took the files, showed no error, added no
    // tiles, and looked broken. The model takes a while to arrive, so this is
    // the first thing most people do. Queue the photos instead, and let the
    // engine-finished path below pick them up.
    console.warn("Models not loaded yet for", currentEngine, "- queueing", fileList.length, "files");
    queuedBatches.push(Array.from(fileList));
    sendLog("process_files_queued", { count: fileList.length, reason: "models_loading" });
    showEngineLoadingNotice(fileList.length);
    return;
  }
  isProcessingBatch = true;
  sendLog("process_files_started", { count: fileList.length });

  // The shared slot: a batch is just another thing that draws progress into it.
  setProgress("batch", "Processing photos…", 0);

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
    clearProgress("batch");
    isProcessingBatch = false;
    return;
  }

  let isBatchAborted = false;
  const btnCancelBatch = document.getElementById("btn-cancel-batch");
  if (btnCancelBatch) {
    btnCancelBatch.onclick = () => {
      isBatchAborted = true;
      setProgress("batch", "Aborting…", null);
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
    scores: {}, detail: {}, logits: null, adP: null,
    status: "queued…", fallback: false, is_cropped: false, verdict: null,
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
  updatePooling(EMB, previews, includedIndices);
  renderResultsTable(previews);

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
        setProgress("batch", `Decoded ${decoded} of ${imageFiles.length} photos…`, null);
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
    setProgress("batch", `Analyzing ${processed + 1} of ${imageFiles.length} photos on ${engineLabel} (${slot.name})…`, (100 * processed) / imageFiles.length);
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
          adP: fused.adP,
          verdict: fused.verdict,
          adjacentDetail: fused.adjacentDetail,
          agreement: fused.agreement,
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
    setProgress("batch", `Analyzed ${processed} of ${imageFiles.length} photos…`, (100 * processed) / imageFiles.length);
    renderThumbnails();
    renderActivePhoto();
    updatePooling(EMB, previews, includedIndices);
    renderResultsTable(previews);
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

  clearProgress("batch");
  isProcessingBatch = false;

  renderThumbnails();
  renderActivePhoto();
  updatePooling(EMB, previews, includedIndices);
  renderResultsTable(previews);
  sendLog("process_files_completed", { added: slots.length, total: previews.length });

  // Anything dropped or queued while this batch ran goes next, before the
  // progress slot is handed back to a model load.
  if (queuedBatches.length) {
    drainQueuedBatches();
  }
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
    updatePooling(EMB, previews, includedIndices);
  } else {
    renderThumbnails();
    renderActivePhoto();
    updatePooling(EMB, previews, includedIndices);
    renderResultsTable(previews);
  }
}

// ---- UI Rendering & Navigation ----

// A photo can only be pooled if its checkbox is enabled, so the bulk actions use
// the same rule rather than a second one that could drift from it.
function isSelectable(p) {
  if (!p || p.fallback || p.pending || p.error) return false;
  // A photo the gate called not-a-mosquito is finished and valid, but it has
  // nothing to contribute to a pooled mosquito result, so it is not selectable.
  return p.verdict?.state !== "non-mosquito";
}

// Tiles are keyed by the photo slot they were built for, so a re-render updates
// them in place instead of rebuilding the strip.
//
// This used to be `strip.innerHTML = ""` followed by building every tile again,
// on every call - and `renderThumbnails` runs after every single photo lands,
// and again for a selection change and a checkbox toggle. Tearing the strip down
// discards every decoded thumbnail, so the browser re-decoded all of them, and
// because the strip sits above the results, every rebuild moved everything below
// it. That is the layout shift on row expansion and on deleting a photo, and it
// is most of the main-thread cost during a batch.
//
// Reusing the nodes removes both: an unchanged tile is not touched at all, so
// nothing about it decodes, resizes or moves.
const tileNodes = new Map();

function buildTile(idx) {
  const tile = document.createElement("div");

  const delBtn = document.createElement("button");
  delBtn.className = "tile-delete-btn";
  delBtn.innerHTML = "&times;";
  // Set per-render, because the index a tile was built for stops being its
  // index as soon as a photo before it is deleted.
  tile.appendChild(delBtn);

  const btn = document.createElement("button");
  btn.className = "tile-btn";
  btn.onclick = () => selectPhoto(idx);
  tile.appendChild(btn);

  const img = document.createElement("img");
  btn.appendChild(img);

  const num = document.createElement("span");
  num.className = "number";
  btn.appendChild(num);

  const badge = document.createElement("span");
  btn.appendChild(badge);

  const label = document.createElement("label");
  label.className = "include";
  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.className = "thumb-optin";
  chk.onchange = (e) => {
    if (e.target.checked) includedIndices.add(idx);
    else includedIndices.delete(idx);
    renderThumbnails();
    updatePooling(EMB, previews, includedIndices);
  };
  label.appendChild(chk);
  tile.appendChild(label);

  return { tile, delBtn, btn, img, num, badge, label, chk };
}

function renderThumbnails() {
  const strip = document.getElementById("thumbnail-strip");
  updateStripActions();
  document.getElementById("gallery-counter").textContent = `${selectedIndex + 1} / ${previews.length}`;

  // Drop the entries for photos that are gone, so a tile whose photo was deleted
  // is not kept alive by the cache.
  const live = new Set(previews);
  for (const [key, node] of tileNodes) {
    if (!live.has(key)) {
      node.tile.remove();
      tileNodes.delete(key);
    }
  }

  previews.forEach((p, idx) => {
    let node = tileNodes.get(p);
    if (!node) {
      node = buildTile(idx);
      tileNodes.set(p, node);
    }

    // A photo still being analyzed is visibly unsettled: greyed tile, pending
    // badge, and it cannot be opted into the pooled result yet.
    node.tile.className = "tile" + (selectedIndex === idx ? " active" : "") +
      (!includedIndices.has(idx) ? " excluded" : "") + (p.pending ? " pending" : "");

    node.delBtn.title = `Remove ${p.name}`;
    node.delBtn.onclick = (e) => {
      e.stopPropagation();
      deletePhoto(idx);
    };

    node.btn.setAttribute("aria-label", `View photo ${idx + 1}: ${p.name}`);

    // A queued photo has no canvas yet: it gets a greyed placeholder tile that
    // resolves to the real image as soon as its own decode finishes. The alt is
    // empty in that state, so the filename does not render over the tile.
    const src = p.cropCanvas || p.fullCanvas;
    if (src) {
      setImgSrc(node.img, canvasUrl(src, 0.8));
      node.img.className = "";
      node.img.alt = p.name;
    } else {
      node.img.removeAttribute("src");
      node.img.className = "thumb-placeholder";
      node.img.alt = "";
    }

    node.num.textContent = `${idx + 1}`;

    const badgeState = p.error ? "error" : p.pending ? "pending" : p.is_cropped ? "cropped" : "uncropped";
    node.badge.className = `crop-badge ${badgeState}`;
    node.badge.textContent = p.error ? "!" : p.pending ? "…" : p.is_cropped ? "✓" : "✕";
    node.badge.title = p.error
      ? p.error
      : p.pending
        ? ""
        : p.is_cropped ? "Mosquito detected & cropped" : "Uncropped / no mosquito detected";

    // The one place a photo's own verdict is visible without selecting it, so an
    // excluded photo is never only knowable from the contribution table.
    const abstained = p.verdict?.state === "unsure";
    node.label.title = abstained
      ? "Not confident enough to name a genus - excluded from the pooled result"
      : !p.fallback ? "Include this photo in pooled result" : "No usable mosquito detection";

    node.chk.checked = includedIndices.has(idx);
    node.chk.disabled = !isSelectable(p);

    // One appendChild on an already-present child moves it to the end, which is
    // how the strip is put into index order after a deletion.
    strip.appendChild(node.tile);
  });
}

function setAllSelected(on) {
  previews.forEach((p, i) => {
    if (isSelectable(p) && on) includedIndices.add(i);
    else includedIndices.delete(i);
  });
  renderThumbnails();
  updatePooling(EMB, previews, includedIndices);
  updateStripActions();
}

function deleteAllPhotos() {
  if (!previews.length) return;
  const n = previews.length;
  // No confirmation, matching deletePhoto: one press removes one photo without
  // asking, so asking only for the batch made the strip inconsistent rather than
  // cautious.
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
  // strip. updatePooling(EMB, previews, includedIndices) decides what it shows.
  updatePooling(EMB, previews, includedIndices);
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
// The photo's aspect is not lost, it is delegated: each panel fits its image
// with object-fit, and fitMapping() reads the surface's box at paint time, so
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
    setImgSrc(fullImg, canvasUrl(p.fullCanvas, 0.9));
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
    setImgSrc(contextImg, canvasUrl(zoomSource, 0.9));
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
    }
    // Deliberately no text for p.pending: an in-flight classification is
    // indicated by the dimmed score list and nothing else. A sentence about
    // what the app is doing is not information about the photo.
    scoreNotice.textContent = noticeText;
    scoreNotice.className = `pending-notice${noticeClass}${noticeText ? " shown" : ""}`;
    // A failed classification is worth reading in full, so it goes in the
    // tooltip rather than being cut off at the panel's edge.
    scoreNotice.title = noticeText;
  }

  // The agreement box keeps its reserved height (see index.html) but is never
  // written to: the two-view agreement was reported as a sentence, and a
  // sentence about how the views relate is not a species score.
  const agreeBox = document.getElementById("view-agreement");
  if (agreeBox) {
    agreeBox.textContent = "";
    agreeBox.className = "pending-notice";
    agreeBox.title = "";
  }
  // What the app is willing to claim about this photo, above the ranking. It is
  // hidden in the species state because there the ranking already says exactly
  // this, and shown otherwise - a photo the classifier is unsure of gets a
  // coarser claim than its own argmax, never a silently narrower one.
  const verdictEl = document.getElementById("score-uncertain");
  if (verdictEl) {
    const vText = (p.verdict && !p.pending && !p.error) ? verdictSentence(p.verdict) : "";
    verdictEl.textContent = vText;
    verdictEl.className = `uncertain${vText ? " shown" : ""}`;
    verdictEl.title = vText;
  }
  const sortedScores = Object.entries(p.detail).sort((a, b) => b[1] - a[1]);
  for (const [name, score] of sortedScores) {
    // A non-finite score has no bar and no number. Math.min/Math.max pass NaN
    // straight through, which emitted `width: NaN%` - an invalid declaration
    // the browser drops, leaving the fill at its default width and drawing a
    // full bar that looks like a confident result for a value that means
    // nothing. Say nothing instead of saying something wrong.
    const finite = Number.isFinite(score);
    const item = document.createElement("div");
    item.className = "score-item";
    const percent = finite ? (score * 100).toFixed(1) : "";
    item.innerHTML = `
      <div class="score-item-header">
        <span class="species-name-wrap">${speciesLabelHtml(name)}</span>
        ${finite ? `<strong>${percent}%</strong>` : ""}
      </div>
      <div class="score-item-track">
        ${finite ? `<div class="score-item-fill" style="width: ${Math.max(0, Math.min(100, score * 100))}%"></div>` : ""}
      </div>
    `;
    scoreList.appendChild(item);
  }

  // A photo the gate called not-a-mosquito gets the winning non-mosquito class
  // on top of the list and the mosquito ranking dropped below it, because a
  // sixteen-row ranking of species this photo is not is the exact readout that
  // made a photograph of paper come back as a confident mosquito. The species
  // scores are still in p.detail for the pooling maths - they are simply not the
  // thing to put in front of someone here.
  if (p.verdict?.state === "non-mosquito" && p.adjacentDetail) {
    const top = Object.entries(p.adjacentDetail).sort((a, b) => b[1] - a[1])[0];
    if (top) {
      const notMosquito = document.createElement("div");
      notMosquito.className = "score-item is-not-mosquito";
      const pct = (top[1] * 100).toFixed(1);
      notMosquito.innerHTML = `
        <div class="score-item-header">
          <span class="species-name-wrap">${top[0]}</span>
          <strong>${pct}%</strong>
        </div>
        <div class="score-item-track">
          <div class="score-item-fill" style="width: ${Math.max(0, Math.min(100, top[1] * 100))}%"></div>
        </div>
      `;
      scoreList.insertBefore(notMosquito, scoreList.firstChild);
      for (const item of scoreList.querySelectorAll(".score-item:not(.is-not-mosquito)")) {
        item.style.display = "none";
      }
    }
  }

  // The status line names the photo and, when one failed, why. A pending
  // photo's p.status describes work in flight ("decoding… detecting…") and is
  // deliberately not shown: the name alone, with the score list dimmed below it,
  // is the whole signal.
  const statusText = p.error
    ? `analysis failed: ${p.error.replace(/^Classification failed: /, "")}`
    : (p.pending ? "" : p.status);
  document.getElementById("photo-name").textContent =
    statusText ? `${p.name} · ${statusText}` : p.name;
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
// Surface fractions -> image fractions through the same contain window
  // cropBoxInFullSurface() draws through, so a drag lands on the pixels the
  // user pointed at rather than on the same fraction of a wider photo.
  //
  // The window is per-axis, not a single k: contain fits one axis to the photo
  // and letterboxes the other, so scaling both by one factor would stretch
  // whichever axis was not letterboxed.
  const { kx, ox, ky, oy } = fitMapping(
    document.getElementById("crop-surface-full"), fullCv, "contain"
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
  const { kx, ox, ky, oy } = zoomedSurfaceMapping(p);
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
  const { spP, nuP, adP } = softmaxJoint(EMB, emb, { offsets: cosineOffsetsFor(currentEngine) });
  return { spP, nuTotal: nuP.reduce((a, b) => a + b, 0), adP, scale: localViewScale() };
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
    updatePooling(EMB, previews, includedIndices);
    renderResultsTable(previews);
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
  p.agreement = fused.agreement;
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
  updatePooling(EMB, previews, includedIndices);
  renderResultsTable(previews);

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
  updatePooling(EMB, previews, includedIndices);
  renderResultsTable(previews);
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
  updatePooling(EMB, previews, includedIndices);
  renderResultsTable(previews);

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
  updatePooling(EMB, previews, includedIndices);
  renderResultsTable(previews);
}






// ---- Initialization & Event Listeners ----
window.addEventListener("DOMContentLoaded", () => {
  setupCropSurfaces();
  wireStripActions();

  // The viewer-aspect cache lives in the crop geometry module; these listeners
  // are wired here because they belong to the page's lifetime, not to that
  // module's, and a module that attached them at import time would make
  // importing it an act with a side effect.
  window.addEventListener("resize", invalidateViewerAspectCache);
  window.addEventListener("orientationchange", invalidateViewerAspectCache);

  // initRouter captures the classifier's own title once and returns the handler
  // that applies a route against it, so both the initial render and every
  // subsequent hashchange go through the same function.
  const onRouteChange = initRouter();
  window.addEventListener("hashchange", onRouteChange);
  onRouteChange();

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
  document.getElementById("btn-samples").onclick = () => loadSamplePhotos({ processFiles, sendLog });
  document.getElementById("btn-prev").onclick = () => selectPhoto(selectedIndex - 1);
  document.getElementById("btn-next").onclick = () => selectPhoto(selectedIndex + 1);
  document.getElementById("btn-csv").onclick = () => downloadCSV(previews, sendLog);

  const savedPooling = localStorage.getItem("mosquito_pooling");
  if (savedPooling) {
    const radio = document.querySelector(`input[name="pooling-method"][value="${savedPooling}"]`);
    if (radio) radio.checked = true;
  }
  document.querySelectorAll('input[name="pooling-method"]').forEach(r => {
    r.onchange = (e) => {
      localStorage.setItem("mosquito_pooling", e.target.value);
      updatePooling(EMB, previews, includedIndices);
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
    updatePooling(EMB, previews, includedIndices);
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
    setProgress("model", null, null);
    setProgressError(`Error: ${err.message}`);
  });

  // Warm the sample photos once the page is up, in the background.
  //
  // Deliberately after the engine load is started and never awaited: the model is
  // the long pole and must not queue behind ten images, and the first render
  // must not either. `requestIdleCallback` keeps the download off the frames the
  // user is actually looking at; the setTimeout is the fallback for a browser
  // without it.
  const warmSamples = () => {
    prefetchSamples().catch(err => console.warn("Sample prefetch failed", err));
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(warmSamples, { timeout: 3000 });
  } else {
    setTimeout(warmSamples, 1500);
  }
});
