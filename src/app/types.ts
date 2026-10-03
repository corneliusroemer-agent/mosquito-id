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
