/**
 * The shapes that cross module boundaries in the app shell.
 *
 * Kept apart from the modules that use them so that a cycle cannot form: every
 * module here is a leaf, and anything that needs a type from this file depends
 * on this file alone.
 */

/**
 * One entry of the static species table (src/app/speciesMeta.ts).
 *
 * Every field is optional. The classifier's label set and that table are edited
 * separately, so an entry that carries only a common name has to be legal.
 */
export interface SpeciesMeta {
  common?: string;
  wiki?: string;
  vectors?: string;
  range?: string;
  activity?: string;
  hosts?: string;
  notes?: string;
}

/** A box in [x1, y1, x2, y2] pixel coordinates. */
export type Box = [number, number, number, number];

/** One detector candidate, after NMS. */
export interface Detection {
  cls: number;
  conf: number;
  box: Box;
}

/**
 * A preprocessed detector input plus the transform that maps its coordinates
 * back to the source image, which is what undoes the letterbox.
 */
export interface Letterboxed {
  tensor: unknown;
  r: number;
  dx: number;
  dy: number;
}

/**
 * The slice of onnxruntime's Tensor that the detection decoder reads.
 *
 * `ort` is a UMD global from a CDN script tag (index.html), not a package this
 * project depends on, so it has no types of its own here. Describing the fields
 * actually accessed keeps decodeDets typechecked without declaring the runtime.
 */
export interface OrtTensor {
  data: ArrayLike<number>;
  dims: readonly number[];
}

/**
 * One photo in the gallery, as far as the geometry and label modules read it.
 *
 * The full record carries the classifier's outputs too - scores, logits, a
 * verdict, the per-view counters - and those belong to the render path. This is
 * the subset the modules outside that path need, so a photo can be passed to the
 * crop geometry or the label helpers without dragging the whole app state along.
 *
 * `cropBox` and `contextBox` are null before a crop exists; `contextCanvas`
 * falls back to `fullCanvas` for a photo classified on the whole frame.
 */
export interface Preview {
  name?: string;
  fullCanvas: HTMLCanvasElement | null;
  cropCanvas: HTMLCanvasElement | null;
  contextCanvas?: HTMLCanvasElement | null;
  cropBox: Box | null;
  contextBox: Box | null;
  /**
   * The detector found a box, the crop was made, and the nuisance gate rejected
   * that crop - so the whole frame was classified instead.
   *
   * A statement about the crop, never about the photo: the frame that was
   * classified is the frame the verdict was read off, and it pools on that
   * verdict. It is recorded because the two ways of ending up uncropped are
   * genuinely different, and because the app used to carry one flag for both.
   */
  crop_rejected?: boolean;
  /** The user asked for the whole photo after cropping it. */
  manual_full_photo?: boolean;
}

/** Anything the surface-mapping helpers can measure: a canvas or an image. */
export interface CanvasLike {
  width: number;
  height: number;
}

/** A box in percent of the surface it is drawn on, which is what CSS wants. */
export interface BoxPercent {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The affine map between a surface and the photo painted in it:
 * imageFraction = k * surfaceFraction + o, per axis.
 */
export interface Mapping {
  kx: number;
  ox: number;
  ky: number;
  oy: number;
}

/** A context region cut around a crop: the pixels and where they came from. */
export interface ContextCrop {
  contextCanvas: HTMLCanvasElement;
  contextBox: Box;
}

/** One photo with a classification attached: the geometry fields plus what the classifier said. */
export interface ClassifiedPhoto extends Preview {
  scores: Record<string, number>;
  detail: Record<string, number>;
  verdict: Verdictish | null;
  status?: string;
  is_cropped?: boolean;
  pending?: boolean;
  error?: string | null;
}

/**
 * The app's own claim about a photo.
 *
 * A structural restatement of confidence/types.ts's Verdict rather than an import
 * of it, because this file is the leaf those types are described in terms of.
 * The three states are the whole set: naming a species, naming only a genus, and
 * declining.
 */
export interface Verdictish {
  state: "species" | "genus" | "unsure" | "non-mosquito";
  genus: string | null;
  species?: string | null;
}
