/**
 * The footer's per-step timing line.
 *
 * The line is rewritten for every analysed photo, and it carries three timings
 * whose digit counts change from photo to photo. Its width therefore changed on
 * every photo of a batch, and because the footer is a centred flex row that
 * moved the text on both sides of it - a cumulative layout shift over a whole
 * run, which is what issue #83 reports.
 *
 * Each number goes into its own fixed-width slot instead. The slot is `4ch`
 * wide, `ch` being the advance width of a digit, and `font-variant-numeric:
 * tabular-nums` (see the `.timing-num` rule in `index.html`) makes every digit
 * exactly that width - so `81` and `144` occupy the same box and neither the
 * digits nor the `ms` beside them move. The label before the timings is left
 * unreserved: it only changes on an engine switch, which is a discrete user
 * action rather than something that happens once per photo.
 */

/** Digits reserved per number. Four covers a 9.9 s/photo step. */
export const TIMING_DIGITS = 4;

/** One photo's three timings, in milliseconds, and the engine that produced them. */
export interface FooterTiming {
  engineLabel: string;
  totalMs: number;
  cropMs: number;
  analyzeMs: number;
}

/** The footer slot. `unknown` rather than Node so a plain stub stands in for it. */
type ParentLike = {
  replaceChildren(...nodes: unknown[]): void;
};

/**
 * Write the timing line, or leave the slot alone when there is none.
 *
 * `replaceChildren` rather than append, so a photo cannot stack a second line on
 * top of the one already there.
 */
export function renderFooterTiming(
  slot: ParentLike | null,
  doc: Document | null,
  timing: FooterTiming,
): boolean {
  if (!slot || !doc) return false;
  const num = (ms: number) => {
    const span = doc.createElement("span");
    span.className = "timing-num";
    // A timing that arrived as NaN or undefined would otherwise print as
    // "NaNms" and be wider than the slot, so anything non-finite reads as 0.
    span.textContent = Number.isFinite(ms) ? String(Math.max(0, Math.round(ms))) : "0";
    return span;
  };
  slot.replaceChildren(
    `inference: ${timing.engineLabel} · `,
    num(timing.totalMs),
    "ms/photo (crop: ",
    num(timing.cropMs),
    "ms · analyze: ",
    num(timing.analyzeMs),
    "ms",
  );
  return true;
}
