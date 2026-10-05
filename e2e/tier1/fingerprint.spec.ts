import { boot, errors, expect, test } from "../helpers/app";

/**
 * A photo's pooling fingerprint is a hash of its bytes.
 *
 * It used to be `cropW x cropH - fullW x fullH`, so two different photographs of
 * the same size shared one and "Dependent evidence" pooled them as a single
 * observation.
 */
test("same-sized distinct photos get distinct fingerprints; identical bytes get equal ones", async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const A = window.__mosqAsync!;
    A.sessDet = {
      inputNames: ["images"],
      async run() { return { output0: { dims: [1, 5, 8400], data: new Float32Array(5 * 8400) } }; },
    };
    const emb = await fetch("text_embeds.json").then((x) => x.json());
    for (const k of ["species_emb", "nuisance_emb"]) emb[k] = Float32Array.from(emb[k]);
    A.embeds = emb;
    A.sessClip = {
      inputNames: ["pixel_values"],
      async run() {
        const dim = A.embeds.dim as number;
        return { embedding: { dims: [1, dim], data: new Float32Array(dim).fill(1 / Math.sqrt(dim)) } };
      },
    };
    const make = async (hue: number, name: string) => {
      const cv = document.createElement("canvas");
      cv.width = 640; cv.height = 480;
      const g = cv.getContext("2d")!;
      g.fillStyle = `hsl(${hue}, 50%, 50%)`; g.fillRect(0, 0, 640, 480);
      g.fillStyle = "#fff"; g.fillRect(hue, 20, 100, 100);
      const blob = await new Promise<Blob>((res) => cv.toBlob((b) => res(b!), "image/jpeg", 0.9));
      return new File([blob], name, { type: "image/jpeg" });
    };
    const a = await make(30, "a.jpg");
    const b = await make(200, "b.jpg");
    const a2 = new File([a], "a-copy.jpg", { type: "image/jpeg" });
    await A.processFiles([a, b, a2]);
    const byName = Object.fromEntries(A.previews.map((p: any) => [p.name, p.fingerprint]));
    return { byName, dims: A.previews.map((p: any) => `${p.fullCanvas.width}x${p.fullCanvas.height}`) };
  });
  expect(new Set(r.dims).size).toBe(1); // same dimensions: the old fingerprint could not tell them apart
  expect(r.byName["a.jpg"]).toMatch(/^[0-9a-f]{64}$/);
  expect(r.byName["b.jpg"]).toMatch(/^[0-9a-f]{64}$/);
  expect(r.byName["a.jpg"]).not.toBe(r.byName["b.jpg"]);
  expect(r.byName["a-copy.jpg"]).toBe(r.byName["a.jpg"]);
  expect(errors(page)).toHaveLength(0);
});
