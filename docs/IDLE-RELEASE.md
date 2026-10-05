# Idle release and the three states of a tab's sessions

## What the state is

`createIdleRelease` (src/app/idleRelease.ts) has one flag, `isReleased`, and one
counter, `pending`. A tab is in one of three states:

| state | `released()` | `needsEnsure()` | what it holds |
|---|---|---|---|
| never released | false | false | sessions |
| release in flight | **false** | **true** | nothing (being taken away) |
| released, no restore asked for | true | true | nothing |

The middle row is the one that is easy to get wrong. The flag is set at the END of
a release, so for the whole duration of a release it reads `false` while the tab
in fact holds no sessions.

## Why the inference entry points guard on `needsEnsure()`

Every inference entry point in main.js reads:

    if (idleRelease.needsEnsure()) await idleRelease.ensure();

`needsEnsure()` is `pending > 0 || isReleased`. The narrower predicate that was
there before - `released()` - is false during a release, so it skipped `ensure`
for exactly the window in which the wait matters: an inference arriving mid-release
proceeded against sessions the release was in the middle of destroying, and the
`pending > 0` wait inside `ensure` could never execute from any of the four call
sites. It is a plain read of two locals with no allocation and no side effect,
which matters because it runs on every classification.

## The wedge a `visible()` during a release used to cause

`doRelease` awaited `opts.release()` - which destroys the sessions - and then
checked whether the generation had moved before recording that the release
happened. `visible()` and `hidden()` both bump that generation, so a reader
switching back to the tab during the await made the release discard its own
completion after it had already destroyed everything.

The result was a tab that was visible, held no sessions, and believed it had never
been released: every later `ensure()` returned immediately, `drainQueuedBatches`
bailed on the null sessions, and dropped photos queued forever on the engine-loading
notice until a reload. It could not happen while `releaseIdleMemory` was
synchronous - nothing could land between the release and the flag - and it became
reachable when release started awaiting `InferenceSession.release()`.

The flag is now recorded unconditionally. Ordering against a concurrent restore is
the serialised chain's job (`enqueue`), which is what already kept a release from
clobbering a rebuild; a restore asked for during a release is queued behind it and
sees the flag set.

## Ruled out: the `shell.spec.ts` queue-notice flake

`e2e/tier1/shell.spec.ts` - "photos dropped before the model is ready are queued,
not lost" - is intermittently red with `#progress-msg` reading "Error: Failed to
fetch". Two writers share that slot: `showEngineLoadingNotice` and `initEngine`'s
catch handler, which fires because tier 1 aborts every model fetch by design.

The obvious suspect was the unconditional `await idleRelease.ensure()` added by the
defect-2 fix. `ensure` is `async`, so awaiting it suspends for a microtask even
when it returns without doing anything, which is enough to let the error handler
land after the notice. That mechanism is **not confirmed**: with all four sites
guarded on `needsEnsure()` - awaiting no more often than the old code did - the
test still failed 3/8, while the same test on the same `main` source in this clone
failed 8/8 and on `main` in a clean worktree passed 16/16. The flake tracks the
clone, not the diff. `needsEnsure()` is kept because it is the correct predicate
for the three-state table above, not because it fixes this.
