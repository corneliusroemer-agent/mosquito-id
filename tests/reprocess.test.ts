/**
 * The engine re-run button: which photos it offers to re-run, and what it says.
 *
 * The defect this exists to fix is that switching the engine leaves the loaded
 * photos holding the previous engine's scores with nothing on the page saying so.
 * The button is the whole of the fix, so what is pinned here is that it appears
 * exactly when a score on screen came from an engine other than the selected one
 * - no earlier, because re-running every loaded photo is minutes and battery the
 * user did not ask to spend, and no later, because a stale score with no signal
 * is the bug.
 *
 * Staleness is read per photo, not as one flag, so these cases are the point
 * rather than an implementation detail: a photo dropped after the switch was
 * scored by the new engine and is not stale, and switching back to the engine
 * that scored the others makes them current again. A single boolean gets both of
 * those wrong in opposite directions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderReprocessButton, sourceFileFor, stalePhotos } from "../src/app/reprocess";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(root, "index.html"), "utf8");

const FP16 = "webgpu-fp16";
const CULICO = "webgpu-culico";

/**
 * A photo, with the only field staleness reads plus a name that says which one
 * it is - an assertion that lists three of the same filename cannot say which
 * three.
 */
function photo(
  scoredBy: string | null | undefined,
  name = "p.jpg",
  extra: Record<string, unknown> = {},
) {
  return { name, scoredBy, ...extra };
}

/** A button, reduced to what drawing it touches. */
function fakeButton() {
  const view = {
    style: { visibility: "" },
    disabled: false,
    attrs: {} as Record<string, string>,
    setAttribute(name: string, value: string) {
      view.attrs[name] = value;
    },
    removeAttribute(name: string) {
      delete view.attrs[name];
    },
  };
  return view;
}

describe("which photos need re-running", () => {
  it("offers the photos scored by an engine that is not the one selected", () => {
    const photos = [photo(FP16, "h14-a.jpg"), photo(FP16, "h14-b.jpg"), photo(CULICO, "culico.jpg")];
    expect(stalePhotos(photos, CULICO).map((p) => p.name)).toEqual(["h14-a.jpg", "h14-b.jpg"]);
    expect(stalePhotos(photos, FP16).map((p) => p.name)).toEqual(["culico.jpg"]);
  });

  it("offers nothing when every photo was scored by the selected engine", () => {
    expect(stalePhotos([photo(FP16), photo(FP16)], FP16)).toEqual([]);
  });

  it("offers nothing when no photo is on screen", () => {
    // The switch happened, but there is nothing to re-run: the button's whole
    // claim is that a score on screen is wrong, and there is no score on screen.
    expect(stalePhotos([], CULICO)).toEqual([]);
  });

  it("does not call a photo that has never been scored stale", () => {
    // A queued photo, a photo still decoding, a photo whose classification
    // failed. None of them is showing a verdict from another engine, and each
    // already says on its own tile why it has none.
    const photos = [
      photo(undefined, "queued.jpg"),
      photo(null, "failed.jpg"),
      photo(CULICO, "culico.jpg"),
    ];
    // Only the third: the first two have no verdict for any engine to be stale
    // relative to.
    expect(stalePhotos(photos, FP16).map((p) => p.name)).toEqual(["culico.jpg"]);
    expect(stalePhotos(photos, CULICO)).toEqual([]);
  });

  it("leaves alone a photo that has been deleted but not yet spliced out", () => {
    // `deletePhoto` marks a photo removed before splicing it, so an inference
    // still in flight for it drops its result. Staleness has to read that same
    // mark, or a deleted photo would keep the button on the page.
    const photos = [photo(CULICO, "live.jpg"), photo(CULICO, "gone.jpg", { removed: true })];
    expect(stalePhotos(photos, FP16).map((p) => p.name)).toEqual(["live.jpg"]);
    expect(stalePhotos([photo(CULICO, "gone.jpg", { removed: true })], FP16)).toEqual([]);
  });

  it("treats switching back as making the photos current again", () => {
    // Three photos on H/14, a switch to culico, a switch straight back. Nothing
    // was re-run, and nothing needs to be: the scores on screen are the ones the
    // selected engine gave.
    const photos = [photo(FP16, "a.jpg"), photo(FP16, "b.jpg")];
    expect(stalePhotos(photos, CULICO)).toHaveLength(2);
    expect(stalePhotos(photos, FP16)).toEqual([]);
  });

  it("re-runs only the photos the switch left behind", () => {
    // The mixed gallery a switch actually produces: a photo dropped after it was
    // scored by the new engine, and is not stale. Re-running it would be the
    // batch spent a second time for a result it already has.
    const photos = [photo(FP16, "old-a.jpg"), photo(FP16, "old-b.jpg"), photo(CULICO, "new.jpg")];
    expect(stalePhotos(photos, CULICO).map((p) => p.name)).toEqual(["old-a.jpg", "old-b.jpg"]);
  });
});

describe("the button", () => {
  it("is not offered when nothing is stale", () => {
    const btn = fakeButton();
    renderReprocessButton(btn, { stale: 0, engineLabel: "culico-net-cls-v1", blockedBy: null });
    expect(btn.style.visibility).toBe("hidden");
    // A hidden button that kept its name is a tab stop and an announcement for
    // something the page is not offering.
    expect(btn.attrs["aria-label"]).toBeUndefined();
    expect(btn.attrs.title).toBeUndefined();
  });

  it("is offered, and says what it would do, when something is stale", () => {
    const btn = fakeButton();
    renderReprocessButton(btn, { stale: 3, engineLabel: "culico-net-cls-v1", blockedBy: null });
    expect(btn.style.visibility).toBe("visible");
    expect(btn.disabled).toBe(false);
    expect(btn.attrs["aria-label"]).toContain("3 photos");
    expect(btn.attrs["aria-label"]).toContain("culico-net-cls-v1");
    // Detection and classification are named because the button re-runs the
    // whole cascade, not just the classifier the engine dropdown names.
    expect(btn.attrs["aria-label"]).toContain("detection and classification");
  });

  it("says nothing about a photo count in its text", () => {
    // The count lives in the accessible name, never in the label: a label whose
    // width changes with the count would move the ENGINE selector beside it every
    // time a photo is added or deleted.
    expect(HTML).not.toMatch(/id="btn-reprocess"[^>]*>[^<]*\d/);
  });

  it("stays visible while it cannot be pressed, and says which of the two reasons", () => {
    // Two different reasons, and the reader has to be able to tell them apart:
    // a batch writing into the gallery, versus the new engine's weights still
    // downloading - during which a click would run the PREVIOUS engine's
    // classifier and stamp the new engine's name on the result.
    const batch = fakeButton();
    renderReprocessButton(batch, { stale: 2, engineLabel: "X", blockedBy: "batch" });
    expect(batch.style.visibility).toBe("visible");
    expect(batch.disabled).toBe(true);
    expect(batch.attrs.title).toBe("batch");

    const model = fakeButton();
    renderReprocessButton(model, { stale: 2, engineLabel: "X", blockedBy: "loading" });
    expect(model.style.visibility).toBe("visible");
    expect(model.disabled).toBe(true);
    expect(model.attrs.title).toBe("loading");
  });

  it("uses the singular for one photo", () => {
    const btn = fakeButton();
    renderReprocessButton(btn, { stale: 1, engineLabel: "X", blockedBy: null });
    expect(btn.attrs["aria-label"]).toContain("1 photo with");
    expect(btn.attrs["aria-label"]).not.toContain("1 photos");
  });
});

describe("the button's place in the page", () => {
  // Placement and reserved space are layout facts, and layout facts are readable
  // from the markup without a browser. What a text scan cannot see - whether the
  // reserved box is wide enough at a given viewport - is e2e/tier1's business.
  it("sits beside the ENGINE label, on its left, at the top", () => {
    const at = HTML.indexOf('id="btn-reprocess"');
    expect(at, "#btn-reprocess is in index.html").toBeGreaterThan(-1);
    const box = HTML.indexOf('class="engine-control-box"');
    expect(box, "the engine control box is in index.html").toBeGreaterThan(-1);
    const label = HTML.indexOf('for="engine-select"');
    expect(label).toBeGreaterThan(-1);
    // Inside the same row, and before the label it belongs to.
    expect(at).toBeGreaterThan(box);
    expect(at).toBeLessThan(label);
  });

  it("reserves its space from first paint rather than taking it when it appears", () => {
    // `visibility`, not `display: none` and not insertion. A display toggle would
    // take the button's width out of the row and put it back, and the engine row
    // is the header's top-right corner, so everything below it moves.
    expect(HTML).toMatch(/#btn-reprocess\s*\{[^}]*visibility:\s*hidden/);
    expect(HTML).not.toMatch(/#btn-reprocess\s*\{[^}]*display:\s*none/);
  });

  it("does not sit inside the engine <select>, where it could not be clicked", () => {
    const select = HTML.match(/<select id="engine-select"[\s\S]*?<\/select>/);
    expect(select).not.toBeNull();
    expect(select![0]).not.toContain("btn-reprocess");
  });

  it("is a real button with its own accessible name, not a div", () => {
    const at = HTML.indexOf('id="btn-reprocess"');
    const tag = HTML.slice(HTML.lastIndexOf("<", at), HTML.indexOf(">", at));
    expect(tag).toMatch(/<button\b/);
    expect(tag).toMatch(/\btype="button"/);
    // The name main.js writes, not one baked into the markup: what it says
    // depends on how many photos are stale and which engine is selected.
    expect(HTML).not.toMatch(/id="btn-reprocess"[^>]*aria-label="[^"]+"/);
  });
});

describe("re-dropping a photo", () => {
  it("hands back the photo's own File when it has one", async () => {
    const file = new File(["x"], "a.jpg", { type: "image/jpeg" });
    expect(await sourceFileFor({ file, name: "a.jpg" })).toBe(file);
  });

  it("encodes the photo's canvas when it has no File", async () => {
    // The shape a photo the batch did not mint arrives in: decoded pixels and a
    // name, and nothing else. Without this it could not be re-run at all.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const fullCanvas = {
      toBlob(cb: (b: Blob | null) => void) {
        cb(new Blob([png], { type: "image/jpeg" }));
      },
    };
    const out = await sourceFileFor({ fullCanvas, name: "photo.jpg" });
    expect(out).not.toBeNull();
    expect(out!.name).toBe("photo.jpg");
    expect(out!.size).toBe(png.length);
  });

  it("gives the name an extension the batch will accept", async () => {
    // `processFiles` filters on the extension and drops a file without one in
    // silence, so a photo named from a clipboard paste would vanish on a re-run.
    const fullCanvas = { toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(["x"])) };
    for (const [name, expected] of [
      ["clipboard-1234-1", "clipboard-1234-1.jpg"],
      ["IMG_0042", "IMG_0042.jpg"],
      ["a.png", "a.png"],
      ["a.JPEG", "a.JPEG"],
    ] as const) {
      const out = await sourceFileFor({ fullCanvas, name });
      expect(out!.name, `a photo named ${name}`).toBe(expected);
    }
  });

  it("returns null for a photo with neither, rather than an empty File", async () => {
    // An empty File would pass the batch's filter and then fail to decode, which
    // reads as a broken photo rather than a photo that cannot be re-run.
    expect(await sourceFileFor({ name: "a.jpg" })).toBeNull();
    expect(
      await sourceFileFor({ name: "a.jpg", fullCanvas: { toBlob: (cb) => cb(null) } }),
    ).toBeNull();
  });
});

describe("the button's wiring in main.js", () => {
  // Everything above tests the module. This reads the wiring, because two of the
  // defects the module was written to prevent lived there and nowhere else:
  // `modelsReady` was cleared inside `loadWebGPUModels` rather than before the
  // button was drawn, which left the button enabled and inert for a whole
  // download; and the button was drawn before `currentEngine` had moved, so the
  // staleness it reported was computed against the engine being left behind.
  const MAIN = readFileSync(join(root, "src", "app", "main.js"), "utf8");
  const handler = MAIN.slice(
    MAIN.indexOf('engineSelect.addEventListener("change"'),
    MAIN.indexOf("const loadModels"),
  );

  it("marks the engine unusable before it draws the button, not after", () => {
    // Order matters and is the whole fix: cleared first, then drawn. Drawn
    // against a `modelsReady` still true from the previous engine, the button
    // reads enabled and every press on it is a silent no-op.
    expect(handler).toContain("if (chosen !== \"server-gpu\") window.modelsReady = false;");
    const clear = handler.indexOf("window.modelsReady = false;");
    const draw = handler.indexOf("updateReprocessButton();");
    expect(clear, "modelsReady is cleared in the change handler").toBeGreaterThan(-1);
    expect(draw, "the handler draws the button").toBeGreaterThan(-1);
    expect(clear, "the engine is marked unusable before the button is drawn")
      .toBeLessThan(draw);
  });

  it("draws the button after the selected engine has become current", () => {
    // The other half: `stalePhotos` compares against `currentEngine`, so a draw
    // placed before the assignment compares the photos against the engine being
    // left behind and finds nothing stale.
    const assign = handler.indexOf("currentEngine = chosen;");
    const draw = handler.indexOf("updateReprocessButton();");
    expect(assign).toBeGreaterThan(-1);
    expect(assign, "the engine is current before the button is drawn").toBeLessThan(draw);
  });

  it("draws the button again after a switch's load has failed", () => {
    // A failed load leaves the engine unusable, and the button has to say so
    // rather than keep the tooltip that invites the press.
    const catchBlock = handler.slice(handler.indexOf("} catch (err) {"));
    expect(catchBlock).toContain("engineLoadError");
    expect(catchBlock).toContain("updateReprocessButton();");
  });

  it("refuses to re-run while a re-classification holds the inference slot", () => {
    // `isProcessingBatch` is only ever true inside `processFiles`. The
    // whole-frame runner holds the single onnxruntime slot without setting it,
    // and two of them at once is the freeze the runner exists to prevent.
    expect(MAIN).toMatch(/if \(reclassifyRunner\.inFlight\) return;/);
    expect(MAIN).toMatch(/reclassifyRunner\.inFlight\s*\n?\s*\? REPROCESS_BLOCKED_BATCH/);
  });

  it("keeps a photo it cannot re-drop instead of dropping it with the gallery", () => {
    // The batch empties `previews`, so a photo left out of the drop and not
    // kept would vanish from the strip with nothing said.
    const fn = MAIN.slice(
      MAIN.indexOf("async function reprocessLoadedPhotos"),
      MAIN.indexOf("/** The button's one listener"),
    );
    expect(fn).toMatch(/const kept = \[\]/);
    expect(fn).toMatch(/else kept\.push\(p\)/);
    expect(fn).toMatch(/previews = \[\.\.\.kept\]/);
    // And it is not the old event, whose counts downstream reads as deletions.
    expect(fn).toContain('sendLog("reprocess_replaced"');
    expect(fn).not.toContain('sendLog("delete_all_photos"');
  });
});
