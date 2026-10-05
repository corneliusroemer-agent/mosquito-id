/**
 * A crop the user just released must survive a batch result that lands while
 * that crop's own inference is still in flight.
 *
 * The race is reachable without anything unusual: a queued photo is fully
 * draggable from the moment its decode finishes, because `decodeStage` records
 * the frame's dimensions and paints the display canvas before `inferSlot` runs,
 * and nothing disables the crop surface while `isProcessingBatch` is set. So the
 * photo whose inference is running is the one on screen, and a crop drawn on it
 * calls `beginRecompute`, taking `rev` from 0 to 1, while the batch's inference
 * is somewhere in its awaits.
 *
 * What the batch then did was compare `slot.rev` against a reading of itself
 * taken one line above, with no await in between. That is always false, so the
 * guard never fired, and `Object.assign` painted the detector's box and canvases
 * back over the crop and wrote `rev: 0` from `classifyImage`'s base literal,
 * rewinding the photo's revision. The crop's own classification then failed
 * `ownsRecompute` and was discarded, and what the user saw was the crop they had
 * just drawn silently revert to the detector's box.
 *
 * The fix is to capture the revision before the batch's first await and compare
 * against THAT, so the overtaken result is dropped instead. This pins the
 * property, not the mechanism: it calls the real `commitBatchSlot` from
 * `main.js` with the real argument list `main.js` calls it with, so a change
 * that moved either one and broke the guard would fail here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beginRecompute, commitScores, ownsRecompute } from "../src/app/photoRecord";
import type { PhotoState } from "../src/app/photoRecord";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const main = readFileSync(join(root, "src", "app", "main.js"), "utf8");

/**
 * The body of `commitBatchSlot`, read out of `main.js` and compiled with its two
 * free variables supplied.
 *
 * Read rather than imported because it is a closure inside `processFiles`, which
 * touches the DOM and the model. Compiled rather than reimplemented because the
 * guard IS the thing under test: a copy of it here would pass whether or not
 * `main.js` still has one.
 */
function loadCommitBatchSlot(previews: PhotoState[], logs: { event: string; fields: unknown }[]) {
  const start = main.indexOf("function commitBatchSlot");
  if (start < 0) throw new Error("commitBatchSlot not found in main.js");
  const src = main.slice(start, main.indexOf("\n}", start) + 2);
  const sendLog = (event: string, fields: unknown) => logs.push({ event, fields });
  // eslint-disable-next-line no-new-func
  return new Function("previews", "sendLog", `${src}\nreturn commitBatchSlot;`)(previews, sendLog);
}

/**
 * The argument list `inferSlot` passes on the local path, taken from its own call
 * site in `main.js` and evaluated here.
 *
 * This is what makes the test bite against the old code rather than merely run on
 * it. The old call site reads `commitBatchSlot(slots[i], res)` - two arguments,
 * the revision nowhere - so evaluating the real expression hands the old
 * signature exactly the arguments the old signature expects, and the guard
 * under test is the old guard.
 */
function localCallExpr(): string {
  const at = main.indexOf("await classifyImage(slot.bitmap");
  if (at < 0) throw new Error("the local classifyImage call site not found in main.js");
  const call = main.indexOf("commitBatchSlot(", at);
  const semicolon = main.indexOf(";", call);
  // The call's argument list, verbatim minus the call's closing paren, so it can
  // be re-called against the extracted `commitBatchSlot`.
  return main.slice(call + "commitBatchSlot(".length, semicolon - 1);
}

/**
 * `main.js` with comments blanked out, positions preserved.
 *
 * `inferSlot` documents its own suspension points, so a search for `await ` over
 * the raw source finds prose before it finds the first `await` keyword - and
 * this file's own comment about that is one of them. Blanking each comment to
 * spaces rather than deleting it keeps the two indices comparable.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)).replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/** A photo as the batch creates it: pending, uncropped, `rev` at 0. */
function batchSlot(name = "m.jpg"): PhotoState {
  return {
    name,
    displayCanvas: null,
    fullW: 800,
    fullH: 600,
    cropCanvas: null,
    contextCanvas: null,
    cropBox: null,
    contextBox: null,
    scores: {},
    detail: {},
    logits: null,
    adP: null,
    status: "queued…",
    crop_rejected: false,
    is_cropped: false,
    manual_full_photo: false,
    fingerprint: null,
    rev: 0,
    pending: true,
    error: null,
    agreement: null,
    viewsLanded: 0,
    viewsTotal: 0,
    detTime: null,
    clipTime: null,
    totalTime: null,
  } as unknown as PhotoState;
}

/** A canvas, as the only stand-in a geometry assertion needs. */
function canvas(id: string) {
  return { id } as unknown as HTMLCanvasElement;
}

const CROP_BOX: [number, number, number, number] = [40, 30, 300, 260];
const DETECTOR_BOX: [number, number, number, number] = [0, 0, 800, 600];

/**
 * The whole race, driven through the real guard.
 *
 * Returns the photo after the batch result has landed and the crop's own
 * classification has had its chance to commit.
 */
function runRace() {
  const slot = batchSlot();
  const previews = [slot];
  const logs: { event: string; fields: unknown }[] = [];
  const commitBatchSlot = loadCommitBatchSlot(previews, logs);

  // The batch's inference starts here, and reads the photo's revision.
  const startRev = slot.rev;

  // ...which is where the user releases a crop on it. `beginRecompute` is the
  // whole of the interference: it bumps `rev` and marks the photo pending.
  const cropRev = beginRecompute(slot);
  const cropCv = canvas("user-crop");
  slot.cropCanvas = cropCv;
  slot.contextCanvas = canvas("user-context");
  slot.cropBox = CROP_BOX;
  slot.contextBox = CROP_BOX;
  slot.is_cropped = true;
  slot.status = "manual crop: 260x230px";

  // The batch's inference lands, with the detector's own geometry and the base
  // literal's `rev: 0`, and is handed to the guard exactly as `inferSlot`
  // hands it over.
  const res = {
    name: slot.name,
    cropBox: DETECTOR_BOX,
    contextBox: DETECTOR_BOX,
    cropCanvas: canvas("detector-crop"),
    contextCanvas: canvas("detector-context"),
    scores: { aedes: 0.91 },
    detail: { "aedes aegypti": 0.91 },
    verdict: { genus: "aedes" },
    is_cropped: false,
    status: "auto",
    rev: 0,
  };
  const slots = [slot];
  // eslint-disable-next-line no-new-func
  new Function("commitBatchSlot", "slots", "i", "startRev", "res", `return commitBatchSlot(${localCallExpr()});` )(commitBatchSlot, slots, 0, startRev, res);

  // The crop's own inference now checks whether it still owns the photo, which
  // is the check the rewound revision used to fail.
  const stillOwns = ownsRecompute(slot, previews, 0, cropRev);
  if (stillOwns) {
    commitScores(
      slot,
      {
        labels: { anopheles: 0.62 },
        detail: { "anopheles gambiae": 0.62 },
        logits: { "anopheles gambiae": 4.1 },
        adP: [0.01],
        adjacentDetail: { anopheles: 0.62 },
        verdict: {
          state: "species",
          genus: "anopheles",
          species: "anopheles gambiae",
          topGenusP: 0.62,
          topSpeciesP: 0.62,
          runnersUp: [],
        },
      },
      "webgpu-fp16",
    );
  }
  return { slot, logs, cropRev, stillOwns };
}

describe("a batch result overtaken by a crop release", () => {
  it("leaves the crop the user drew in place", () => {
    const { slot } = runRace();
    expect(slot.cropBox, "the batch result repainted the detector's box over the crop").toEqual(CROP_BOX);
    expect(slot.is_cropped).toBe(true);
  });

  it("leaves the crop's own pixels and its context in place", () => {
    const { slot } = runRace();
    expect((slot.cropCanvas as unknown as { id: string }).id).toBe("user-crop");
    expect((slot.contextCanvas as unknown as { id: string }).id).toBe("user-context");
  });

  it("does not rewind the revision the crop's classification is holding", () => {
    const { slot, cropRev } = runRace();
    expect(slot.rev).toBe(cropRev);
  });

  it("does not discard the crop's own classification", () => {
    const { slot, stillOwns } = runRace();
    expect(stillOwns, "the crop lost ownsRecompute, so its result was thrown away").toBe(true);
    // The crop's numbers, not the batch's.
    expect(slot.scores).toEqual({ anopheles: 0.62 });
  });

  it("leaves the photo neither loading nor failed once the crop settles", () => {
    const { slot } = runRace();
    // The dropped batch result is not a second unfinished computation: the
    // release that took the revision is the thing settling this photo, and it
    // has now done so. A re-run enqueued here would race that release.
    expect(slot.pending).toBe(false);
    expect(slot.error).toBeNull();
  });

  it("says it dropped a result, with both revisions in the log", () => {
    const { logs } = runRace();
    const dropped = logs.find((l) => l.event === "batch_slot_superseded");
    expect(dropped, "the dropped result was not reported").toBeDefined();
    expect(dropped!.fields).toMatchObject({ name: "m.jpg", rev: 0, currentRev: 1 });
  });

  it("captures the revision before the batch's first await, and passes it on the server path too", () => {
    // The capture has to be ahead of the first suspension point, or it is the
    // same reading taken too late to mean anything.
    const infer = main.slice(main.indexOf("async function inferSlot"));
    const capture = infer.indexOf("const startRev = slot.rev;");
    expect(capture).toBeGreaterThan(-1);
    // Comments talk about awaits, so the comparison is made on the code with
    // them stripped: what matters is the first suspension point, not the first
    // mention of one.
    const code = stripComments(infer);
    const firstAwait = code.indexOf("await ");
    expect(capture, "the revision is read after an await, so it can already have moved").toBeLessThan(firstAwait);
    // Both call sites, or the server path keeps the unguarded commit.
    expect(main.match(/commitBatchSlot\(slots\[i\], startRev,/g)).toHaveLength(2);
  });
});

describe("a batch result that has not been overtaken", () => {
  it("still commits", () => {
    const slot = batchSlot("uncontended.jpg");
    slot.cropCanvas = canvas("detector-crop");
    slot.cropBox = DETECTOR_BOX;
    const previews = [slot];
    const logs: { event: string; fields: unknown }[] = [];
    const commitBatchSlot = loadCommitBatchSlot(previews, logs);

    const startRev = slot.rev;
    const res = { name: "uncontended.jpg", cropBox: DETECTOR_BOX, scores: { aedes: 0.91 }, rev: 0 };
    const slots = [slot];
    // eslint-disable-next-line no-new-func
    new Function("commitBatchSlot", "slots", "i", "startRev", "res", `return commitBatchSlot(${localCallExpr()});` )(commitBatchSlot, slots, 0, startRev, res);

    expect(slot.scores).toEqual({ aedes: 0.91 });
    expect(slot.pending).toBe(false);
    expect(logs.filter((l) => l.event === "batch_slot_superseded")).toHaveLength(0);
    expect(commitBatchSlot).toBeTypeOf("function");
  });

  it("still drops a deleted photo", () => {
    const slot = batchSlot("deleted.jpg");
    const previews = [slot];
    const logs: { event: string; fields: unknown }[] = [];
    const commitBatchSlot = loadCommitBatchSlot(previews, logs);
    slot.removed = true;

    const res = { name: "deleted.jpg", scores: { aedes: 0.91 }, rev: 0 };
    const slots = [slot];
    // eslint-disable-next-line no-new-func
    new Function("commitBatchSlot", "slots", "i", "startRev", "res", `return commitBatchSlot(${localCallExpr()});`)(commitBatchSlot, slots, 0, 0, res);

    expect(slot.scores).toEqual({});
    expect(logs.map((l) => l.event)).toContain("batch_slot_superseded");
  });
});