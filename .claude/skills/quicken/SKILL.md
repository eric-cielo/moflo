---
name: quicken
description: Quicken the codebase — an ad-hoc performance audit that reveals what drags (N+1 queries, needless re-renders, missing caching, memory leaks, redundant computation, hot-path complexity) and prescribes the fix, surfaced inline in the session. Scoped to your current diff by default, or to a path/area you name. Use before a perf-sensitive merge, when something feels slow, or when you want a targeted optimization pass. Replaces the old always-on `optimize` daemon worker (alias: /perf-audit).
arguments: "[path or area | --all]"
---

# /quicken — Performance Audit

Cast over the code to reveal what drags and how to hasten it. This is the **ad-hoc, in-session** successor to the removed `optimize` background worker: instead of a billed daemon loop re-auditing the whole tree every 15 minutes and writing to a report nobody reads, `/quicken` runs when you ask, scopes to what actually changed, and surfaces findings **in the conversation** where you can act on them.

**Arguments:** $ARGUMENTS

## Phase 1: Memory first (gate requirement)

```
mcp__moflo__memory_search { query: "<the hot symbols/files in scope> performance", namespace: "patterns" }
```

Also check `code-map` for where the audited symbols live and `learnings` for prior perf decisions on this codebase (don't re-litigate a deliberate tradeoff).

## Phase 2: Decide scope

Pick the **smallest scope that answers the ask** — a whole-codebase re-audit is exactly the waste this skill was built to end.

| Argument | Scope |
|----------|-------|
| _(none)_ | The current diff: `git diff HEAD` + `git diff main...HEAD`. Audit the changed hot paths only. |
| a path or glob | That subtree (e.g. `/quicken src/api`). |
| an area in prose | Resolve to files via `code-map` search, then audit those. |
| `--all` | Whole codebase. Only on explicit request — say so and expect it to be slower. |

If the diff is empty and no target was given, ask what to audit rather than defaulting to `--all`.

## Phase 3: Audit

Read the in-scope code and look for, in rough order of typical impact:

1. **N+1 / repeated I/O** — queries or fetches inside a loop that could be batched or hoisted; missing `IN (...)` / `Promise.all`.
2. **Redundant computation** — work repeated per-iteration that is loop-invariant; recomputing a derived value that could be memoized; re-parsing/re-serializing.
3. **Algorithmic complexity** — accidental O(n²) (nested `.find`/`.includes` over the same list, building a `Set`/`Map` would make it O(n)); unbounded growth on a hot path.
4. **Caching opportunities** — pure, expensive, frequently-called functions with no memoization; missing HTTP/DB result caching where staleness is acceptable.
5. **Framework-specific** — React: re-renders from unstable props/callbacks (missing `useMemo`/`useCallback`/`memo`), context that re-renders the tree; server: sync work on the request path that could be deferred.
6. **Memory leaks** — listeners/timers/subscriptions never torn down; growing module-level collections; closures pinning large objects.

Only flag things you can point at with `file:line`. Skip micro-optimizations with no measurable payoff — altitude matters, don't drown a real finding in nitpicks.

## Phase 4: Surface findings inline

Report **in-thread**, ranked most-impactful first. For each:

- **What & where** — one line + `file:line`.
- **Why it drags** — the concrete cost (e.g. "runs a query per row, ~N round-trips").
- **The fix** — a short code sketch (fenced block). Keep it minimal and idiomatic to the surrounding code.

End with a one-line summary (e.g. "3 findings: 1 high (N+1 in `loadOrders`), 2 medium"). If nothing meaningful turns up, say so plainly — a clean audit is a valid result.

## Phase 5: Offer to act

Ask whether to apply the fixes. Only edit when the user confirms (or if they invoked with a clear "fix it" intent). If the audit was large and the user wants a record, offer to write it to `.moflo/reports/quicken-<scope>.md` — but the in-thread report is the primary deliverable, not a file.
