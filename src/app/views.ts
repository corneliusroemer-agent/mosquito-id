/**
 * The multi-view path: which views a photo offers, and how each one is scored
 * before `fuseViews` pools them.
 *
 * This was unchecked `main.js`, and it is the orchestration directly around the
 * two worst bugs of this project. `fuseViews` collapsed a nuisance vector to a
 * single index, so every non-mosquito verdict read "a photograph of a person",
 * and `verdictFrom` consumed that collapsed value. Both modules were already
 * TypeScript by the time those were found; what was NOT typed was the code that
 * builds what they are handed, so nothing said a view had to carry the fields
 * they read.
 *
 * That is what this module states. `classifyViewLocal` and `serverView` return
 * `ViewResult`, so a view missing `scale` - the field `fuseViews` refuses to
 * pool across - or carrying a `spP` of the wrong length is a compile error at
 * the construction site rather than a fused posterior that means something
 * else.
 */
import { softmaxJoint } from "../confidence/softmax";
import { genusOf } from "../confidence/genus";
import type { Head, VerdictState, ViewResult } from "../confidence/types";
import type { FusedResult } from "../confidence/fuseViews";
import { cosineOffsetsFor } from "./modelConfig";
import { viewKinds } from "./viewSelection";
import type { PhotoState } from "./photoRecord";

/** A box in [x1, y1, x2, y2] pixel coordinates. */
export type Box = [number, number, number, number];

/** One view to classify: the pixels (local path) or the box to ask the server about. */
export interface ViewRequest {
  canvas: HTMLCanvasElement | null;
  box: Box | null;
}

/**
 * The views of one photo that get classified and pooled: the crop on screen,
 * and the whole frame unless the user has turned that second opinion off. Two
 * views of the same specimen, because one view of it is fallible - see
 * `fuseViews` for what the second buy is worth.
 *
 * A photo already showing the whole frame has only one view to offer, and
 * running the same pixels through the model twice would fuse a view with
 * itself. That covers both a photo the detector found nothing in and one the
 * user reverted to whole. Each view carries its crop box because the server path
 * takes a box where the local path takes the already-cut pixels.
 *
 * The whole frame is passed in rather than read off the photo because the photo
 * no longer holds one: it holds a display-sized copy, and the classifier's input
 * is the pixels the photograph had, not a 2048 px reduction of them. A caller
 * that has no full-resolution frame to offer passes what it has and accepts that
 * this is a differently-sourced view, which is its decision to make, not this
 * function's to make silently.
 *
 * The decision of which views those are lives in `viewKinds`, shared with the
 * batch paths, so the three places a photo gets classified cannot disagree about
 * what a photo offers.
 */
export function viewsFor(
  full: HTMLCanvasElement | null,
  cropCv: HTMLCanvasElement | null,
  cropBox: Box | null,
  includeWholeFrame: boolean,
): ViewRequest[] {
  if (!full) return [];
  const whole: ViewRequest = { canvas: full, box: [0, 0, full.width, full.height] };
  return viewKinds(Boolean(cropCv) && cropCv !== full, includeWholeFrame).map((kind) =>
    kind === "crop" ? { canvas: cropCv, box: cropBox } : whole,
  );
}

/**
 * Score one view locally: embed, then joint softmax against species, nuisance
 * and adjacent classes at once.
 *
 * The nuisance classes enter as their combined mass (`nuTotal`), never
 * individually: the per-view gate has already used them to decide whether a crop
 * is worth classifying, and letting eight nuisance classes vote on which species
 * this is would mix that decision into the species verdict.
 *
 * `scale` is the logit scale this view was scored AT, attached here rather than
 * read from the current engine at fuse time, because the engine can be switched
 * while a photo's second view is still in flight.
 */
export function viewResultFrom(
  head: Head,
  emb: ArrayLike<number>,
  engineKey: string,
  scale: number,
): ViewResult {
  const { spP, nuP, adP } = softmaxJoint(head, emb, { offsets: cosineOffsetsFor(engineKey) });
  return { spP, nuTotal: nuP.reduce((a, b) => a + b, 0), adP, scale };
}

/** One classified view, plus the async embed it came from. */
export type Embed = (canvas: HTMLCanvasElement) => Promise<ArrayLike<number>>;

/**
 * Score one view on the device the app is running on.
 *
 * `embed` and `scale` are injected rather than read from module state, so this
 * is checkable without the 1.26 GB classifier and without a browser.
 */
export async function classifyViewLocal(
  canvas: HTMLCanvasElement,
  engineKey: string,
  head: Head,
  embed: Embed,
  scale: number,
): Promise<ViewResult> {
  return viewResultFrom(head, await embed(canvas), engineKey, scale);
}

/** The slice of a `/api/predict` response this module reads. */
export interface PredictResponse {
  /** Species -> logit, as the server reports them. */
  logits: Record<string, number>;
  /** Species -> posterior, already normalised against the nuisance classes. */
  detail: Record<string, number>;
  /** Genus -> summed posterior. */
  labels: Record<string, number>;
  /** The box the server actually classified, for the divergence log. */
  cropBox?: Box | null;
}

/**
 * The same conversion from a `/api/predict` response, for the batch path which
 * holds the response rather than a canvas.
 *
 * The server reports no adjacent classes, so the returned view carries no
 * `adP`: the pool then has no non-mosquito evidence from this path to speak of,
 * which is a statement about the server rather than an omission here.
 *
 * The nuisance mass is whatever the species did not take, since `detail` is
 * already normalised against the nuisance classes by the server's own joint
 * softmax. Floored at 1e-12 rather than 0 so a server that claims every species
 * cannot report a certain mosquito.
 */
export function serverView(
  data: Pick<PredictResponse, "detail">,
  head: Head,
  scale: number,
): ViewResult {
  const spP = head.species.map((name) => data.detail[name] || 0);
  const speciesMass = spP.reduce((a, b) => a + b, 0);
  return { spP, nuTotal: Math.max(1 - speciesMass, 1e-12), scale };
}

/** A `/api/predict` response carrying the scores for a box the app asked about. */
export interface ScoredCrop {
  labels: Record<string, number>;
  detail: Record<string, number>;
  logits: Record<string, number>;
}

/**
 * Server path: the server owns no geometry decision we need for display, only
 * the scores for a crop box we send it.
 *
 * The canvas and the box must agree on a scale. `cropBox` is in the
 * photograph's pixels, and the server applies it to whatever image it is sent,
 * so a downscaled frame sent with a full-resolution box asks the server for a
 * region of the picture that does not contain the crop - and it answers
 * confidently about it. So this takes the full-resolution frame explicitly
 * rather than whatever the photo is holding, and refuses rather than guessing.
 *
 * If it answers with a different box than the one it was given, its labels
 * describe a crop the user is not looking at, so the box is logged and ignored
 * rather than silently re-displayed.
 */
export async function classifyCanvasServer(
  canvas: HTMLCanvasElement | null,
  name: string,
  cropBox: Box,
  log: (event: string, fields: Record<string, unknown>) => void,
): Promise<ScoredCrop> {
  if (!canvas) throw new Error(`No frame to send for ${name}`);
  const blob = await new Promise<Blob>((r) => canvas.toBlob(r as (b: Blob | null) => void, "image/jpeg", 0.85));
  if (!blob) throw new Error(`Could not encode ${name} for the server`);
  const formData = new FormData();
  formData.append("file", blob, name);
  formData.append("crop_box", JSON.stringify(cropBox));
  const res = await fetch("/api/predict", { method: "POST", body: formData });
  if (!res.ok) throw new Error(`Server inference error ${res.status}`);
  const data = (await res.json()) as PredictResponse;
  if (JSON.stringify(data.cropBox) !== JSON.stringify(cropBox)) {
    log("server_crop_box_diverged", { requested: cropBox, returned: data.cropBox });
  }
  return { labels: data.labels, detail: data.detail, logits: data.logits };
}

/** The server's answer for one crop box, in the shape a fusion takes. */
export async function classifyViewServer(
  canvas: HTMLCanvasElement | null,
  name: string,
  cropBox: Box,
  head: Head,
  scale: number,
  log: (event: string, fields: Record<string, unknown>) => void,
): Promise<ViewResult> {
  return serverView(await classifyCanvasServer(canvas, name, cropBox, log), head, scale);
}

/** Round to 4 dp, or null for anything that is not a finite number. */
export const round4 = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null;

/**
 * A posterior in a form a log line can be read from.
 *
 * The failure this exists to catch is a distribution that is uniformly zero or
 * uniformly flat, which is indistinguishable from "no result" in every log line
 * that reports only a conclusion - and exact zeros across every photo are the
 * symptom. `spN: 0` is the report for an empty posterior.
 */
export function posteriorSummary(
  fused: Partial<FusedResult> | null,
  head: Head | null,
): Record<string, number | null> {
  const sp = fused?.spP ?? [];
  if (!sp.length) return { spN: 0 };
  const vals = Array.from(sp);
  const sum = vals.reduce((a, b) => a + b, 0);
  const max = Math.max(...vals);
  const nz = vals.filter((v) => v > 0).length;
  const idx = vals.indexOf(max);
  return {
    spN: vals.length,
    spSum: round4(sum),
    spMax: round4(max),
    spNonZero: nz,
    spTopIdx: idx,
    adMass: round4(fused?.adP ? fused.adP.reduce((a, b) => a + b, 0) : null),
    genusTotal: round4(fused ? genusTotals(fused, idx, head) : null),
  };
}

/** What the verdict on the photo says, in numbers a log line can be read from. */
export function verdictSummary(
  p: Pick<PhotoState, "verdict">,
): Record<string, VerdictState | string | null | number> {
  const v = p.verdict;
  return v
    ? { state: v.state, genus: v.genus, topGenusP: round4(v.topGenusP), topSpeciesP: round4(v.topSpeciesP) }
    : {};
}

/**
 * The summed posterior of every species in the winning species' genus.
 *
 * Null where there is no head to read the genus off, or where the winner is
 * outside the label set (`topIdx < 0`), rather than 0 - which would read as
 * "this genus scored nothing" when the truth is "there was nothing to score".
 */
export function genusTotals(
  fused: Partial<Pick<FusedResult, "spP">>,
  topIdx: number,
  head: Head | null,
): number | null {
  if (!head || topIdx < 0) return null;
  const g = genusOf(head.species[topIdx] ?? "");
  let t = 0;
  head.species.forEach((name, i) => {
    if (genusOf(name) === g) t += fused.spP?.[i] || 0;
  });
  return t;
}
