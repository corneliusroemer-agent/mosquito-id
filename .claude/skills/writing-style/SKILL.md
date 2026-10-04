---
name: writing-style
description: How to write anything human-readable in mosquito-id - issue bodies, PR descriptions, GitHub comments, commit messages and code comments. Use when drafting or editing any of these, and especially when linkifying code references, commits, PRs, issues and external sources. Triggers on "write a PR description", "draft an issue", "comment on this PR", "reply to review", "improve this comment".
---

# Writing style for mosquito-id

Applies to issues, PR descriptions, GitHub comments, commit bodies and code comments.

## Linkify everything

Every reference a reader could follow becomes a link. A bare `file.ts:118` or a bare SHA is
text they have to go and resolve.

| Instead of | Write |
| --- | --- |
| `PR #84` | `` [#84](https://github.com/corneliusroemer-agent/mosquito-id/pull/84) `` |
| `58f8e2f` | `` [`58f8e2f`](https://github.com/corneliusroemer-agent/mosquito-id/commit/58f8e2f93f174d8aa6858bdc71017359f04fb653) `` |
| issue `#85` | `` [#85](https://github.com/corneliusroemer-agent/mosquito-id/issues/85) `` |
| a paper, dataset, standards doc, external tool | the real URL, not the name |
| a report or doc filename | a link to its path on GitHub, or the path in backticks if it is not committed |

### Pin code links, and pin them to the right commit

A line-number permalink only stays correct if it names a commit. `blob/main/...#L118` drifts
the moment anything else lands. Which commit you name depends on who reads it and when:

| The link is in | Pin to |
| --- | --- |
| a PR description or review comment | the branch's own SHA — the commit the diff is against, so the line number means what it means to the reviewer |
| a committed doc, an issue, anything that outlives the branch | a commit on `main`, so a reader from a fresh clone lands in the project's history |

Once the work merges, re-point `main`-pinned links at the merge commit.

Get the SHA in one command:

```sh
gh api repos/corneliusroemer-agent/mosquito-id/commits/<branch> --jq .sha
```

When there is no commit to point at yet — the line does not exist on any commit, or the file
is about to move — link the file at the base branch and give the line in prose. Do not invent
an anchor that lands on the wrong line; a link that is 90% right is worse than none, because
the reader trusts it.

### Worked example

The confidence router landed via
[#84](https://github.com/corneliusroemer-agent/mosquito-id/pull/84). Its routing branch is
[`src/confidence/fuseViews.ts:118`](https://github.com/corneliusroemer-agent/mosquito-id/blob/196d57b3c064954217923f8693fce3605ce1b7d1/src/confidence/fuseViews.ts#L118)
at `196d57b`, the line `if (V > 1 && Math.max(...viewResults[0]!.spP) < CROP_ONLY_MAX_POSTERIOR)`.
The threshold itself is
[`src/confidence/fuseViews.ts:28`](https://github.com/corneliusroemer-agent/mosquito-id/blob/196d57b3c064954217923f8693fce3605ce1b7d1/src/confidence/fuseViews.ts#L28).

This is the `main`-pinned form, because a skill is committed documentation. In a PR
description the same reference carries the branch SHA instead, so the reviewer lands on the
code you are proposing.

## Register

- **Write for a reader who was not in the session.** They do not know what you just tried, or
  what was already ruled out. Say what is true now, not how you got there. Git keeps the
  history; the issue or PR does not need the journey.
- **No assistant voice.** No "happy to", "let me know if", "feel free to", no sign-off. An
  author writing their own PR does not add them.
- **No hard-wrapped paragraphs.** One long line per paragraph; let the renderer wrap.
- **Lead with why.** Say what a reviewer has to decide, not a restatement of the diff — the
  diff is right there.
- **State what is not known plainly.** "Untested on Safari" is better than a hedge that reads
  as confidence. Same the other way: if you measured it, say the number, not "significantly
  better".
- **Keep the `why` in code comments, drop the `how`.** Explain why the code is as it is. Never
  what it replaced, never what else was tried. One line or nothing.

## Before posting

Verify every link resolves to what the sentence claims, and every SHA and line number by
running the command that produced it. A wrong permalink teaches the next reader a wrong
pattern.
