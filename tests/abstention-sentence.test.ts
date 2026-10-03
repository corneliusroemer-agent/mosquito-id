// An abstention that says what it is unsure between.
//
// The `unsure` state used to render as one fixed line - "Not confident enough to
// name a genus" - which is true of every unconfident photo and therefore says
// nothing about any of them. The ranking underneath it already carries the
// numbers, so the sentence's only job is to say WHAT it is torn between.
//
// The genus state already did this ("Definitely Aedes - most likely albopictus,
// possibly aegypti or vexans"), so the unsure state is being brought to the same
// standard rather than given a new mechanism.
import { describe, it, expect, beforeAll } from "vitest";
import { realHead, post } from "./fixtures";
import type { Head } from "../src/confidence/types";
import { DEFAULT_FLOORS } from "../src/confidence/types";
import { verdictFrom, verdictSentence } from "../src/confidence/verdict";

let head: Head;
beforeAll(() => {
  head = realHead();
});

const unsure = (over: Record<string, number>) => {
  const v = verdictFrom(head, post(head, over), null, []);
  expect(v.state).toBe("unsure");
  return v;
};

describe("the unsure sentence names the candidates", () => {
  it("says what it is torn between rather than only that it is unsure", () => {
    const v = unsure({ "Aedes aegypti": 0.22, "Culex pipiens": 0.2, "Culiseta annulata": 0.18 });
    const sent = verdictSentence(v);
    // Still an abstention: the leading candidates are named, not claimed.
    expect(sent).toMatch(/not confident/i);
    expect(sent).toContain("aegypti");
    expect(sent).toContain("pipiens");
  });

  it("leads with the most likely candidate, then the next", () => {
    const v = unsure({ "Aedes aegypti": 0.22, "Culex pipiens": 0.2, "Culiseta annulata": 0.18 });
    const sent = verdictSentence(v);
    expect(sent.indexOf("aegypti")).toBeGreaterThanOrEqual(0);
    expect(sent.indexOf("aegypti")).toBeLessThan(sent.indexOf("pipiens"));
  });

  it("uses genus-first names, so the line stays short", () => {
    const v = unsure({ "Aedes aegypti": 0.2, "Aedes albopictus": 0.19, "Culex pipiens": 0.18 });
    const sent = verdictSentence(v);
    // "aegypti" not "Aedes aegypti": the epithet alone names it, and the line
    // already opens with the reason it is unsure.
    expect(sent).toContain("aegypti");
    expect(sent).not.toContain("Aedes aegypti");
  });

  it("stays an abstention with one candidate, and names it", () => {
    // A degenerate posterior: one species carries almost everything but is under
    // the species floor. There is nothing to be "torn between", and the sentence
    // must not imply there is.
    const v = verdictFrom(head, post(head, { "Aedes aegypti": 0.30, "Aedes albopictus": 0.20,
      "Culex pipiens": 0.15, "Aedes vexans": 0.1, "Culex torrentium": 0.1, "Culiseta annulata": 0.075,
      "Anopheles maculipennis": 0.05, "Aedes japonicus": 0.025 }), null, []);
    expect(v.state).toBe("unsure");
    const sent = verdictSentence(v);
    expect(sent).toMatch(/not confident/i);
    expect(sent).toContain("aegypti");
  });

  it("degrades to the plain line when there is no posterior at all", () => {
    const v = verdictFrom(head, [], null, []);
    expect(v.state).toBe("unsure");
    // Nothing to name, so nothing is named - but the line is still an abstention.
    expect(verdictSentence(v)).toMatch(/not confident/i);
  });

  it("the floors it reads are the shipped ones", () => {
    expect(DEFAULT_FLOORS.species).toBe(0.373);
    expect(DEFAULT_FLOORS.genus).toBe(0.8);
  });
});
