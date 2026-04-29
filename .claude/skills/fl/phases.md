# Workflow Phases

Phase-by-phase notes for the full `/flo <issue>` run. Phase 2 (Ticket) lives in `./ticket.md`.

## Phase 1: Research (also `-r`)

### 1.1 Fetch the issue
```bash
gh issue view <issue-number> --json number,title,body,labels,state,assignees,comments,milestone
```

### 1.2 Check ticket status
Look for the `## Acceptance Criteria` heading in the body.
- Present → ticket already enhanced; skip ahead to execute.
- Absent → continue with research and enhance the ticket.

### 1.3 Search memory first
Search memory before reading guidance docs or scanning files. Memory often has the file paths, context, and patterns you need.

```bash
flo memory search --query "<issue title keywords>" --namespace patterns
flo memory search --query "<domain keywords>" --namespace guidance
```

Or via MCP: `mcp__moflo__memory_search`.

### 1.4 Read guidance docs (only if memory was thin)
If memory returned fewer than three relevant results, read guidance:
- Bug → testing patterns, error handling
- Feature → domain model, architecture
- UI → frontend patterns, components

### 1.5 Survey the codebase
Use the Task tool with the Explore agent to find:
- Affected files and their current state
- Related code and dependencies
- Existing patterns to follow
- Test coverage gaps

## Phase 3: Execute

### 3.1 Assign the issue and mark in-progress
```bash
gh issue edit <issue-number> --add-assignee @me
gh issue edit <issue-number> --add-label "in-progress"
```

### 3.2 Create the branch

If `--epic-branch <branch>` is set, the epic orchestrator already created and checked out the shared branch. Just confirm:
```bash
git branch --show-current  # should match the epic branch name
```

Otherwise:
```bash
git checkout main && git pull origin main
git checkout -b <type>/<issue-number>-<short-desc>
```
Types: `feature/`, `fix/`, `refactor/`, `docs/`.

### 3.3 Implement
Follow the plan from the ticket.

## Phase 4: Tests

Run unit, integration, and E2E tests appropriate for the change. Follow the project's existing style and runner. If the project has no tests yet, pick what fits the language and stack and stays compatible with existing dependencies.

If tests fail, enter the auto-fix loop (max 3 retries or 10 minutes):
1. Run tests.
2. If all pass → continue to simplify.
3. If any fail, analyze, fix, retry.
4. If retries are exhausted, stop and report.

The `check-before-pr` gate blocks `gh pr create` until a recognised test runner has executed since the last code edit. The bash heuristic recognises `npm/yarn/pnpm test`, `vitest`, `jest`, `pytest`, `mocha`, `cargo test`, `go test`, and similar.

## Phase 4.5: Simplify

The built-in `/simplify` command reviews changed code for reuse, quality, and efficiency, preserving behavior.

If `/simplify` edits anything, rerun the tests. If those re-tests fail, revert the simplification and continue with the original code.

The `check-before-pr` gate blocks `gh pr create` until `/simplify` has run since the last code edit.

## Phase 5: Commit and PR

### 5.1 Commit
```bash
git add <specific files>
git commit -m "type(scope): description

Closes #<issue-number>

Co-Authored-By: moflo <noreply@motailz.com>"
```

### 5.2 Store learnings
Before opening the PR, call `mcp__moflo__memory_store` with what was learned. The `check-before-pr` gate blocks `gh pr create` until this has run.

```
mcp__moflo__memory_store:
  key: "pattern:<topic>"
  namespace: "patterns"
  value: "<files changed, patterns used, decisions made>"
  tags: ["<relevant-tags>"]
```

This step happens before `gh pr create`, not after.

### 5.3 Create the PR

In epic mode (`--epic-branch` set): skip the PR. The commit from 5.1 (with `Closes #<issue-number>`) is enough; the epic orchestrator handles the consolidated PR and final push. Skip pushing too.

Otherwise:
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

### 5.4 Update issue status
```bash
gh issue edit <issue-number> --remove-label "in-progress" --add-label "ready-for-review"
gh issue comment <issue-number> --body "PR created: <pr-url>"
```
