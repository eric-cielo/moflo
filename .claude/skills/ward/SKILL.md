---
name: ward
description: Ward the codebase — an ad-hoc test-gap audit that reveals unguarded code (untested functions, uncovered edge cases, missing error-handling and integration tests) and conjures ready-to-paste test skeletons as protective wards against regression, surfaced inline in the session. Scoped to your current diff by default, or to a path/area you name. Use before merging risky changes or when you suspect thin coverage. Replaces the old always-on `testgaps` daemon worker (alias: /test-gaps).
arguments: "[path or area | --all]"
---

# /ward — Test-Gap Audit

Cast over the code to reveal where it sits **unprotected** and raise wards against regression. This is the **ad-hoc, in-session** successor to the removed `testgaps` background worker: instead of a billed daemon loop re-scanning the whole tree every 20 minutes into a report nobody reads, `/ward` runs when you ask, scopes to what actually changed, and surfaces gaps — with test skeletons — **in the conversation** where you can act on them.

**Arguments:** $ARGUMENTS

## Phase 1: Memory first (gate requirement)

```
mcp__moflo__memory_search { query: "<the symbols/files in scope> test coverage", namespace: "tests" }
```

The `tests` namespace maps source → covering tests; use it to see what's *already* covered before flagging a gap. Also check `patterns` for the project's test framework and conventions so skeletons match house style.

## Phase 2: Decide scope

Pick the **smallest scope that answers the ask** — a whole-codebase re-scan is exactly the waste this skill was built to end.

| Argument | Scope |
|----------|-------|
| _(none)_ | The current diff: `git diff HEAD` + `git diff main...HEAD`. Ward the changed code only. |
| a path or glob | That subtree (e.g. `/ward src/api`). |
| an area in prose | Resolve to files via `code-map` search, then ward those. |
| `--all` | Whole codebase. Only on explicit request — say so and expect it to be slower. |

If the diff is empty and no target was given, ask what to ward rather than defaulting to `--all`.

## Phase 3: Detect the framework

Before writing any skeleton, determine the project's test runner and conventions (vitest / jest / pytest / go test / etc.) from config files, existing tests, and the `tests` memory. Skeletons MUST be in the project's actual framework and match its file naming, import style, and assertion idiom — a skeleton in the wrong dialect is noise.

## Phase 4: Find the gaps

For the in-scope code, look for, in rough order of risk:

1. **Untested functions / classes / exports** — public surface with no covering test. Cross-check against the `tests` namespace before flagging.
2. **Uncovered edge cases** — boundaries (empty, null/undefined, zero, negative, max), off-by-one, unusual-but-valid inputs the happy-path test skips.
3. **Missing error-handling tests** — `throw`/reject/error branches with no test asserting the failure path; validation that nothing exercises.
4. **Integration gaps** — units tested in isolation but the seam between them (I/O, DB, external calls, cross-module contracts) is unexercised.
5. **Regression-prone changes** — in a diff, logic that changed behavior but whose tests didn't.

Only flag gaps in code that has a real failure mode. Don't demand tests for trivial pass-throughs.

## Phase 5: Surface gaps + conjure wards inline

Report **in-thread**, ranked most-risky first. For each gap:

- **What's unguarded & where** — one line + `file:line`.
- **The risk** — what breaks silently if this regresses.
- **The ward** — a ready-to-paste test skeleton in the project's framework, as a fenced code block. Fill in the arrange/act/assert structure and the specific cases; leave a `// TODO` only where a real fixture/mock the user must supply is needed.

End with a one-line summary (e.g. "4 gaps: 2 high (error paths in `parseConfig`), 2 medium"). If coverage is genuinely solid, say so — a clean audit is a valid result.

## Phase 6: Offer to act

Ask whether to write the skeletons into the test tree. Only create/modify test files when the user confirms (or invoked with a clear "add the tests" intent). If the audit was large and the user wants a record, offer to write it to `.moflo/reports/ward-<scope>.md` — but the in-thread report is the primary deliverable, not a file.
