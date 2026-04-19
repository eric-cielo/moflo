# Workflow Phases

Core phase-by-phase instructions for the full `/flo <issue>` run. Phase 2 (Ticket) lives in `./ticket.md`.

## Phase 1: Research (-r or default first step)

### 1.1 Fetch Issue Details
```bash
gh issue view <issue-number> --json number,title,body,labels,state,assignees,comments,milestone
```

### 1.2 Check Ticket Status
Look for `## Acceptance Criteria` marker in issue body.
- **If present**: Ticket already enhanced, skip to execute or confirm
- **If absent**: Proceed with research and ticket update

### 1.3 Search Memory FIRST
ALWAYS search memory BEFORE reading guidance or docs files.
Memory has file paths, context, and patterns - often all you need.
Only read guidance files if memory search returns zero relevant results.

```bash
flo memory search --query "<issue title keywords>" --namespace patterns
flo memory search --query "<domain keywords>" --namespace guidance
```

Or via MCP: `mcp__moflo__memory_search`

### 1.4 Read Guidance Docs (ONLY if memory insufficient)
**Only if memory search returned < 3 relevant results**, read guidance files:
- Bug -> testing patterns, error handling
- Feature -> domain model, architecture
- UI -> frontend patterns, components

### 1.5 Research Codebase
Use Task tool with Explore agent to find:
- Affected files and their current state
- Related code and dependencies
- Existing patterns to follow
- Test coverage gaps

## Phase 3: Execute (default, runs automatically after ticket)

### 3.1 Assign Issue and Update Status
```bash
gh issue edit <issue-number> --add-assignee @me
gh issue edit <issue-number> --add-label "in-progress"
```

### 3.2 Create Branch

**If `--epic-branch <branch>` was passed** (epic mode):
Skip branch creation entirely. The epic orchestrator has already created and checked out the shared epic branch. Just verify you're on it:
```bash
git branch --show-current  # Should match the epic branch name
```

**Otherwise** (normal mode):
```bash
git checkout main && git pull origin main
git checkout -b <type>/<issue-number>-<short-desc>
```
Types: `feature/`, `fix/`, `refactor/`, `docs/`

### 3.3 Implement
Follow the implementation plan from the ticket. No prompts - execute all steps.

## Phase 4: Testing (MANDATORY GATE)

This is NOT optional. ALL applicable test types must pass for the change type.
WORKFLOW STOPS HERE until tests pass. No shortcuts. No exceptions.

### 4.1 Write and Run Tests
Write unit, integration, and E2E tests as appropriate for the change type.
Follow the project's established test style, runner, and patterns. If no existing tests or test guidance is present, choose the best options for the project's language and stack, taking compatibility with existing dependencies into account.

### 4.2 Test Auto-Fix Loop
If any tests fail, enter the auto-fix loop (max 3 retries OR 10 minutes):
1. Run all tests
2. If ALL pass -> proceed to simplification
3. If ANY fail: analyze failure, fix test or implementation code, retry
4. If retries exhausted -> STOP and report to user

## Phase 4.5: Code Simplification (MANDATORY)

The built-in /simplify command reviews ALL changed code for:
- Reuse opportunities and code quality
- Efficiency improvements
- Consistency with existing codebase patterns
- Preserves ALL functionality - no behavior changes

If /simplify makes changes -> re-run tests to confirm nothing broke.
If re-tests fail -> revert changes, proceed with original code.

## Phase 5: Commit and PR (only after tests pass)

### 5.1 Commit
```bash
git add <specific files>
git commit -m "type(scope): description

Closes #<issue-number>

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### 5.2 Store Learnings (REQUIRED — gate blocks PR creation until this runs)

Before creating a PR, store what was learned using `mcp__moflo__memory_store`.
The `check-before-pr` gate will **block** `gh pr create` if this step is skipped.

```
mcp__moflo__memory_store:
  key: "pattern:<topic>"
  namespace: "patterns"
  value: "<what was learned: files changed, patterns used, decisions made>"
  tags: ["<relevant-tags>"]
```

This must happen BEFORE `gh pr create` — not after.

### 5.3 Create PR

**If `--epic-branch` was passed** (epic mode):
**SKIP PR creation entirely.** The commit from 5.1 (with `Closes #<issue-number>`) is sufficient.
The epic orchestrator will create a single consolidated PR after all stories complete.
Also skip pushing — the epic orchestrator handles the final push.

Proceed directly to 5.4 (update issue status only).

**Otherwise** (normal mode):
```bash
git push -u origin <branch-name>
gh pr create --title "type(scope): description" --body "## Summary
<brief description>

## Changes
<bullet list>

## Testing
- [x] Unit tests pass
- [x] Integration tests pass
- [x] E2E tests pass
- [ ] Manual testing done

Closes #<issue-number>"
```

### 5.4 Update Issue Status
```bash
gh issue edit <issue-number> --remove-label "in-progress" --add-label "ready-for-review"
gh issue comment <issue-number> --body "PR created: <pr-url>"
```
