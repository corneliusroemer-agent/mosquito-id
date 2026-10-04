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
/**
 * The box score below which a detection is discarded, and nothing else.
 *
 * Was 0.70, where the detector fired on 55.8% of a 4,172-image gold-box
 * held-out set while 92.4% of the boxes it did fire on were correct - a
 * precision-conditional-on-firing figure that reads well and answers the wrong
 * question. The images the detector is unsure about are the ones that then get
 * analysed whole, at 69.97% accuracy and 0.356 macro-F1 against 0.480 for the
 * shipped threshold.
 *
 * At 0.50 the detector fires on 71.5% of that 4,172-image set, wrong boxes on
 * 9.9% of fired images rather than 4.2%. On a separate 1,199-image held-out
 * subsample, measured under the app's own two-view pooling rule - crop and
 * whole frame combined log-linearly - paired over report groups, 2,000
 * resamples, every arm at the shipped temperature of 2.5: against 0.70 it is
 * +2.26 to +2.59 pp accuracy, +0.026 to +0.028 macro-F1, and better on
 * prior-corrected entropy (-0.047 [-0.095, -0.004]) under both gate rules that
 * reject a wrong box. No retraining, but not free either: 16 pp more images
 * get a crop classified beside the whole frame, so each pays a second encoder
 * pass.
 *
 * That entropy claim is conditional and the condition is the point. Under the
 * gate rule that never rejects - every crop pooled however wrong the box - 0.50
 * is *worse* than 0.70 on entropy (+0.101 [-0.054, +0.333]), and a worse
 * sign-flip is what a wrong crop being pooled looks like. All three rules
 * simulate the gate as a box-IoU test against a gold box; the app's real gate
 * is `max(species) >= max(nuisance)` - is this crop even a mosquito - with no
 * reference to a gold box at all. Read these as bracket, not as measurement.
 *
 * 0.30 is the same call made harder and is NOT settled on accuracy or macro-F1,
 * where it is better still (+0.33 to +0.75 pp, +0.015 to +0.019). On entropy
 * it buys nothing: indistinguishable under the rejecting gates (+0.011
 * [-0.029, +0.052]) and worse under the permissive one. On the headline metric
 * there is no case for it, and it doubles wrong boxes on the 4,172-image set
 * to 20.2% of fired images. What holds it back is therefore a measurement and a
 * proxy together, not a proxy alone. See 71-detconf-entropy.md before
 * changing this.
 *
 * Do not raise this back on the strength of "of fired": that number is a
 * property of the boxes that survive, and it is maximised by never firing at
 * all. Measured in `investigations/2026-10-02-mosquito-id/61-detector.md`.
 */
export const DET_CONF = 0.50;
export const NMS_IOU = 0.70;
export const CROP_PAD = 0.10;
export const CACHE_NAME = "mosquito-models-v1";

/**
 * The detector's size in bytes, which the load bar weighs it by.
 *
 * The one declared size `WEBGPU_MODELS` does not carry: the detector is fetched
 * by a bare path rather than as a selectable engine, so nothing else records
 * how big it is. It is needed because the bar aggregates across the whole load,
 * and a step with no declared bytes cannot be weighted against a 1.2 GB
 * classifier. Measured from the bucket's Content-Length, like the sizes beside
 * it; a stale value here costs accuracy in the bar's middle, never its end.
 */
export const DETECTOR_SIZE = 10607017;

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
 *
 * H/14 carries an entry too, for a different reason: it is the engine the shipped
 * floors were fitted on, and it does not meet them on a second corpus. See above.
 *
 * B/16's head was refitted on the same day and by the same route (see
 * docs/HEADS.md), from a zero-shot text head to a 16-way linear probe plus one fitted
 * background row. Its floors were re-derived from its own selective-accuracy curves on
 * the held-out corpus, fitted on one half and read on the other:
 *
 *   species 0.80   half A 91.6% at 33% coverage; half B 90.6% at 31%
 *   genus   0.90   half A 98.1% at 55% coverage; half B 97.8% at 52%
 *
 * The two values happen to equal culico's. That is a coincidence of where the two
 * probes' accuracy curves cross the target, not a shared decision: they are fitted
 * per engine because a floor is an absolute threshold on a posterior and neither
 * engine produces the other's. `temperature` is unchanged at 2.5, because
 * `logit_scale` is 2.5 too and the arithmetic requires their ratio to be 1.0.
 *
 * The `nuisance` floor is this engine's own most consequential number, because B/16
 * has no adjacent block: its nuisance rows are the gate's ONLY evidence. The block
 * carries a ninth row, `a photograph without a mosquito`, fitted on the 700
 * detector-verified background crops against in-domain mosquitoes (see
 * docs/HEADS.md); the eight above it are still the zero-shot text prompts, which were
 * never fitted against a mosquito and move with the species block's uncertainty rather
 * than with the photograph. Raising the floor to 0.30 is what stops those eight from
 * carrying the gate on their own.
 *
 *   floor 0.05   100.0% of 700 negatives refused, 54.0% of 2,450 mosquitoes
 *   floor 0.20     99.3% of negatives,  6.4% of mosquitoes
 *   floor 0.30     97.9% of negatives,  0.8% of mosquitoes, every one of them
 *                 named `a photograph without a mosquito`
 *   floor 0.60     90.6% of negatives,  0.04% of mosquitoes
 *
 * 0.30 is where the fitted row does the work and the text rows stop mattering.
 */
const ENGINE_FLOORS: Readonly<Record<string, Floors>> = Object.freeze({
  // H/14 has NO entry, and 2026-10-04 is when one was proposed here and taken
  // back out. The measurement behind it is sound - on 2,450 held-out photographs
  // through `softmaxJoint` -> `fuseViews` -> `verdictFrom`, the shipped 0.373 has
  // the app naming a species on 86.7% of them and being right 83.66% of the time,
  // and 0.80 gives 97.05% at 37.4% coverage - and it does not identify a value to
  // put here:
  //
  //   * It was read single-view. The app pools the detector crop and the whole
  //     frame on every photograph (main.js:1035), and fusion is log-linear, so
  //     the real operating point at 0.373 is 78.40% selective at 97.7% coverage
  //     and at 0.80 is 90.69% at 67.9%. Coverage roughly doubles.
  //   * Selective accuracy is the column that improves. Whole-set correctness -
  //     the app being right about a photograph at all - goes 75.43% -> 60.82% at
  //     0.80. Neither end reaches the 96.6% this floor was fitted for (see
  //     DEFAULT_FLOORS), so the corpus says the floor is mistuned and not what a
  //     better value is.
  //   * 0.80 sits in the one part of that curve where whole-set accuracy is at its
  //     worst, and the genus floor that came with it is justified by 27
  //     photographs.
  //   * It was fitted and read on the same 2,450 rows, on a different corpus from
  //     the one DEFAULT_FLOORS came from, which is the transfer the change exists
  //     to question.
  //
  // Re-deriving H/14's floors needs the 6,264-row cache DEFAULT_FLOORS was fitted
  // against, on fused posteriors, with the whole-set column reported beside the
  // selective one. That is the work, not a second line in this map.
  "webgpu-culico": Object.freeze({
    ...DEFAULT_FLOORS,
    species: 0.80,
    genus: 0.90,
  }),
  "webgpu-b16": Object.freeze({
    ...DEFAULT_FLOORS,
    species: 0.80,
    genus: 0.90,
    nuisance: 0.30,
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
