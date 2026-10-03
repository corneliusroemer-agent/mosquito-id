# ON HOLD — the Svelte rewrite does not receive new code

**Status: parked. Do not build on this, do not port features into it, do not merge into it.**

Cornelius's decision, 2026-10-03: *"let's not do too much svelte for now, we might later refactor
to react anyways, I'm not sure the svelte experiment worked well."*

## Why it is parked rather than deleted

It is a working experiment with real results, and those results are worth keeping:

- the gap audit against the live app found **~25 capability differences**, not the nine an earlier
  report claimed — the earlier figure was unverified and roughly four times too small
- it found and fixed **four pre-existing type errors that blocked `npm run build`** in that repo
- it surfaced a CSS comment asserting an `object-fit` the stylesheet never declared, which is the
  same failure shape as the footer bug in the live app: a comment describing an intent the code
  does not implement

None of that makes it the app. The app is `mosquito-id`, built with Vite and TypeScript, and it is
the only thing deployed at `/mosquito-id/`.

## What this costs, stated plainly

Maintaining two implementations of the same app is how this project lost a day: correct work lands
in one tree while the other rots. The Vite build fixed that for the *app* by making
`src/confidence/*.ts` the code the browser actually runs — and this rewrite is a second copy that
does **not** have the pooled-card gate, the non-mosquito pooled gate, or the `GENUS_MARGIN`
deletion. It is a third place for a fix to be forgotten.

## Rules

- **No new code here.** Not a feature, not a fix, not a refactor.
- **Do not merge anything into `main` on this branch family.**
- **Do not treat it as a source of truth for anything.** If a number or a decision appears only
  here, it needs re-deriving before it is quoted.
- Work that would have gone here goes to the Vite app instead: `mosquito-id`.
- Reading it is fine, and porting a genuinely better idea *out* of it into the Vite app is
  encouraged — that is the only way anything here stays useful.

## Reports

Everything else that would have been written here goes to
`investigations/` in `corneliusroemer-agent/mosquito-id`. That directory is the ground truth for
findings; this one is a parked experiment.
