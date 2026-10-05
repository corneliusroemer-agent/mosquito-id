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
import { assertPartition } from "../confidence/taxonomy";
import { verdictFrom as _verdictFrom, verdictSentence, nonMosquitoLabel } from "../confidence/verdict";
import { pooledPosterior as _pooledPosterior,
         splitPoolable, poolingWeights, aggregateLogits, aggregateAdjacent,
         pooledCandidates, pooledVerdict as _pooledVerdictOf } from "../confidence/pooling";
import { escapeHtml, speciesLabelHtml } from "./speciesLabels";
import { activeGroups, claimSentence, mergeUnresolvable, resolvableGroups, setActiveHead } from "./granularity";
import { CACHE_NAME, CLIP_MEAN, CLIP_SIZE, CLIP_STD, CROP_PAD, DET_SIZE, DETECTOR_SIZE,
         FP16_AVAILABLE, NMS_IOU, TEMPERATURE, WEBGPU_MODELS, capabilityNote,
         cosineOffsetsFor, floorsFor, resolveModelUrl } from "./modelConfig";
import { beginModelLoad, clearProgress, completeLoadStep, loadStepProgress, setProgress, setProgressError } from "./progress";
import { createLogger } from "./telemetry";
import { canvasUrl, dataUrlToCanvas, prepareThumbnail, setImgSrc, thumbnailUrl } from "./canvasCache";
import { photoObjectUrl, releasePhotoUrl } from "./photoUrl";
import { displayCanvasFrom, fullCanvasFor, releaseFullCanvas, resetFullCanvasCache,
         retainedFullCanvasCount } from "./fullResSource";
import { contentFingerprint } from "./contentHash";
import { decodeDets, letterbox, selectDetection } from "./detector";
import { applyBox, cropBoxInFullSurface, cropBoxInZoomSurface, cutCrop, extractContextCrop, photoFrame,
         fitMapping, invalidateViewerAspectCache, zoomedSurfaceMapping } from "./cropGeometry";
import { downloadCSV, renderResultsTable } from "./resultsTable";
import { fetchWithCache } from "./modelFetch";
import { loadSamplePhotos, prefetchSamples } from "./samples";
import { initRouter } from "./router";
import { renderBuildLink, stampBuildSha } from "./buildSha";
import { renderFooterTiming } from "./footerTiming";
import { updatePooling } from "./poolingPanel";
import { badge, canView, checkLabel, contributesToPool, photoRef,
         removeLabel, SelectedScrollGuard, shiftIncluded,
         shiftIncludedForPrepend, shiftSelected, validateIncluded,
         viewLabel } from "./thumbnailStrip";
import { DEFAULT_INCLUDE_WHOLE_FRAME, WHOLE_FRAME_KEY,
         readIncludeWholeFrame, viewKinds } from "./viewSelection";
import { createReclassifyRunner } from "./reclassifyQueue";
import { keyEventBelongsElsewhere, describeKeyTarget } from "./keyNav";
import { readPref, writePref } from "./safeStorage";
import { createIdleRelease } from "./idleRelease";
import { renderReprocessButton, sourceFileFor, splitForRerun, stalePhotoCount } from "./reprocess";
import { clipTensor, embedCanvas as _embedCanvas } from "./embedding";
import { halvingEnabled } from "./resizeMode";
import { isUsableIntermediate } from "./downscale";
import { beginRecompute, commitScores, markComputeFailed, ownsRecompute,
         Superseded } from "./photoRecord";
import { releaseGpuResources } from "./gpuRelease";
import { classifyCanvasServer as _classifyCanvasServer,
         classifyViewLocal as _classifyViewLocal,
         classifyViewServer as _classifyViewServer, genusTotals as _genusTotals,
         posteriorSummary as _posteriorSummary, round4, serverView as _serverView,
         verdictSummary as _verdictSummary, viewsFor as _viewsFor,
         aliasesWholeFrame } from "./views";

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
const fuseViews = (viewResults) => _fuseViews(EMB, viewResults, floorsFor(currentEngine));
// `nuP` is forwarded because the non-mosquito gate reads the nuisance block, not
// only the adjacent one: without it this adapter silently drops the evidence for
// "this photo is a wall", which is the case the gate exists to catch.
const verdictFrom = (spP, agreement, adP, nuP) => _verdictFrom(EMB, spP, agreement, adP, floorsFor(currentEngine), nuP);
// The view-classification adapters, bound to this file's EMB and scale the same
// way the confidence adapters above are: read at CALL time, so a reloaded
// embeddings file is picked up. `includeWholeFrame` and `sendLog` are passed at
// each call site rather than bound, because both are read at event time.
const viewsFor = (full, cropCv, cropBox) => _viewsFor(full, cropCv, cropBox, includeWholeFrame);
const serverView = (data) => _serverView(data, EMB, serverViewScale());
const classifyViewLocal = (canvas, engine) =>
  _classifyViewLocal(canvas, engine, EMB, clipEmbed, localViewScale());
const classifyViewServer = (full, name, cropBox) =>
  _classifyViewServer(full, name, cropBox, EMB, serverViewScale(), sendLog);
const posteriorSummary = (fused) => _posteriorSummary(fused, EMB);
const verdictSummary = (p) => _verdictSummary(p);
const genusTotals = (fused, topIdx) => _genusTotals(fused, topIdx, EMB);

const pooledPosterior = (aggLogits) => _pooledPosterior(EMB, aggLogits);
const pooledVerdictOf = (aggLogits, included, aggAdjLogits) =>
  _pooledVerdictOf(EMB, aggLogits, included, aggAdjLogits, floorsFor(currentEngine));


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
// Which photo the strip was last scrolled to. Lives here rather than in the
// render because the question "does the strip need scrolling" is about the
// selection's history, not about any one render: the strip's box changing under
// a still selection (a resize) is the only thing that revives it.
const scrollGuard = new SelectedScrollGuard();
/** The strip's box moved under a selection that did not: scroll again on the next render. */
function invalidateScrollGuard() {
  scrollGuard.invalidate();
}
let isProcessingBatch = false;
let idleRestoreAttempts = 0;
// The `GPUDevice` `loadWebGPUModels` obtained for itself. onnxruntime-web takes
// over `ort.env.webgpu.device` on first use, so this is only reachable from here
// - which is what makes it the one device an idle release can safely destroy.
// See `gpuRelease.ts` for why the backend's own device must be left alone.
let appOwnedDevice = null;
// A re-run in progress: the window between emptying the gallery and the batch
// that refills it starting. See reprocessLoadedPhotos.
let reprocessRunning = false;

// Whether a cropped photo is fused with its whole frame as well as its crop.
// Read once at load and written on every change, so it survives a reload; the
// read cannot throw (see readIncludeWholeFrame). Changing it re-classifies the
// photos already on screen, because a photo's verdict is a statement about the
// views it was fused from and a verdict fused from two views is not the verdict
// for a crop on its own.
let includeWholeFrame = DEFAULT_INCLUDE_WHOLE_FRAME;

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
  // The per-engine session cache. A tier-1 test that puts an entry here makes an
  // engine switch take the already-loaded branch of `loadWebGPUModels`, so the
  // switch runs for real - rebinding the head, the session and the footer - with
  // no download. The alternative is a switch that never completes, which cannot
  // exercise anything downstream of it.
  get clipSessions() { return clipSessions; },
  // The classifier, replaceable. Tier 1 aborts every model request and so has no
  // session to run a re-classification through, and the one thing that has to be
  // observable end to end - that a toggle drives inference and settles - needs
  // an inference that returns without downloading 1.26 GB of weights.
  set sessClip(v) { sessClip = v; },
  get sessDet() { return sessDet; },
  // The detector, replaceable for the same reason and needed for the same
  // reason: `processFiles` refuses a batch while either session is missing, so a
  // fake classifier alone leaves every photo queued and the gallery empty. The
  // getter and the setter have to come as a pair - a getter on its own makes an
  // assignment to it a silent no-op outside strict mode, and `page.evaluate`
  // bodies are not strict.
  set sessDet(v) { sessDet = v; },
  // The idle-release controller, so a tier-1 spec can drive a release without
  // waiting out the 60 s grace period and without faking `visibilityState`. The
  // decision logic itself is unit-tested in `tests/idle-release.test.ts`; what
  // this seam is for is the wiring - that a release really empties the session
  // cache and that the next `processFiles` refills it.
  get idleRelease() { return idleRelease; },
  get idleRestoreAttempts() { return idleRestoreAttempts; },
  /**
   * The `GPUDevice` the app obtained for itself in `loadWebGPUModels`, which
   * tier 1 never reaches - it aborts every model fetch, so the load that would
   * install one never completes. A tier-1 spec that wants to watch the release
   * destroy a device installs one here, the same way `sessClip` is a replaceable
   * seam rather than a reimplementation of the load path.
   *
   * Write it to BOTH this and `ort.env.webgpu.device`: the first is what the
   * release destroys (it is the app's to destroy - see `gpuRelease.ts`), the
   * second is the slot the release has to clear.
   */
  set appOwnedDevice(v) {
    appOwnedDevice = v;
    if (v && ort?.env?.webgpu) {
      // `delete` first, for the reason `loadWebGPUModels` does it: once a
      // webgpu session exists the property is `writable: false`.
      delete ort.env.webgpu.device;
      ort.env.webgpu.device = v;
    }
  },
  get appOwnedDevice() { return appOwnedDevice; },
  // Reachable so a spec can put a fake session in and watch the release take it
  // out. `release` is counted rather than asserted on identity, because
  // onnxruntime's own sessions are what a real run releases.
  get loadedClipEngine() { return loadedClipEngine; },
  get modelsReady() { return window.modelsReady; },
  set modelsReady(v) { window.modelsReady = v; },
  get selectedIndex() { return selectedIndex; },
  set selectedIndex(v) { selectedIndex = v; },
  get includedIndices() { return includedIndices; },
  // Test seam. EMB is otherwise only assigned once a classifier session has been
  // built, so a layout test cannot reach the pooled card without downloading the
  // 1.26 GB model. Production never writes it.
  get embeds() { return EMB; },
  set embeds(v) { EMB = v; setActiveHead(v); },
  // The verdict functions are already bound to this file's EMB by the adapters
  // above, so a test can drive a layout case with the SHIPPED arithmetic rather
  // than re-reading the bundle and eval-ing it out - which is what this seam's
  // predecessor did, and what made it break the moment the source was bundled.
  verdictFrom,
  verdictSentence,
  clipTensor,
  selectPhoto,
  processFiles,
  deletePhoto,
  // Empties the gallery, which is the other way the cache can be left holding
  // frames for photographs that are no longer on screen.
  deleteAllPhotos,
  // The crop release, so a test can cut a crop the way a drag does rather than
  // reaching past the pointer handlers into the canvas. It is the path that
  // fetches the full-resolution frame back, so it is also the path a test has to
  // drive to observe that the frame is not left on the record.
  applyCropFromFullSurface,
  // The photo's full-resolution pixels, decoded from its File on demand. A test
  // that installs a crop by hand has to cut it from the same pixels the app
  // would, or it is asserting about a different photograph than the re-run will
  // score.
  fullCanvasFor,
  // How many full-resolution frames are held right now. The bound is a fixed
  // number, and a test asserting the gallery is empty has to be able to see it.
  retainedFullCanvasCount,
  // The engine re-run, so a test can press the button's action without reaching
  // into the gallery's internals first.
  reprocess: () => reprocessLoadedPhotos(),
  // The photo set an engine-switch re-run is narrowing the shared pass to, or
  // null. Writable so a test can stand in for a re-run in progress: that is the
  // only way to reach a whole-frame toggle's path while the narrowing is set,
  // since the real re-run needs a live detector and minutes of inference.
  // Read-only in production; nothing outside `reprocessLoadedPhotos` writes it.
  get rerunPhotos() { return rerunPhotos; },
  set rerunPhotos(v) { rerunPhotos = v; },
  // The render entry points, so a probe can time and inspect a render with the
  // same functions the app calls rather than a re-implementation of them. These
  // are the functions the encode cache exists for, so a probe that did not call
  // them would not be measuring it.
  renderThumbnails,
  renderActivePhoto,
  updatePooling: () => updatePooling(EMB, previews, includedIndices),
  renderResultsTable: () => renderResultsTable(previews),
  // The CSV is the other way a claim leaves the machine, and it is a separate
  // function from the table it mirrors, so a test has to be able to call it.
  downloadCSV: () => downloadCSV(previews, sendLog)
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









const embedsCache = {};
// Taxonomies, keyed by the head they belong to. Kept apart from `embedsCache`
// because they are a different artefact with a different lifetime: the head is
// 271 KB of fitted weights, this is 3 KB of labels, and an engine switch should
// not re-fetch either when the other is already loaded.
const taxonomyCache = {};

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
        // Tracked so an idle release can destroy it. onnxruntime-web replaces
        // this reference with a device of its own on the first
        // `InferenceSession.create` (its `WebGpuBackend.initialize` calls
        // `adapter.requestDevice` again), so this one is orphaned from that
        // moment - but it is still a live `GPUDevice`, and the release path is
        // the only thing that can hand it back.
        appOwnedDevice = device;
        // `delete` first: once a webgpu session exists, onnxruntime-web has
        // redefined `env.webgpu.device` as `writable: false`, so assigning to
        // it throws and the catch below would swallow a spurious warning on
        // every load after the first. The property is `configurable: true`, so
        // this is the supported way to replace it.
        delete ort.env.webgpu.device;
        ort.env.webgpu.device = device;
      }
    } catch (e) {
      console.warn("WebGPU adapter pre-init:", e);
    }
  }

  // The bar is declared for the whole load before anything starts, so it advances
  // once across every download instead of restarting at 0% per file, and so the
  // slice it reserves for session setup is known up front. A step is listed only
  // if this load will actually perform it: an engine already in `clipSessions` or
  // an embeds file already in memory contributes no step, and listing it anyway
  // would leave the bar short of 100% for the rest of the session.
  const clipCfg = WEBGPU_MODELS[engineKey] || WEBGPU_MODELS["webgpu-fp16"];
  const targetEmbedsPath = clipCfg.embedsPath || "text_embeds.json";
  const needsDetector = !sessDet;
  const needsClassifier = !clipSessions[engineKey];
  const needsEmbeds = !embedsCache[targetEmbedsPath];
  const steps = [];
  if (needsDetector) steps.push({ key: "detector", bytes: DETECTOR_SIZE });
  if (needsDetector) steps.push({ key: "detector-session" });
  if (needsClassifier) steps.push({ key: "classifier", bytes: clipCfg.size });
  if (needsClassifier) steps.push({ key: "classifier-session" });
  // The embeddings are same-origin and under a megabyte, so their transfer is
  // not worth a byte slice of its own - what the bar reports for them is that
  // they parsed and the head is now usable.
  if (needsEmbeds) steps.push({ key: "embeds" });
  // The taxonomy is a few KB beside a 172 MB classifier, so it gets its own slice
  // of the bar rather than riding on the head's - a missing or malformed
  // taxonomy has to be visible on the progress bar, not inferred from the head
  // arriving.
  const needsTaxonomy = Boolean(clipCfg.taxonomyPath) && !taxonomyCache[targetEmbedsPath];
  if (needsTaxonomy) steps.push({ key: "taxonomy" });
  beginModelLoad(steps);

  // 1. Load detector if not loaded
  if (needsDetector) {
    const detPath = resolveModelUrl("yolo11n-mosquito-det-640.onnx");
    const detBuf = await fetchWithCache(detPath, loadStepProgress("detector", "Detector (YOLO11n)"), sendLog);
    try {
      sessDet = await ort.InferenceSession.create(detBuf, { executionProviders: ["webgpu"] });
      detEP = "webgpu";
    } catch (err) {
      console.warn("WebGPU unavailable for detector, falling back to WASM");
      sessDet = await ort.InferenceSession.create(detBuf, { executionProviders: ["wasm"] });
      detEP = "wasm";
    }
    // Past this the detector can run, which is the only thing that advances the
    // bar's session slice - the download reaching 100% did not earn it.
    completeLoadStep("detector-session");
  }

  // 2. Load BioCLIP model with cache
  if (needsClassifier) {
    const buf = await fetchWithCache(resolveModelUrl(clipCfg.path), loadStepProgress("classifier", clipCfg.name), sendLog);

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
    completeLoadStep("classifier-session");
  } else {
    sessClip = clipSessions[engineKey].sess;
    clipEP = clipSessions[engineKey].ep;
  }
  loadedClipEngine = engineKey;

  // 3. Load text embeddings for this model
  //
  // Through the same cache as the weights, and on the same build-versioned URL
  // (`versionedModelUrl`). A refitted head is a few hundred KB at a URL that
  // does not change, so a browser serves the head it fetched before the refit -
  // the page runs the old `logit_scale` and the new scores, and a deployed fix
  // looks like it did not land. Keyed by the build, a deploy fetches the new
  // head; the weights, which are gigabytes and do not change with the build,
  // keep the cache that makes a second visit bearable.
  //
  // `needsEmbeds` and `targetEmbedsPath` are declared with the rest of the load
  // plan above, so this step is one the bar is already counting. No byte
  // reporter is passed: driving the bar from this transfer would put the final
  // slice of it - the one reserved for a usable model - at the last byte of the
  // file, before `JSON.parse` has made the head usable.
  if (needsEmbeds) {
    // No SHA argument: the default is `COMMIT_SHA`, the SHA this bundle was
    // built from, and that is what makes the head's URL change per deploy.
    const headBuf = await fetchWithCache(targetEmbedsPath, undefined, sendLog);
    const data = JSON.parse(new TextDecoder().decode(headBuf));
    for (const k of ["species_emb", "nuisance_emb"]) {
      data[k] = Float32Array.from(data[k]);
    }
    // The head's one camelCase field, mapped from the file's snake_case like the
    // rest of it. Which embedding coordinate is the probe's intercept is a fact
    // about the artefact and the gate needs it - see Head.biasIndex.
    data.biasIndex = data.bias_index ?? -1;
    embedsCache[targetEmbedsPath] = data;
    completeLoadStep("embeds");
  }
  // Attached to the head, so every consumer that reads `head.taxonomy` - the
  // rank roll-up, the genus index - sees it without threading a second argument
  // through. A taxonomy that does not match the head is caught here rather than
  // surfacing as a species filed under the wrong genus.
  // Read through the cache, not through `data`: that binding lives inside the
  // `needsEmbeds` block above, and an engine whose head is already loaded has no
  // `data` at all - which is exactly the path an engine switch takes.
  const head = embedsCache[targetEmbedsPath];
  if (needsTaxonomy) {
    // A taxonomy is an enhancement, and a head without one is fully supported -
    // genus falls back to the first word of the label. So a taxonomy that is
    // missing, malformed, or not the array it claims to be degrades to that
    // fallback and says so in the log rather than leaving a head that silently
    // has no tree.
    //
    // `fetchWithCache` already absorbs a failed fetch, so the catch is not
    // covering that (measured: tier 1 aborts every model request and the engine
    // switch still completes). What it IS covering is everything downstream of
    // the fetch - a truncated body makes `JSON.parse` throw, and that is outside
    // fetchWithCache's reach. Failing a 172 MB classifier download over 3 KB of
    // labels would be the wrong trade by a wide margin.
    try {
      const taxBuf = await fetchWithCache(resolveModelUrl(clipCfg.taxonomyPath), loadStepProgress("taxonomy", "Taxonomy"), sendLog);
      const taxDoc = JSON.parse(new TextDecoder().decode(taxBuf));
      if (Array.isArray(taxDoc?.taxonomy)) {
        taxonomyCache[targetEmbedsPath] = taxDoc.taxonomy;
        sendLog("taxonomy_loaded", { head: targetEmbedsPath, entries: taxDoc.taxonomy.length });
      } else {
        sendLog("taxonomy_unusable", { head: targetEmbedsPath, reason: "not_an_array" });
        console.warn("[taxonomy] ignoring", clipCfg.taxonomyPath, "- no `taxonomy` array; using the first-word genus rule");
      }
    } catch (err) {
      sendLog("taxonomy_unusable", { head: targetEmbedsPath, reason: "fetch_failed" });
      console.warn("[taxonomy]", clipCfg.taxonomyPath, "could not be loaded; using the first-word genus rule:", err);
    }
    completeLoadStep("taxonomy");
  }
  if (taxonomyCache[targetEmbedsPath]) head.taxonomy = taxonomyCache[targetEmbedsPath];
  assertPartition(head);
  EMB = head;
  // Bind the species this head cannot separate to the label helpers. Done where
  // the head is assigned, so an engine switch rebinds them with it.
  setActiveHead(EMB);
  // Logged, not just printed: when the head is refitted and these groups split,
  // this line is how that shows up in a deployment's own log rather than only in
  // the source diff.
  const groups = resolvableGroups(EMB);
  if (groups.length) {
    console.info("[granularity] this head cannot separate:\n  " + groups.map((g) => g.label).join("\n  "));
  }
  sendLog("head_granularity", {
    species: EMB.species.length,
    unresolvableGroups: groups.length,
    unresolvableSpecies: groups.reduce((n, g) => n + g.species.length, 0),
  });

  const deviceLabel = `inference: ${clipCfg.name} (${clipEP.toUpperCase()}) · YOLO11n (${detEP.toUpperCase()})`;
  document.getElementById("footer-device").textContent = deviceLabel;
  clearProgress("model");
  window.modelsReady = true;
  // The button was blocked for the whole download; it becomes pressable here.
  updateReprocessButton();
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

  // Preference: URL query param > localStorage > default. An engine the map does
  // not carry is not selectable either, so a saved choice left behind by a removed
  // engine falls through instead of selecting itself on the next visit. fp16 is
  // skipped while it is unavailable, for the same reason.

  // H/14 is the default, and it is the default because culico's head cannot yet be
  // made to serve this app: its species argmax sits at 22% because the ten species
  // the corpus never labels carry the GENUS weight row, so on a correctly-identified
  // Aedes photo those three rows outscore the species probe. Pinning them instead
  // lifts species to 71% but drops genus from 83% to 57%, and the app's default
  // read is a genus, so the honest position is that the head needs fitting that
  // treats a genus-only label as evidence about the genus rather than copying it
  // into every species column. That is analysis, not a UI default.
  const defaultEngine = "webgpu-fp16";
  const params = new URLSearchParams(window.location.search);
  const requestedEngine = params.get("engine");
  const savedEngine = readPref("mosquito_engine");
  const selectable = (e) =>
    (e === "server-gpu" ? false : !!WEBGPU_MODELS[e]) && (e !== "webgpu-fp16" || FP16_AVAILABLE);

  const chosenEngine = selectable(requestedEngine)
    ? requestedEngine
    : selectable(savedEngine)
      ? savedEngine
      : defaultEngine;

  currentEngine = chosenEngine;
  applyEngineNotices(chosenEngine);
  labelEngineOptions();
  if (engineSelect) {
    engineSelect.value = chosenEngine;
    engineSelect.addEventListener("change", async (e) => {
      const chosen = e.target.value;
      // Reported rather than thrown: a browser that refuses the write would
      // otherwise leave the selector showing an engine that reverts on reload,
      // with nothing said. The switch itself still happens either way.
      if (!writePref("mosquito_engine", chosen)) {
        sendLog("pref_not_stored", { key: "mosquito_engine" });
      }
      sendLog("engine_switched", { from: currentEngine, to: chosen });
      applyEngineNotices(chosen);
      currentEngine = chosen;
      // The engine is not usable from this instant: `sessClip` still holds the
      // PREVIOUS engine's session and `EMB` its head until the weights land, so a
      // re-run started now would run the old classifier and commit the result
      // under the new engine's name. Cleared HERE rather than on
      // `loadWebGPUModels`'s first line, because the button is read in between -
      // clearing it there left the button enabled and inert for the whole 1.26 GB
      // download, which is the one state it must never be in.
      if (chosen !== "server-gpu") window.modelsReady = false;
      engineLoadError = null;
      // With `currentEngine` already moved and the engine already marked unusable:
      // the photos are stale the moment the selection changes, and for the
      // duration of the download this button - disabled, saying so - is what the
      // reader has instead.
      updateReprocessButton();
      if (chosen === "server-gpu") {
        clearProgress("model");
        if (footerDevice) {
          footerDevice.textContent = `inference: ${serverEngineLabel} · YOLO11n & BioCLIP 2.5 H/14 (Instant)`;
        }
        window.modelsReady = true;
        updateReprocessButton();
        drainQueuedBatches();
      } else {
        if (footerDevice) {
          footerDevice.textContent = `inference: ${WEBGPU_MODELS[chosen]?.name || "WebGPU"}`;
        }
        // Caught, and reported the way a failed initial load is: this listener is
        // async, so a rejected download was an unhandled rejection and nothing on
        // the page. A switch whose weights cannot be fetched has to leave the
        // engine named in the dropdown with the failure on screen, and the
        // re-run button blocked rather than offering to re-run the PREVIOUS
        // engine's classifier under the new one's name.
        try {
          await loadWebGPUModels(chosen);
        } catch (err) {
          console.error("Engine switch failed:", err);
          engineLoadError = `Could not load ${WEBGPU_MODELS[chosen]?.name || chosen}`;
          setProgress("model", null, null);
          setProgressError(`${engineLoadError}: ${err.message}`);
        }
        // The button was disabled for the download either way; what it says now
        // differs, and a failed load leaves it unusable rather than merely slow.
        updateReprocessButton();
      }
    });
  }

  if (chosenEngine === "server-gpu" && serverAvailable) {
    clearProgress("model");
    if (footerDevice) {
      footerDevice.textContent = `inference: ${serverEngineLabel} · YOLO11n & BioCLIP 2.5 H/14 (Instant)`;
    }
    window.modelsReady = true;
    updateReprocessButton();
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
/**
 * Say, in the engine dropdown, what each engine's head can name.
 *
 * The head behind an unchosen engine is not loaded, so this is the only place the
 * limitation can be read before the user picks one, and the dropdown is where they
 * pick. Nothing is added above the content: a header caveat moved the page (0.27
 * CLS on desktop) and has been rejected twice.
 *
 * Appended to whatever the option already says, so the size and the "experimental"
 * marker each keep one source and this owns only the granularity. Idempotent: it
 * runs on every init.
 */
function labelEngineOptions() {
  const engineSelect = document.getElementById("engine-select");
  if (!engineSelect) return;
  for (const opt of engineSelect.options) {
    const cfg = WEBGPU_MODELS[opt.value];
    if (!cfg || opt.dataset.granularity === cfg.reports) continue;
    opt.dataset.granularity = cfg.reports;
    opt.textContent = cfg.reports === "species"
      ? opt.textContent.replace(/ \u00b7 genus only$/, "")
      : opt.textContent + capabilityNote(cfg.reports);
  }
}

// ---- Re-running the loaded photos on the selected engine ----
//
// Switching the engine changes what the next photo will be scored by and
// nothing about the photos already on screen, so their scores stay the previous
// engine's while the footer names the new one. Re-running them is minutes and a
// lot of battery on the phone this is mostly used on, so it is an explicit
// action; the button's presence is what says the scores are stale.
//
// Both the rule and the button's drawing live in ./reprocess, because which
// photos are stale is a question about the photos and not about the DOM.
const REPROCESS_BLOCKED_BATCH = "A batch is being analysed - re-run when it finishes";
// Set when a switch's weights could not be fetched, and cleared by the next
// switch. It is the difference between "still loading" and "did not load", which
// are the same button state and not the same thing to be told.
let engineLoadError = null;

/** The engine's name as the dropdown gives it, for the button's tooltip. */
function engineLabel() {
  return currentEngine === "server-gpu"
    ? `Server (${serverEngineLabel})`
    : WEBGPU_MODELS[currentEngine]?.name || "WebGPU";
}

function updateReprocessButton() {
  const btn = document.getElementById("btn-reprocess");
  if (!btn) return;
  const stale = stalePhotoCount(previews, currentEngine);
  // Checked in this order because a re-run is a batch is a re-run. The last is
  // the dangerous one: the dropdown already names an engine whose session is not
  // the one loaded, so pressing would stamp the new engine's name on the
  // previous engine's result.
  const blockedBy = reprocessRunning || isProcessingBatch || reclassifyRunner.inFlight
    ? REPROCESS_BLOCKED_BATCH
    : engineLoadError
      ? `${engineLoadError} - the engine in the dropdown is not the one that scored these photos`
      : !window.modelsReady
        ? "The selected engine is still loading - re-run when it has"
        : null;
  renderReprocessButton(btn, { stale, engineLabel: engineLabel(), blockedBy });
}

/**
 * Re-run every loaded photo against the engine now selected.
 *
 * Every loaded photo is re-run, not only the stale ones: selecting a subset
 * would leave a gallery half on each engine, which is the mixed state this
 * exists to remove. What each one costs is not the same, and the split is what
 * the button's job requires rather than what a fresh drop happens to do.
 *
 * A photo that already carries a crop box - the detector's, or one the user drew
 * - has everything the classifier needs, so it is re-classified from the box it
 * has. Re-running the detector over it is minutes of inference for a box that was
 * already correct, and it replaces a manual crop with the detector's, which is a
 * crop the user drew being destroyed by an action that never said it would.
 *
 * A photo with no box has no crop to classify, and getting one is what makes a
 * second view possible at all, so those still go through `processFiles`: the
 * detection, the batch scheduling and the pending bookkeeping all come with it,
 * because a parallel path would be a second thing to keep in step with that one.
 */
async function reprocessLoadedPhotos() {
  // Same as `processFiles`: a released tab rebuilds on demand rather than
  // refusing the re-run. The button is disabled for the duration either way,
  // and the weights come from the Cache API, so the cost is a load the reader
  // was going to pay on their next photo drop anyway.
  if (idleRelease.released()) await idleRelease.ensure();
  if (isProcessingBatch || !window.modelsReady || reprocessRunning) return;
  // A whole-frame or crop re-classification holds the single inference slot
  // without ever setting `isProcessingBatch`, and this app runs onnxruntime on
  // the main thread: two of them at once is the freeze the runner exists to
  // prevent, and the runner's own `onSettled` would then render against a
  // gallery this has already replaced.
  if (reclassifyRunner.inFlight) return;
  const sources = previews.filter((p) => p && !p.removed);
  if (!sources.length) return;
  sendLog("reprocess_requested", { photos: sources.length, engine: currentEngine });

  // The button is disabled for the whole of this, but `isProcessingBatch` only
  // becomes true once the batch below starts, and collecting the sources is
  // several awaits wide. Without this a second click lands in that gap and
  // empties the gallery the first click is about to refill.
  reprocessRunning = true;
  updateReprocessButton();

  try {
    // The two groups, split by the work each one actually needs. Everything the
    // user asked for is scores from the current engine; a photo that already has
    // a crop has all it takes to produce them, so it never reaches the detector.
    const { classify, detect } = splitForRerun(sources);

    // Of the photos that DO need detection, every one that can be re-dropped, and
    // every one that cannot - kept aside rather than dropped. A photo is
    // un-re-droppable only if it has neither a File nor decoded pixels, and the
    // batch below empties the gallery, so a photo left out of the drop without
    // being kept would vanish from the strip with nothing said: a decode that
    // failed, a photo whose canvas backing store was lost. Both are rare and both
    // are someone's photo. `classify` is kept for the same reason and never
    // needed a File at all: it re-classifies the pixels it is already holding.
    const files = [];
    const kept = [...classify];
    for (const p of detect) {
      const f = await sourceFileFor(p);
      if (f) files.push(f);
      else kept.push(p);
    }
    if (!files.length && !classify.length) {
      sendLog("reprocess_impossible", { photos: kept.length });
      return;
    }
    if (kept.length > classify.length) {
      console.warn("Re-running without", kept.length - classify.length,
        "photo(s) that have no source image left");
    }

    // Only the photos the batch is about to replace are marked removed; `kept`
    // stays in the gallery and lands BELOW the batch, which is what
    // `processFiles` prepends to whatever is already there. Its own
    // `shiftIncludedForPrepend` then moves `kept`'s checks down by the batch's
    // length, which is the same arithmetic a drop over a populated gallery does.
    previews.forEach((p) => { if (!kept.includes(p)) { p.removed = true; releasePhotoUrl(p); } });
    previews = [...kept];

    // The already-cropped photos are marked pending for the whole re-run, not
    // from when the classify pass reaches them. Their scores are the PREVIOUS
    // engine's until that pass lands, and `updatePooling` runs between here and
    // there - twice, once now and once per batch slot - so leaving them
    // settled would pool old-engine verdicts together with new ones for the
    // duration. That is the mixed gallery the button exists to remove, and it is
    // invisible: a pending photo is simply out of the pool. Inclusion is by
    // index and sticky, so it comes back when the pass settles them.
    //
    // `beginRecompute` marks them again on the way in. An error is cleared by the
    // runner's `due`, which does not consult one for a re-run's own photos - a
    // user pressing the button after a failure is asking for that photo to be
    // retried, and the runner's standing rule is that a photo with an error has
    // nothing to re-fuse.
    //
    // `scoredBy` is deliberately left alone. Clearing it would make the photo
    // look current - so a press that failed to reach it withdraws the button and
    // the stale scores stay on screen under a new engine's name, which is the one
    // outcome worse than a button that offers again.
    for (const p of classify) p.pending = true;

    includedIndices = new Set(kept.map((_, i) => i));
    selectedIndex = 0;
    sendLog("reprocess_replaced", {
      replaced: files.length, reclassified: classify.length, kept: kept.length,
    });
    renderThumbnails();
    updatePooling(EMB, previews, includedIndices);
    renderResultsTable(previews);
    // Awaited, so the guard is held until the batch has run: the photos on
    // screen between this point and its end are the batch's, and the button
    // must not offer to replace them again.
    if (files.length) await processFiles(files);

    // The already-cropped photos go through the SAME serial runner the whole-frame
    // toggle uses, and not a private loop: that runner is what holds the single
    // inference slot, and a second scheduler beside it would put two runs on one
    // session - the page freeze it exists to prevent. It reads `due` fresh at the
    // start of every pass, so the indices it works on are the post-batch ones.
    if (classify.length) {
      rerunPhotos = new Set(classify);
      try {
        await reclassifyRunner.request();
      } finally {
        rerunPhotos = null;
      }
    }
  } finally {
    reprocessRunning = false;
    updateReprocessButton();
  }
}

/** The button's one listener: a click re-runs the gallery, nothing else. */
function wireReprocessButton() {
  const btn = document.getElementById("btn-reprocess");
  if (!btn) return;
  btn.onclick = () => { reprocessLoadedPhotos(); };
  updateReprocessButton();
}

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


// `preScaled`, when given, is a smaller copy of `sourceCanvas` at the same
// aspect ratio - in practice the detector's own unpadded input. Scaling that
// instead of the photograph reads ~0.3 MP rather than 12-50 MP, which is the
// whole of the cost of this step. It is refused whenever it would not be the
// same picture, so a caller that passes the wrong canvas gets the direct read
// rather than a stretched or enlarged embedding.
async function clipEmbed(sourceCanvas, preScaled) {
  // With halving on, the whole view is read from the photo itself: the detector's
  // 640 px canvas was a single non-anti-aliased reduction, and halving from it
  // would only continue that.
  const src = !halvingEnabled() && preScaled && isUsableIntermediate(preScaled, sourceCanvas, CLIP_SIZE) ? preScaled : sourceCanvas;
  return _embedCanvas(src, sessClip, EMB, (data, dims) => new ort.Tensor("float32", data, dims));
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
async function classifyImage(imgBitmap, filename, file) {
  const t0 = performance.now();
  // Read once, so this photo's `scoredBy` names one engine rather than whichever
  // was selected when the commit landed. It does NOT pin the arithmetic: `sessClip`
  // and `EMB` are module state that `loadWebGPUModels` rebinds mid-download, so a
  // photo classified in that window is still scored against whichever session and
  // head happened to be bound. What the pin guarantees is that such a photo is
  // LABELLED consistently, which is what the re-run button reads; the window is
  // closed by the button being disabled until `modelsReady`, not by this.
  const engine = currentEngine;
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
  //
  // What the gate says is about the crop alone. The whole frame is classified
  // either way, and its verdict is the photo's verdict, so a rejected crop
  // leaves a photo that pools on what the frame said rather than one that is
  // struck off the list.
  let cropView = null;
  let cropRejected = false;
  if (best) {
    const emb = await clipEmbed(cropCv);
    const j = softmaxJoint(EMB, emb, { offsets: cosineOffsetsFor(engine) });
    if (Math.max(...j.spP) >= Math.max(...j.nuP)) {
      cropView = { spP: j.spP, nuTotal: j.nuP.reduce((a, b) => a + b, 0), adP: j.adP,
                   scale: localViewScale() };
    } else {
      cropCv = fullCv;
      cropBox = null;
      best = null;
      cropRejected = true;
    }
  }

  const views = [];
  if (cropView) views.push(cropView);
  // Which views this photo offers is one decision, in `viewKinds`, and it is not
  // "always both": the whole frame is the second opinion on a crop that passed
  // the gate, and that second opinion can be turned off. It stays the only view
  // there is for a photo with no crop, so the list is never empty and no fused
  // posterior is ever derived from zero views. The crop is already scored above,
  // so only the whole frame is left to decide here.
  if (viewKinds(Boolean(cropView), includeWholeFrame).includes("whole")) {
    // `lb.content` is the photograph already resampled for the detector, so
    // this reads ~0.3 MP rather than reading the 12-50 MP frame a second time.
    const wholeEmb = await clipEmbed(fullCv, lb.content);
    const wholeJ = softmaxJoint(EMB, wholeEmb, { offsets: cosineOffsetsFor(engine) });
    views.push({ spP: wholeJ.spP, nuTotal: wholeJ.nuP.reduce((a, b) => a + b, 0),
                 adP: wholeJ.adP, scale: localViewScale() });
  }

  const clipTime = Math.round(performance.now() - tClip0);
  const totalTime = Math.round(performance.now() - t0);

  // What happened, not what is missing from the photo: a detector that found no
  // box and a gate that rejected the crop are different events, and neither of
  // them establishes that the photo holds no mosquito.
  const status = best
    ? `detector: ${dets.length} box(es), best ${best.conf.toFixed(2)}`
    : cropRejected
      ? "whole photo analysed (the crop was rejected as a nuisance)"
      : "whole photo analysed (the detector found no box)";

  const is_cropped = Boolean(best);
  const { contextCanvas, contextBox } = extractContextCrop(fullCv, fullCv, cropBox);
  const displayCanvas = displayCanvasFrom(fullCv);

  const base = {
    name: filename,
    // The engine whose arithmetic produced this, so a later engine switch can be
    // told apart from a photo that is still current. See `engine` above.
    scoredBy: engine,
    // What the record keeps. The full-resolution frame goes with this function:
    // it has been classified, and the two paths that need it again re-decode it
    // from the File rather than holding it for every photo in the gallery.
    displayCanvas: displayCanvas,
    fullW: fullCv.width,
    fullH: fullCv.height,
    // Retained only for a photo with no File: with no bytes there is nothing to
    // decode it again from, so this is the whole of what such a photo can offer.
    sourceCanvas: file ? null : fullCv,
    // One canvas under three names when there is no detection, not three copies
    // of the same picture. A photo the detector found nothing in has one set of
    // pixels and one display size, and splitting them across three canvases
    // would cost exactly what this change reclaimed.
    cropCanvas: cropCv === fullCv ? displayCanvas : displayCanvasFrom(cropCv),
    contextCanvas: cropBox ? contextCanvas : displayCanvas,
    cropBox,
    contextBox,
    status,
    crop_rejected: cropRejected,
    is_cropped,
    rev: 0,
    error: null,
    manual_full_photo: !best,
    detTime,
    clipTime,
    totalTime
  };

  const epLabel = clipEP === "webgpu" ? "WEBGPU" : "WASM CPU";
  renderFooterTiming(document.getElementById("footer-device"), document, {
    engineLabel: `${WEBGPU_MODELS[engine]?.name || "WebGPU"} (${epLabel})`,
    totalMs: totalTime,
    cropMs: detTime,
    analyzeMs: clipTime,
  });

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
  // A tab that released its sessions while hidden rebuilds them here rather
  // than queueing the photos and waiting for something else to notice. This is
  // a no-op unless a release actually happened, so it costs nothing on the
  // normal path.
  if (idleRelease.released()) await idleRelease.ensure();
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
  includedIndices = shiftIncludedForPrepend(includedIndices, offset);

  // Placeholders first, so the gallery shows the whole batch immediately: each
  // tile greyed with a pending badge, then resolved as its own inference
  // finishes rather than all at the end. A placeholder carries the same
  // rev/pending contract as a crop release, so a photo deleted or superseded
  // mid-flight is never painted as finished.
  const slots = imageFiles.map((file) => ({
    name: file.name, file,
    displayCanvas: null, fullW: null, fullH: null, sourceCanvas: null,
    cropCanvas: null, contextCanvas: null,
    cropBox: null, contextBox: null,
    scores: {}, detail: {}, logits: null, adP: null,
    status: "queued…", crop_rejected: false, is_cropped: false, verdict: null,
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
          // Hashed once, here: the slot's `fingerprint` is what pooling
          // de-duplicates on, and `commitBatchSlot` does not overwrite it.
          slot.fingerprint = await contentFingerprint(slot.file);
          slot.bitmap = await createImageBitmap(slot.file, { imageOrientation: "from-image" });
          // Paint the photo as soon as it is decoded, so the tile is the real
          // image (greyed) while its own inference is still to come.
          // The photograph's own dimensions, recorded once here, in the
          // orientation every box on this photo will be expressed in. Every
          // crop and context box is cut and placed against these, never
          // against the display canvas below, whose dimensions differ.
          slot.fullW = slot.bitmap.width;
          slot.fullH = slot.bitmap.height;
          // Display-sized from the start: this canvas exists so the tile shows
          // the real image while the photo's own inference is still to come,
          // and holding a full-resolution copy of every queued photo to do
          // that is the retention this file exists to remove.
          slot.displayCanvas = displayCanvasFrom(slot.bitmap);
          slot.status = "decoding… detecting…";
          await prepareThumbnail(slot.displayCanvas, 0.8, slot.file);
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
    // Read once, so the photos a batch scores all carry one engine in
    // `scoredBy` rather than one each, and the footer naming the last of them
    // cannot leave a reader unable to tell which scores are whose. The batch
    // itself does not straddle a switch: `processFiles` is unreachable while the
    // engine is unusable, so the session and head are settled for its duration.
    const engine = currentEngine;
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
      if (engine === "server-gpu") {
        const formData = new FormData();
        formData.append("file", slot.file);
        const res = await fetch("/api/predict", { method: "POST", body: formData });
        if (!res.ok) throw new Error("Server inference error " + res.status);
        const data = await res.json();
        const fullCv = await dataUrlToCanvas(data.fullDataUrl);
        const cropCv = await dataUrlToCanvas(data.cropDataUrl);
        const contextCv = await dataUrlToCanvas(data.contextDataUrl);
        // Aliasing is decided from the data URLs, which is what the server sent:
        // `dataUrlToCanvas` allocates a fresh canvas per URL, so the decoded
        // canvases are never the same object and comparing them would never
        // alias - which held three capped copies of one photograph in exactly the
        // case the comment below claims to collapse to one.
        const aliased = aliasesWholeFrame(data);
        const displayCv = displayCanvasFrom(fullCv);

        // The photo's bytes become the server's frame, because from here on that
        // frame is what the app holds: `commitBatchSlot` puts its dimensions in
        // `fullW`/`fullH` and its bytes in `file`,
        // the crop box is in its coordinates, and `cropGeometry` divides by its
        // width and height. Leaving `file` as the upload would leave the viewer
        // showing bytes that were never classified, beside a box positioned for
        // pixels it does not have - and nothing downstream can detect that,
        // because the server's decode is as correct a decode as the browser's
        // own. What it is not guaranteed to be is the SAME decode: a re-encode, a
        // downscale or a different EXIF reading on the server all produce a
        // frame the browser's copy of the upload does not match.
        //
        // So the record is made self-consistent here rather than trusted to be:
        // the object URL the viewer serves is minted from these bytes, and
        // `photoObjectUrl` revokes the upload's URL when `file` changes, so the
        // old one cannot outlive the frame it stood for.
        //
        // Encoding here rather than at selection is what keeps this cheap -
        // `toBlob` is off the click, and it is paid once per photo against a
        // network round trip that cost far more.
        const serverFile = await sourceFileFor({ sourceCanvas: fullCv, name: data.filename });

        // Second view over the same contract, no server change needed: the
        // endpoint already classifies whatever box it is given, so the whole
        // frame is one more request with crop_box spanning it. Skipped when the
        // server's own detection found nothing and it classified the whole frame
        // anyway - then there is only one view to have - and when the user has
        // turned the whole-frame view off.
        const views = [serverView(data)];
        if (viewKinds(Boolean(data.is_cropped), includeWholeFrame).includes("whole")) {
          const fd2 = new FormData();
          fd2.append("file", slot.file);
          fd2.append("crop_box", JSON.stringify([0, 0, data.fullWidth, data.fullHeight]));
          const res2 = await fetch("/api/predict", { method: "POST", body: fd2 });
          if (!res2.ok) throw new Error("Server inference error " + res2.status);
          views.push(serverView(await res2.json()));
        }
        const fused = fuseViews(views);

        commitBatchSlot(slots[i], {
          name: data.filename, scoredBy: engine,
          // Null when the encode failed, and null is the safe answer here rather
          // than the old upload: with no file the viewer falls back to encoding
          // `displayCanvas` itself, which is this frame by definition. Keeping the
          // upload instead would put back the mismatch this exists to remove.
          //
          // A re-run therefore re-classifies these bytes rather than the original
          // upload, which is what makes it a re-run of the same photograph: the
          // frame on screen is the frame that was classified.
          file: serverFile,
          displayCanvas: displayCv, fullW: fullCv.width, fullH: fullCv.height,
          // Every photo minted here has a File, so the frame is not retained on
          // the record; `fullCanvasFor` decodes it back on demand.
          sourceCanvas: null,
          // The server sends full-resolution data URLs, so all three are capped
          // here, and the no-detection case shares one canvas rather than three
          // copies of the same photograph.
          cropCanvas: aliased.crop ? displayCv : displayCanvasFrom(cropCv),
          contextCanvas: aliased.context ? displayCv : displayCanvasFrom(contextCv),
          cropBox: data.cropBox, contextBox: data.contextBox, scores: fused.labels,
          detail: fused.detail, logits: fused.logits, status: data.status,
          // The server reports one `fallback` bit for both ways of ending up
          // uncropped, which is exactly the conflation `crop_rejected` exists to
          // undo, and nothing pools off it any more. Only its own field is read.
          crop_rejected: data.crop_rejected === true,
          is_cropped: data.is_cropped,
          adP: fused.adP,
          verdict: fused.verdict,
          adjacentDetail: fused.adjacentDetail,
          agreement: fused.agreement,
          viewsLanded: views.length, viewsTotal: views.length,
          manual_full_photo: !data.is_cropped,
          detTime: data.detTime, clipTime: data.clipTime, totalTime: data.totalTime
        });
        renderFooterTiming(document.getElementById("footer-device"), document, {
          engineLabel: data.engine_label,
          totalMs: data.totalTime,
          cropMs: data.detTime,
          analyzeMs: data.clipTime,
        });
      } else {
        const res = await classifyImage(slot.bitmap, slot.name, slot.file);
        commitBatchSlot(slots[i], res);
      }
    } catch (err) {
      // One unreadable photo must not take the batch down with it.
      if (slots[i].pending) markComputeFailed(slots[i], err, sendLog);
      else slots[i].error = `Analysis failed: ${err.message || err}`;
      console.error("Error processing", slot.name, err);
    }
    // The crop is a new canvas; give its tile the native resize too.
    if (slots[i].cropCanvas && slots[i].cropCanvas !== slots[i].displayCanvas) {
      await prepareThumbnail(slots[i].cropCanvas, 0.8);
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
    if (!slots[i].bitmap && !slots[i].error) {
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
  // A photo with no File cannot be re-decoded, so for that one the
  // full-resolution frame stays on the record as `sourceCanvas`. Every photo the
  // app's own intake produces has a File - a drop, a paste, a zip entry and the
  // sample fetch all mint one - so this is a photo installed from outside it,
  // and holding the frame is that photo's whole of what it can offer rather
  // than a fallback. The batch path never sets one, so the memory is not spent
  // on photos that did not need it.
  slot.sourceCanvas = res.sourceCanvas ?? null;
  // The ImageBitmap goes: it is the same pixels as the frame just classified,
  // and a decoded copy of a 12-megapixel photograph is the largest thing a photo
  // holds.
  //
  // The File stays, though it used to be released here with it. A re-run
  // re-drops the photo through `processFiles`, which takes Files, so releasing
  // it would make every re-run re-encode the photo's own canvas and feed the
  // batch a second generation of JPEG instead of the bytes that were dropped.
  //
  // What that costs is bounded but not zero, and it is not zero for every intake:
  // a dropped or picked file is a reference to bytes the browser holds outside
  // its heap, but a zip entry, a clipboard paste and a sample fetch all build the
  // File from an in-memory Blob. For those, a session that keeps the photos on
  // screen now also keeps their encoded bytes - against a `displayCanvas` that is
  // a fraction of the size, and bounded per photo rather than linear in the
  // gallery, but not nothing.
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
  releasePhotoUrl(deleted);
  releaseFullCanvas(deleted);
  previews.splice(idx, 1);
  includedIndices = shiftIncluded(includedIndices, idx);
  // Follow the photo, not the index. Deleting anything before the selected photo
  // shifts every later photo down one, so the selection has to move with it -
  // otherwise deleting the leftmost tile silently switched the gallery to a
  // different photo while the highlighted tile stayed where it was. The clamp
  // alone only handled the case where the selection fell off the end.
  selectedIndex = shiftSelected(selectedIndex, idx, previews.length);
  // The strip is re-rendered either way. It used to be re-rendered only when a
  // photo survived, which left the deleted tile in the DOM with the gallery
  // hidden around it: a tile outliving the photo it was built for, held alive by
  // the cache, with its handlers still bound to an index that no longer existed.
  renderThumbnails();
  updatePooling(EMB, previews, includedIndices);
  if (previews.length === 0) {
    document.getElementById("gallery-section").style.display = "none";
    document.getElementById("results-table-section").style.display = "none";
  } else {
    renderActivePhoto();
    renderResultsTable(previews);
  }
}

// ---- UI Rendering & Navigation ----

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

// A stable DOM id per photo, for the checkbox's label. Minted once and kept for
// the photo's life, so it does not change when the photo's index does.
const inputIds = new WeakMap();
let inputIdSeq = 0;
function inputIdFor(p) {
  let id = inputIds.get(p);
  if (!id) { id = `strip-in-${++inputIdSeq}`; inputIds.set(p, id); }
  return id;
}

/**
 * Build a tile's DOM once, for the photo it will show for as long as it lives.
 *
 * No index is captured. Every handler reads `node.idx`, which `renderThumbnails`
 * writes on each render, so a tile reused after a photo before it was deleted acts
 * on the photo it now shows.
 *
 * Capturing the index at build time is what made three separate defects out of
 * one: clicking the tile labelled "View photo 2: photo_C.jpg" selected photo_D,
 * clicking one checkbox toggled a different tile's checkbox, and three ticked
 * boxes reached the pooled card as fewer photos than were ticked. The delete
 * button was re-pointed on every render, which is exactly why it was the one that
 * worked - and why the other two went unnoticed for so long.
 *
 * Child order is select, include, delete, so the tab order matches the visual
 * order and the destructive action is last.
 */
function buildTile() {
  const tile = document.createElement("div");

  const btn = document.createElement("button");
  btn.className = "tile-btn";
  btn.type = "button";

  const img = document.createElement("img");
  btn.appendChild(img);

  const num = document.createElement("span");
  num.className = "number";
  btn.appendChild(num);

  const badgeEl = document.createElement("span");
  btn.appendChild(badgeEl);

  // The checkbox is its own interactive element, pointed at by an explicit
  // label. It used to sit inside a <label> with no text, which gave it no
  // accessible name in any state, and put a <button> in the same corner of the
  // tile for the browser to retarget a click onto.
  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.className = "thumb-optin";

  const delBtn = document.createElement("button");
  delBtn.className = "tile-delete-btn";
  delBtn.type = "button";
  delBtn.innerHTML = "&times;";

  const node = { tile, delBtn, btn, img, num, badge: badgeEl, chk, idx: -1 };

  btn.onclick = () => selectPhoto(node.idx);
  chk.onchange = () => {
    if (chk.checked) includedIndices.add(node.idx);
    else includedIndices.delete(node.idx);
    renderThumbnails();
    updatePooling(EMB, previews, includedIndices);
  };
  delBtn.onclick = (e) => {
    e.stopPropagation();
    deletePhoto(node.idx);
  };

  tile.append(btn, chk, delBtn);
  return node;
}

function renderThumbnails() {
  const strip = document.getElementById("thumbnail-strip");
  updateStripActions();
  // With the strip's own actions, and for the same reason: whether the engine
  // re-run belongs on the page is a fact about the photos as much as about the
  // controls, and it changes wherever the photos do - a batch landing, a photo
  // deleted, a re-classification settling.
  updateReprocessButton();

  // The strip is the only writer of `includedIndices`, so this is where an index
  // is made valid. `updatePooling` drops an index it cannot resolve, silently,
  // and that silence is how three ticked boxes reached a pooled card counting one
  // of them.
  includedIndices = validateIncluded(includedIndices, previews.length);

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
      node = buildTile();
      tileNodes.set(p, node);
    }
    // Whether this tile can already be in the right place, read before `idx` is
    // overwritten: a tile keeps its index exactly when nothing before it was
    // added or removed, so the tiles before it kept theirs too and none of them
    // moved - which means it is still ahead of them, where it belongs.
    //
    // That implication only holds while nothing is *replaced* rather than added
    // or removed: a tile whose index is unchanged can still have lost its
    // neighbours, if the tiles before it were swapped one-for-one or reordered.
    // No caller does that today - `previews` is appended to, prepended to,
    // filtered and spliced, never reordered within a render - so this is safe
    // now and wrong-by-omission if that ever changes. A caller that adds a sort
    // must revisit this line rather than trust it.
    const alreadyInPlace = node.idx === idx;
    node.idx = idx;

    // A photo still being analyzed is visibly unsettled: greyed tile, pending
    // badge, and it cannot be opted into the pooled result yet.
    node.tile.className = "tile" + (selectedIndex === idx ? " active" : "") +
      (!includedIndices.has(idx) ? " excluded" : "") + (p.pending ? " pending" : "");

    // One string for both the tooltip and the accessible name: a delete button
    // whose tooltip said "Remove photo_C.jpg" while its label said "Remove photo
    // 3: photo_C.jpg" is the inconsistency this change exists to remove.
    node.delBtn.title = removeLabel(p, idx + 1);
    node.delBtn.setAttribute("aria-label", removeLabel(p, idx + 1));

    node.btn.setAttribute("aria-label", viewLabel(p, idx + 1));
    // The selection is announced, not only drawn: a border is not a state a
    // screen reader can report.
    node.btn.setAttribute("aria-current", selectedIndex === idx ? "true" : "false");

    node.chk.id = inputIdFor(p);

    // The select button is never disabled in any state, and this is where that is
    // true rather than merely intended: a photo whose classifier failed or has
    // not run yet is exactly the one whose state the user needs to see.
    node.btn.disabled = !canView(p);

    // A queued photo has no canvas yet: it gets a greyed placeholder tile that
    // resolves to the real image as soon as its own decode finishes. The alt is
    // empty in that state, so the filename does not render over the tile.
    const src = p.cropCanvas || p.displayCanvas;
    if (src) {
      setImgSrc(node.img, thumbnailUrl(src, 0.8));
      node.img.className = "";
      node.img.alt = p.name;
    } else {
      node.img.removeAttribute("src");
      node.img.className = "thumb-placeholder";
      node.img.alt = "";
    }

    node.num.textContent = `${idx + 1}`;

    const b = badge(p);
    node.badge.className = b.className;
    node.badge.textContent = b.glyph;
    // A badge that cannot be acted on has to say so on the badge. "✕" alone said
    // only that no mosquito was detected, which reads as a crop failure rather
    // than as "this control is off, and here is why" - the whole of which was the
    // report that started this: a tile that looks inert and does not explain.
    node.badge.title = b.title;

    // The one place a photo's own verdict is visible without selecting it, so an
    // excluded photo is never only knowable from the contribution table. The
    // same string is the checkbox's accessible name and its tooltip, so the two
    // cannot disagree - and a closed checkbox never claims it can be included.
    const why = checkLabel(p, idx + 1);
    node.chk.setAttribute("aria-label", why);
    node.chk.title = why;
    node.chk.checked = includedIndices.has(idx);
    node.chk.disabled = !contributesToPool(p);

    // One appendChild on an already-present child moves it to the end, which is
    // how the strip is put into index order after a deletion - so it has to
    // happen for every tile whose index moved, and only for those. Doing it for
    // the rest too is a real remove-and-insert per tile per render, on the one
    // path that runs n times per photo of a batch.
    if (!alreadyInPlace) strip.appendChild(node.tile);
  });

  scrollSelectedIntoView();
}

/**
 * Bring the selected tile inside the strip's own scroll box.
 *
 * A selection the user cannot see is a selection that did not happen as far as
 * the page is concerned. With a dozen photos the strip overflows, and the arrow
 * keys or the gallery arrows walked the selection straight off the end of it.
 *
 * The strip's `scrollLeft` is written directly rather than through
 * `scrollIntoView`, which walks up the tree and scrolls whatever ancestor it
 * finds - including the page, which is a layout shift the strip has no business
 * causing.
 *
 * Both rect reads below force a synchronous layout of the whole document, over a
 * strip and a results table the render that just preceded them rebuilt. This
 * runs at the end of every render and a render runs once per photo as a batch
 * lands, so the cost is paid n times per batch for an answer that only changes
 * when the selection does - and a batch never changes the selection. The guard
 * is what makes it once.
 */
function scrollSelectedIntoView() {
  const photo = previews[selectedIndex];
  if (!scrollGuard.needsScroll(photo)) return;
  const strip = document.getElementById("thumbnail-strip");
  const node = tileNodes.get(photo);
  if (!strip || !node) return;
  const pad = 8;
  const stripBox = strip.getBoundingClientRect();
  const tileBox = node.tile.getBoundingClientRect();
  // Rects, not `offsetLeft`: an element's offsetParent is the nearest positioned
  // ancestor, which is not the scrolling box, so offsetLeft is not an offset into
  // this strip's content and scrolling by it lands somewhere else entirely.
  if (tileBox.left < stripBox.left + pad) {
    strip.scrollLeft -= stripBox.left + pad - tileBox.left;
  } else if (tileBox.right > stripBox.right - pad) {
    strip.scrollLeft += tileBox.right - (stripBox.right - pad);
  }
  scrollGuard.record(photo);
}

function setAllSelected(on) {
  previews.forEach((p, i) => {
    if (contributesToPool(p) && on) includedIndices.add(i);
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
  previews.forEach((p) => { p.removed = true; releasePhotoUrl(p); });
  previews.length = 0;
  // The whole cache, not the frames of the photos that are going: a photo that
  // is merely evicted from a two-slot cache leaves its frame behind here, and an
  // emptied gallery holding two photographs' pixels is the leak this path
  // exists to stop.
  resetFullCanvasCache();
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
// rather than sitting there as no-ops. A disabled control that does not say why
// is indistinguishable from a broken one.
const STRIP_ACTIONS = {
  "btn-select-all": ["Check all photos that can be pooled", "No photos to act on"],
  "btn-select-none": ["Uncheck all photos", "No photos to act on"],
  "btn-delete-all": ["Delete all photos", "No photos to act on"],
};
function updateStripActions() {
  const empty = previews.length === 0;
  for (const [id, [label, why]] of Object.entries(STRIP_ACTIONS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.disabled = empty;
    el.setAttribute("aria-label", label);
    el.title = empty ? why : label;
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
  wireWholeFrameToggle();
  updateStripActions();
}

// The whole-frame checkbox in the gallery header row: one control, no panel.
//
// A photo's verdict describes the views it was fused from, so turning this off
// leaves every photo already on screen holding a verdict that was fused from two
// views while the control says one. The photos are therefore re-classified rather
// than left to disagree with the setting, and each is marked pending while its
// views are re-run so the pooled card is never read as settled on a pool that is
// about to change.
function wireWholeFrameToggle() {
  const box = document.getElementById("chk-whole-frame");
  if (!box) return;
  includeWholeFrame = readIncludeWholeFrame(
    // `localStorage` throws in a context where storage is disabled, and reading
    // the property is itself the throwing access; readIncludeWholeFrame takes
    // the store as an argument so it can be exercised without one.
    (() => {
      try {
        return localStorage;
      } catch {
        return null;
      }
    })(),
  );
  box.checked = includeWholeFrame;
  box.addEventListener("change", () => {
    const on = box.checked;
    if (on === includeWholeFrame) return;
    includeWholeFrame = on;
    // `writePref` reports whether the value stuck rather than throwing, so a
    // browser that refuses the write (private mode, quota) leaves the setting
    // working for this session and says so, instead of the UI implying a
    // preference that will be gone on reload.
    const stored = writePref(WHOLE_FRAME_KEY, on ? "true" : "false");
    if (!stored) sendLog("pref_not_stored", { key: WHOLE_FRAME_KEY });
    sendLog("whole_frame_toggled", { includeWholeFrame: on, photos: previews.length });
    // A toggle is about every photo on screen, so it withdraws a re-run's scope
    // rather than inheriting it. `request()` during a re-run's pass sets the
    // runner's follow-up flag, and that follow-up is what re-fuses under the new
    // setting - if it ran still scoped to the re-run's photos, every photo the
    // re-run did not touch would be left pooled under the setting the user just
    // turned off. The pass already in flight keeps the set it read at its start;
    // this only decides what the follow-up sees.
    rerunPhotos = null;
    reclassifyRunner.request();
  });
}

// One pass over the photos already on screen, run under `reclassifyQueue`.
//
// The scheduling - one photo at a time, one pass per toggle - is in that module
// and not here, because the thing that has to hold is "at most one inference in
// flight", and that is checkable there without the model. This side supplies the
// three things it needs: which photos are due, how to classify one, and what the
// setting is at this instant.
//
// `onSettled` renders once for the whole pass rather than once per photo: the
// runner is what makes that possible, and it is why a toggle no longer paints a
// dozen times before the first inference has started.
const reclassifyRunner = createReclassifyRunner({
  // Photos that were never classified, or whose classification failed, are left
  // alone: there is nothing to re-fuse, and their tile already says why.
  //
  // `rerunPhotos` narrows a pass to the photos an engine-switch re-run is
  // re-classifying. Without it a re-run would be indistinguishable from a
  // whole-frame toggle and would re-fuse the photos the batch has just scored -
  // running the classifier a second time over results it produced moments ago.
  // A whole-frame toggle sets it to null, and so re-classifies the whole gallery.
  due: () => previews
    .filter((p) => {
      if (!p || p.removed || !p.displayCanvas) return false;
      if (rerunPhotos) return rerunPhotos.has(p);
      return !p.pending && !p.error;
    }),
  currentSetting: () => includeWholeFrame,
  classify: async (p) => {
    // The index is looked up HERE, not read from `due`'s snapshot. A pass is
    // seconds long and the strip's delete button stays live throughout it, and
    // deleting one photo shifts every later one down - so a snapshotted index is
    // stale for the rest of the pass and `ownsRecompute`'s `previews[idx] === p`
    // drops the result of every photo behind the deleted one, leaving each stuck
    // on the `pending` that `beginRecompute` set. The batch path has always
    // resolved by `indexOf` for exactly this reason.
    const rev = beginRecompute(p);
    renderThumbnails();
    try {
      await classifyViews(p, previews.indexOf(p), rev, p.cropCanvas, p.cropBox);
    } catch (err) {
      if (err instanceof Superseded || !ownsRecompute(p, previews, previews.indexOf(p), rev)) return;
      console.error("Reclassification failed:", err);
      markComputeFailed(p, err, sendLog);
    }
  },
  onSettled: () => {
    renderThumbnails();
    renderActivePhoto();
    updatePooling(EMB, previews, includedIndices);
    renderResultsTable(previews);
    // A re-run settles through this same runner, so the event says which of the
    // two reasons the pass ran - a log line reading "whole frame reclassified"
    // for a pass the whole-frame setting never changed would be unreadable.
    if (rerunPhotos) {
      sendLog("reprocess_reclassified", { passes: reclassifyRunner.passes, photos: rerunPhotos.size });
    } else {
      sendLog("whole_frame_reclassified", { passes: reclassifyRunner.passes, photos: previews.length });
    }
  },
});

/**
 * The photos an engine-switch re-run is re-classifying, or null when no re-run
 * is in progress. Scopes the shared runner to that set, so the batch and the
 * re-run can use one serial scheduler instead of two racing for the single
 * inference slot.
 */
let rerunPhotos = null;

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

/**
 * What the zoomed panel says when there is no image to put in it.
 *
 * Reaching this branch means the photo has no pixels at all - a decode that has
 * not finished, or one that failed. It used to say "Using full photo" or "No
 * mosquito detected" here, and both are statements about a classification that
 * has not happened: a photo still queued was reported as one where no mosquito
 * was found, and two queued photos were indistinguishable in the viewer, so
 * selecting one of them changed nothing the user could see. The message names the
 * photo and says what is actually true about it.
 */
function emptyPanelMessage(p) {
  const ref = p.name || "This photo";
  if (p.error) return `${ref} could not be analysed: ${p.error}`;
  if (p.pending) return `${ref} has not been analysed yet`;
  return `${ref} could not be displayed`;
}

function renderActivePhoto() {
  if (!previews.length || !previews[selectedIndex]) return;
  const p = previews[selectedIndex];

  // 1. Render Left Panel (Full Photo)
  const surfaceFull = document.getElementById("crop-surface-full");
  fitSurface(surfaceFull, p.displayCanvas);
  const fullImg = document.getElementById("full-img");
  // A photo whose decode has not finished has no canvas to show yet. Hide the
  // image rather than leaving a broken-icon with alt text over an empty panel;
  // the pending notice beside it says what is happening.
  if (p.displayCanvas) {
    // The original bytes by object URL; a photo with no File falls back to an
    // encode of its display canvas.
    setImgSrc(fullImg, photoObjectUrl(p) ?? canvasUrl(p.displayCanvas, 0.9));
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
  const zoomSource = p.contextCanvas || p.displayCanvas;
  if (zoomSource) {
    surfaceZoomed.style.width = "100%";
    surfaceZoomed.style.height = "100%";
    setImgSrc(contextImg, (zoomSource === p.displayCanvas && photoObjectUrl(p)) || canvasUrl(zoomSource, 0.9));
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
    cropEmpty.textContent = emptyPanelMessage(p);
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
    const vText = (p.verdict && !p.pending && !p.error) ? claimSentence(p.verdict) : "";
    verdictEl.textContent = vText;
    verdictEl.className = `uncertain${vText ? " shown" : ""}`;
    verdictEl.title = vText;
  }
  // Species the loaded head cannot tell apart are ONE row here, carrying the
  // class phrase and the class's score. Three identical bars under three names is
  // a ranking that asserts the model separated them, and it is why one species of
  // each group appeared to win essentially every tie it was in.
  const sortedScores = mergeUnresolvable(
    Object.entries(p.detail).sort((a, b) => b[1] - a[1]),
    (e) => e[1],
    (e) => e[0],
  );
  for (const { name, score } of sortedScores) {
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

  // A photo the gate called not-a-mosquito gets the class it was refused as on
  // top of the list and the mosquito ranking dropped below it, because a
  // sixteen-row ranking of species this photo is not is the exact readout that
  // made a photograph of paper come back as a confident mosquito. The species
  // scores are still in p.detail for the pooling maths - they are simply not the
  // thing to put in front of someone here.
  //
  // The row reads the VERDICT, not the highest-scoring adjacent class. Those are
  // not the same thing: a nuisance refusal names no adjacent family at all, and on
  // a head whose adjacent rows are placeholders that all score equally the top of
  // that ranking is whichever row the file happens to list first, printed at the
  // 0.4% it genuinely holds.
  const refused = nonMosquitoLabel(p.verdict);
  if (refused) {
    const notMosquito = document.createElement("div");
    notMosquito.className = "score-item is-not-mosquito";
    const pct = (refused.p * 100).toFixed(1);
    notMosquito.innerHTML = `
      <div class="score-item-header">
        <span class="species-name-wrap">${speciesLabelHtml(refused.name)}</span>
        <strong>${pct}%</strong>
      </div>
      <div class="score-item-track">
        <div class="score-item-fill" style="width: ${Math.max(0, Math.min(100, refused.p * 100))}%"></div>
      </div>
    `;
    scoreList.insertBefore(notMosquito, scoreList.firstChild);
    for (const item of scoreList.querySelectorAll(".score-item:not(.is-not-mosquito)")) {
      item.style.display = "none";
    }
  }

  // The status line names the photo and, when one failed, why. A pending
  // photo's p.status describes work in flight ("decoding… detecting…") and is
  // deliberately not shown: the name alone, with the score list dimmed below it,
  // is the whole signal.
  const statusText = p.error
    ? `analysis failed: ${p.error.replace(/^Classification failed: /, "")}`
    : (p.pending ? "" : p.status);
  const ref = photoRef(p, selectedIndex + 1);
  document.getElementById("photo-name").textContent =
    statusText ? `${ref} · ${statusText}` : ref;
  // The same reference, in the strip's own hint row, so the filename a submitter
  // recognises is visible without scrolling past the viewer to find it.
  const refEl = document.getElementById("photo-ref");
  refEl.textContent = ref;
  refEl.title = ref;
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
  // Drawing a crop re-runs inference, so a released tab has to come back first.
  // A drag that started before the tab was hidden and ended after it was
  // released lands here with no sessions, and used to compute against null.
  if (idleRelease.released()) await idleRelease.ensure();
  const p = previews[idx];
  // The photograph's own dimensions, which is what the box is in. Not the
  // canvas the photo holds: that one is display-sized, and a box scaled by it
  // is a fraction of a different picture.
  const frame = photoFrame(p);
  if (!frame) return;
// Surface fractions -> image fractions through the same contain window
  // cropBoxInFullSurface() draws through, so a drag lands on the pixels the
  // user pointed at rather than on the same fraction of a wider photo.
  //
  // The window is per-axis, not a single k: contain fits one axis to the photo
  // and letterboxes the other, so scaling both by one factor would stretch
  // whichever axis was not letterboxed.
  const { kx, ox, ky, oy } = fitMapping(
    document.getElementById("crop-surface-full"), frame, "contain"
  );
  const r = [kx * rect[0] + ox, ky * rect[1] + oy, kx * rect[2] + ox, ky * rect[3] + oy];
  const x1 = Math.max(0, Math.min(frame.width, Math.round(r[0] * frame.width)));
  const y1 = Math.max(0, Math.min(frame.height, Math.round(r[1] * frame.height)));
  const x2 = Math.max(0, Math.min(frame.width, Math.round(r[2] * frame.width)));
  const y2 = Math.max(0, Math.min(frame.height, Math.round(r[3] * frame.height)));

  if (x2 - x1 < 10 || y2 - y1 < 10) return;

  sendLog("manual_crop", { target: "full", rect: [x1, y1, x2, y2] });
  return executeCrop(p, idx, [x1, y1, x2, y2], t0);
}

// Execute Crop from Zoomed 50% Context surface (fine-tuning)
async function applyCropFromZoomedSurface(idx, rect, t0) {
  if (idleRelease.released()) await idleRelease.ensure();
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

  // Clamped to the photograph, not to a canvas: `contextBox` is in the photo's
  // pixels and so is the box this produces.
  const frame = photoFrame(p);
  if (!frame) return;
  const x1 = Math.max(0, Math.min(frame.width, Math.round(ctx_x1 + r[0] * ctx_w)));
  const y1 = Math.max(0, Math.min(frame.height, Math.round(ctx_y1 + r[1] * ctx_h)));
  const x2 = Math.max(0, Math.min(frame.width, Math.round(ctx_x1 + r[2] * ctx_w)));
  const y2 = Math.max(0, Math.min(frame.height, Math.round(ctx_y1 + r[3] * ctx_h)));

  if (x2 - x1 < 10 || y2 - y1 < 10) return;

  sendLog("manual_crop", { target: "zoomed", rect: [x1, y1, x2, y2] });
  return executeCrop(p, idx, [x1, y1, x2, y2], t0);
}

// One view of one photo, scored. Returns the pieces fusion needs (the species
// posteriors and the nuisance mass they were normalised against) rather than a
// finished verdict, because the verdict is the fused one.
//
// `engine` is passed rather than read, because a two-view pass spans several// Classify every view of one photo and commit the fused verdict, once per view
// as each lands so a photo shows progress rather than sitting blank until its
// last inference is done.
//
// The rev guard is the same one a single-view commit used, checked before and
// after every view: a photo deleted mid-flight, or superseded by a newer crop
// release, must not be painted by an inference that started before either. With
// two views per photo that check runs twice as often, which is the point - the
// second view has strictly more opportunity to arrive late and stale.
async function classifyViews(p, idx, rev, cropCv, cropBox) {
  // The whole-frame view is the photograph's own pixels, so it needs the frame;
  // the crop is re-cut from that same frame rather than from the record's
  // display-sized copy, so a re-run scores what the original release scored. One
  // decode covers both, and the cache holds it for the caller above as well.
  const frame = photoFrame(p);
  const fullCv = (frame ? await fullCanvasFor(p) : null) ?? null;
  const wholeCv = fullCv ?? p.displayCanvas;
  // Read once, so a switch between the crop's view and the whole frame's cannot
  // fuse two engines and stamp the result with whichever the pass ended on. The
  // calibration each softmax applies follows this key; the session and head they
  // read are the module's, and the whole-frame runner - which is what drives this
  // path - only runs while the engine is usable.
  const engine = currentEngine;
  // Re-cut from the frame when there is one, so the crop view is full
  // resolution however the record is holding the crop. With no frame the record's
  // own crop is what there is, and this is the degraded case the photo's status
  // says nothing about - which is why every photo the app creates has a File.
  const cutCropCv = fullCv && cropBox ? cutCrop(fullCv, frame, cropBox) : cropCv;
  const views = viewsFor(wholeCv, cutCropCv, cropBox);
  const landed = [];
  let dropped = false;
  // The fused result for the views that have landed, kept for the log line below.
  // The loop recomputes it once per view as each lands; the last one is the pool
  // of every view, which is what a reader of `views_fused` wants to see.
  let fused = null;

  for (const view of views) {
    await afterNextPaint();
    if (!ownsRecompute(p, previews, idx, rev)) { dropped = true; break; }
    const v = engine === "server-gpu"
      ? await classifyViewServer(fullCv, p.name, view.box)
      : await classifyViewLocal(view.canvas, engine);
    if (!ownsRecompute(p, previews, idx, rev)) { dropped = true; break; }
    landed.push(v);
    // Paint what is known so far. The fused verdict is recomputed from the views
    // that have landed, so the first view's paint is that view's own softmax
    // unchanged, and the second replaces it with the pool of the two.
    fused = applyViews(p, landed, views.length, engine);
    renderThumbnails();
    renderActivePhoto();
    updatePooling(EMB, previews, includedIndices);
    renderResultsTable(previews);
  }

  if (dropped) {
    sendLog("views_superseded", { name: p.name, rev, currentRev: p.rev, landed: landed.length });
    return { dropped: true };
  }
  // Numbers, not conclusions. `views_fused` alone says a thing happened; what a
  // reader needs is the distribution it produced, because an exact-zero species
  // posterior and a confident one look identical from the outside.
  sendLog("views_fused", {
    name: p.name,
    rev,
    views: landed.length,
    ...posteriorSummary(fused || {}),
    ...verdictSummary(p),
  });
  return { dropped: false };
}

// Write the fused verdict for the views that have landed: commitScores for the
// verdict itself, then the multi-view bookkeeping on top. The photo stays
// pending until every view is in, so a tile is never shown as settled on a
// partial pool that is about to be replaced by the full one.
function applyViews(p, landed, total, engine) {
  const fused = fuseViews(landed);
  commitScores(p, fused, engine);
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
  const started = t0 ?? performance.now();

  const frame = photoFrame(p);
  const fullCv = frame ? await fullCanvasFor(p) : null;
  if (!frame || !fullCv) {
    // No bytes and no retained pixels: this photo cannot be cut. Said on the
    // photo rather than thrown, because the crop the user drew is still a real
    // rectangle over a real photograph and only its analysis is unavailable.
    sendLog("crop_no_source", { name: p.name, reason: p.file ? "decode_failed" : "no_file" });
    markComputeFailed(p, "This photo has no source image left to crop", sendLog);
    renderThumbnails();
    return;
  }

  const cw = Math.max(1, bx2 - bx1);
  const ch = Math.max(1, by2 - by1);
  const cropCv = cutCrop(fullCv, frame, cropBox);
  const { contextCanvas, contextBox } = extractContextCrop(fullCv, frame, cropBox);

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
  // Drawing a new crop is the opposite of giving the old one up.
  p.revertedToFull = false;
  p.crop_rejected = false;

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
    if (err instanceof Superseded || !ownsRecompute(p, previews, idx, rev)) {
      rec.dropped = true;
      return;
    }
    console.error("Crop classification failed:", err);
    markComputeFailed(p, err, sendLog);
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
    is_cropped: p.is_cropped === true,
    detScore: round4(p.detScore ?? p.detectionScore ?? null),
    ...posteriorSummary({ spP: scoreVector(p), adP: p.adP }),
    ...verdictSummary(p),
  });
}

async function revertToFullPhoto(idx) {
  const p = previews[idx];
  const frame = photoFrame(p);
  const started = performance.now();
  sendLog("revert_to_full", { name: p.name });

  // Phase one, as in executeCrop: the full photo is displayed immediately. What
  // is displayed is the display canvas; what is classified is the frame, which
  // `classifyViews` fetches. Showing the frame here would put 45 MiB back on
  // every reverted photo, which is the retention this change exists to remove.
  const rev = beginRecompute(p);
  p.cropCanvas = p.displayCanvas;
  p.contextCanvas = p.displayCanvas;
  p.cropBox = null;
  p.contextBox = [0, 0, frame?.width ?? 0, frame?.height ?? 0];
  p.status = "manual full photo";
  p.is_cropped = false;
  p.manual_full_photo = true;
  // The user gave this photo up on its crop, which is a decision about a photo
  // that HAD one - and nothing else in the app records that. Without it the box
  // is simply null, indistinguishable from the detector having found nothing,
  // and an engine-switch re-run re-detects over the photo and takes the
  // decision back with no undo. `executeCrop` clears it.
  p.revertedToFull = true;
  p.crop_rejected = false;

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
    const r = await classifyViews(p, idx, rev, null, null);
    if (r.dropped) {
      rec.dropped = true;
      sendLog("revert_superseded", { name: p.name, rev, currentRev: p.rev });
      return;
    }
    p.status = "manual full photo";
    rec.scoresMs = Math.round(performance.now() - started);
    rec.topSpecies = Object.keys(p.scores)[0];
  } catch (err) {
    if (err instanceof Superseded || !ownsRecompute(p, previews, idx, rev)) {
      rec.dropped = true;
      return;
    }
    console.error("Revert classification failed:", err);
    markComputeFailed(p, err, sendLog);
    p.status = "manual full photo · analysis failed";
    rec.failed = p.error;
    rec.scoresMs = Math.round(performance.now() - started);
  }

  renderThumbnails();
  renderActivePhoto();
  updatePooling(EMB, previews, includedIndices);
  renderResultsTable(previews);
}






// ---- Releasing memory while the tab is in the background (#36) ----
//
// Several tabs of this app open at once is the normal case. Each holds an
// onnxruntime session (the classifier alone is 1.26 GB of weights plus whatever
// the execution provider has put on the device) and a WebGPU device, and
// browsers keep background tabs alive, so all of it adds up.
//
// A hidden tab therefore hands its memory back after a grace period and takes it
// back when it is next needed. What is kept across the release is everything
// cheap and everything the reader would be angry to lose: the `File`s, the
// thumbnails, and every computed result. What goes is the sessions, the device,
// and the decoded bitmaps - all of which are rebuilt on demand, the weights from
// the Cache API, so the cost of returning is a load the reader would have paid
// anyway.
//
// The decisions that have to be right - the grace period, the generation
// counter that stops a slow release landing after a restore, and the busy check
// that keeps a release out of a running batch - live in `idleRelease.ts` and are
// tested there. This is the wiring.

async function releaseIdleMemory() {
  const sessions = Object.values(clipSessions);
  const hadDetector = Boolean(sessDet);
  // Every session, not just the current one: a user who switched engines twice
  // has three sessions alive, and onnxruntime-web only empties its weight cache
  // when the LAST session is released - so releasing a subset frees nothing.
  const toRelease = [...sessions.map((entry) => entry?.sess)];
  if (sessDet) toRelease.push(sessDet);

  // The device is cleared and the app's own device destroyed by the same call,
  // and only after every `release()` has resolved - see `gpuRelease.ts`, which
  // documents why the backend's device is not destroyed here.
  const freed = await releaseGpuResources({ sessions: toRelease, ort, ownedDevice: appOwnedDevice });
  appOwnedDevice = null;

  for (const key of Object.keys(clipSessions)) delete clipSessions[key];
  sessClip = null;
  sessDet = null;
  loadedClipEngine = null;
  window.modelsReady = false;

  // Bitmaps still held by a photo mid-decode. `commitBatchSlot` already
  // releases the ones a finished photo owned, so this is the decode pool's
  // only, and it is what makes releasing mid-batch safe enough to be worth it:
  // the slots whose bitmap goes are exactly the ones that have not started
  // their inference, and a slot with no bitmap is re-decoded on the next run.
  for (const p of previews) {
    if (p.bitmap && typeof p.bitmap.close === "function") {
      try {
        p.bitmap.close();
      } catch {
        // Already closed. Nothing to reclaim.
      }
      p.bitmap = undefined;
    }
  }

  updateReprocessButton();
  sendLog("idle_released", {
    sessions: sessions.length + (hadDetector ? 1 : 0),
    // What actually came back: `releasedSessions` is the count whose
    // `release()` resolved, which is what destroys the weight `GPUBuffer`s.
    // A lower number than `sessions` means some weights are still on the device.
    freed: freed.releasedSessions,
    unreleased: freed.failedSessions,
    deviceDestroyed: freed.deviceDestroyed,
  });
}

async function restoreIdleMemory() {
  // Counted on the seam: a tier-1 spec aborts every weights fetch, so the only
  // thing it can observe about a restore is that it was reached at all. The
  // failure this pins is the restore never being entered, which leaves the tab
  // inert with nothing on the page saying why.
  idleRestoreAttempts++;
  if (currentEngine === "server-gpu") {
    // Nothing was held locally: the server does the inference.
    window.modelsReady = true;
    updateReprocessButton();
    drainQueuedBatches();
    return;
  }
  await loadWebGPUModels(currentEngine);
  updateReprocessButton();
  drainQueuedBatches();
}

const idleRelease = createIdleRelease({
  // A tab that flickers between two windows must not pay a reload it did not
  // need, and the reader switching back and forth is the common case here - a
  // reference page open beside the app is how this gets used.
  delayMs: 60_000,
  release: releaseIdleMemory,
  restore: restoreIdleMemory,
  // Read when the timer fires, not when the tab was hidden: work dropped before
  // the tab went to the background is still work.
  isBusy: () => isProcessingBatch || reprocessRunning || reclassifyRunner.inFlight,
  onRelease: ({ waitedMs }) => sendLog("idle_release_timer_fired", { waitedMs }),
});

function wireIdleRelease() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      idleRelease.hidden();
      sendLog("tab_hidden");
    } else {
      idleRelease.visible();
      sendLog("tab_visible", { wasReleased: idleRelease.released() });
    }
  });
}

// ---- Initialization & Event Listeners ----
window.addEventListener("DOMContentLoaded", () => {
  // First, so the address bar names the build before anything else runs: the
  // whole point is reading the SHA off the URL when the page misbehaves.
  stampBuildSha();

  // The same SHA, this time where it is visible: the footer's build link. It
  // renders nothing in a local build, which has no VITE_COMMIT_SHA.
  renderBuildLink(document.getElementById("footer-build"), document);

  setupCropSurfaces();
  wireStripActions();
  wireReprocessButton();
  wireIdleRelease();

  // The viewer-aspect cache lives in the crop geometry module; these listeners
  // are wired here because they belong to the page's lifetime, not to that
  // module's, and a module that attached them at import time would make
  // importing it an act with a side effect.
  window.addEventListener("resize", invalidateViewerAspectCache);
  window.addEventListener("orientationchange", invalidateViewerAspectCache);
  // A resize changes the strip's own box without moving the selection, so the
  // tile that was in view before it need not be in view after it - and the
  // scroll guard, which can only see the selection change, would not notice.
  window.addEventListener("resize", invalidateScrollGuard);
  window.addEventListener("orientationchange", invalidateScrollGuard);
  // ...and a tile can change size with no resize event at all: `@media (pointer:
  // coarse)` sizes tiles differently from a mouse-driven layout, so a hybrid
  // whose input capability changes (a tablet undocked, a convertible switched to
  // its keyboard) moves every tile without the window changing. There is no
  // event for that, so the guard is invalidated on the next render that follows
  // a match-media flip.
  if (window.matchMedia) {
    const coarse = window.matchMedia("(pointer: coarse)");
    const onPointerChange = () => {
      invalidateScrollGuard();
      renderThumbnails();
    };
    if (typeof coarse.addEventListener === "function") coarse.addEventListener("change", onPointerChange);
    else if (typeof coarse.addListener === "function") coarse.addListener(onPointerChange);
  }

  // initRouter captures the classifier's own title once and returns the handler
  // that applies a route against it, so both the initial render and every
  // subsequent hashchange go through the same function.
  //
  // The callback is the engine's start signal, and it fires on the first route
  // that resolves to the classifier - at boot if that is where the page opened,
  // at the navigation that gets there if it opened on the species guide, which
  // is a route of this shell and must not pay for 1.2 GB of weights.
  const onRouteChange = initRouter(() => {
    initEngine().catch(err => {
      console.error("Engine initialization error:", err);
      setProgress("model", null, null);
      setProgressError(`Error: ${err.message}`);
    });
  });
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

  const savedPooling = readPref("mosquito_pooling");
  if (savedPooling) {
    const radio = document.querySelector(`input[name="pooling-method"][value="${savedPooling}"]`);
    if (radio) radio.checked = true;
  }
  document.querySelectorAll('input[name="pooling-method"]').forEach(r => {
    r.onchange = (e) => {
      writePref("mosquito_pooling", e.target.value);
      updatePooling(EMB, previews, includedIndices);
    };
  });

  const corrSlider = document.getElementById("corr-slider");
  const savedCorr = readPref("mosquito_corr");
  if (savedCorr && corrSlider) {
    corrSlider.value = savedCorr;
    document.getElementById("corr-val").textContent = parseFloat(savedCorr).toFixed(2);
  }
  corrSlider.oninput = (e) => {
    writePref("mosquito_corr", e.target.value);
    document.getElementById("corr-val").textContent = parseFloat(e.target.value).toFixed(2);
    updatePooling(EMB, previews, includedIndices);
  };

  // Arrow Key Navigation
  //
  // Focus follows the selection. Moving the selection with the keyboard while
  // focus stayed on the tile button that was left behind is how a keyboard user
  // ends up pressing Enter on a different photo than the one the highlight is
  // on, which is the same defect as a click landing on the wrong tile.
  window.addEventListener("keydown", (e) => {
    // The handler owns the arrow/Home/End keys only when the user is not
    // operating some other control. The old guard was `instanceof
    // HTMLInputElement`, and a `<select>` is not one - so with the engine
    // dropdown focused, ArrowDown changed the ENGINE and Home/End jumped the
    // dropdown to its last option. See keyNav.ts.
    if (keyEventBelongsElsewhere(describeKeyTarget(e.target), e)) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      selectPhoto(selectedIndex + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      selectPhoto(selectedIndex - 1);
    } else if (e.key === "Home" || e.key === "End") {
      if (!previews.length) return;
      e.preventDefault();
      selectPhoto(e.key === "Home" ? 0 : previews.length - 1);
    } else {
      return;
    }
    tileNodes.get(previews[selectedIndex])?.btn.focus();
  });

  // Warm the sample photos once the page is up, in the background.
  //
  // Deliberately after the engine load is started and never awaited: the model is
  // the long pole and must not queue behind ten images, and the first render
  // must not either. `requestIdleCallback` keeps the download off the frames the
  // user is actually looking at; the setTimeout is the fallback for a browser
  // without it. On the species route the engine load has not started, and the
  // samples are still worth having cached for the navigation that starts it.
  const warmSamples = () => {
    prefetchSamples().catch(err => console.warn("Sample prefetch failed", err));
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(warmSamples, { timeout: 3000 });
  } else {
    setTimeout(warmSamples, 1500);
  }
});

// The per-species scores already committed for a photo, as a vector in head
// order, so a log line can report a distribution rather than a name.
function scoreVector(p) {
  const scores = p && p.scores;
  const head = EMB;
  if (!scores || !head) return null;
  const v = new Array(head.species.length).fill(0);
  for (const name of head.species) v[head.species.indexOf(name)] = scores[name] || 0;
  return v;
}
