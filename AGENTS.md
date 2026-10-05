# AGENTS.md

A client-side mosquito species classifier: YOLO11n detector → one of three WebGPU encoders,
scored in the browser. Vite + TypeScript, deployed to GitHub Pages. No server; the only
network calls are fetching model weights and an iNaturalist proxy.

Read `investigations/` before claiming anything about accuracy — it is the ground truth for
every number this app reports, and several shipped constants were fitted in reports that
contradict each other.

## Work goes through pull requests

Every change reaches `main` through a PR. **An agent opens a draft PR and stops.** It does
not merge, and does not mark a PR ready for review.

The coordinator gets an adversarial review going on the PR, then decides: resume the original
agent to fix what the review found, merge as is, leave it as a draft on the backburner, or
task a fresh agent with the review's points — new eyes often implement a few targeted changes
better than an author already invested in their own framing. **The coordinator effects the
merge. No agent merges.**

Reviewers post their findings **as a comment on the PR**, under the agent identity, stating
which reviewer they are. A reviewer's first act is to write its findings to a file before it
measures anything — a finding that exists only in a transcript is worth nothing.

**CI must pass on the merged `main`, not a stale one.** Merge `origin/main` into the branch
and re-run before calling a PR green. This is not ceremony: `f0babee` was green, the
confidence-router merge `58f8e2f` was red, and only the merged comparison showed the router
had broken the e2e specs.

**Squash by default.** A normal merge is acceptable when nothing builds on the branch *and*
the coordinator explicitly asked for the work to target that branch.

The gate before a merge is green:

```sh
npx vitest run          # unit
npm run test:all        # unit + e2e + build
actionlint .github/workflows/pages.yml
```

**A red CI run is a defect to be fixed, not a pre-existing condition to be noted and moved
past.** Relaxing an assertion to get green is the failure mode this rule exists to prevent.

## The changelog is written at merge time

`CHANGELOG.md` carries one section per day. **Whoever merges a change writes its entry** —
in the same PR, or as a follow-up on `main`, before the merge is considered done. Nothing is
added when the branch is opened, and no separate backfill pass exists.

Categories are **Feature**, **Bug Fix**, **Documentation**, **Testing / Reliability**,
**Internal**. Every entry cross-references the PR (`#NN`), the issue (`#NN`), or the commit
SHA — an entry with no reference is not finished either. Day granularity is deliberate: the
file is a record of what reached `main` on a date, not a per-commit log. `git log` is that.

## Traps that have cost real time here

**The model bucket's CORS allowlist has six fixed origins**: `127.0.0.1:` ports 4173, 4199,
4299, 8100, 8153, 8907. A page served from any other port **cannot fetch the models at all**,
so its e2e run fails in a way that looks like an app bug. Do not add a port; widening the
allowlist needs the Cloudflare token. A failed `npx vite preview --strictPort` on an unlisted
port is a configuration error, not a flake — do not re-run it hoping for a different result.

**Playwright's real false greens are narrow, and `docs/TESTING.md` measures them.** An earlier
version of this file claimed `npx playwright test` exits 0 when the preview server fails to
start. That is **false, and was retracted** in
[#54](https://github.com/corneliusroemer-agent/mosquito-id/pull/54): measured on 1.63.0 against
this repo's config, a port held by a live server, a port held by a dead listener, a `webServer`
that exits before the URL is reachable, and an empty selection each exit **1**. Playwright
checks whether the URL came up, not the child's exit code. The three real ones:

- **`reuseExistingServer: true`** lets the suite pass against another agent's `dist/`. This repo
  is immune — `playwright.config.ts` sets `reuseExistingServer: false` and `--strictPort` —
  which is why it is worth stating rather than assuming.
- **`--pass-with-no-tests`** exits 0 on an empty selection.
- **A shell wrapper** — `|| true`, or a pipeline without `pipefail` — makes `$?` read 0 while
  the error scrolls past. This is the one that bit: a wrapper ending `echo "EXIT=$?"` reports
  the exit status of the `echo`.

**A second `@playwright/test` install under another checkout also breaks this one**, separately:
the shared transform cache serves entries recorded against the other tree and every spec fails
at collection. Clearing the cache and setting a private `TMPDIR` do not fix it; `npm ci` in the
repo does. Before concluding a Playwright change broke the suite, run `npm ci`.

**Constants fitted in one coordinate system have been applied in another.** `CROP_ONLY_MAX_POSTERIOR`
was fitted on a **6-class species-only** `predict_proba` posterior (report 80: `n = 1,199`,
`n_classes = 6`), while the quantity `fuseViews` actually read was `viewResults[0].spP` out of
`softmaxJoint` — for the shipped B/16 head a **25-class** joint softmax in which nine nuisance
rows compete for mass. That made the router fire on **10 of 10 shipped example photographs**
(report 82), and 93% of real in-domain crops, so the whole-frame view was discarded almost always
and "include the whole photo" was a near-total no-op. **The router has been removed** (issues #85,
#90; every view is now always pooled), but the trap is not: check that a threshold's *input* is the
quantity the app computes, not merely one with the same name.

**Never `git stash`** in a tree another agent is using: it sweeps every tracked modification
into the stash, including their uncommitted work.

## Testing notes

- `tests/gate.test.ts` lifts the 23 original assertions out of `main.js` as real imports, so
  a change to the shipped code and a change to these expectations cannot drift apart silently.
- Fixtures distribute a view's leftover mass over the species the fixture left at zero,
  because that is where a real softmax puts it — a view that assigns 10% to a species and
  0.1 to nuisance is one the model would score as a nuisance photo.
- `split_group`, not `group`, is the split key. `leak_check` rules out group straddling only;
  cross-split near-duplicate leakage is unmeasured
  ([#81](https://github.com/corneliusroemer-agent/mosquito-id/issues/81)).
- BLAS thread count moves results by ±0.007 macro-F1 on identical data. Pin threads on the
  worker and treat a smaller margin as unmeasured.
- Entropy is the headline metric; macro-F1 is secondary and never decides alone
  ([#40](https://github.com/corneliusroemer-agent/mosquito-id/issues/40),
  [#52](https://github.com/corneliusroemer-agent/mosquito-id/issues/52)).

## Reports

Investigation reports live in `investigations/YYYY-MM-DD-<topic>/`, one directory per
investigation, numbered reports at the top level and each topic's scripts in their own
numbered subdirectory. Write **what is true now**, not the path that got there — with one
exception: an investigation may record what was ruled out, because "X is not the cause" is
itself a result.