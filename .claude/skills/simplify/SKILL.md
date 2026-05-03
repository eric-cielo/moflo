---
name: simplify
description: Review changed code for reuse, quality, and efficiency, then fix any issues found. Sizes review effort to the diff — trivial edits get a self-review, substantial edits get parallel agents.
---

# /simplify — Adaptive Code Review

Review changed code for reuse opportunities, quality issues, and efficiency improvements. **Effort scales with diff size and reuses prior context** — a 5-line comment trim doesn't get the same treatment as a 500-line refactor, and a re-run after fixing pass-1 findings doesn't re-pay for a fresh fan-out.

## Phase 1: Identify changes

Run `git diff HEAD` (working tree) and `git diff main...HEAD` (committed) to get the full set of changes since the branch diverged. If on `main` with uncommitted changes, just `git diff HEAD`.

Treat the union of staged + unstaged + committed-since-base as the diff to review.

Also note: was `/simplify` already run on this branch in this session? If yes, you're in a **validation pass** (Phase 2.5 below) — most of the heavy lifting is done.

## Phase 2: Classify the diff

Pick the **smallest tier** the diff genuinely fits. When in doubt, escalate one step (not two).

### TRIVIAL — self-review, no agent spawn
ALL of these must hold:
- ≤10 net LOC changed (insertions + deletions, excluding pure whitespace)
- Single file
- No logic changes — only comments, formatting, renames of local vars, JSDoc, or string-literal edits
- No new imports, no new exports, no new function/class declarations
- No removed safety checks, error handlers, or guards

Examples that qualify: trimming a comment, fixing a typo in a log message, renaming a private helper, reformatting a single block.
Examples that DON'T qualify: changing an `if` condition, reordering function args, deleting a try/catch.

### SMALL — single agent, all three categories (DEFAULT for most diffs)
ALL of these must hold:
- ≤200 net LOC changed
- ≤2 files
- No structural changes (no new modules, no API additions/removals, no contract changes)

This is the default tier for **most real diffs**, including changes to critical surface (launcher, hooks, MCP wiring). Critical surface raises the *care* of the agent prompt (sharper checklist, blast-radius framing), not the *number* of agents.

Examples that qualify: extracting a constant, inlining a one-liner, swapping a `for` for a `forEach`, adding one early-return, refactoring a single function within a file, adding a cache fast-path inside an existing block.

### NORMAL — three parallel agents
Reserved for **genuinely cross-cutting** changes. ANY of these triggers NORMAL:
- 3+ files changed
- >200 net LOC changed
- Adds/removes/renames a public API
- Introduces or removes a dependency
- Cross-cutting refactor (touches the same pattern in multiple modules)

Three agents exist to cover orthogonal axes (Reuse / Quality / Efficiency) when the change is broad enough that one agent's tool-call budget can't survey it all. For single-file edits, one focused agent always covers all three axes — three is duplication, not coverage.

## Phase 2.5: Validation pass (re-run after fixes)

If `/simplify` already ran on this branch in this session AND the only edits since are fixes driven by the prior pass's findings, default to **self-review tier** regardless of LOC count. The fan-out already happened; the fix is small relative to the diff that was already reviewed.

Escalate one tier (self-review → SMALL agent) only if the fix introduced any of:
- A new file
- A new exported symbol
- A new dependency or import from a previously-untouched module
- A change to control flow not covered in the original findings

Do **not** escalate to NORMAL on a validation pass. If the fix is so structural that NORMAL is warranted, treat it as a fresh diff and start over from Phase 1.

## Phase 2.7: Route the model (before any Agent spawn)

For every tier that spawns an Agent (SMALL / NORMAL — TRIVIAL self-review skips this), call the moflo router to pick the cheapest model that fits the task **before** invoking Agent:

```
mcp__moflo__hooks_model-route — {
  task: "<diff summary — see wording rules below>",
  preferCost: true
}
```

### Wording the task description

The router's complexity score is keyword-sensitive. Words like `refactor`, `architect`, `audit`, `system`, `redesign`, `migrate` flip a high-complexity flag and force opus *even when scoring suggests sonnet*. For `/simplify` you are **always doing code review**, never genuine architecture, so frame the task accordingly:

- ✅ Good: `"Review 110-line single-file change in bin/session-start-launcher.mjs for reuse, quality, efficiency."`
- ❌ Bad: `"Review refactor that adds mtime-cache fast-path and architects new caching layer."`

Drop the trigger words. State LOC count, file count, and "review for reuse, quality, efficiency". That's enough signal.

### Applying the result

The router returns `{ model: 'haiku' | 'sonnet' | 'opus', complexity, reasoning, alternatives, ... }`.

**Hard rule for `/simplify`: opus is never correct.** Code review does not require Opus-tier reasoning even on critical surface. If the router returns `opus`:

1. Look at `alternatives` — if `sonnet` scores higher than the selected model's confidence, downgrade to sonnet.
2. Otherwise, downgrade to sonnet anyway (treat opus as "router was uncertain — pick the safer middle").

Pass the final model verbatim to the Agent's `model` parameter (Agent accepts `'haiku' | 'sonnet' | 'opus'`). On router failure (MCP call errors), default to `'sonnet'`.

In practice: comment trims and pure formatting → haiku; everything else for `/simplify` → sonnet.

### Feed back the outcome

After the agent completes, record the outcome so the router learns:

```
mcp__moflo__hooks_model-outcome — { task: "<same wording as route call>", model: "<chosen>", outcome: "success" | "failure" | "escalated" }
```

`escalated` = the agent missed something a higher-tier pass would have caught. That signal teaches the router to bias similar tasks upward next time. Don't fake `escalated` to retroactively justify opus — only record it when a *real* miss happened.

## Phase 3: Run the appropriate review

### TRIVIAL / Validation: self-review
Run the same three category checks (reuse / quality / efficiency) yourself, in one pass, against the diff. Most TRIVIAL and validation diffs will be clean — the goal is to confirm, not to fan out. If you find an issue, fix it; otherwise stamp clean. Total budget: ~30 seconds, no Agent calls. No router call needed.

### SMALL: one agent (model from router)
Launch a SINGLE Agent with subagent_type `reviewer`, passing the model returned by Phase 2.7's router call. Cap the agent's tool budget by being explicit:

```
Agent — {
  subagent_type: "reviewer",
  model: "<from router, typically 'sonnet'>",
  prompt: "Review this diff for reuse, quality, and efficiency. <diff inline>. Flag specific issues as file:line + 1-line description. Max 5 file reads. Under 200 words. Skip cosmetic style. Don't suggest cross-cutting refactors of code outside this diff."
}
```

For critical-surface files, prepend a 1-line risk note to the prompt (e.g., "This is `bin/session-start-launcher.mjs` — runs in every consumer's session-start hot path; cross-platform + blast-radius matter."). One careful agent, not three.

Budget: ~1 minute.

### NORMAL: three parallel agents (model from router, applied to all)
Launch three agents in a single message — Reuse, Quality, Efficiency — passing the full diff and the same routed `model` to each. Each agent gets the same tool-budget cap as SMALL.

**Reuse**: existing helpers/utilities that should be used instead; duplicated patterns; new functions that re-implement something already in the codebase.

**Quality**: redundant state, parameter sprawl, copy-paste with variation, leaky abstractions, stringly-typed code, nested conditionals 3+ levels, unnecessary comments (WHAT-explanations, task references).

**Efficiency**: unnecessary work, missed concurrency, hot-path bloat, recurring no-op updates, TOCTOU existence checks, unbounded structures, over-broad reads.

## Phase 4: Fix or skip

Aggregate findings. Fix each one directly. False positives or not-worth-fixing — note and skip without arguing. If self-review found nothing, just confirm clean and exit.

If fixes were made, re-run tests to confirm nothing broke. If tests fail after a fix, revert it.

After fixes: the next `/simplify` invocation is a **validation pass** (Phase 2.5). Do not re-fan-out unless the fix added genuinely new concerns — bundle related fixes into one batch so a single validation pass covers them.

## Phase 5: Stamp the gate

Whatever tier ran, the gate (`check-before-pr`) registers /simplify as having executed. The skill is satisfied. Self-review counts.

## Briefly summarize

End with one or two sentences: which tier ran, what was fixed (or "clean — no changes"). No headers, no bullets unless needed.
