/**
 * The footer's per-step timing line: three numbers, each in its own slot.
 *
 * The slots are what hold the footer's width steady while a batch runs, and the
 * width is a CSS concern - the e2e spec measures it in a browser. What is
 * pinnable here is the structure the CSS depends on: one `.timing-num` span per
 * timing, in total/crop/analyze order, so `.timing-num`'s reservation applies to
 * all three and not to the labels around them.
 */
import { describe, it, expect } from "vitest";
import { renderFooterTiming, TIMING_DIGITS } from "../src/app/footerTiming";

/** A node env has no document, so the slot and the factory are stand-ins. */
function fakeDom() {
  const rendered: { className: string; textContent: string }[] = [];
  const texts: string[] = [];
  const slot = {
    replaceChildren(...nodes: unknown[]) {
      rendered.length = 0;
      texts.length = 0;
      for (const n of nodes) {
        if (typeof n === "string") texts.push(n);
        else rendered.push(n as { className: string; textContent: string });
      }
    },
  };
  const doc = {
    createElement() {
      return { className: "", textContent: "" };
    },
  };
  return { rendered, texts, slot, doc };
}

const TIMING = {
  engineLabel: "culico-net-cls-v1 (WEBGPU)",
  totalMs: 224,
  cropMs: 81,
  analyzeMs: 144,
};

describe("renderFooterTiming", () => {
  it("gives each of the three timings its own slot, in order", () => {
    const { rendered, slot, doc } = fakeDom();
    expect(renderFooterTiming(slot, doc as unknown as Document, TIMING)).toBe(true);

    expect(rendered.map((n) => n.className)).toEqual([
      "timing-num",
      "timing-num",
      "timing-num",
    ]);
    expect(rendered.map((n) => n.textContent)).toEqual(["224", "81", "144"]);
  });

  it("writes the line the app showed before, slot markup aside", () => {
    const { rendered, texts, slot, doc } = fakeDom();
    renderFooterTiming(slot, doc as unknown as Document, TIMING);

    expect(texts.join("|")).toBe(
      "inference: culico-net-cls-v1 (WEBGPU) · |ms/photo (crop: |ms · analyze: |ms",
    );
    // Reassembling the pieces must give the pre-fix string exactly, so the fix
    // reserves space without changing what anyone reads.
    const line = (texts[0] ?? "") + rendered[0]!.textContent + (texts[1] ?? "")
      + rendered[1]!.textContent + (texts[2] ?? "") + rendered[2]!.textContent + (texts[3] ?? "");
    expect(line).toBe(
      "inference: culico-net-cls-v1 (WEBGPU) · 224ms/photo (crop: 81ms · analyze: 144ms",
    );
  });

  it("replaces the line rather than stacking a second one", () => {
    const { rendered, slot, doc } = fakeDom();
    renderFooterTiming(slot, doc as unknown as Document, TIMING);
    renderFooterTiming(slot, doc as unknown as Document, { ...TIMING, totalMs: 9 });
    expect(rendered).toHaveLength(3);
    expect(rendered[0]!.textContent).toBe("9");
  });

  it("rounds to whole milliseconds, so the digit count is bounded", () => {
    const { rendered, slot, doc } = fakeDom();
    renderFooterTiming(slot, doc as unknown as Document, { ...TIMING, totalMs: 223.7 });
    expect(rendered[0]!.textContent).toBe("224");
  });

  it("reads a timing that is not a number as 0 rather than printing NaN", () => {
    // A `NaNms` is wider than the reservation and would shift the footer, which
    // is the defect this line exists to prevent - so a missing timing must not
    // reach the DOM as one.
    const { rendered, slot, doc } = fakeDom();
    renderFooterTiming(slot, doc as unknown as Document, {
      ...TIMING,
      totalMs: Number.NaN,
      cropMs: undefined as unknown as number,
    });
    expect(rendered.map((n) => n.textContent)).toEqual(["0", "0", "144"]);
  });

  it("reserves four digits, which is what the CSS rule reserves", () => {
    // The two have to agree: a five-digit step would overflow the slot and shift
    // the footer, so the number here is the number in `.timing-num`'s `min-width`.
    expect(TIMING_DIGITS).toBe(4);
  });

  it("does nothing without a slot or a document", () => {
    const { slot, doc } = fakeDom();
    expect(renderFooterTiming(null, doc as unknown as Document, TIMING)).toBe(false);
    expect(renderFooterTiming(slot, null, TIMING)).toBe(false);
  });
});
