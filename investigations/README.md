# Investigations

Reports and findings. The code these describe lives in
`investigations/2026-10-02-mosquito-id/10-github-pages/site/` (the app) and in the
`mosquito-id-svelte` repository (the precision work); this directory holds the
write-ups so they are readable without either.

| | |
|---|---|
| `2026-10-02-mosquito-id/40-temporal-progression.md` | What happened over the project's ~19 hours: phases, what moved and what did not, the merges that clobbered earlier fixes, and which research directions were correctly closed versus merely abandoned. Its central finding: three different apps existed at the end and only one is what anyone sees. |
| `2026-10-02-mosquito-id/41-second-model-blocked.md` | Why a second, small model cannot ship yet. The mechanism, not the accuracy gap, is what stops a retry. |
| `2026-10-03-precision/40-precision/98-evaluation-audit/` | How we were measuring, and what the current metrics cannot see. Every headline was `argmax == manifest label`, which cannot express abstention, "not a mosquito", or genus. Recommends risk-coverage as primary, stratified by label tier. |
| `2026-10-03-precision/40-precision/99-calibration-ship/` | Calibration for both model sizes, fitted on `log p` because that is what the app consumes. |
| `2026-10-03-precision/40-precision/95-distillation/` | Teacher-student pilot. A clean negative, structural rather than marginal. |
| `2026-10-03-precision/40-precision/97-relabel/` | 640 genus-rank rows recovered to species rank, all human-expert. |
| `2026-10-04-session-mining.md` | Request-level: 66 rows of what was asked versus what shipped, each with `git log` or served-bytes evidence. |
| `2026-10-03-rewrite/00-ON-HOLD.md` | **The Svelte rewrite is parked.** No new code, nothing merged, not a source of truth. Read it; port ideas out of it; do not build on it. |
| `2026-10-01-user-message-mining/STANDING-INSTRUCTIONS.md` | **Read this before dispatching an agent.** One page: the rules that must not be violated, each with the message and date behind it. |
| `2026-10-01-user-message-mining/06-session-2026-10-03.md` | One day in full — 15 rules and 11 product decisions, every one a correction made after an agent got it wrong. |
| `2026-10-01-user-message-mining/07-unresolved-asks.md` | What was asked on 2026-10-03 and is still open: six never started, five pushed-but-unmerged. |

Written with agents; commit when a finding is worth keeping, not when it is tidy.
