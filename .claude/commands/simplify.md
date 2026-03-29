---
description: Review changed code for reuse, quality, and efficiency, then fix any issues found.
---

# /simplify — Gate-Compliant Code Review

Review all changed files for reuse opportunities, code quality, and efficiency improvements.

## Prerequisites (MANDATORY — do these FIRST)

1. **Memory search**: Search for relevant patterns before reviewing
```
mcp__moflo__memory_search — query: "code quality patterns", namespace: "patterns"
```

2. **Create task**: Track the simplification work
```
TaskCreate — subject: "🔍 [Reviewer] Simplify changed code", description: "Review changed files for reuse, quality, and efficiency"
```

## Execution

After prerequisites are satisfied, get the list of changed files:

```bash
git diff --name-only HEAD~1
```

Then launch 3 reviewer agents **in parallel** (single message, multiple Agent tool calls):

### Agent 1: Reuse Reviewer
```
Agent — name: "reuse-reviewer", prompt: "Review these changed files for code reuse opportunities. Look for: duplicated logic that could use existing utilities, patterns already solved elsewhere in the codebase, opportunities to extract shared helpers. Files: $CHANGED_FILES", subagent_type: "reviewer"
```

### Agent 2: Quality Reviewer
```
Agent — name: "quality-reviewer", prompt: "Review these changed files for code quality issues. Look for: unclear naming, overly complex logic, missing error handling at system boundaries, potential bugs, consistency with existing patterns. Files: $CHANGED_FILES", subagent_type: "reviewer"
```

### Agent 3: Efficiency Reviewer
```
Agent — name: "efficiency-reviewer", prompt: "Review these changed files for efficiency improvements. Look for: unnecessary allocations, O(n^2) where O(n) is possible, redundant operations, opportunities to batch or cache. Files: $CHANGED_FILES", subagent_type: "reviewer"
```

## Post-Review

1. Collect findings from all 3 reviewers
2. Apply fixes that preserve ALL existing functionality — no behavior changes
3. If fixes were made, re-run tests to confirm nothing broke
4. If tests fail after fixes, revert the simplification changes
