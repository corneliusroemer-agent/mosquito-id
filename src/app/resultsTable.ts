/**
 * The results table, and the CSV that mirrors it.
 *
 * Both are pure reads of the photo list: they render what each photo's verdict
 * is and export exactly what the table shows, so a photo the app would not name
 * cannot leave the machine looking named. The list is passed in rather than read
 * from app state, which is the only thing these need.
 *
 * The export carries the strip's number as its own column rather than folding it
 * into `Filename`. The CSV is read by a spreadsheet as much as by a person, and
 * "Photo 4 \u00b7 nothing.jpg" is not the filename.
 */

import { activeName } from "./granularity";
import { photoRef } from "./thumbnailStrip";
import { escapeHtml } from "./speciesLabels";
import type { LogFn } from "./telemetry";
import type { ClassifiedPhoto } from "./types";

/**
 * Look up a static element that the table cannot render without.
 *
 * These ids are in index.html from first paint, so a miss means the markup and
 * this file have diverged - which should fail here rather than silently draw an
 * empty table the user reads as "no photos".
 */
function need<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from the page`);
  // getElementById cannot know T; the caller names the element type it expects.
  return el as unknown as T;
}

/**
 * What the app claims about one photo, in words: the species (as the loaded head
 * can separate it), the genus alone, or that it is not confident.
 *
 * A photo with no verdict at all - one the gate never ran on - has no claim, and
 * says so. It used to be read as a species verdict, which named the top of the
 * ranking as though the app had stood behind it.
 */
export function claimFor(p: ClassifiedPhoto, topSpec: [string, number] | (string | number)[]): string {
  const v = p.verdict;
  if (!v) return "No verdict";
  if (v.state === "species") return activeName(String(topSpec[0])) ?? String(topSpec[0]);
  if (v.state === "genus") return `${v.genus} (genus only)`;
  return "Not confident";
}

/** One CSV field, quoted, with embedded quotes doubled (RFC 4180 section 2.7). */
export function csvField(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

// ---- Results Table & CSV Export ----
export function renderResultsTable(previews: ClassifiedPhoto[]): void {
  const tbody = need<HTMLTableElement>("results-table").querySelector("tbody");
  if (!tbody) throw new Error("#results-table has no tbody");
  tbody.innerHTML = "";
  need("table-summary").textContent = `Processed ${previews.length} images.`;

  previews.forEach((p, i) => {
    // The row is the one place a photo is named without its tile in sight, so it
    // carries the number the strip shows too - otherwise a submitter reading the
    // table cannot tie a filename back to the thumbnail it came from.
    const ref = photoRef(p, i + 1);
    const tr = document.createElement("tr");
    // Every row is five cells wide, whatever state its photo is in. A pending
    // or failed row leaves the four unknown cells empty rather than filling
    // them with a word: a colspan here changed the table's column widths, and
    // the replaced text changed the row's height, so the row below it moved
    // twice over as each photo finished. The photo's own state is already
    // visible as its tile and its entry in the score panel; a third copy of it
    // in this table was the layout cost of saying it again.
    if (p.pending || p.error) {
      tr.className = "row-pending";
      tr.innerHTML = `
        <td title="${escapeHtml(ref)}">${escapeHtml(ref)}</td>
        <td></td>
        <td></td>
        <td></td>
        <td></td>
      `;
      tbody.appendChild(tr);
      return;
    }
    const sortedGenus = Object.entries(p.scores).sort((a, b) => b[1] - a[1]);
    const topGenus = sortedGenus[0] || ["-", 0];
    const sortedSpec = Object.entries(p.detail).sort((a, b) => b[1] - a[1]);
    const topSpec = sortedSpec[0] || ["-", 0];

    // What the app would claim about the photo. It is a coarser claim than the
    // ranking when the species gate abstains, never a fabricated one: a photo
    // the classifier cannot place shows the genus it did place, or nothing.
    // `claimFor` is what keeps the table honest: a species the loaded head
    // cannot separate from its group-mates is written as the group here, so the
    // column never shows a name the model did not earn. A head that separates
    // every row returns the name unchanged.
    const topCell = claimFor(p, topSpec);
    const specPct = (topSpec[1] || 0) * 100;
    tr.innerHTML = `
      <td title="${escapeHtml(ref)}">${escapeHtml(ref)}</td>
      <td title="${escapeHtml(topGenus[0])}">${escapeHtml(topGenus[0])}</td>
      <td style="text-align:right">${(topGenus[1] * 100).toFixed(1)}%</td>
      <td title="${escapeHtml(String(topCell))}">${escapeHtml(String(topCell))}</td>
      <td style="text-align:right">${specPct.toFixed(1)}%</td>
    `;
    tbody.appendChild(tr);
  });
}

/** The export, as text: one header and one record per photo. */
export function buildCsv(previews: ClassifiedPhoto[]): string {
  let csv = "Photo,Filename,Status,Cropped,Top Genus,Genus Score (%),Top Species,Species Score (%)\n";
  previews.forEach((p, i) => {
    // The number the strip shows, beside the filename rather than inside it: a
    // row read on screen and a row read in the export are then the same row, and
    // the `Filename` column stays a filename a spreadsheet can match against.
    const num = i + 1;
    if (p.pending || p.error) {
      // Exporting the previous crop's numbers under the new crop's name would be
      // a wrong result, not a stale one.
      csv += `${num},${csvField(p.name)},${csvField(p.error || "classifying")},${p.is_cropped},"-","-","-","-"\n`;
      return;
    }
    const sortedGenus = Object.entries(p.scores).sort((a, b) => b[1] - a[1]);
    const topGenus = sortedGenus[0] || ["-", 0];
    const sortedSpec = Object.entries(p.detail).sort((a, b) => b[1] - a[1]);
    const topSpec = sortedSpec[0] || ["-", 0];
    // Same rule as the results table: the export carries the claim the app made,
    // so a photo the app would not name cannot leave the machine looking named.
    const claim = claimFor(p, topSpec);
    const specPct = ((topSpec[1] || 0) * 100).toFixed(1);
    csv += `${num},${csvField(p.name)},${csvField(p.status)},${p.is_cropped},${csvField(topGenus[0])},${(topGenus[1] * 100).toFixed(1)},${csvField(claim)},${specPct}\n`;
  });
  return csv;
}

export function downloadCSV(previews: ClassifiedPhoto[], sendLog: LogFn): void {
  if (!previews.length) return;
  sendLog("download_csv");
  const csv = buildCsv(previews);

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mosquito_identification_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
