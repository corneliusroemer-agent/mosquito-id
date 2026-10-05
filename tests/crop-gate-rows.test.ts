// The crop gate must read the same nuisance rows `nonMosquitoGate` reads.
//
// `softmaxJoint` puts the species, nuisance and adjacent rows in ONE softmax, so
// a nuisance row that scores higher than every species row costs the photo its
// crop - it falls back to the whole frame. culico's head carries eight nuisance
// rows that are placeholders: measured, they hold 0.00000 of mass outside the
// head's bias coordinate, so they are constant vectors that score every photo
// alike. `informativeRows` is what says so, and both gates read through it.
//
// This file is about the CROP gate (`cropPassesGate`, called from main.js). The
// non-mosquito gate already reads informative rows only, so on a head whose
// nuisance block is entirely placeholders it reports no nuisance at all; the crop
// gate used to compare against the raw nuisance posteriors, so on the same head
// it could refuse a crop for evidence the verdict had already discarded.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { informativeRows, softmaxJoint } from "../src/confidence/softmax";
import { cropPassesGate } from "../src/confidence/cropGate";
import { nonMosquitoGate } from "../src/confidence/verdict";
import type { Head } from "../src/confidence/types";
import { DEFAULT_FLOORS } from "../src/confidence/types";

const here = dirname(fileURLToPath(import.meta.url));

/** culico-net-cls-v1's shipped head, with its declared intercept coordinate. */
function culicoHead(): Head {
  const raw = JSON.parse(
    readFileSync(join(here, "..", "public", "text_embeds_culico.json"), "utf8"),
  ) as Record<string, unknown>;
  return { ...raw, biasIndex: raw.bias_index } as unknown as Head;
}

/**
 * culico's nuisance block with its intercept weight rewritten.
 *
 * The intercept is the only weight a placeholder row carries, so it is the one
 * number that decides how much posterior those rows hold - and therefore whether
 * the crop gate reads them as evidence. The shipped file puts every one of them
 * at -20.7, which pushes them far below every species logit, so on culico today
 * the gate happens not to fire. The defect is not that number: it is that the
 * gate's answer depends on it at all.
 */
function withPlaceholderIntercept(head: Head, w: number): Head {
  const D = head.dim;
  const bias = head.biasIndex!;
  const nu = (head.nuisance_emb as number[]).slice();
  const n = head.nuisance?.length ?? 0;
  for (let i = 0; i < n; i++) {
    if (informativeRows(head, head.nuisance_emb, n)[i]) continue;
    nu[i * D + bias] = w;
  }
  return { ...head, nuisance_emb: nu };
}

/**
 * A hesitant crop: no image information at all in the feature coordinates, so
 * every species row sits at cosine 0 and the softmax has no reason to prefer any
 * of them. It is the case the crop is most informative in and the case the gate
 * used to throw away.
 */
function hesitantCrop(head: Head): number[] {
  const emb = new Array<number>(head.dim).fill(0);
  emb[head.biasIndex!] = 1;
  return emb;
}

const real = culicoHead();
const hesitant = hesitantCrop(real);

describe("the crop gate reads only rows that carry image information", () => {
  it("culico's nuisance block is eight placeholders, none of them a detector", () => {
    const keep = informativeRows(real, real.nuisance_emb, real.nuisance!.length);
    expect(keep.some(Boolean)).toBe(false);
  });

  it("keeps a hesitant crop whose nuisance mass sits in those placeholder rows", () => {
    // The head a fix must hold: all eight nuisance rows are placeholders whose
    // intercept puts them above every species row on an undecided crop.
    const head = withPlaceholderIntercept(real, 1);
    const j = softmaxJoint(head, hesitant);

    // The crop really is one the old arithmetic refused: the nuisance block
    // outscores every species row.
    expect(Math.max(...j.nuP)).toBeGreaterThan(Math.max(...j.spP));
    // And the verdict gate has already ruled that evidence inadmissible.
    expect(nonMosquitoGate(head, j.adP, j.nuP, DEFAULT_FLOORS)?.kind).not.toBe("nuisance");

    // So the crop survives: both gates must agree on which rows are evidence.
    expect(cropPassesGate(head, j.spP, j.nuP)).toBe(true);
  });

  it("cannot be moved by the weight on a row that carries no image information", () => {
    // The invariant the fix establishes, stated so it cannot be satisfied by
    // accident: the crop gate's answer does not depend on what a non-informative
    // row weighs, because it does not read it.
    for (const w of [-20.7, -1, 0, 1, 5, 40]) {
      const head = withPlaceholderIntercept(real, w);
      const j = softmaxJoint(head, hesitant);
      expect(cropPassesGate(head, j.spP, j.nuP), `intercept ${w}`).toBe(true);
    }
  });

  it("still rejects a crop a genuinely fitted nuisance row outscores", () => {
    // The other direction, so the fix cannot be read as "always keep the crop":
    // culico's ONE fitted adjacent row is nuisance evidence the gate must be
    // able to act on when it stands in the nuisance block. Give the head a
    // nuisance row with real mass in it and a crop that lands on it.
    const head = culicoHead();
    const D = head.dim;
    const n = head.nuisance!.length;
    const nu = (head.nuisance_emb as number[]).slice();
    // Row 0 becomes a real detector: mass on its own coordinate, the rest zero.
    for (let k = 0; k < D; k++) nu[k] = 0;
    nu[0] = 1;
    const fitted: Head = { ...head, nuisance_emb: nu };
    const keep = informativeRows(fitted, fitted.nuisance_emb, n);
    expect(keep.filter(Boolean)).toHaveLength(1);

    // An embedding on that row's coordinate: the nuisance row wins the softmax.
    // `softmaxJoint` scales a raw dot product, so the magnitude is the lever.
    const emb = new Array<number>(D).fill(0);
    emb[0] = 10;
    emb[head.biasIndex!] = 1;
    const j = softmaxJoint(fitted, emb);
    expect(Math.max(...j.nuP)).toBeGreaterThan(Math.max(...j.spP));
    expect(cropPassesGate(fitted, j.spP, j.nuP)).toBe(false);
  });

  it("leaves the shipped heads' crops exactly where they were", () => {
    // The two text heads have no bias coordinate, so every row of theirs is
    // informative and the filter removes nothing: the gate's answer is the one
    // the raw comparison gave.
    for (const file of ["text_embeds.json", "text_embeds_b16.json"]) {
      const raw = JSON.parse(readFileSync(join(here, "..", "public", file), "utf8")) as Record<string, unknown>;
      const head = { ...raw } as unknown as Head;
      const first = head.species_emb as number[];
      const emb = new Array<number>(head.dim).fill(0);
      for (let k = 0; k < head.dim; k++) emb[k] = first[k]!;
      const j = softmaxJoint(head, emb);
      const was = Math.max(...j.spP) >= Math.max(...j.nuP);
      expect(cropPassesGate(head, j.spP, j.nuP), file).toBe(was);
    }
  });
});
