---
name: flo-simplify
description: Review changed code for reuse, quality, and efficiency, then fix any issues found. Sizes review effort to the diff — trivial edits get a self-review, substantial edits get parallel agents. Renamed from /simplify to avoid collision with Claude Code's built-in simplify skill.
---

# /flo-simplify — Adaptive Code Review

Review changed code for reuse opportunities, quality issues, and efficiency improvements. **Effort scales with diff size and reuses prior context** — a 5-line comment trim doesn't get the same treatment as a 500-line refactor, and a re-run after fixing pass-1 findings doesn't re-pay for a fresh fan-out.

## Phase 1: Identify changes

Run `git diff HEAD` (working tree) and `git diff main...HEAD` (committed) to get the full set of changes since the branch diverged. If on `main` with uncommitted changes, just `git diff HEAD`.

Treat the union of staged + unstaged + committed-since-base as the diff to review.

Also note: was `/flo-simplify` already run on this branch in this session? If yes, you're in a **validation pass** (Phase 2.5 below) — most of the heavy lifting is done.

## Phase 2: Classify the diff (deterministic — call the classifier)

**Call the classifier first, follow its decision.** Do not eyeball the diff and pick a tier in prose — that's the failure mode that costs ~230K tokens per run on mechanical decompositions (issue #908). The classifier reads the same diff Claude would, applies the rules below, and returns a JSON dispatch decision:

```bash
node .claude/helpers/simplify-classify.cjs --base main
```

(In the moflo source repo, equivalent is `node bin/simplify-classify.cjs --base main`. The launcher syncs `bin/simplify-classify.cjs` → `.claude/helpers/simplify-classify.cjs` in consumer projects.)

Output:
```json
{
  "tier": "TRIVIAL" | "SMALL" | "NORMAL",
  "model": "sonnet",
  "agentCount": 0 | 1 | 3,
  "reasoning": ["..."],
  "stats": { "added": ..., "deleted": ..., "declAdded": ..., "declRemoved": ..., "netDecls": ..., "fileCount": ..., "securityHit": ... }
}
```

If `bin/simplify-classify.cjs` is missing (older moflo install), fall back to the prose rules below — but on a current install the classifier IS the source of truth. Default behavior: **single Sonnet agent** unless the diff signals genuinely warrant escalation.

Tier definitions the classifier encodes (for reference, not for re-derivation):

Pick the **smallest tier** the diff genuinely fits. When in doubt, escalate one step (not two).

### TRIVIAL — gate stamp, no review
The classifier already proved the diff is below the threshold where review provides value (≤10 net LOC, single file, no declaration/import/export changes, no removed guards). **Stamp the gate with one line of confirmation and exit immediately.** Do not walk the three-category check yourself — the classifier IS the review at this tier, and at the gate level the classifier-aware skip (`bin/gate.cjs:classifyForGateSkip`) often satisfies the gate without invoking this skill at all.

Examples that qualify: trimming a comment, fixing a typo in a log message, renaming a private helper, reformatting a single block.
Examples that DON'T qualify: changing an `if` condition, reordering function args, deleting a try/catch.

### SMALL — single agent, all three categories (DEFAULT for most diffs)
ALL of these must hold:
- ≤200 net LOC changed
- ≤2 files
- No structural changes (no new modules, no API additions/removals, no contract changes)

This is the default tier for **most real diffs**, including changes to critical surface (launcher, hooks, MCP wiring). Critical surface raises the *care* of the agent prompt (sharper checklist, blast-radius framing), not the *number* of agents.

Examples that qualify: extracting a constant, inlining a one-liner, swapping a `for` for a `forEach`, adding one early-return, refactoring a single function within a file, adding a cache fast-path inside an existing block.

### NORMAL — three parallel agents (high bar)
Reserved for **genuinely cross-cutting** changes that single-agent review can't cover. The classifier escalates to NORMAL only when ANY of:
- `>500 LOC changed` (real volume, not just "more than 200")
- `5+ files AND ≥3 net new declarations` (broad new surface, not relocation)
- `security-sensitive path AND netDecls > 0` (aidefence/, swarm/consensus/, hooks gate, daemon-lock, launcher — only when adding logic, not on a 1-line touch)
- `3+ new files AND ≥5 new declarations` (genuinely new subsystem)

**Mechanical relocation is NOT NORMAL** even with many files / many lines. If `declAdded` and `declRemoved` are both ≥2 and `netDecls` is small (within 30% of total declarations touched), it's a structural move — SMALL, single agent. This is the #906/#908 case: ~330 LOC across 6 files of pure decomposition was costing 230K tokens via three-agent fan-out when it needed one Sonnet agent.

Three agents exist to cover orthogonal axes (Reuse / Quality / Efficiency) when the change is broad enough that one agent's tool-call budget can't survey it all. For single-file edits, one focused agent always covers all three axes — three is duplication, not coverage.

## Phase 2.5: Validation pass (re-run after fixes)

If `/flo-simplify` already ran on this branch in this session AND the only edits since are fixes driven by the prior pass's findings, default to **self-review tier** regardless of LOC count. The fan-out already happened; the fix is small relative to the diff that was already reviewed.

Escalate one tier (self-review → SMALL agent) only if the fix introduced any of:
- A new file
- A new exported symbol
- A new dependency or import from a previously-untouched module
- A change to control flow not covered in the original findings

Do **not** escalate to NORMAL on a validation pass. If the fix is so structural that NORMAL is warranted, treat it as a fresh diff and start over from Phase 1.

## Phase 2.7: Model selection

**Use the model the classifier returned.** The classifier IS the router for this skill — no separate router call needed. Possible outputs:

- `sonnet` (default) — real logic changes, single agent or three-agent fan-out.
- `haiku` — mostly-relocation diffs (mechanical moves where pattern-matching beats deep reasoning, ~5x cheaper).
- `opus` — never. Code review is breadth-bound, not depth-bound; the three-agent fan-out at sonnet is the high-effort tier.

If you fell back to prose rules in Phase 2 (no classifier available), use `sonnet` unconditionally. Pass the classifier's `model` field verbatim to Agent's `model` parameter.

## Phase 3: Run the appropriate review

### TRIVIAL: stamp and exit
The classifier proved the diff is below the review-value threshold. Print one confirmation line (e.g. `simplify: TRIVIAL — N LOC, 1 file — stamped`) and exit. **Do not** walk the three-category check; the classifier already concluded the answer is "clean." Budget: <5 seconds, no Agent calls.

### Validation pass: confirm clean
Run the three category checks (reuse / quality / efficiency) yourself, in one pass, against the post-fix diff. Most validation passes are clean — the goal is to confirm fixes didn't introduce new concerns, not to fan out. Budget: ~30 seconds, no Agent calls.

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

After fixes: the next `/flo-simplify` invocation is a **validation pass** (Phase 2.5). Do not re-fan-out unless the fix added genuinely new concerns — bundle related fixes into one batch so a single validation pass covers them.

## Phase 5: Stamp the gate

Whatever tier ran, the gate (`check-before-pr`) registers /flo-simplify as having executed. The skill is satisfied. Self-review counts.

## Briefly summarize

End with one or two sentences: which tier ran, what was fixed (or "clean — no changes"). No headers, no bullets unless needed.
