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
}

/**
 * The engines the user can pick, keyed by engine id.
 *
 * A record rather than a union because the engine id reaches this from a DOM
 * value and from the URL query, so it is a string at every call site; an absent
 * key reads as undefined, which the callers already handle.
 */
export const WEBGPU_MODELS: Record<string, ModelConfig> = {
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

