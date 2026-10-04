import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pooledRows } from "../src/app/poolingPanel";
import { pooledCandidates } from "../src/confidence/pooling";
import { speciesLabelHtml } from "../src/app/speciesLabels";
import { equivalenceGroups, resolvableGroups, setActiveHead } from "../src/app/granularity";
import type { Head } from "../src/confidence/types";

/**
 * One pooled ranking row per class the head can separate.
 *
 * Spec: docs/REPORT-GRANULARITY-SPEC.md R3.5. The pooled card renders one row
 * per GROUP; a head with byte-identical weight rows gives every member of a
 * group the same aggregated logit, so a row per species is the same row three
 * times under a label saying the three are one answer.
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

/**
 * Aggregated logits that give every member of a group the SAME number, as the
 * head does: a group's members share a weight row, so they share the sum, and
 * that shared number is what the collapsed row carries. Seeded off the head's
 * own grouping rather than the species index - a fixture that handed the three
 * Aedes a spread would not be the situation the app is in.
 */
function aggLogits(head: Head, over: Record<string, number>): Record<string, number> {
  const rankOf = new Map<string, number>();
  equivalenceGroups(head).forEach((g, i) => { for (const sp of g.species) rankOf.set(sp, i); });
  const out: Record<string, number> = {};
  head.species.forEach((sp) => { out[sp] = -rankOf.get(sp)!; });
  for (const [sp, v] of Object.entries(over)) {
    if (!(sp in out)) throw new Error(`fixture names a species the head does not carry: ${sp}`);
    out[sp] = v;
  }
  return out;
}

describe("the pooled card emits one row per group", () => {
  it("gives a three-member group one row, not three", () => {
    setActiveHead(CULICO);
    const rows = pooledRows(CULICO, aggLogits(CULICO, { "Aedes albopictus": 5, "Aedes aegypti": 4 }));
    const group = rows.filter((r) => r.name.startsWith("Aedes (") && r.name.includes("vexans"));
    expect(group).toHaveLength(1);
    expect(group[0]!.name).toBe("Aedes (vexans / geniculatus / cinereus not separable)");
  });

  it("gives a two-member group one row too - the rule is group size, not three", () => {
    // The shipped head has no two-member group, so one is built: two species
    // sharing a row and a third with its own.
    const dim = 4;
    const species = ["Aedes albopictus", "Culex pipiens", "Culex quinquefasciatus"];
    const head: Head = {
      species,
      adjacent: [], adjacent_common: [], nuisance: [],
      dim, logit_scale: 100,
      species_emb: [1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0],
      adjacent_emb: [], nuisance_emb: [],
    };
    setActiveHead(head);
    expect(equivalenceGroups(head).map((g) => g.species.length)).toEqual([1, 2]);
    const rows = pooledRows(head, { "Aedes albopictus": 3, "Culex pipiens": -2, "Culex quinquefasciatus": -2 });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name)).toEqual(["Aedes albopictus", "Culex (pipiens / quinquefasciatus not separable)"]);
  });

  it("leaves a singleton species as its own row", () => {
    setActiveHead(CULICO);
    const rows = pooledRows(CULICO, aggLogits(CULICO, { "Aedes albopictus": 5 }));
    expect(rows.map((r) => r.name)).toContain("Aedes albopictus");
  });

  it("counts rows by group, not by species column", () => {
    setActiveHead(CULICO);
    const rows = pooledRows(CULICO, aggLogits(CULICO, { "Aedes albopictus": 5 }));
    expect(rows).toHaveLength(equivalenceGroups(CULICO).length);
    expect(rows.length).toBeLessThan(CULICO.species.length);
    expect(new Set(rows.map((r) => r.name)).size).toBe(rows.length);
  });

  it("renders the group once where the species-level list renders it three times", () => {
    // The shape of the defect: `pooledCandidates` is one entry per species, so
    // rendering its rows is the same group repeated. `pooledRows` is what the
    // card draws, and the count is the difference.
    setActiveHead(CULICO);
    const agg = aggLogits(CULICO, {});
    const label = "Aedes (vexans / geniculatus / cinereus not separable)";
    const members = resolvableGroups(CULICO).find((g) => g.label === label)!.species;
    const perSpecies = pooledCandidates(CULICO, agg).filter((c) => members.includes(c.name));
    expect(perSpecies).toHaveLength(3);
    // The rendered rows collapse, and carry the label the card prints.
    expect(pooledRows(CULICO, agg).filter((r) => r.name === label)).toHaveLength(1);
    expect(speciesLabelHtml(members[0]!)).toContain("(vexans / geniculatus / cinereus not separable)");
  });

  it("carries the shared score of the group it collapsed", () => {
    setActiveHead(CULICO);
    const agg = aggLogits(CULICO, { "Aedes albopictus": 5 });
    const best = Math.max(...Object.values(agg));
    const vexans = agg["Aedes vexans"]! - best;
    const rows = pooledRows(CULICO, agg);
    const group = rows.find((r) => r.name.startsWith("Aedes ("))!;
    expect(group.relScore).toBeCloseTo(vexans, 12);
    // And it is the number all three members carried, which is why any one of
    // them would have been truthful.
    for (const s of resolvableGroups(CULICO).find((g) => g.genus === "Aedes")!.species) {
      expect(agg[s]! - best).toBeCloseTo(group.relScore, 12);
    }
  });

  it("changes nothing on a head that separates every species", () => {
    setActiveHead(H14);
    const agg = aggLogits(H14, {});
    const rows = pooledRows(H14, agg);
    expect(rows).toHaveLength(H14.species.length);
    expect(rows.map((r) => r.name)).toEqual([...H14.species].sort((a, b) => agg[b]! - agg[a]!));
  });

  it("keeps the relative order of the rows it does not collapse", () => {
    // Two collapsed groups and a singleton, ranked interleaved, so a merge that
    // reordered anything would show here.
    setActiveHead(H14);
    const species = H14.species;
    const byIndex = (i: number) => aggLogits(H14, { [species[0]!]: 3, [species[1]!]: 2, [species[2]!]: 1 })[species[i]!]!;
    expect([0, 1, 2].map(byIndex)).toEqual([3, 2, 1]);
    const rows = pooledRows(H14, aggLogits(H14, { [species[0]!]: 3, [species[1]!]: 2, [species[2]!]: 1 }));
    expect(rows[0]!.name).toBe(species[0]);
    expect(rows[1]!.name).toBe(species[1]);
    expect(rows[2]!.name).toBe(species[2]);
  });
});
