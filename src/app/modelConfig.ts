/**
 * The numbers the inference path is built out of: tensor shapes, thresholds,
 * normalisation statistics, and where the model files live.
 *
 * All of it is read-only configuration, so this module depends on nothing and
 * everything else may depend on it. Two of these are load-bearing in a way that
 * is easy to undo by accident - TEMPERATURE and DET_CONF - and their comments
 * say why, which is most of the reason this file exists rather than inlining
 * each constant at its use.
 */
import { PER_GENUS_COSINE_OFFSET } from "../confidence/calibration";
import { DEFAULT_FLOORS, type Floors } from "../confidence/types";
import type { Capability } from "./granularity";

/** Detector input is a square of this side, in pixels. */
export const DET_SIZE = 640;
export const CLIP_SIZE = 224;
export const DET_CONF = 0.70;
export const NMS_IOU = 0.70;
export const CROP_PAD = 0.10;
export const CACHE_NAME = "mosquito-models-v1";

// CLIP's channel normalisation, applied to the 0-1 pixel tensor before it is
// handed to the classifier. Indexed by channel.
export const CLIP_MEAN: readonly number[] = [0.48145466, 0.4578275, 0.40821073];
export const CLIP_STD: readonly number[] = [0.26862954, 0.26130258, 0.27577711];

// Hand-set, deliberately. Fitting the temperature by cross-validation at this
// sample size is actively harmful: each fold independently chose T~8.7 and
// held-out NLL got *worse* (2.172 vs 0.966 at T=1). The optimum is not
// identifiable at n=112. Do not "improve" this by fitting it at runtime.
//
// Module scope, not local to softmaxJoint, because multi-view fusion has to put
// two views on this same scale before it can pool them.
export const TEMPERATURE = 2.5;

// Models live on Cloudflare R2, reached through the bucket's public development
// URL. Objects sit at the root of that host - the dev URL serves the one bucket
// directly, with no bucket-name path segment.
//
// Two hosts were ruled out first. GitHub Releases serve no
// Access-Control-Allow-Origin on either redirect hop, so a browser cannot fetch
// them cross-origin at all. HuggingFace works, but a free account caps at 1 GB
// per repository and bioclip_2_5_fp16.onnx is 1207 MB, so it cannot hold the
// full set however the models are split across repos.
/**
 * Per-genus cosine calibration, and which engines it applies to.
 *
 * `PER_GENUS_COSINE_OFFSET` was fitted on the H/14 embedding cache, correcting a
 * prompt artefact in a zero-shot text head. culico's head is a trained linear
 * probe on a different encoder, so those four numbers are not merely useless for
 * it - applying them would bias its posteriors with a correction derived from a
 * model that has nothing to do with it, and the result would look entirely
 * plausible. So the map is opt-in per engine: only the heads it was fitted
 * against may set it.
 *
 * An engine that omits this gets NO calibration, which is the correct state for
 * a probe -- its intercepts already carry the class priors the offset would
 * otherwise be correcting.
 */
/** The offsets to pass for an engine the calibration was not fitted for. */
const EMPTY_OFFSETS: Readonly<Record<string, number>> = Object.freeze({});

export const CALIBRATED_ENGINES: ReadonlySet<string> = new Set(["webgpu-fp16"]);

/**
 * The cosine offsets to apply for an engine, or an empty map for an engine the
 * calibration was not fitted for.
 *
 * An empty map is NOT the same as no map: `softmaxJoint` defaults to
 * `PER_GENUS_COSINE_OFFSET` when `opts.offsets` is undefined, so an uncalibrated
 * engine has to pass `{}` explicitly to opt out.
 */
export function cosineOffsetsFor(engineKey: string): Readonly<Record<string, number>> {
  return CALIBRATED_ENGINES.has(engineKey) ? PER_GENUS_COSINE_OFFSET : EMPTY_OFFSETS;
}

/**
 * The floors each engine is scored at, where they differ from the shipped ones.
 *
 * `DEFAULT_FLOORS` were fitted on BioCLIP H/14's posteriors. An engine whose head
 * is a different kind of object does not produce posteriors on that scale, and a
 * floor is an absolute threshold on a posterior, so inheriting one is a claim the
 * engine has never been tested for. The per-engine opt-in is the same shape as
 * `CALIBRATED_ENGINES` above: absent means the shipped floors, explicitly.
 *
 * culico's head was refitted in 2026-10-04 (see docs/HEADS.md). It is a trained
 * probe, its posterior is much sharper than the head it replaced, and on the
 * corpora it was fitted on it clears a 0.373 species floor on 70% of photographs
 * at 72% accuracy - against the ~88% the floor was fitted to deliver. Its floors
 * were re-derived from its own selective-accuracy curves, fitted on one half of a
 * held-out corpus and read on the other:
 *
 *   species 0.80   on-corpus 96.7% at 17% coverage; off-corpus 91.6% at 12%
 *   genus   0.90   on-corpus 99.3% at 30% coverage; off-corpus 94.4% at 23%
 *
 * Both meet the ~88% accuracy target the shipped floors were chosen against. The
 * cost is coverage: the app names a species far less often on this engine, which
 * is the correct behaviour for a head this far from its training distribution and
 * not a tuning choice.
 */
const ENGINE_FLOORS: Readonly<Record<string, Floors>> = Object.freeze({
  "webgpu-culico": Object.freeze({
    ...DEFAULT_FLOORS,
    species: 0.80,
    genus: 0.90,
  }),
});

/**
 * The floors to score an engine at. An engine with no entry of its own is scored
 * at `DEFAULT_FLOORS` - the shipped values, on the models they were fitted on.
 */
export function floorsFor(engineKey: string): Floors {
  return ENGINE_FLOORS[engineKey] ?? DEFAULT_FLOORS;
}

export const MODEL_BASE_URL =
  "https://pub-2bbf73b4e93d40c9af925724fbd48d51.r2.dev/";
export const FP16_AVAILABLE = true;

/** One downloadable classifier: where it lives, what to call it, how big it is. */
export interface ModelConfig {
  path: string;
  embedsPath: string;
  label: string;
  name: string;
  size: number;
  /**
   * What this engine's head can name, stated so the dropdown can say so BEFORE
   * the user has chosen it - the head behind an unchosen engine is not loaded,
   * so the words in the selector are the only place this can be said.
   *
   * Reporting does not read it. What the app prints comes from the grouping
   * derived from the head that is actually loaded (see `capabilityOf`), because
   * a refit can change this and cannot change the head. The two are asserted
   * equal in `tests/report-granularity.test.ts`, so a refit that moves an engine
   * from genus to species fails a test rather than leaving a stale label.
   */
  reports: Capability;
}

/**
 * The trailing note on an engine's dropdown option, from its declared
 * capability. Appended to the option's own text rather than replacing it, so the
 * size and the "experimental" marker keep one source each and this only owns the
 * granularity.
 */
export function capabilityNote(reports: Capability): string {
  return reports === "genus" ? " \u00b7 genus only" : "";
}

/**
 * The engines the user can pick, keyed by engine id.
 *
 * A record rather than a union because the engine id reaches this from a DOM
 * value and from the URL query, so it is a string at every call site; an absent
 * key reads as undefined, which the callers already handle.
 */
export const WEBGPU_MODELS: Record<string, ModelConfig> = {
  // culico-net-cls-v1: a 21M-parameter TinyViT, 15x smaller than H/14, which
  // is what makes it the one engine a phone can actually fetch. Its head is a
  // trained linear probe rather than a text head, so it is labelled experimental
  // selector; see the dropdown option text.
  "webgpu-culico": {
    path: "culico-net-cls-v1-17-embed.onnx",
    embedsPath: "text_embeds_culico.json",
    label: "culico-net (experimental · 81 MB)",
    name: "culico-net-cls-v1",
    size: 85378550,
    // The head is a 16-way linear probe REFITTED on 2026-10-04 (see
    // docs/HEADS.md), so all sixteen species have their own weight row and the
    // app names species rather than genus. Before that refit it gave three
    // species one row each within four genera, which capped it at genus.
    // Measured through this app's own scoring on the held-out corpus: 61.2%
    // species and 82.3% genus, against 15.9% / 65.4% for the head it replaced.
    reports: "species"
  },
  "webgpu-b16": {
    path: "bioclip_visual_b16_fp16.onnx",
    embedsPath: "text_embeds_b16.json",
    label: "BioCLIP B/16 (FP16 · 172 MB)",
    name: "BioCLIP B/16 FP16",
    size: 172725427,
    reports: "species"
  },
  "webgpu-fp16": {
    path: "bioclip_2_5_fp16.onnx",
    embedsPath: "text_embeds.json",
    label: "BioCLIP 2.5 H/14 (FP16 · 1.2 GB)",
    name: "BioCLIP 2.5 H/14 FP16",
    size: 1259593728,
    reports: "species"
  }
};


/**
 * Resolve a model path against the model host.
 *
 * An absolute URL is returned untouched, so a caller may point one engine at a
 * different host (a local server, a mirror) without this having to know.
 */
export function resolveModelUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return MODEL_BASE_URL + path;
}
