/**
 * Whether the classifier's resize is the stepwise-halving one.
 *
 * The heads were fitted on PIL-BICUBIC resizes, which are anti-aliased. A canvas
 * `drawImage` of a 12-50 MP photograph to 224 px is a single 4-tap bilinear read
 * that skips almost every source pixel, so the browser feeds the head a different
 * picture than the one it was fitted on (investigations/2026-10-04-devcontainer-
 * cpu/10-skew). Halving the canvas repeatedly until it is within 2x of the target
 * and taking the whole-frame view from the photo rather than from the 640 px
 * detector canvas closes most of that gap.
 *
 * It changes classification output, so it is off unless asked for: `?resize=halving`
 * in the URL, or `RESIZE_HALVING_DEFAULT` flipped once the effect has been accepted.
 */
export const RESIZE_HALVING_DEFAULT = false;

export function halvingEnabled(search: string = typeof location === "undefined" ? "" : location.search): boolean {
  const v = new URLSearchParams(search).get("resize");
  if (v === "halving") return true;
  if (v === "default" || v === "direct") return false;
  return RESIZE_HALVING_DEFAULT;
}
