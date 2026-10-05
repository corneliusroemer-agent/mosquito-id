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
import type { Agreement, Verdict, ViewResult } from "../confidence/types";
import type { ViewKind } from "./viewSelection";

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
   * The decoded bitmap, released once `fullCanvas` holds the same pixels. A
   * decoded copy of a 12-megapixel photograph is the largest thing a photo holds.
   */
  bitmap?: ImageBitmap | null;
  /**
   * SHA-256 of the file's bytes (`contentFingerprint`), or null where it could
   * not be computed. Pooling de-duplicates on it and treats null as unique.
   */
  fingerprint: string | null;

  // --- geometry ---
  fullCanvas: HTMLCanvasElement | null;
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
  /**
   * What each view of this photo said, kept per view rather than as the one
   * fused posterior `detail` holds.
   *
   * A view's posterior is a function of (the pixels of that view, the engine,
   * the head), and nothing else. The whole-frame checkbox changes which views
   * are POOLED, never what a view says, so a toggle is a re-fusion of these and
   * not a re-classification. Caching the fused posterior instead would make the
   * toggle look free and silently destroy what pooling needs: `viewAgreement`
   * compares the views against each other, and a single fused distribution
   * carries no per-view detail to compare.
   *
   * Keyed by view kind, so a crop-only photo holds one entry and a two-view
   * photo holds two. Each entry is stamped with the identity of everything that
   * produced it, and a mismatch is a miss rather than a stale read - see
   * `ViewCacheEntry`.
   */
  viewCache?: Partial<Record<ViewKind, ViewCacheEntry>>;

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
  /**
   * Bumped only when the photo's PIXELS change, not on every recompute.
   *
   * `rev` cannot key the view cache: a whole-frame toggle recomputes without
   * changing a pixel, and bumping `rev` there would invalidate the very entries
   * the toggle exists to reuse. This is that separate counter, and the cache key
   * is built from it rather than from `rev`.
   */
  contentRev?: number;
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
 *
 * `contentChanged` says whether the photo's PIXELS are about to change, which is
 * a separate question from whether its scores are being recomputed. A new crop
 * release does both. A whole-frame toggle does only the second: the same crop
 * canvas and the same whole frame are about to be scored, just pooled
 * differently. Passing `false` is what lets `viewCache` survive a toggle, so it
 * is stated at the call site rather than inferred. It defaults to `true` because
 * that is the answer that cannot serve a stale posterior.
 */
export function beginRecompute(p: PhotoState, contentChanged = true): number {
  p.rev = (p.rev || 0) + 1;
  if (contentChanged) p.contentRev = (p.contentRev || 0) + 1;
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

/**
 * One view's posteriors, stamped with everything that produced them.
 *
 * The stamp is the cache key. Keying on the view kind alone would serve the
 * previous engine's numbers after a switch, or a previous head's after a refit,
 * and neither is detectable downstream: the shape is identical, so a stale read
 * is a confident wrong answer rather than an error. So each entry carries:
 *
 * - `contentRev` - the photo's PIXEL generation, bumped only by
 *   `beginRecompute(p, true)`. A new crop release or a revert to the full frame
 *   bumps it, so a photo whose content changed cannot match. This is the reuse
 *   of the record's own guard: the cache is invalidated by exactly the event
 *   that already invalidates a stale commit, rather than by a second,
 *   separately-maintained notion of "this photo changed". It is deliberately NOT
 *   `rev`, which a pooling-only recompute also bumps.
 * - `engine` - the engine key, the same string `scoredBy` files. An engine switch
 *   re-classifies, so a cached entry from another engine is a miss.
 * - `head` - the head object the softmax ran against, compared by identity. A
 *   refit replaces the head object rather than mutating it, so identity is the
 *   test; a string of the species list would be a re-derivation of the same fact
 *   that could go stale.
 *
 * `contentRev` is deliberately the record's own generation counter and NOT
 * `fingerprint`: the fingerprint is the file's bytes, used for cross-photo
 * de-duplication, and two different photos of one file share it while a single
 * photo's crop changes without it changing at all. They answer different
 * questions.
 */
export interface ViewCacheEntry {
  /** The pixel generation this view was scored at. */
  contentRev: number;
  /** The engine key this view was scored by. */
  engine: string;
  /** The head object this view was scored against, by identity. */
  head: unknown;
  /** The per-view result, exactly as `fuseViews` consumes it. */
  result: ViewResult;
}

/** The stamp every lookup is made against, read once per pass. */
export interface ViewCacheStamp {
  contentRev: number;
  engine: string;
  head: unknown;
}

/**
 * The cached posterior for one view, or null when there is nothing usable.
 *
 * A missing entry and a stale one are the same answer here: run the classifier.
 * Nothing here throws or repairs, so a cache can never be the reason a photo has
 * no score - the miss falls through to the path that produces one.
 */
export function readViewCache(
  p: PhotoState,
  kind: ViewKind,
  stamp: ViewCacheStamp,
): ViewResult | null {
  const e = p.viewCache?.[kind];
  if (!e) return null;
  if (e.contentRev !== stamp.contentRev || e.engine !== stamp.engine || e.head !== stamp.head) return null;
  return e.result;
}

/**
 * File one view's posteriors, replacing whatever was there for that kind.
 *
 * Written only by the computation that still owns the photo: the caller holds
 * the same `rev` its `ownsRecompute` check just verified, so a classification
 * overtaken by a newer crop cannot leave its result behind for the next read.
 */
export function writeViewCache(
  p: PhotoState,
  kind: ViewKind,
  stamp: ViewCacheStamp,
  result: ViewResult,
): void {
  (p.viewCache ??= {})[kind] = {
    contentRev: stamp.contentRev,
    engine: stamp.engine,
    head: stamp.head,
    result,
  };
}
