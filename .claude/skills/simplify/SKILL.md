---
name: simplify
description: Review changed code for reuse, quality, and efficiency, then fix any issues found. Sizes review effort to the diff — trivial edits get a self-review, substantial edits get parallel agents.
---

# /simplify — Adaptive Code Review

Review changed code for reuse opportunities, quality issues, and efficiency improvements. **Effort scales with diff size** — a 5-line comment trim doesn't get the same treatment as a 500-line refactor.

## Phase 1: Identify changes

Run `git diff HEAD` (working tree) and `git diff main...HEAD` (committed) to get the full set of changes since the branch diverged. If on `main` with uncommitted changes, just `git diff HEAD`.

Treat the union of staged + unstaged + committed-since-base as the diff to review.

## Phase 2: Classify the diff

Pick the **smallest tier** the diff genuinely fits. When in doubt, escalate.

### TRIVIAL — self-review, no agent spawn
ALL of these must hold:
- ≤10 net LOC changed (insertions + deletions, excluding pure whitespace)
- Single file
- No logic changes — only comments, formatting, renames of local vars, JSDoc, or string-literal edits
- No new imports, no new exports, no new function/class declarations
- No removed safety checks, error handlers, or guards

Examples that qualify: trimming a comment, fixing a typo in a log message, renaming a private helper, reformatting a single block.
Examples that DON'T qualify: changing an `if` condition, reordering function args, deleting a try/catch.

### SMALL — single agent, all three categories
ALL of these must hold:
- ≤50 net LOC changed
- ≤2 files
- No structural changes (no new modules, no API additions/removals, no contract changes)

Examples that qualify: extracting a constant, inlining a one-liner, swapping a `for` for a `forEach`, adding one early-return.

### NORMAL — three parallel agents (the original flow)
Anything that doesn't fit TRIVIAL or SMALL. Includes any diff that:
- Spans 3+ files
- Adds/removes/renames a public API
- Changes control flow in a non-trivial way
- Introduces or removes a dependency
- Touches `bin/`, hooks, MCP tool handlers, or anything called out in `CLAUDE.md` as critical surface

When CLAUDE.md flags a file as critical surface (SessionStart, launcher, hooks, MCP coordinator wiring, swarm/hive-mind), **always escalate to NORMAL** regardless of LOC count. Risk-weighted, not size-weighted.

## Phase 3: Run the appropriate review

### TRIVIAL: self-review
Run the same three category checks (reuse / quality / efficiency) yourself, in one pass, against the diff. Most TRIVIAL diffs will be clean — the goal is to confirm, not to fan out. If you find an issue, fix it; otherwise stamp clean. Total budget: ~30 seconds, no Agent calls.

### SMALL: one agent
Launch a SINGLE Agent with subagent_type `reviewer` covering all three categories in one prompt. Pass the diff inline. Budget: ~1 minute.

```
Agent — subagent_type: "reviewer", prompt: "Review this diff for reuse, quality, and efficiency. <diff inline>. Flag specific issues with file:line; skip generic advice. Under 200 words."
```

### NORMAL: three parallel agents (original flow)
Launch three agents in a single message — Reuse, Quality, Efficiency — passing the full diff to each. Use the original flow's category checklists.

**Reuse**: existing helpers/utilities that should be used instead; duplicated patterns; new functions that re-implement something already in the codebase.

**Quality**: redundant state, parameter sprawl, copy-paste with variation, leaky abstractions, stringly-typed code, nested conditionals 3+ levels, unnecessary comments (WHAT-explanations, task references).

**Efficiency**: unnecessary work, missed concurrency, hot-path bloat, recurring no-op updates, TOCTOU existence checks, unbounded structures, over-broad reads.

## Phase 4: Fix or skip

Aggregate findings. Fix each one directly. False positives or not-worth-fixing — note and skip without arguing. If TRIVIAL self-review found nothing, just confirm clean and exit.

If fixes were made, re-run tests to confirm nothing broke. If tests fail after a fix, revert it.

## Phase 5: Stamp the gate

Whatever tier ran, the gate (`check-before-pr`) registers /simplify as having executed. The skill is satisfied.

## Briefly summarize

End with one or two sentences: which tier, what was fixed (or "clean — no changes"). No headers, no bullets unless needed.
