# Workflow Phases

Phase-by-phase notes for the full `/flo <issue>` run. Phase 2 (Ticket) lives in `./ticket.md`.

## Phase 0: Record run start (Flo Runs dashboard)

Before research, write a row to the `tasklist` namespace so the Luminarium "Flo Runs" tab shows this run live and after the next session restart (#968). Skip this phase ONLY when `--epic-branch` is set — the epic orchestrator owns the parent record and the per-story spell engine writes its own row.

Compute and **remember** for Phase 5:
- `runId` — `flo-<issue-number-or-"new">-<startedAt-ms>` (sortable, unique).
- `startedAt` — `Date.now()` snapshot (ms since epoch).

Pick the matching `context.type`:
| Mode | type | label format |
|------|------|--------------|
| Full / ticket on existing issue | `ticket` | `#<n> — <title>` |
| `-r` research | `research` | `#<n> — Research` |
| `-t` with title (no issue # yet) | `new-ticket` | `New: <title>` |
| Epic detected | `epic` | `Epic #<n> — <title> (0/<total> stories)` |
| `-wf <spell>` | `spell` | `<spell-name> → <args>` |

Then call once:

```
mcp__moflo__memory_store
  namespace: "tasklist"
  key: "<runId>"
  upsert: true
  value: {
    "status": "running",
    "context": {
      "type": "<ticket|research|new-ticket|epic|spell>",
      "label": "<computed label>",
      "issueNumber": <n | omit>,
      "issueTitle": "<title | omit>",
      "execMode": "<normal|swarm|hive>"
    },
    "spellName": "<same as label>",
    "startedAt": <startedAt>,
    "updatedAt": "<new Date().toISOString()>"
  }
```

The schema mirrors `storeFloRunRecord` in `src/cli/services/daemon-dashboard.ts` — keep it in sync if you ever change one. The session-start launcher retains the most recent ~200 tasklist rows so this record outlives the session and renders in the Flo Runs tab on subsequent restarts.

## Phase 1: Research (also `-r`)

### 1.1 Fetch the issue + history (cheap, before any file exploration)

Run these BEFORE any `Glob` / `Grep` / `Read` of source files. The goal is to catch "this is already (partially) fixed" in two commands rather than 10K tokens of file scanning.

```bash
# Issue + closing PRs (one call, one new field vs. before).
gh issue view <issue-number> --json number,title,body,labels,state,assignees,comments,milestone,closedByPullRequestsReferences

# Commits that reference the issue. Silently no-ops outside a git work tree —
# consumers without git, fresh `npx moflo` shells, non-git VCS all skip cleanly.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git log --all --grep="\b<issue-number>\b\|#<issue-number>" --oneline -30 || true
fi
```

**Surface what you find and proceed — never pause to ask.** `/flo` is fire-and-forget; a prompt that blocks for 30 minutes waiting on a yes/no is a worse failure than re-doing already-shipped work. Specifically:

- **Issue is CLOSED with non-empty `closedByPullRequestsReferences`** → read the closing PR body and merge commit as primary context. Treat the run as "look for any remaining work or follow-up" and continue. Do not stop.
- **Commits reference the issue but it's still open** → those are partial fixes. Summarise them in one line (`partial fix already shipped: <sha> <subject>`), then `git show <sha>` if you need the diff, scope the implementation around what's still missing, and continue. Do not stop.
- **No history found / scan skipped** → proceed silently to memory + code exploration as before.

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

The `/flo-simplify` skill reviews changed code for reuse, quality, and efficiency, preserving behavior.

If `/flo-simplify` edits anything, rerun the tests. If those re-tests fail, revert the simplification and continue with the original code.

The `check-before-pr` gate blocks `gh pr create` until `/flo-simplify` has run since the last code edit.

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

### 5.5 Finalize run record (Flo Runs dashboard)

Update the tasklist row written in Phase 0 with the terminal status. Same `runId`, `upsert: true`. On success:

```
mcp__moflo__memory_store
  namespace: "tasklist"
  key: "<runId>"          # same key from Phase 0
  upsert: true
  value: {
    "status": "completed",
    "success": true,
    "context": <same context object as Phase 0>,
    "spellName": "<same label as Phase 0>",
    "startedAt": <startedAt from Phase 0>,
    "duration": <Date.now() - startedAt>,
    "updatedAt": "<new Date().toISOString()>"
  }
```

On failure (tests still red after retries, or any aborting error): same shape with `"status": "failed"`, `"success": false`, and an `"error": "<short summary>"` field.

This finalize call MUST also fire if the run aborts *before* reaching Phase 5 (early failure during research, ticket, or implement) — otherwise the dashboard shows a permanently "running" row for a dead run.

Skip this when `--epic-branch` is set — the epic orchestrator records its own outcome.
