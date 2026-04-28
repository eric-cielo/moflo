# Testing — Performance and Flakiness

**Purpose:** Rules for handling slow or flaky tests in moflo. These rules apply to **every** test in the suite — unit, integration, isolation, fixture-based.

---

## 1. Slow tests must be fixed, not papered over

**Bumping a test's `timeout` is never the answer.** When a test breaches its timeout, the test isn't broken — the *thing being tested* is slow, and the slowness will hit production users too.

| When you see | Don't | Do |
|--------------|-------|-----|
| `await handler(...)` exceeds 5 s | Bump the per-test timeout to 30 s / 60 s | Find what makes the handler slow and fix that |
| Heavy import takes 10+ s under load | Mark the test slow / skip in CI | Reduce what the import pulls in (lazy load, tree-shake) |
| `process.cwd()`-driven scan walks the whole repo in tests | Add to `isolationTests` and ship | Chdir to a tempdir or pass an explicit narrower path |
| Performance assertion flakes (`<100 ms`) | Widen to `<60_000 ms` | Widen to a generous *catastrophic-regression* bound (e.g. `<500 ms`) and rename the test to a "smoke check" that matches |

**Never bump a per-test timeout above 30 s.** Anything that needs more is hiding a real slowness. Fix the slowness; don't paper over it.

A timeout > 30 s is a code smell that says "I gave up finding the root cause." That tax compounds — every CI run pays it.

## 2. Find the actual problem before reaching for `isolationTests`

The `isolationTests` list in `vitest.config.ts` exists for tests that *fundamentally* need serialized execution — process-spawn timing, cwd contention, real fastembed model loading. It is **not** a parking lot for "this is slow under load, just take it out of the parallel pass."

Before adding a test to `isolationTests`, time it with the actual slow operation isolated. The question is *why* the test is slow — pick whichever of these matches:

- **Heavy handler / module init** → reduce its work scope (chdir to tempdir, pass an empty path arg, mock the slow internal step).
- **Subprocess spawn**: `execFileSync('node', ...)` for a syntax check or similar trivial work → replace with in-process equivalent (`await import(pathToFileURL(path).href)` for ESM parse checks).
- **Real fastembed model load** → file genuinely belongs in `isolationTests` because parallel forks fight for the model load. Document *why* in the comment.
- **Performance assertion** → widen the bound to a smoke-check threshold (10× the typical observed time), per precedent in commit `e18e56b15`.

## 3. Concrete examples (#639 PR)

Three flakes in the suite were diagnosed and root-caused (PR #711):

- `tests/issue-fixes.test.ts` #75 — `hooksSessionStart` auto-pretrain hard-codes `path: process.cwd()` and embeds every extracted pattern via fastembed (~200 ms each). Run from the moflo repo the handler took 10–15 s; under isolation-pass cumulative load it breached the 30 s timeout. **Fix**: chdir to a tempdir → 0 files → 0 patterns → 0 embeddings → 1 s handler. Wrong fix would have been bumping the timeout to 60 s.
- `tests/bin/process-manager.test.ts` 'parses as valid ESM' — `execFileSync('node', ['--check', PM_PATH], {timeout: 5000})` couldn't reliably get a Windows fork() within 5 s under maxForks=2 contention, even though the actual `--check` runs in 70 ms. **Fix**: replaced with in-process `await import(pathToFileURL(PM_PATH).href)` — module's top level is side-effect-free, so a dynamic import is a clean parse check.
- `src/cli/__tests__/neural/algorithms.test.ts` Decision Transformer 100 ms smoke check — fragile bound under fork contention. **Fix**: widened to 500 ms to match the DQN smoke check above (precedent: commit `e18e56b15`). Still catches catastrophic regressions; no longer flakes.

Each fix removed a flake source AND made the test run faster than the baseline. That is the shape of a good test-performance fix.

## 4. The standing decision

We don't have "known flaky tests" in moflo. Either a test is fixed or it's not in the suite. When triaging a failure:

1. Run the test in isolation. If it passes alone but fails under load, the suite has cumulative pressure — find the slow contributor and trim it.
2. If a per-test budget is the limit, the budget is a symptom, not the diagnosis. Find what's slow and reduce it.
3. Re-running until green is *never* the answer. If you can't find the root cause, leave the failure visible until you do.
