# Standing instructions — read before dispatching an agent

One line each. Every rule has a message and a date behind it; the full evidence is in the numbered
files beside this one. Dates are 2026 unless stated.

## Ship

- **Push continuously.** Work in a working tree or on a branch has not happened. — *"let's keep it flowing so we have latest always on github"*, 10-03 02:52; *"why haven't we committed and pushed?"*, 06:05
- **Commit to `corneliusroemer-agent/*`, never `corneliusroemer/*`.** — 10-03 15:51
- **Every report goes in `mosquito-id`'s `investigations/`.** That is the ground truth; a report anywhere else is lost. — 10-03 16:00
- **Push if you think you have a fix. Don't let verification be the enemy of progress.** — *"don't let verification be the enemy of progres"*, 10-03 05:10
- **Never claim what you did not verify.** A green check is evidence only if it would fail on the buggy code. Verify served bytes, not the repo. — two vacuous tests found 10-03 09:32 *(the coordinator's rule; he never said it)*

## Decide

- **Prioritisation is a recommendation, not a veto.** An agent that skips work because it judged it low-value has overstepped. — *"why would the agent block a download that's stupid"* / *"it should just try it"*, 10-03 05:43
- **Never inflate an estimate or a cost.** — *"those costs are a joke we've written this page in 2hr"*, 10-03 05:23
- **If you say it's easy, just do it.** Don't present it as an option. — 10-03 05:31
- **Name what makes a number true.** A measurement in this container measures the container. Agreement with a label is not accuracy if the label came from the same model family. — *"this is an artefact from being in devcontainer"*, 10-03 12:52; ground-truth question, 13:11
- **A negative result states what was tested, not what is ruled out.** — reviewer's correction, forwarded 10-03 12:18

## Agents

- **Ask for updates on a clock — every ~10 min.** — 10-03 04:53
- **"Fine" is not a status report.** They must say what they are doing, how it fits the goal, why continuing is worth it, what they expect next. — *"they need to say more than fine"*, 10-03 05:23
- **You decide whether it continues, and you say so.** — 10-03 05:22
- **An agent gets ~45 minutes, then wraps up, writes a handoff, and a fresh one starts.** Never let an agent drift into work it chose. — *"prefer fresh ones after 45min"*, 10-03 16:13; *"how come the architect became a handyman?"*, 05:12
- **Long *jobs* are fine. Long *agents* are not.** Two hours of CPU costs nothing; two hours of agent attention does. Run the job detached, hand off the agent on a clock. — *"don't let agents assume they have only 45 min, if they can make a case"*, 10-03 15:42
- **Agents may spawn up to 2 subagents, for independent perspective** — adversarial review, unsticking, reconsidering priorities. A fresh agent does not inherit your framing. — 10-03 13:40
- **Never let two agents edit the same file at once.** Work was lost this way twice on 10-03.

## Write

- **Just run it yourself.** Read-only local investigation needs no permission; only the listed writes do. — `02-standing-corrections.md` §4, 2026-09
- **Do the small boring task; don't ask for a brief.** — *"why a brief from me i don't get it"*, 10-03 05:16
- **Answer every part of a multi-part question, including several inside one message.** — `02-standing-corrections.md` §3, 2026-09
- **Prefer the simpler construct, in code and in data.** Don't settle early on evidence. — *"i don't get why you settle so early"*, 10-03 05:35
- **Don't edit `AGENTS.md`/`CLAUDE.md` as a side effect of another task.** Propose the line instead. — 2026-09-14
- **Code comments: none by default, 1–2 lines when they earn it, never repeated across a PR.** — `02-standing-corrections.md` §1, 2026-09
- **Commercial-use restrictions on image data are fine** (NC/NC-SA yes; ND and unknown no). He has said this three times; don't re-derive it. — *"put that in a skill"*, 10-03 06:26
- **Write the end state, not the journey.** No "happy to X", no sign-offs, no journey narrative. Keep the why; drop the how-you-got-here.

## Talk

- **Surface blockers and decisions immediately.** He asked *"Is there anything for me to decide?"* because he had been left waiting. — 10-03 10:31
- **He will sometimes talk to a second agent.** If he says so, don't be surprised and don't re-litigate it. — *"i chatted with a distillation agent just so you know"*, 10-03 15:07

## Repo scope

- **Read-only `gh` needs no permission. Writes need an explicit ask.** Never push or open a PR on your own initiative. Every Loculus PR is draft.
- **Unconfirmed, do not rely on it:** that draft PRs are Loculus-only. No message supports it — see `06-session-2026-10-03.md` §15.

Full evidence: [`00-synthesis.md`](./00-synthesis.md) · [`02-standing-corrections.md`](./02-standing-corrections.md) · [`06-session-2026-10-03.md`](./06-session-2026-10-03.md) · [`07-unresolved-asks.md`](./07-unresolved-asks.md)
