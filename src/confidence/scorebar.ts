/**
 * How one score row renders: a bar width in percent, or nothing at all.
 *
 * A non-finite score has NO bar and NO number. `Math.min`/`Math.max` pass NaN
 * straight through, so the old inline `Math.max(0, Math.min(100, score*100))`
 * produced `width: NaN%` - an invalid declaration the browser drops, leaving the
 * fill at its default width and drawing a FULL BAR that reads as a confident
 * result for a value that means nothing. The guard lives here, as a function
 * that returns the two numbers the row needs, because a one-line inline
 * expression is exactly what regressed.
 */
export interface ScoreRow {
  /** Whether the score carries a usable value at all. */
  finite: boolean;
  /** "28.6" for a usable score, "" otherwise. Never "NaN%". */
  percent: string;
  /** Clamped to 0..100, or 0 for a non-finite score. */
  widthPct: number;
}

export function scoreRow(score: number): ScoreRow {
  if (!Number.isFinite(score)) return { finite: false, percent: "", widthPct: 0 };
  return {
    finite: true,
    percent: (score * 100).toFixed(1),
    widthPct: Math.max(0, Math.min(100, score * 100)),
  };
}

/**
 * The pooled card's version, on the -20..0 relative-logit axis: 0 is the pool's
 * best, -20 the left edge of the track. Same non-finite rule, different axis.
 */
export function pooledScoreRow(relScore: number): ScoreRow {
  if (!Number.isFinite(relScore)) return { finite: false, percent: "", widthPct: 0 };
  return {
    finite: true,
    percent: relScore.toFixed(1),
    widthPct: Math.max(0, Math.min(100, ((relScore + 20) / 20) * 100)),
  };
}
