# Synthesis: repeated requests and standing corrections

Two subagents read the 2,029-message corpus on separate questions — repeated *task shapes* that
might deserve a skill, and standing *corrections* that might deserve a rule. I verified their
claims against the files before accepting any of them, and **two of the strongest claims did not
survive**. That is the most useful thing in this document.

## Corrections

### 1. My own: I misread the best-structured investigation in the repo as the worst one

I used `investigations/2026-09-28-ppx-prod-log-review/` as the counter-example of a botched
coordinator run, on the grounds that several files share each number —
`03-issue-7432-body-as-posted.md`, `03-issue-7432-review-notes.md`, `03-issue-7432-drafts/`. I read
that as chaos. It is the opposite: **the number is the topic, and everything about that topic sits
under it.** Multiple files per number is the grouping working, not failing. Each topic's scripts
live in that topic's own directory (`01-silo-data/hammer.py`, `09-log-volume-data/series.py`), and
no script sits anywhere at the top level.

It is the best-structured directory in `investigations/`, and it works because it does two things
that pull against each other: the **reports stay at the top level**, so one `ls` shows what was
found, and the **work stays committed and visible but scoped to its topic**, so the next person can
re-run exactly what was run. Those are only in tension if you throw the work away — the workdirs
are tracked, not scratch.

The actual counter-example is `investigations/2026-10-01-ppx-prod-rollout/`: 16 files and 14
directories, **none numbered**, with `cancel.sql`, `progress.sql`, `pg-pod-run.sh` and eleven
`out-*` directories loose at the top.

I had this backwards in the first version of the `coordinating-subagents` skill and built an
`artefacts/` rule on top of the misreading. Both are corrected.

### 2. "Code comments are covered but not firing because the skill's trigger is wrong" — **the diagnosis is false**

`pr-descriptions` §4 is titled *"Code comments: one line, or none"* and says: default to no
comment, keep it to one line, comments say why never what. Its frontmatter description ends
*"Use whenever writing or editing a PR description, issue body, PR review comment, commit body, or
**a comment in source code**."* The trigger surface is exactly right; it was not mis-scoped.

What *is* true, and more interesting: the skill was added **2026-09-11** with that section, and
the corrections are dated **2026-09-14 and 2026-09-21** — they postdate the rule existing. So this
is a stickiness problem, not a coverage problem. The likely cause is competition, not wording:
38 skills now load, and `pr-descriptions`, `reviewing-someone-elses-pr` and
`adversarial-review-loop` all have descriptions that mention comments and description-writing.
Mid-way through editing a Kotlin test, "a comment in source code" is not a salient thought.

**Conclusion: no new rule.** The rule is written down twice and correctly. Adding a third copy in
AGENTS.md would treat a retrieval problem as a writing problem.

### 3. "`outbox/` and `handoff/` appear in no instruction file" — **imprecise, and the distinction is the finding**

Both appear in `AGENTS.md:109`, in the search-scope discussion, purely as examples of directories
the whitelist `.gitignore` hides. What is true is sharper and more useful: **neither is in the
Layout section**, which lists only `kb/`, `.devcontainer/`, `claude-config/`, `bin/`, `.secrets/`
and `.claude/settings*.json`. `investigations/`, `scratch/`, `handoff/`, `outbox/` and `tmp/` are
all in daily use and all absent from the map of the repo.

### 4. Session counts are upper bounds — forks share history

The corpus dedups on message uuid, but a **forked** session is a separate transcript file carrying
a copy of the pre-fork history. One SILO/LAPIS thread spans 12 transcripts. The subagent ranked on
distinct *utterances* where the gap was large, which is the right correction, but every session
count below should be read as "at least N, and possibly one conversation".

## What survives verification

### A. `outbox/` is a live, undocumented, safety-relevant convention — **strongest finding**

52 files, used across 14 sessions and 19 messages over 18 days, with a consistent naming scheme:

```
2026-09-10-urllib3-3375-subclass-workaround-comment.md
2026-09-17-claude-code-webfetch-truncation-issue.md
2026-09-15-loculus-annotations-s3-cost.md
```

`YYYY-MM-DD-<project>-<slug>-<kind>.md`, where kind is `comment`, `issue`, or a bare topic for
notes. The norm it encodes is **"write the words, never post them"** — the same rule
`filing-bug-reports` applies to bug reports, extended to upstream comments, issues and letters.
Nothing tells an agent the directory exists, so an agent asked to draft a comment writes it to
`tmp/` or into the conversation, and the corpus shows that happening.

One line in Layout. No new skill.

### B. "Just run it yourself in the sandbox" — genuinely missing

Four sessions, no coverage. The nearest thing is `AGENTS.md:243` *"No need to ask"*, which is
scoped to **read-only `gh`**. The write-permission rules that follow plausibly *cause* the
behaviour by making agents permission-cautious about local work too, where nothing is at stake.

### C. Multi-part questions inside one message — an amendment, not a new rule

`AGENTS.md:195` says *"When Cornelius sends several messages or questions **in a row**, address
each one"*. That wording covers sequential messages. The observed failure is several questions
**inside a single message** — "explain X, and also check whether Y, and tell me if Z still holds" —
which the sentence as written does not obviously cover.

### D. Merge-conflict resolution on someone else's PR — 8 distinct utterances, no home

`github-gotchas` mentions merge conflicts only as the *reason CI never queues*, never as a task.
Each request carries the same constraints: preserve the other author's intent, don't push, resolve
the review comments in the same pass. This is additive to `reviewing-someone-elses-pr` — no extra
shelf space.

### E. Auditing a third-party tool before adopting it — the best rare-but-expensive candidate

Three sessions on 2026-09-27 asked for a security audit of the same tool in three different
phrasings, which means nothing recognised the shape. Rare, but the failure mode is expensive and
`loculus-security-review` is scoped to Loculus code specifically.

### F. Diagnosing a live deployment — 19 sessions, but five overlapping skills

`grafana-ppx-loculus`, `ppx-prod-log-monitoring`, `loculus-preview-probing` and others each cover
part of it. The subagent counted distinct utterances at ~14. Real demand, but the fix is
disambiguation between existing skills, not a new one.

## Explicitly rejected

- **A "verify your claims" rule.** "Are you sure" appears in 14 sessions, which looks like a
  verification complaint. It is not — it is substantive technical challenge, and Cornelius is
  usually right to challenge. A rule against it would be actively harmful.
- **Adding a third copy of the code-comment rule** (see correction 1).
- **Dependabot triage** (2 sessions, 5 utterances) and **prod SQL surgery** (1 session) are too thin
  to justify shelf space; SQL surgery is already covered by `postgres`.

## A confound that limits the whole exercise

`filing-bug-reports` and `reviewing-someone-elses-pr` were created **2026-10-01**, today. Both
subagents flagged independently that repetition predating a skill's creation may simply mean the
skill fixed it. For the shapes those two skills cover, "repeated" is not evidence of a live gap.
This is why the shortlist above is short.

## Second round — three more angles

Reports 03, 04 and 05 read the same corpus on three further questions. Their verified findings:

**03 — meta-tooling** (123 sessions; 21% of the slice was harness prompts that survived the
pre-filter, a third contamination class). The largest theme by far: subagents appear in 49 of 123
sessions and 122 of 270 messages, and `coordinating-subagents` covers dispatch thoroughly while saying
nothing about **supervising an agent after dispatch** — status, wrap-up deadline, handoff to a fresh
agent, resume rather than shut down. He restated three sub-rules across 2026-08-29 → 09-30: wrap up
and hand off (8 sessions), ask for intermediary status (4), resume rather than shut down (3). Two of
the three are already in CLAUDE.md and he repeated them anyway, which points at an always-loaded file
rather than a skill. Also: `zai-claude` and `openrouter-claude` are two on-PATH binaries documented
nowhere, and their non-obvious env behaviour cost a day on 2026-10-01.

**04 — explaining** (67 sessions, 33% false positives). The honest headline is a negative: **the slice
does not support a new explanation skill.** What recurs is a request for *lower altitude* — "explain
1 and 2", "for dummies", "explain all the changes you intend to make and why" (27 sessions) — which is
an AGENTS.md line about answering altitude, not a procedure to load. Its most useful output is
negative too: three subsystems have no pointer in `loculus-orientation`, of which **file sharing /
multipart upload** is the one submission-flow stage with no entry at all.

**05 — drafting and continuity** (96 and 50 sessions). Independently confirmed the `outbox/` finding
from §A above, and added a fourth contamination class: harness subagent task-tracking reminders
arrive as `type=="user"` and contain a real request inside harness text. Its most consequential
finding is a data-loss one — see below.

### The one that is not a writing finding

**Transcripts are being deleted at 30 days.** `cleanupPeriodDays` was unset in
`~/.claude/settings.json`, so the default applied, and the oldest surviving project transcript was
2026-08-25. That is the floor of this entire corpus, it moves every day, and it silently removes the
substrate for `prior-art-search`, both mining skills, and resuming anything at all. Now set to
`false` and snapshotted. An earlier investigation had found this on 2026-09-17
(`investigations/claude-session-rediscoverability/`) and it was still unfixed a fortnight later.

## Third round — 2026-10-03, one session

Reports 06 and 07 mine a single nineteen-hour day rather than the whole corpus, because that day is
where nearly all of the current behaviour lives: 379 Claude messages plus 68 Antigravity ones, of
which 137 Claude messages are harness noise (the coordinator ticks, Stop-hook goal echoes, `/compact`,
compaction summaries). **Every rule in 06 is a rule that was broken at least once that day**, which
is the property the earlier rounds could not offer.

What changed most, in order:

1. **Shipping cadence became the dominant failure.** Pushing was requested **six separate times**
   (02:52, 02:53, 03:34, 06:05, 07:16, 15:51). Nine commits ended the day stranded on unmerged
   branches, including *"this is not a mosquito"* complete and pushed while he believed it was live.
   **Merge your own work** is now a rule with evidence behind it, not just a preference.
2. **Verification split into two rules.** *"push if you think you might have a fix, don't let
   verification be the enemy of progres"* (05:10) and, the same day, two tests found green and
   measuring nothing (09:32). The reconciliation is **push unverified, never claim unverified**.
3. **Prioritisation became a recommendation, not a veto** (05:43) — he quotes the agent's own
   reasoning back, agrees with it, and overrides it anyway.
4. **Subagent lifecycle got numbers.** Updates every ~10 min (04:53), a real status report rather
   than *"fine"* (05:23), **~45 minutes then hand off** (16:13), up to 2 subagents of its own for
   independent perspective (13:40).
5. **The 45-minute collision was resolved**, not just noted. *"don't let agents assume they have only
   45 min"* (15:42) sits thirty seconds from *"prefer fresh ones after 45min"* (16:13). They are
   different objects — **job runtime versus agent lifetime** — and resolving that class of collision
   is more useful than either rule alone.

**Two things the brief asked for that the evidence does not support**, recorded because a plausible
rule with no message behind it is worse than no rule: *"draft PRs are for Loculus work only"* and
*"a green test that measured nothing is worse than no test"*. The first has **no message anywhere** in
today's corpus, the last sixty transcripts, or the memory notes — every draft PR in the session was
an agent's choice. The second is real and well-supported, but the agent found it and the coordinator
relayed it; **Cornelius never stated it as a rule.** Both are flagged in 06 §"Where the record is too
thin" and in `STANDING-INSTRUCTIONS.md`.

## A safety finding about the corpus itself

The corpus contains **pasted credentials** — 49 lines of `user_own_words.tsv` match a
credential-shaped pattern, including a glooko password and a Cloudflare token. They are Cornelius's
own, pasted by him into his own sessions, so they were already in the same trust domain. But the
slices must never be committed or shared, and no credential is quoted anywhere in these
investigation files. The slices live in `tmp/`, which is gitignored, and the `bin/` helpers
`gitleaks` and `trufflehog` are the right check before any of this corpus leaves the box.

---

## The layout of this directory

```
STANDING-INSTRUCTIONS.md     the one page. Read this before dispatching an agent.
00-synthesis.md              this file — the entry point and the index
01-task-shapes.md                    subagent 1 — repeated task shapes
02-standing-corrections.md           subagent 2 — standing corrections (extended 2026-10-03)
03-meta-tooling.md                   subagent 3 — questions about the tooling
04-explaining.md                     subagent 4 — explanation requests
05-drafting-and-continuity.md        subagent 5 — drafting text, resuming work
06-session-2026-10-03.md             one day in full: 15 rules, 11 product decisions
07-unresolved-asks.md                what was asked on 2026-10-03 and is still open
03-meta-tooling/ 04-explaining/ 05-drafting-and-continuity/   their scratch
scripts/                             extract_user.py, cluster.py
```

`STANDING-INSTRUCTIONS.md` is what to read in the thirty seconds before dispatching an agent. It
holds only rules that can be traced to a message and a date, one line each, and it is **deliberately
capped at one page** — if it grows past that it has stopped being usable and belongs back in the
numbered files, where the evidence and the reasoning live. `06` and `07` are the two most recent
reports and supersede `02` where they overlap; `02`'s addendum names each extension rather than
restating it.

Numbered reports at the top level, no script at the top level, and the work committed rather than
left in `tmp/` where a single `rm` would have lost both subagent reports. `scripts/` is shared
corpus-preparation rather than one agent's own work, which is why it is a single directory instead
of a per-topic `01-`/`02-` one.

## Method and why each step exists

1. **User-text only, non-sidechain.** `type=="user"` and not `isSidechain`, so agent→subagent
   instructions never enter the corpus. Content is a string or a list of `text` blocks.
2. **Strip pasted material inside each message.** Cornelius copy-pastes heavily, so pasted logs,
   code, stack traces, diffs, tables and quoted threads dominate every length- and frequency-based
   measure if left in. What survives is his own prose. Without this step the analysis is a study of
   whatever he happened to paste.
3. **Drop skill bodies and compaction summaries.** Both arrive as `type=="user"` messages — skill
   bodies because Claude Code injects them, compaction summaries because they are prepended to a
   resumed session. 320 of them; left in, 92 sessions looked like nothing but PR-description
   writing.
4. **Drop harness probes.** `reply with exactly`, `print verbatim only`, `without using any tools`
   are smoke tests and the skill-doctor, not requests.
5. **Date each message by its own `timestamp`, not the file mtime.** A session resumed weeks later
   rewrites its history into a new file, so mtime silently relabels August work as September.
   This moved 156 messages back to the month they actually happened in.
6. **Weight recent sessions higher** in the n-gram pass: October ×3, September ×2, August ×1.

## Corpus

| | messages | sessions |
|---|---|---|
| 2026-08 | 135 | 14 |
| 2026-09 | 1833 | 264 |
| 2026-10-01 (partial) | 61 | 10 |
| **total** | **2029** | **285** |

Slices in `tmp/mining2/` (gitignored — they are raw message text spanning many projects, and a
pattern-allowlist secret scan is not proof they are credential-free):

- `slice_sept.tsv` — the bulk
- `slice_recent_oct.tsv` — today
- `slice_aug.tsv` — oldest
- `slice_feedback.tsv` — messages containing correction/pushback language

## Known limits of this pass

- n-grams alone are not evidence of a repeated task; they produce spurious spans across unrelated
  adjacent words (`"pasted content"` in the first clustering run was one word from one message and
  one from another). The clustering output is a way to find things to *read*, not a finding.
- The feedback slice is keyword-filtered, so it also catches him complaining about the work rather
  than about an agent's behaviour.
- 285 sessions is the whole corpus, and it covers only 2026-08-25 onward. "Repeated" here means
  repeated within five weeks, which is a weak signal for a habit rather than a strong one.
