---
description: Review changed code for reuse, quality, and efficiency, then fix any issues found. Sizes review effort to the diff and routes the cheapest model that fits.
---

# /simplify — Adaptive Gate-Compliant Code Review

Review changed code for reuse, quality, and efficiency. **Effort scales with diff size; model is routed for cost.** A 5-line comment trim does not get 3 Opus agents.

## Phase 0: Gate prerequisites

These satisfy the memory-first and task-create-first gates. Always do them before any Agent spawn.

1. **Memory search** — `mcp__moflo__memory_search — query: "code quality patterns", namespace: "patterns"`
2. **Task create** — `TaskCreate — subject: "🔍 [Reviewer] Simplify changed code"`

## Phase 1: Identify the diff

```bash
git diff HEAD          # working tree
git diff main...HEAD   # committed since branch base
```

Treat the union as the diff. Note whether `/simplify` already ran on this branch in this session — if so, you are in a **validation pass** (Phase 4 below).

## Phase 2: Classify the diff

Pick the smallest tier the diff genuinely fits.

| Tier | Trigger | Action |
|------|---------|--------|
| **TRIVIAL** | ≤10 net LOC, single file, comments/formatting/local renames only | Self-review, zero agents |
| **SMALL** | ≤200 net LOC, ≤2 files, no API/dependency change | **One agent** (default for most diffs, including critical surface) |
| **NORMAL** | ≥3 files, OR >200 LOC, OR public API change, OR new/removed dependency, OR cross-cutting refactor | Three parallel agents |

Critical-surface files (launcher, hooks, MCP wiring) raise the *care* of the agent prompt — sharper checklist, blast-radius framing — they do **not** automatically escalate to NORMAL. Risk-weighted ≠ headcount-weighted.

## Phase 3: Route the model (skip for TRIVIAL)

Before spawning any Agent, ask the moflo router which model to use:

```
mcp__moflo__hooks_model-route — {
  task: "Review N-line change in <files> for reuse, quality, efficiency",
  preferCost: true
}
```

**Wording rules:** the router's complexity score is keyword-sensitive. Avoid `refactor`, `architect`, `audit`, `system`, `redesign`, `migrate` — those force opus even when scoring suggests sonnet. State LOC count, file count, and "review for reuse, quality, efficiency". Nothing more.

**Hard rule for `/simplify`: opus is never correct.** Code review never needs Opus reasoning, even on critical surface. If the router returns `opus`, downgrade to `sonnet`. On router failure, default to `sonnet`. Comment trims and pure formatting → `haiku`.

## Phase 4: Validation pass (re-run after fixes from a prior simplify)

If `/simplify` already ran on this branch in this session AND the only edits since are fixes the prior pass surfaced, **default to TRIVIAL self-review** regardless of LOC count. The fan-out happened; the fix is small relative to the already-reviewed diff.

Escalate one tier (self-review → SMALL agent) only if the fix introduced a new file, a new exported symbol, a new dependency, or a control-flow change not covered by the original findings. Never escalate a validation pass to NORMAL.

## Phase 5: Run the appropriate review

### TRIVIAL / Validation
Run the three category checks (reuse / quality / efficiency) yourself in one pass against the diff. Most TRIVIAL diffs are clean — confirm and exit. Budget: ~30 seconds, no Agent.

### SMALL — one agent
```
Agent — {
  subagent_type: "reviewer",
  model: "<sonnet (or haiku for trivial-formatting tier from router)>",
  prompt: "FIRST ACTION: Run mcp__moflo__memory_search with query 'code review patterns' and namespace 'patterns' to satisfy the memory-first gate. THEN review this diff for reuse, quality, and efficiency. <diff inline>. Flag specific issues as file:line + 1-line description. Max 5 file reads. Under 200 words. Skip cosmetic style. Don't suggest cross-cutting refactors of code outside this diff."
}
```

For critical-surface files, prepend a 1-line risk note (e.g., "This is `bin/session-start-launcher.mjs` — runs in every consumer's session-start hot path; cross-platform + blast-radius matter."). One careful agent, not three.

### NORMAL — three parallel agents
Launch three agents in a single message, each at the routed model (typically sonnet). Each agent gets the SMALL-tier tool-budget cap.

- **Agent 1 (Reuse):** existing helpers/utilities that should be used; duplicated patterns; functions re-implementing something already in the codebase.
- **Agent 2 (Quality):** redundant state, parameter sprawl, copy-paste with variation, leaky abstractions, stringly-typed code, nested conditionals 3+ levels, unnecessary comments.
- **Agent 3 (Efficiency):** unnecessary work, missed concurrency, hot-path bloat, recurring no-op updates, TOCTOU existence checks, unbounded structures, over-broad reads.

Each agent prompt must start with `FIRST ACTION: mcp__moflo__memory_search ... namespace: "patterns"` — subagents must satisfy the memory-first gate independently before Glob/Grep/Read.

## Phase 6: Fix or skip

Aggregate findings. Fix each issue directly that's worth fixing. False positives or out-of-scope: note and skip without arguing.

If fixes were made, re-run tests to confirm nothing broke. If tests fail after a fix, revert it.

After fixes: the next `/simplify` invocation is a **validation pass** (Phase 4). Bundle related fixes into one batch so a single validation pass covers them — don't re-fan-out for cosmetic micro-corrections.

## Phase 7: Optional — record routing outcome

If you spawned an agent, feed back the outcome so the router learns:

```
mcp__moflo__hooks_model-outcome — { task: "...", model: "<chosen>", outcome: "success" | "failure" | "escalated" }
```

`escalated` only when a real miss happened that a higher tier would have caught — never used to retroactively justify opus.

## Briefly summarize

End with one or two sentences: which tier ran, which model, what was fixed (or "clean — no changes"). No headers, no bullets.
