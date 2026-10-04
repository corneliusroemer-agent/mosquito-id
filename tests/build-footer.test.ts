/**
 * The footer names the build it came from, and says nothing at all when there is
 * nothing to name: a local `npm run build` has no VITE_COMMIT_SHA, and an empty
 * link or a dangling divider would be worse than silence.
 *
 * The SHA is read from the same injected constant the ?build= stamp uses, so the
 * footer and the address bar cannot disagree about which deploy this is. The href
 * is built from a pattern-checked SHA only, never from a free string.
 */
import { describe, it, expect } from "vitest";
import { buildLink, renderBuildLink } from "../src/app/buildSha";

const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const REPO = "https://github.com/corneliusroemer-agent/mosquito-id/commit/";

/** A node env has no document, so the slot and the factory are stand-ins. */
function fakeDom() {
  const rendered: unknown[] = [];
  const slot = {
    replaceChildren(...nodes: unknown[]) {
      rendered.length = 0;
      rendered.push(...nodes);
    },
  };
  const doc = {
    createElement() {
      return { className: "", href: "", target: "", rel: "", textContent: "" };
    },
  };
  return { rendered, slot, doc };
}

describe("buildLink", () => {
  it("shows the short SHA and links the full one", () => {
    expect(buildLink(SHA)).toEqual({ text: SHA.slice(0, 7), href: REPO + SHA });
  });

  it("returns nothing when the SHA is absent, empty or blank", () => {
    for (const sha of [undefined, "", "   "]) {
      expect(buildLink(sha)).toBeNull();
    }
  });

  it("refuses a SHA that is not a git object name", () => {
    // The SHA is the one string in this path that arrives from the build
    // environment; anything that is not hex of git's lengths never becomes a URL.
    for (const sha of [
      "../../evil",
      "javascript:alert(1)",
      "1a2b3c4<script>",
      "1a2b3c",
      `${SHA}0`,
      "ABCDEF1234567",
    ]) {
      expect(buildLink(sha), sha).toBeNull();
    }
  });
});

describe("renderBuildLink", () => {
  it("fills the footer slot with a divider and a safe link to the commit", () => {
    const { rendered, slot, doc } = fakeDom();
    expect(renderBuildLink(slot, doc as unknown as Document, SHA)).toBe(true);
    expect(rendered).toEqual([
      { className: "divider", href: "", target: "", rel: "", textContent: "·" },
      {
        className: "build-link",
        href: REPO + SHA,
        target: "_blank",
        rel: "noopener noreferrer",
        textContent: `build ${SHA.slice(0, 7)}`,
      },
    ]);
  });

  it("renders nothing at all when the SHA is absent or blank", () => {
    for (const sha of [undefined, "", "  "]) {
      const { rendered, slot, doc } = fakeDom();
      expect(renderBuildLink(slot, doc as unknown as Document, sha)).toBe(false);
      expect(rendered).toEqual([]);
    }
  });

  it("clears a slot rather than stacking a second link when it is re-run", () => {
    const { rendered, slot, doc } = fakeDom();
    renderBuildLink(slot, doc as unknown as Document, SHA);
    renderBuildLink(slot, doc as unknown as Document, SHA);
    expect(rendered).toHaveLength(2);
    renderBuildLink(slot, doc as unknown as Document, undefined);
    expect(rendered).toEqual([]);
  });

  it("is a no-op when the footer slot is missing", () => {
    const { doc } = fakeDom();
    expect(renderBuildLink(null, doc as unknown as Document, SHA)).toBe(false);
    type Slot = Parameters<typeof renderBuildLink>[0];
    expect(renderBuildLink(undefined as unknown as Slot, doc as unknown as Document, SHA)).toBe(
      false,
    );
  });
});
