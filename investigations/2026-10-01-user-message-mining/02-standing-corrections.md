# Standing corrections: what Cornelius has to tell agents more than once

**Corpus.** `tmp/mining2/slice_feedback.tsv` (103 msgs / 64 transcript files, 2026-08-26 → 2026-10-01)
is the pre-filtered primary input. Because it turned out to be thin and heavily duplicated, every
candidate was counted against the full `user_own_words.tsv` (2029 messages, 285 transcripts,
2026-08-25 → 2026-10-01) and cross-checked with `slice_aug.tsv` / `slice_recent_oct.tsv`.
Session counts below are **distinct transcript paths**, never message counts.

**Contamination found beyond what was already handled.** 7 of the 103 feedback lines
(2026-09-21, six distinct transcripts) are the harness's own "Your response above was stopped by a
safety classifier" notice, not Cornelius. `slice_aug.tsv` line 25 and `slice_recent_oct.tsv` line 74
are pasted **credentials** (a glooko password, a Cloudflare token) inside his messages — they are
his words but must never be quoted or copied anywhere. Several messages appear 2-6 times because
the same text was sent from forked/resumed copies of one conversation (e.g. the 2026-09-10
"you never answered the 1/2 question" is **4 transcript files but one conversation**, and the
2026-09-14 "few things I don't like" is 2 transcripts of one review). Counts below are discounted
accordingly and this is stated per item.

**Noise ratio.** Roughly 70% of the feedback slice is complaints about *the work* ("that's not
great", "ok but why did enrich with nextclade fail?", plotting and SQL requests, metric-definition
questions). Those are excluded. What survives is genuinely about agent behaviour, but it is a
**short list of 6 real items, not a long one** — see "What this slice does not support" at the end.

---

## Ranked summary

| # | Rule | Sessions | Status | Where |
|---|------|----------|--------|-------|
| 1 | Don't write code comments that restate the code; 1-2 lines max, never repeated across a PR | **4** | **Covered but not firing** | `pr-descriptions` §4 exists; needs an AGENTS.md line |
| 2 | Prefer the simpler construct; don't inflate a one-line change into 50 lines of scaffolding | **5** | **Partially covered** (only for prose) | AGENTS.md, new bullet |
| 3 | Answer every part of a multi-part question, and say which parts you're answering | **2** | **Covered but not firing** | AGENTS.md:195 |
| 4 | Just run the thing yourself in the sandbox instead of asking or proposing | **4** | **Missing** | AGENTS.md, new bullet |
| 5 | Don't edit AGENTS.md/CLAUDE.md unless asked | **1** (2 signals) | **Missing** | AGENTS.md or CLAUDE.md |
| 6 | Don't list an easily-fixable flaw as a "downside" — fix it or say why not | **1** | **Missing, low value** | judgement call, see below |

---

## 1. Code comments: cut the ones that only restate the code

**Rule.** Default to no comment. A comment that explains *what* the line does is noise; if the
explanation is worth more than 1-2 lines it belongs in the PR description or `git blame` already
has it. Never say the same thing in a comment on four adjacent tests.

**Sessions: 4** (2026-09-14 loculus-pr7309 ×2 transcripts, 2026-09-17, 2026-09-21 ×2).

**Quotes.**
- 2026-09-14: "Ok - there's a few things I don't like: - Get rid of all comments that just explain, there's one good one: the one that explains level 0."
- 2026-09-21: "delete the comment on the new integration test on 7369 don't like"
- 2026-09-21: "tests in comments are almost entirely unnecessary, if anyone needs to know why they can use git blame, keep comments much shorted in general, just 1-2 lines, not repetitive across the pr - yo usay the same thing like 4 times and verbosely."
- 2026-09-21: "cut the comments they are way too much also unicode is from 1987"

**Status: covered but not firing.** `claude-config/skills/pr-descriptions/SKILL.md` §4 already
says it, and well: *"Default to **no comment**… keep it to **one line**… Comments say **why**, never
what. `// increment the counter` above `count++` is noise."* AGENTS.md:216 also says *"For code
comments this is the standard rule."* It is not firing for two reasons. First, **wrong trigger
surface**: the skill's description fires on *writing a PR description or issue body* — writing a
comment while editing a Kotlin test file is not a "pr-descriptions" task, so the skill is never
loaded. Second, AGENTS.md:216's version is about *what* a comment should say (end state, not
journey) and never mentions **length** or **repetition**, which is what he actually objected to
every time.

**Fix.** One line in AGENTS.md, near the existing writing-style bullets, stating length and
repetition: comments default to none, 1-2 lines when they earn their place, and the same
explanation does not get repeated across a file or PR. This is general (any repo, any language),
so AGENTS.md, not the skill. Optionally widen the skill's trigger, but the AGENTS.md line is the
fix that will actually land.

**Judgement: worth adding.** Highest count in the corpus, zero existing coverage of the specific
objection, and a competent agent really does over-comment.

---

## 2. Prefer the simpler construct; don't inflate a one-line change

**Rule.** When the fix is one line, write one line. Don't add try/catch ladders, wrapper
abstractions, nested indentation or restructured control flow around a problem a wait loop or a
single annotation already solves. If a change is much larger than the ask, say so and offer the
small version.

**Sessions: 5** (2026-08-25, 2026-09-08 ×2, 2026-09-10, 2026-09-17 ×2).

**Quotes.**
- 2026-09-10: "also why the heck 52 lines? i thought it was a one line change..."
- 2026-09-17: "for a do we need to do all this crap you show there? why all the extra indentation? i don't like how noisy this is - rather than a simple annotation"
- 2026-09-17: "why don't we just move it into the wait loop? this is still so verbose i don't like it - especially as in the end all we want is to know quickly that secrets didn't come up. couldn't we do this once there's failure? current doesn't save anything really does it?"
- 2026-09-08: "can you push it to a branch so i can see (but don't make a draft pr) keep it simple, don't invent lots of tooling for it"
- 2026-08-25: "ugh i closed this pr because it's crazy complex. is this really necessary to diagnose the failure of the large submit test? is there no other way?"

**Status: partially covered.** AGENTS.md's `simplify` built-in and the "keep it simple" instinct
cover *prose*. The `pr-descriptions` skill covers "no hard-wrapped paragraphs". **Nothing covers
the size of a code change relative to the ask** — and that is the shape of every complaint here.
Note this is distinct from item 1: item 1 is about comments, this is about structure and line count.

**Judgement: worth adding, one sentence.** It is close to obvious-to-a-good-agent, but the corpus
shows it failing 5 times, and the failures are specific and cheap to prevent ("if the change is
much bigger than the request, say so and show the smaller version"). Keep it to two lines in
AGENTS.md; do not turn it into a gold-plating essay.

---

## 3. Answer every part of a multi-part question

**Rule.** When a message contains several numbered or separately-stated questions, answer each one
explicitly, in his numbering, and say which you are not answering and why.

**Sessions: 2 conversations** (2026-09-10 loculus silo-cache-eviction work; 2026-09-11 same
thread's follow-up). The 2026-09-10 instance appears as 4 transcript files because it was sent
from 4 forks of one session — **one real incident, not four.**

**Quotes.**
- 2026-09-10: "wait i asked about 3 and also separately 1 and 2 you never answered the 1/2 question did you? also why the heck 52 lines? i thought it was a one line change..."
- 2026-09-11: "so 2 questions: to maintain the intent of cache eviction on silo being truly down how to maintain this? when does silo do 503? when did it evict in the past? when does it now? what are the options?"
- 2026-09-21 (related failure — silently dropping a task): "also, have you addressed the Claude comments (don't do things that are not good, but i wonder if you forgot or addressed)"

**Status: covered but not firing.** AGENTS.md:195: *"**Answer every message.** When Cornelius sends
several messages or questions in a row, address each one; a later message never makes an earlier
question moot."* The wording is about **sequential messages** ("several messages in a row"), and the
actual failure is **several questions inside one message**. An agent that answers the latest
question in a three-question message technically complies with the rule as written. That is the
whole bug.

**Judgement: worth a two-word amendment, not a new rule.** Change "several messages or questions in
a row" to explicitly cover "several questions in one message", and add "if you skip one, say so".
A memory note (`answer-every-question.md`) already carries this; the durable fix is the AGENTS.md
wording. The related 2026-09-21 "have you addressed the Claude comments … i wonder if you forgot"
is a **checklist-before-reporting** failure, not a dropped question, and is too thin to add on its
own.

---

## 4. Just run it yourself in the sandbox

**Rule.** In this sandbox, run the command. Download the source, execute the script, check the
file. Do not ask permission to investigate, and do not propose a command and wait — proposing
"you could just download the nextclade source to figure out what it does" when you have a shell is
a waste of a turn.

**Sessions: 4** (2026-08-29, 2026-09-15, 2026-09-16, 2026-09-28).

**Quotes.**
- 2026-08-29: "you can also run things yourself here inside the sandbox no need to be careful"
- 2026-09-15: "you know you can just download nextclade source code to figure out what it does... why don't you do that"
- 2026-09-16: "can you just do it?"
- 2026-09-28: "AA can do it i give permission, you can also just do it yourself"

**Status: missing.** Grepping AGENTS.md and CLAUDE.md for autonomy language turns up nothing. The
nearest neighbours are the *permission* rules (AGENTS.md:244 "Writing needs permission", :265 "Show
text before posting it"), and those plausibly **cause** this failure by making an agent
permission-cautious in a domain where Cornelius wants none — he has to distinguish "write access to
a remote repo needs permission" from "run a read-only command locally needs none" every time.

**Judgement: worth adding, and the most useful new rule here.** Four sessions, zero coverage, and
it is cheap to state. It belongs in AGENTS.md next to the GitHub permission block, phrased as the
contrast: read-only local investigation needs no permission; only the listed write actions do. The
caveat to write around: `rm`, force-push and the other destructive shapes still warrant a glance,
so do not phrase it as "never ask".

---

## 5. Don't edit the instruction files unless asked

**Rule.** When asked to do a task, do the task. Do not also add a line to `AGENTS.md` or
`CLAUDE.md` as a bonus; if a rule seems worth persisting, mention it and let him say yes.

**Sessions: 1 clear instance** (2026-09-14, loculus-pr7309), plus 2026-09-28 where he had to
redirect the *destination* of an edit.

**Quotes.**
- 2026-09-14: "why did you add anything to Claude.md?"
- 2026-09-28: "you should add to Claude.md not agents md..."

**Status: missing.** The `agent-instruction-files` skill governs *how* to edit the files well; it
does not say "only when asked". The 2026-09-28 quote is really a routing complaint, and the skill
already exists to fix routing — so that half is a skill-fires-too-late problem, not a missing rule.

**Judgement: add one clause, low cost.** A single sentence appended to the existing
`agent-instruction-files` skill ("do not edit either file as a side effect of another task; propose
the line instead") is enough. Not worth an AGENTS.md bullet on its own — one session, and the
skill is the right home. Note this sits in mild tension with the standing
`Record what you worked out` rule, which invites agents to write findings down; the resolution is
that findings go in `investigations/` or the worked-on repo's `docs/`, and only *behavioural
instructions for future agents* need his sign-off.

---

## 6. Don't file an easily-fixable flaw as a "downside"

**Rule.** If you find a problem you can fix in a few lines, fix it rather than listing it as a
trade-off of the approach you proposed. Raise it as a downside only when fixing it is genuinely
expensive, and say what that cost is.

**Sessions: 1** (2026-10-01, RhyDB/SILO gzip work).

**Quote.**
- 2026-10-01: "Can you not just fix this now? I don't like you bringing this up as a downside if we can easily fix it? Or does it then become too slow? \"- Its gzip output is ~44% larger than LAPIS's.\""

**Status: missing, and I do not think it should be added.** One session, and the rule is close to
unfalsifiable — an agent has to judge "easily fixable", which is exactly the judgement he is asking
for. AGENTS.md is already long and this would be a line whose compliance is unmeasurable.
**Recommend not adding.** Recorded here because the parent analysis asked for the honest count, and
because the same sentence contains a better rule: he wants the *fix* plus its cost, not a
trade-off paragraph. That is closer to item 2 and already captured there.

---

## What this slice does not support

Two things I looked for and did not find, so as not to be chased later:

- **No repeated "verify before you claim" correction.** The keyword search for "are you sure"
  returns 14 sessions, which looks like the biggest signal in the corpus — but reading them shows
  almost all are *substantive challenge of a technical claim* ("are you sure glooko doesn't know
  liberty?", "are you sure the pg dump does not need to terminate any transactions?"), not a
  complaint that the agent skipped verification. Similarly "check again"/"double check" (10
  sessions) is mostly him re-asking a substantive question. There is a real instruction buried here
  — *state your assumption when a claim rests on one* — but it never surfaces as a
  behaviour correction, and I cannot count it honestly. **Do not add a "verify your claims" rule on
  this evidence.**
- **No repeated "you forgot to do X I asked for" beyond item 3.** The 11-session
  "did you (fix|address|test|do)" count is dominated by "which of the several agents did this?"
  bookkeeping across multi-agent sessions, not forgotten instructions.

The dominant character of this corpus is **substantive technical disagreement**, not process
correction. Items 1-3 are the real signal; 4 and 5 are genuine gaps with lower counts; 6 I would
skip.

## Could not determine

- Whether the 2026-09-10 "you never answered the 1/2 question" and its 3 sibling transcripts are
  one conversation or four independent recurrences. The identical text in 4 files with the same
  timestamp points to forks/resumes; I counted it as 1. If they were genuinely 4, item 3 moves to
  the top of the ranking.
- Whether the 2026-09-14 "few things I don't like" review was re-sent after each round of fixes
  (6 occurrences in the feedback slice across 2 transcripts, which could be a single review
  iterated, or the same complaint repeated as the agent regressed). Either way item 1 stands.
- Any signal from 2026-08-25 → 2026-08-31 in `slice_aug.tsv`: that window is one long CamAPS
  reverse-engineering thread and contains process corrections only for that project's own
  conventions (decompiles go in `scratch/camaps/`, not `investigations/`; subagents write
  numbered scripts into their own dir). Those are project conventions, not standing rules, and
  `loculus-orientation` / `coordinating-subagents` are the right homes if they are still current.

---

## Addendum, 2026-10-03 — extensions to items above, from one nineteen-hour session

Full material in [`06-session-2026-10-03.md`](./06-session-2026-10-03.md). Only the extensions are
recorded here, so this file stays the standing list rather than becoming a second copy of the day's
transcript.

**Item 2 (prefer the simpler construct) — the data analogue is new.** *"there's even more ma than a
thousand we could use hundreds of thousands. i don't get why you settle so early"* (05:35); *"why
the heck don't we get a bigger dataset. data is king!"* (05:41). He objects to an agent settling for
the cheap path on evidence as firmly as to one scaffolding a one-line fix into fifty lines.

**Item 4 (just run it yourself) — extended to writes that are reversible and local.** 05:31:
*"when you say something is easy to do then let's just do it, like calibration fusing etc."* And the
flip side, which is the same rule pointed the other way: 05:23 *"come on those costs are a joke
we've written this page in 2hr let's not exaggerate"*. An agent that both over-scopes and stalls on
permission has the same defect: substituting its own judgement for his.

**Item 3 (answer every part) — an unstated sub-case, satisfied today.** He asked *"Is there anything
for me to decide?"* at 10:31, unprompted. Surfacing a decision before it blocks is the positive
form of the same rule.

**Item 5 (don't edit instruction files unless asked) — inverted today, deliberately.** He asked for
two rules to be written down rather than merely applied: *"we are fine with commercial restrictions
for gods sake put that in a skill"* (06:26), and *"i think you shoudl get an agetn to do mosquito id
session mining and write out all my prompts into a doc so that we have it in one plce because i feel
like i'm repeating myself and we're not getting anywhere"* (06:43). The 2026-09-14 correction was
about not editing instruction files **as a side effect**. Asking for a skill or a record is the
other thing entirely, and it is the more valuable half.

**Item 6 (don't file an easily-fixable flaw as a downside) — supported twice, still not a rule.**
The pattern held at 12:52 (*"this is not true! i think that's an artefact from being in devcontainer
on my computer"*) and 12:18, where he forwarded a reviewer objecting that the coordinator kept
turning a scoped negative into a general one — *"another backbone is not the answer"* / *"it bought
nothing"* / *"route ruled out"* against evidence that only supported *"simple global blending does
not exploit the complementary information"*. A negative result states what was tested. The
recommendation not to add the rule to AGENTS.md stands, but the evidence is now stronger than one
session.

### New items that do not belong to any existing row

| Rule | Quote | Date |
|---|---|---|
| Push continuously; work in a working tree has not happened | *"ok have you pushed to github already let's keep it flowing so we have latest always on github link"*; *"why haven't we committed and pushed? i don't undersatnd"* | 02:52, 06:05 |
| Prioritisation is a recommendation, not a veto | *"why would the agent block a download that's stupid"* / *"nonono it should just try it"* | 05:43 |
| A green check is not evidence unless it would fail on the buggy code | two vacuous tests found 09:32, relayed 15:08 — **his words absent, the coordinator's inference** | 09:32 |
| "~fine" is not a status report | *"yeah agents need to say more than fine, they need to explain what they're doing, how it fits into the goal they were given, why they think it's worth to keep going what they expect to learn in the next work they're doing"* | 05:23 |
| Agents get ~45 minutes, then hand off | *"the agents are rather long lived now, prefer fresh ones after 45min"* | 16:13 |
| Long *jobs* are fine; long *agents* are not | *"don't let agents assume they have only 45 min, if they can make a case we can do more computational stuff for sure"* | 15:42 |
| Commit to `corneliusroemer-agent/*`, never `corneliusroemer/*` | *"agents should always commit in corneliusroemer-agent repos not corneliusroemer"* | 15:51 |
| `investigations/` is the ground truth for reports | *"make sure that all reports are definitely in the investigations dir … as that's our groun truth place always"* | 16:00 |
| Name the thing that makes a number true | *"this is not true! i think that's an artefact from being in devcontainer on my computer"* | 12:52 |
