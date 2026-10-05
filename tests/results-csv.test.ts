import { describe, expect, it } from "vitest";
import { buildCsv, csvField, claimFor } from "../src/app/resultsTable";
import type { ClassifiedPhoto } from "../src/app/types";

/** A settled photo, over the fields the table reads. */
function photo(over: Partial<ClassifiedPhoto> = {}): ClassifiedPhoto {
  return {
    name: "a.jpg",
    scores: { Aedes: 0.9, Culex: 0.1 },
    detail: { "Aedes aegypti": 0.9, "Culex pipiens": 0.1 },
    verdict: { state: "species", genus: "Aedes", species: "Aedes aegypti" },
    status: "ok",
    is_cropped: true,
    ...over,
  } as ClassifiedPhoto;
}

const rows = (csv: string) => csv.trimEnd().split("\n");

describe("a photo with no verdict is exported as having none", () => {
  it("claimFor says 'No verdict', not 'species'", () => {
    expect(claimFor(photo({ verdict: null }), ["Aedes aegypti", 0.9])).toBe("No verdict");
    expect(claimFor(photo({ verdict: undefined as never }), ["Aedes aegypti", 0.9])).toBe("No verdict");
  });

  it("the CSV row does not name the top species", () => {
    const csv = buildCsv([photo({ verdict: null })]);
    expect(rows(csv)[1]).toContain('"No verdict"');
    expect(rows(csv)[1]).not.toContain('"Aedes aegypti"');
  });

  it("a photo that has a verdict is unchanged", () => {
    expect(rows(buildCsv([photo()]))[1]).toBe('1,"a.jpg","ok",true,"Aedes",90.0,"Aedes aegypti",90.0');
    expect(claimFor(photo({ verdict: { state: "unsure", genus: null } }), ["Aedes aegypti", 0.9])).toBe("Not confident");
    expect(claimFor(photo({ verdict: { state: "genus", genus: "Culex" } }), ["Aedes aegypti", 0.9])).toBe("Culex (genus only)");
  });
});

describe("CSV quoting follows RFC 4180", () => {
  it("csvField doubles embedded quotes and wraps the field", () => {
    expect(csvField('say "hi".jpg')).toBe('"say ""hi"".jpg"');
    expect(csvField("plain")).toBe('"plain"');
    expect(csvField("a,b")).toBe('"a,b"');
  });

  it("a name that would run as a spreadsheet formula is written as text", () => {
    expect(csvField("=HYPERLINK(\"http://x\")")).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvField("+1")).toBe("\"'+1\"");
    expect(csvField("@a")).toBe("\"'@a\"");
    expect(csvField("-")).toBe('"-"');
    expect(csvField("a=b")).toBe('"a=b"');
  });

  it("a file name with a quote, a comma and a newline stays one record", () => {
    const csv = buildCsv([photo({ name: 'a "b", c\nd.jpg' })]);
    expect(csv).toContain('"a ""b"", c\nd.jpg"');
    // Parse it back with a minimal RFC 4180 reader: one header + one record, 8 fields.
    const parsed = parseCsv(csv);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toHaveLength(8);
    expect(parsed[1]![1]).toBe('a "b", c\nd.jpg');
  });

  it("a failed photo's error message and status are quoted, not rewritten", () => {
    const csv = buildCsv([photo({ error: 'Could not read "x.jpg"', pending: false })]);
    const parsed = parseCsv(csv);
    expect(parsed[1]![2]).toBe('Could not read "x.jpg"');
  });

  it("a status with a quote round-trips", () => {
    const parsed = parseCsv(buildCsv([photo({ status: 'detector: "none"' })]));
    expect(parsed[1]![2]).toBe('detector: "none"');
  });
});

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, newlines inside quotes. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); out.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f || row.length) { row.push(f); out.push(row); }
  return out;
}
