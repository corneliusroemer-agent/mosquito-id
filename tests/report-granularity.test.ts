import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeName, capabilityOf, claimSentence, equivalenceGroups, groupLabel, groupOf,
  mergeUnresolvable, resolvableGroups, setActiveHead,
} from "../src/app/granularity";
import { speciesLabelHtml } from "../src/app/speciesLabels";
import { WEBGPU_MODELS, capabilityNote } from "../src/app/modelConfig";
import { verdictFrom, verdictSentence } from "../src/confidence/verdict";
import type { Head, Verdict } from "../src/confidence/types";
import { fixtureHead } from "./fixtures";

/**
 * What the app is allowed to name, per head.
 *
 * Spec: docs/REPORT-GRANULARITY-SPEC.md. Every rule it states is asserted here,
 * and the assertions that matter are on the RENDERED STRING - a name in prose is
 * the defect, and no intermediate value held one.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function headFrom(file: string): Head {
  const e = JSON.parse(readFileSync(join(root, "public", file), "utf8")) as Record<string, unknown>;
  return {
    species: e.species as string[],
    adjacent: e.adjacent as string[],
    adjacent_common: e.adjacent_common as string[],
    nuisance: e.nuisance as string[],
    dim: e.dim as number,
    logit_scale: e.logit_scale as number,
    species_emb: e.species_emb as number[],
    adjacent_emb: e.adjacent_emb as number[],
    nuisance_emb: e.nuisance_emb as number[],
  };
}

const CULICO = headFrom("text_embeds_culico.json");
const H14 = headFrom("text_embeds.json");
const B16 = headFrom("text_embeds_b16.json");

/** A head whose every row is distinct: what a refitted probe is expected to ship. */
function distinctHead(species: string[], dim = 8): Head {
  const h = fixtureHead(species, { dim });
  h.species_emb = new Float32Array(species.length * dim);
  species.forEach((_, i) => {
    for (let j = 0; j < dim; j++) h.species_emb![i * dim + j] = Math.sin(i * 7 + j);
  });
  return h;
}

const culicoGroups = () => resolvableGroups(CULICO);

describe("grouping is derived from the head", () => {
  it("finds exactly four groups of three in the shipped culico head", () => {
    const groups = culicoGroups();
    expect(groups).toHaveLength(4);
    expect(groups.map((g) => g.species.length)).toEqual([3, 3, 3, 3]);
    expect(groups.map((g) => g.label)).toEqual([
      "Aedes (vexans / geniculatus / cinereus not separable)",
      "Culex (pipiens / torrentium / quinquefasciatus not separable)",
      "Culiseta (annulata / morsitans / longiareolata not separable)",
      "Anopheles (maculipennis / claviger / plumbeus not separable)",
    ]);
  });

  it("finds no group in the H/14 or B/16 head", () => {
    expect(resolvableGroups(H14)).toEqual([]);
    expect(resolvableGroups(B16)).toEqual([]);
    expect(capabilityOf(H14)).toBe("species");
    expect(capabilityOf(B16)).toBe("species");
    expect(capabilityOf(CULICO)).toBe("genus");
  });

  it("a head whose rows are all distinct makes every species its own group", () => {
    // The regression guard for the planned refit: if it lands, this still holds
    // and the app reports species everywhere without a code change.
    const refit = distinctHead(H14.species);
    expect(resolvableGroups(refit)).toEqual([]);
    expect(equivalenceGroups(refit)).toHaveLength(H14.species.length);
    expect(capabilityOf(refit)).toBe("species");
    expect(groupOf(refit, "Aedes vexans")).toBeNull();
  });

  it("groups rows that are merely similar, not identical, as separate", () => {
    // The exact-equality test is load-bearing: a cosine threshold would take this
    // branch and suppress species the head can actually separate.
    const h = distinctHead(["Aedes vexans", "Aedes geniculatus", "Culex pipiens"]);
    const base = h.species_emb as Float32Array;
    base[1] = base[0]! + 1e-7;
    expect(resolvableGroups(h)).toEqual([]);
  });

  it("caches per head, so a reloaded head is re-derived and two heads do not collide", () => {
    expect(resolvableGroups(CULICO)).toBe(resolvableGroups(CULICO));
    expect(resolvableGroups(H14)).not.toBe(resolvableGroups(CULICO));
    expect(capabilityOf(H14)).toBe("species");
  });

  it("treats a head with no embeddings as separating everything", () => {
    expect(resolvableGroups(null)).toEqual([]);
    expect(resolvableGroups(fixtureHead(["Aedes aegypti"]))).toEqual([]);
  });
});

describe("ModelConfig's declared capability matches the head", () => {
  it("every engine's `reports` is what its head derives", () => {
    for (const [key, cfg] of Object.entries(WEBGPU_MODELS)) {
      const head = headFrom(cfg.embedsPath);
      expect(capabilityOf(head), `${key} (${cfg.embedsPath})`).toBe(cfg.reports);
    }
  });

  it("says so in the dropdown note, and only for a genus engine", () => {
    expect(capabilityNote("genus")).toContain("genus only");
    expect(capabilityNote("species")).toBe("");
  });
});

describe("what a verdict is allowed to print", () => {
  const groups = culicoGroups();
  /** A verdict from a real posterior, by the real gate - never hand-written. */
  const verdictFor = (over: Record<string, number>): Verdict => {
    const p = new Array<number>(CULICO.species.length).fill(0);
    for (const [n, v] of Object.entries(over)) p[CULICO.species.indexOf(n)] = v;
    return verdictFrom(CULICO, p, null, []);
  };

  it("never prints a bare species from a multi-member group", () => {
    // Every species in a group, at a posterior that clears the species floor on
    // its own, and a genus claim too. Not one rendered sentence may contain a
    // binomial the head cannot earn.
    for (const g of groups) {
      for (const name of g.species) {
        const rest = (1 - 0.9) / (CULICO.species.length - 1);
        const over: Record<string, number> = {};
        for (const s of CULICO.species) over[s] = s === name ? 0.9 : rest;
        const spoken = claimSentence(verdictFor(over), groups);
        expect(spoken, `${name} in the species state`).not.toContain(name);
        for (const other of g.species) expect(spoken).not.toContain(other);
        expect(spoken).toBe(groupLabel(g));
      }
    }
  });

  it("never prints a grouped species as a runner-up either", () => {
    // A genus claim whose LEADER is a singleton but whose runner-ups are a group:
    // "possibly vexans or geniculatus" names two species that are one output.
    const v = verdictFor({
      "Aedes albopictus": 0.30,
      "Aedes vexans": 0.19,
      "Aedes geniculatus": 0.19,
      "Aedes cinereus": 0.13,
      "Culex pipiens": 0.10,
    });
    expect(v.state).toBe("genus");
    const spoken = claimSentence(v, groups);
    expect(spoken).toContain("albopictus");
    expect(spoken).not.toContain("vexans");
    expect(spoken).not.toContain("geniculatus");
    expect(spoken).not.toContain("cinereus");
  });

  it("prints the species when the head separates it", () => {
    // The species state spends no sentence (R2.1): the ranking's top row IS the
    // claim, and that row is the binomial. What must not happen is the group
    // phrase appearing where the model could have named the species.
    const confident = verdictFor({ "Aedes albopictus": 0.9, "Aedes aegypti": 0.1 });
    expect(confident.state).toBe("species");
    expect(claimSentence(confident, groups)).toBe("");
    expect(activeName("Aedes albopictus")).toBe("Aedes albopictus");
    expect(speciesLabelHtml("Aedes albopictus")).toContain("Asian tiger mosquito");

    // Under the species floor the leader is named in the genus sentence instead,
    // and it is a binomial the head supports.
    // Spread across the genus so the genus clears its 0.80 floor while no single
    // species clears the 0.373 species floor - the ordinary genus-only outcome.
    const torn = verdictFor({
      "Aedes albopictus": 0.30, "Aedes aegypti": 0.20,
      "Aedes japonicus": 0.15, "Aedes koreicus": 0.15,
    });
    expect(torn.state).toBe("genus");
    const spoken = claimSentence(torn, groups);
    expect(spoken).toContain("albopictus");
    expect(spoken).not.toContain("not separable");
  });

  it("says nothing for unsure and keeps the non-mosquito sentence", () => {
    expect(claimSentence(verdictFor({ "Aedes albopictus": 0.05 }), groups)).toBe(
      "Not confident enough to name a genus",
    );
    expect(claimSentence(null, groups)).toBe("");
  });

  it("is a no-op on a head with no groups: the old sentences, unchanged", () => {
    const p = new Array<number>(H14.species.length).fill(0);
    p[H14.species.indexOf("Aedes albopictus")] = 0.9;
    p[H14.species.indexOf("Aedes aegypti")] = 0.05;
    const genusish = verdictFrom(H14, p, null, []);
    expect(claimSentence(genusish, [])).toBe(verdictSentence(genusish));
  });
});

describe("what the ranking is allowed to show", () => {
  it("one row per class, carrying the group phrase and one percentage", () => {
    const detail: Record<string, number> = {};
    CULICO.species.forEach((s, i) => (detail[s] = i < 4 ? 0.2 - i * 0.01 : 0.01));
    const rows = mergeUnresolvable(Object.entries(detail), (e) => e[1], (e) => e[0], culicoGroups());
    expect(rows).toHaveLength(CULICO.species.length - 8);
    expect(rows[0]!.name).toBe("Aedes albopictus");
    const groupRow = rows.find((r) => r.name.startsWith("Culex ("))!;
    expect(groupRow.source).toHaveLength(3);
    // All three Culex rows carry the same score, so the row carries it once.
    expect(groupRow.score).toBeCloseTo(detail["Culex pipiens"]!, 12);
    expect(rows.map((r) => r.name)).not.toContain("Culex pipiens");
  });

  it("keeps every row, and the order, when the head separates everything", () => {
    const detail = Object.fromEntries(H14.species.map((s, i) => [s, 1 - i / 100]));
    const rows = mergeUnresolvable(Object.entries(detail), (e) => e[1], (e) => e[0], []);
    expect(rows).toHaveLength(H14.species.length);
    expect(rows.map((r) => r.name)).toEqual(H14.species);
  });
});

describe("the species label itself", () => {
  it("renders a group as the group, and a singleton as before", () => {
    setActiveHead(CULICO);
    try {
      expect(speciesLabelHtml("Culex pipiens")).toBe(
        '<span>Culex</span> <span class="species-unresolvable">(pipiens / torrentium / quinquefasciatus not separable)</span>',
      );
      expect(speciesLabelHtml("Aedes albopictus")).toContain("species-kb-link");
      expect(speciesLabelHtml("Aedes albopictus")).toContain("Asian tiger mosquito");
    } finally {
      setActiveHead(H14);
    }
    expect(speciesLabelHtml("Aedes albopictus")).toContain("species-kb-link");
  });
});