/**
 * The onnxruntime-web global.
 *
 * index.html loads onnxruntime-web as a UMD bundle from a CDN, so `ort` is a
 * global rather than an import and this project has no types for it. Declaring
 * the narrow surface actually used is what lets the inference code be TypeScript
 * without pulling the runtime in as a dependency the bundler would then have to
 * resolve - a static import of the runtime is exactly what BUILD-VERIFICATION.md
 * rules out.
 */

export interface OrtTensorCtor {
  new (type: string, data: Float32Array, dims: readonly number[]): unknown;
}

declare global {
  // eslint-disable-next-line no-var
  var ort: { Tensor: OrtTensorCtor };
}
