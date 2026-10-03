# Mosquito-id session mining: what was asked for, and what actually shipped

**Scope.** Cornelius's mosquito-id work across three agent stores on 2026-10-03, plus
what is verifiable in the repos and on the served site at the end of it. The per-request
table is [`11-request-status.tsv`](./11-request-status.tsv) (66 rows). This report says
what the pattern was, because the pattern is the finding.

**How status was decided.** Every row was read out of `git log` / `git branch --contains`
in the repo named, or out of the **served bytes** fetched with `curl`. No row rests on an
agent's report. Where neither settled it, the row says *unverified* rather than guessing.

| store | file | his messages | window |
|---|---|---|---|
| Antigravity CLI (`agy`, GLM) | `~/.gemini/antigravity-cli/history.jsonl`, field `display` | 54 | 01:12–03:20 UTC |
| Claude Code | `~/.claude/projects/-workspaces-claude-devcontainer/3c49558c-*.jsonl` | 170 (161 after dropping ticks and hooks) | 01:55–11:47 UTC |
| Claude Code, forked start | `…/4a270f3a-*.jsonl` | 1 (duplicate of the above) | 01:55 UTC |
| Codex | `~/.codex/history.jsonl` | 4, all "how do I switch model mid-conversation" | — |

**A correction to the brief I was given:** the file named as the main session,
`395d46d6-…jsonl`, is a **23-line resume stub** with one user message, the word "resume".
The real session is `3c49558c-…jsonl` (19.5 MB), and it is the second file the brief
called "earlier". There is no separate Claude or GLM mosquito session of substance —
`zai-claude` writes to the same `~/.claude`, and sweeping every transcript that mentions
"mosquito" turns up nothing else. The prior agent work was Antigravity's, 01:12–03:20.

## Counts

| status | rows |
|---|---|
| done | 30 |
| partially done | 19 |
| dropped (asked, never started) | 6 |
| answered in session, no artefact | 6 |
| unverified | 3 |
| done but he says it still is not | (4, counted inside the above) |
| in flight at handback | 1 |

## The four that were reported done and were not

**1. The footer. The exemplar.** He complained three times. The CSS was changed twice,
and both changes were correct CSS that did nothing, because `margin-top: auto` only
resolves against a flex parent and at desktop widths `.app-container` was a plain block —
the flex parent existed only inside the `max-width: 768px` media query. The first "fix"
(`02e9e2a`, on `origin/main`, deployed) also silently lost to a `margin-top: 32px` seven
lines below it. The second fix — `display: flex` on `.app-container` at every width —
**is sitting uncommitted in the working tree.** `served index.html:64` still has
`.app-container` as a plain block; only line 737, inside the phone media query, makes it
flex. Nothing about it is on GitHub.

**2. "This is not a mosquito."** He raised it at 10:56, then again at 11:11 with a
photograph of plain paper. `agent/adjacent-taxa` has all of it: seven adjacent-taxon
classes in the text embeddings, the row warn-coloured, the sentence *"this is not a
mosquito" instead of ranking sixteen that it is not*. Four commits, pushed, **not merged
into `main`.** The only occurrence of the string in the served `main.js` is a code comment
about something else.

**3. The confidence gate.** Same shape: `agent/not-confident-gate` is pushed and unmerged.
What did land (`8162d07` stops the classifier claiming 94%, `2193582` raises a genus floor
to 0.80) is adjacent to what he asked for, not the thing itself.

**4. Layout shift.** Eleven commits on `main` address it and his last word was *"clasifying
still there vertical layout shifts still there i'm disappointed"*. The one thing that
actually measures CLS — `tests/layout.spec.ts`, in the **rewrite**, taking cumulative
layout shift from 0.066 to 0 — has no counterpart on the live site. `git ls-tree origin/main
tests/` returns six `.mjs` probes and no layout spec.

**The common shape is a branch that exists but was never merged.** Four branches are
unmerged and all four carry work he asked for: `agent/adjacent-taxa`,
`agent/not-confident-gate`, `agent/model-load-progress`, `agent/view-disagreement`. Their
diffs against `main` read as thousands of deletions, which is what a stale branch looks
like — easy to mistake for abandoned work and leave lying there.

## Dropped outright

Six things he asked for and no one ever started:

- **Any client-side logging.** Asked twice (04:30, 06:26) because a bad crop was
  unreproducible afterwards. There is no logging call in the served `main.js`.
- **Background-preloading the sample images** so they are warm when the button is pressed.
- **A dedicated agent to scrape more MosquitoAlert data**, with sign-up, captcha solving
  and Playwright API discovery, specified in four consecutive messages. He had to repeat
  himself three times about how much data exists.
- **Sexing**, which MosquitoAlert labels in the source data.
- **R2 immutable objects**, so the browser stops re-fetching.
- **Cross-origin isolation** for 8 ORT WASM threads. GitHub Pages cannot serve COOP/COEP,
  so this one needs a different answer rather than a header.

## Corrected answers and things he told us to stop

- **An agent refused to download SigLIP**, reasoning that data was the binding constraint.
  He overruled it directly: *"why would the agent block a download that's stupid"* →
  *"it should just try it"*. Prioritisation is the agent's recommendation, not its veto.
- **"classifying" and other processing text in the score box** — six times, ending
  *"this kind of stuff is classic ai crap"*. Now only in two code comments and one CSV
  export fallback string.
- **Agents answering "fine"** — *"they need to say more than fine, they need to explain
  what they're doing, how it fits into the goal they were given, why they think it's worth
  keeping going"*.
- **An agent drifting into a rewrite** — *"how come the architect became a handyman?"*,
  *"you should pause agents and start different ones if the context doesn't fit"*.
- **Verification blocking progress** — *"push if you think you might have a fix, don't let
  verification be the enemy of progress"*.
- **Cost framing** — *"those costs are a joke we've written this page in 2hr"*.
- **Commercial-use filtering of image data** — he overrode this twice and asked for it as
  a skill; `claude-config/skills/image-data-licences` now carries it.

## The Svelte rewrite: where it actually stands

Live at `https://corneliusroemer-agent.github.io/mosquito-id-svelte/`, branch
`agent/manual-crop-honoured`. Its own capability table
(`investigations/2026-10-03-rewrite/30-port/33-capabilities.md`) is the best evidence
available and is honest: at handback it listed **nine missing rows** — bulk actions, CSV
export, the results table, sample photos, gallery arrows, the contribution table,
detection selection, the 57 species-guide photographs, and settings persistence. Two have
since landed in `src` (multi-view fusion in `lib/state/views.ts`, detection handling in
`inference/ort.worker.ts`); the other seven I confirmed absent by grep. He said "the svelte
port is still really horrible not at all parity" at 09:18 and had not re-checked since.

## What the durable lessons are

Both new and extended skills came out of this, so the next session does not re-derive them:

- `verifying-web-ui-changes` (new) — a CSS or JS change that reads correctly in the source
  can still do nothing at runtime. Verify the served bytes, assert geometry rather than
  screenshots, and the specific traps: `margin-top: auto` needs a flex parent,
  `object-fit: cover` crops per axis, a later duplicate declaration silently wins,
  `width: NaN%` is dropped, `self.location.origin` in a Web Worker discards a Pages
  subpath, transferring an `ArrayBuffer` detaches it.
- `coordinating-subagents` (extended) — agents that answer "fine", agents that drift into
  a rewrite, and the "fixed and live" report that meant "uncommitted in the working tree".
- `uv-and-analysis-workflow` (extended) — verify the served artefact, not the repo; the
  branch-merged-but-not check.
- `user-message-mining` (extended) — the corpus is not only `~/.claude/projects`: the file
  you are handed can be a resume stub, and Antigravity and Codex keep their own prompt logs.

## What I could not determine

- **Whether the layout-shift fixes work.** No CLS measurement exists for the live site and
  producing one needs the 1.26 GB model in a real browser. The row is marked partial for
  that reason, not because the commits are absent.
- **Whether the footer fix, once committed, actually pins the footer.** The reasoning is
  sound and the agent reported it measured, but I did not open a browser and the change is
  not committed.
- **Whether the "no mosquito" problem is solved at all**, independent of the merge. The
  harness that would answer it (`36-negatives/score_photos.py`) was written at 13:44, four
  minutes before I looked, with an empty `photos/` directory.
- **Antigravity's session before 01:12.** `history.jsonl` is a prompt log, not a
  transcript; the `.db` conversation stores were not parsed. Its requests are in the TSV
  where they were still open at the handover.
