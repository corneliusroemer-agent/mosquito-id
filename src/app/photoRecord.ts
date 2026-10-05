/**
 * The photo record, and the rev-guard protocol that decides which computation
 * may write to it.
 *
 * This was 2,849 lines of unchecked `main.js`. The record itself is the blast
 * radius: every classification path in the app writes a subset of these fields
 * into one object, and a field a path forgets to write is not a compile error
 * but a photo that reads as though that evidence were absent. That is how
 * `nuP` reached the pooled card on the crop-release path and not on the batch
 * path (6647d05) - two writers, one shared shape, nothing to say they had
 * drifted.
 *
 * `PhotoState` is therefore one record, written through `commitScores`, so a
 * path that adds evidence to `FusedResult` and forgets to file it here is a
 * type error rather than a silent omission.
 */
import type { Agreement, Verdict } from "../confidence/types";

/**
 * One photo in the gallery, in full.
 *
 * Extends nothing: `types.ts`'s `Preview` is the narrow slice the geometry and
 * label modules take, and a photo satisfies it structurally. This is the
 * record the app shell itself holds.
 */
export interface PhotoState {
  // --- identity and provenance ---
  /** The file's name, or the server's name for it. */
  name: string;
  /** The dropped File. Retained across inference so a re-run does not re-encode. */
  file?: File | null;
  /**
   * The decoded bitmap, released once the batch has classified the photo. A
   * decoded copy of a 12-megapixel photograph is the largest thing a photo
   * holds, and nothing about it outlives that one call.
   */
  bitmap?: ImageBitmap | null;
  /**
   * A cheap identity for the geometry, so two runs can be compared without
   * hashing pixels: `cropW x cropH - fullW x fullH`.
   */
  fingerprint: string | null;

  // --- geometry ---
  /**
   * A display-sized copy of the photograph, longest edge at most
   * `DISPLAY_MAX_EDGE`: what the panels paint and what the thumbnail encodes.
   *
   * The full-resolution frame is NOT held here. On a 12 MP photograph it is
   * 45.8 MiB, and retaining one per photo cost the gallery ten gigabytes at a
   * hundred photos with no plateau in the curve. The two paths that read
   * full-resolution pixels - cutting a crop, and re-running the classifier -
   * get the frame back from `fullResSource`, which holds at most one.
   */
  displayCanvas: HTMLCanvasElement | null;
  /**
   * The photograph's own pixel dimensions, measured once at decode, in the
   * orientation the frame is drawn in.
   *
   * Every box below is in these pixels and every mapping that places one divides
   * by them. They are carried separately from `displayCanvas` precisely because
   * that canvas has different dimensions: read them off it and each box is a
   * fraction of the wrong picture, which is a wrong crop with nothing to say so.
   */
  fullW: number | null;
  fullH: number | null;
  /**
   * Full-resolution pixels kept for a photo whose File is gone, and only for
   * one: with no bytes there is nothing to re-decode, so holding the frame is
   * the whole of what this photo can offer. Null on every photo the app's own
   * intake produces, because every intake mints a File.
   */
  sourceCanvas?: HTMLCanvasElement | null;
  cropCanvas: HTMLCanvasElement | null;
  contextCanvas: HTMLCanvasElement | null;
  cropBox: [number, number, number, number] | null;
  contextBox: [number, number, number, number] | null;
  /**
   * The detector found a box, the crop was made, and the nuisance gate rejected
   * that crop - so the whole frame was classified instead.
   *
   * A statement about the crop, never about the photo. The server reports one
   * `fallback` bit for both ways of ending up uncropped, which is the
   * conflation this undoes; nothing pools off that bit.
   */
  crop_rejected: boolean;
  is_cropped: boolean;
  /** The user asked for the whole photo after cropping it. */
  manual_full_photo: boolean;
  /** The user reverted a cropped photo to its whole frame. */
  revertedToFull?: boolean;

  // --- what the classifier said ---
  /** Genus -> summed posterior, as the results table renders it. */
  scores: Record<string, number>;
  /** Species -> fused posterior. */
  detail: Record<string, number>;
  /** Species -> logit on the single-view scale, so a fused photo is comparable. */
  logits: Record<string, number> | null;
  /**
   * Per-class adjacent (confusable non-mosquito) posteriors, index-aligned with
   * `head.adjacent`. Absent where the scoring path reports none - the server
   * path has no adjacent classes - and then the pool has no non-mosquito
   * evidence to speak of.
   */
  adP: number[] | null;
  /**
   * The pooled nuisance posteriors, as the one-element array the fused result
   * carries.
   *
   * Nothing writes this at HEAD: `commitScores` files `adP` and the verdict but
   * not the nuisance block, so the pooled card reads no nuisance evidence. Filed
   * here because that is a decision about the record's shape rather than an
   * omission, and because the field is what makes the gap visible - see the
   * report. Deliberately not written by `commitScores`: adding it is a behaviour
   * change, not an extraction.
   */
  nuP?: number[] | null;
  verdict: Verdict | null;
  /** Plain-language adjacent name -> posterior, for naming the winner. */
  adjacentDetail: Record<string, number> | null;

  // --- multi-view bookkeeping ---
  /**
   * What viewAgreement reported about the views that produced `detail`. Cleared
   * with every recompute, because the agreement on screen described the previous
   * crop's views.
   */
  agreement: Agreement | null;
  viewsLanded: number;
  viewsTotal: number;

  // --- which engine filed these numbers ---
  /**
   * The engine whose arithmetic produced the current `scores`. A later engine
   * switch is told apart from a photo that is still current by this.
   */
  scoredBy: string;

  // --- lifecycle ---
  status: string;
  /**
   * The revision counter. Bumped by every recompute, which is what makes the
   * last release win: an earlier computation still in flight holds a revision
   * that no longer matches and drops its result.
   */
  rev: number;
  /** A computation is in flight; the tile shows a pending badge. */
  pending: boolean;
  error: string | null;
  /** Deleted, so any computation still running has nothing to write to. */
  removed?: boolean;

  // --- timings, for the footer and the probes ---
  detTime: number | null;
  clipTime: number | null;
  totalTime: number | null;
  /** The detector's confidence on the chosen box. Carried by the server path. */
  detScore?: number;
  detectionScore?: number;
}

/**
 * Take ownership of a photo's scores for a new crop.
 *
 * Bumping the revision is what makes the last release win. Returns the new
 * revision, which the caller passes back to `ownsRecompute`.
 */
export function beginRecompute(p: PhotoState): number {
  p.rev = (p.rev || 0) + 1;
  p.pending = true;
  p.error = null;
  // The agreement on screen described the previous crop's views. It goes with
  // them, rather than sitting there next to a pending recompute claiming to be
  // about the crop now being drawn.
  p.agreement = null;
  p.viewsLanded = 0;
  p.viewsTotal = 0;
  return p.rev;
}

/**
 * A result may be written back only by the computation that still owns the
 * photo: same revision (no newer release), same object still in `previews` (not
 * deleted, and not replaced by a batch that finished meanwhile), not removed.
 */
export function ownsRecompute(p: PhotoState, previews: readonly PhotoState[], idx: number, rev: number): boolean {
  return p.rev === rev && previews[idx] === p && !p.removed;
}

/**
 * Everything a finished computation commits, in one place, so the local and
 * server paths cannot drift apart in what they mark current. The multi-view
 * paths go through `applyViews`, which layers the per-view bookkeeping on top.
 */
export function commitScores(
  p: PhotoState,
  r: {
    labels: Record<string, number>;
    detail: Record<string, number>;
    logits: Record<string, number>;
    adP: number[];
    adjacentDetail: Record<string, number>;
    verdict: Verdict;
  },
  engine: string,
): void {
  p.scores = r.labels;
  p.detail = r.detail;
  p.logits = r.logits;
  // Which engine these numbers are filed under, so the re-run button can tell a
  // photo that is current from one still showing another engine's verdict.
  // Written here and at the batch commit because those are the two places scores
  // land.
  p.scoredBy = engine;
  // Index-aligned with head.adjacent, so the pooled card can carry the pool's
  // non-mosquito evidence through its own softmax. Absent where the scoring path
  // reports none - the server path has no adjacent classes - and then the pool
  // has no non-mosquito evidence to speak of.
  p.adP = r.adP || null;
  // A verdict that claims nothing must not keep the one it had: pooling reads it.
  p.verdict = r.verdict || null;
  // The per-class adjacent posteriors, for the score panel to name the winner
  // from. Cleared with the verdict so a stale one cannot outlive the claim.
  p.adjacentDetail = r.adjacentDetail || null;
  p.pending = false;
  p.error = null;
}

/**
 * Clear the pending state with a message, and report the failure once.
 *
 * `log` is the app's telemetry sink, threaded rather than imported so this
 * module stays free of the app's module state.
 */
export function markComputeFailed(
  p: PhotoState,
  err: unknown,
  log: (event: string, fields: Record<string, unknown>) => void,
): void {
  p.pending = false;
  p.error = `Classification failed: ${err instanceof Error ? err.message : String(err)}`;
  log("crop_failed", { name: p.name, error: String(err) });
}

/**
 * Thrown when a release is overtaken before its work starts, so the catch block
 * can tell "nothing to do" from "the model failed".
 */
export class Superseded extends Error {}
