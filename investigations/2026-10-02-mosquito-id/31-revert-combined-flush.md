# Revert the pooled card to its 240px reservation

Branch `agent/revert-combined-flush`, one commit (`cafa280`) on top of
`origin/main` (`5f1edc8`). Live app: <https://corneliusroemer-agent.github.io/mosquito-id/>.

## What changed

`.combined-scores` in `/Users/cr/code/claude-devcontainer/tmp/deadspace-revert/index.html`
back to `height: 240px; overflow-y: auto` — the declaration `deff442` replaced
with `max-height: 320px`. The commit's own comment is restored with it. One
declaration, one file.

Untouched, as required: the `.score-item-header` flush, the `#score-pending` /
`#view-agreement` `.shown` reservation, the `Number.isFinite` bar guards, the
progress meter. `main.js` is not modified at all.

## The trade-off, restated

The reservation does not prevent layout shift in the pooled card — it defers
it. Pooled content needs ~320px where 240px is reserved, so the card still
grows 80px the instant anything is pooled; the empty card meanwhile holds
~234px of void. `deff442` measured this and removed the reservation on the
grounds that it bought a 234px void to suppress 80px of a shift that
content-appearing causes regardless.

Cornelius has reviewed that and prefers the fixed reservation: dead space is
more acceptable than a card that resizes substantially when he checks a second
photo. The trade is accepted deliberately, not re-litigated here.

The `.score-list` panel is unaffected either way — it is a fixed box in both
states at both viewports.

## Verification

Playwright against the worktree served on `127.0.0.1:8907`, with `**/*.onnx`,
`**/*r2.dev*` and `/api/` aborted, so the 1.26 GB classifier never downloads.
Photos are fabricated as canvas previews pushed into `previews` and pooled
through the app's own `selectPhoto()` path and `.thumb-optin` checkboxes — no
model, real panels, real DOM. Harness adapted from the one at
`/workspaces/claude-devcontainer/tmp/deadspace/pw/`; this run's copy is at
`/workspaces/claude-devcontainer/tmp/dsrev/` (`verify.mjs`, `after.json`,
screenshots), uncommitted — Playwright is not a repo dependency.

The property the revert exists for, asserted directly:

| `.combined-scores` height | 1440×900 | 390×844 |
|---|---|---|
| empty | **240** | **240** |
| populated | **240** | **240** |
| pooled card, empty → populated | 369 → **369** | 361 → **361** |

Page `scrollHeight` still moves when the second photo is checked (1125 → 1226
at 1440) — that is the scores panel filling, not the pooled card.

`node --check main.js` clean; `node --test tests/gate.test.mjs` passes (1 test).

## Push

`agent/revert-combined-flush` on `github.com/corneliusroemer-agent/mosquito-id`.
Not opened as a PR.

https://github.com/corneliusroemer-agent/mosquito-id/compare/main...agent/revert-combined-flush
