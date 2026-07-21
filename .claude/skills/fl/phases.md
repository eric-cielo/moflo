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

Otherwise, **without** `--worktree`:
```bash
git checkout main && git pull origin main
git checkout -b <type>/<issue-number>-<short-desc>
```
Types: `feature/`, `fix/`, `refactor/`, `docs/`.

#### With `--worktree` (`-w` / `-wt`) — isolate the run in a fresh worktree

When the worktree flag is set, create the branch **in a new git worktree** and do all
implementation, tests, simplify, commit, and PR from inside it. The current checkout is left
untouched. Durable learnings still converge automatically — a worktree shares the repo's
`<git-common-dir>/moflo/durable.db` (see `/memory-worktree`).

Compute paths with Node, never string-concatenate — the branch name contains `/`, and the
worktree dir must sit **outside** the checkout on every OS (Rule #1: no hardcoded separators,
no `/tmp`, no `mkdir -p`):

```bash
# 1. Fresh base — update main in the current checkout first (worktrees share objects).
git fetch origin main

# 2. Resolve a sibling worktree path: <repo-parent>/<repo>-worktrees/<slugged-branch>
#    Slug the branch's "/" to "-" so the dir is flat and valid on Windows/macOS/Linux.
node -e "const p=require('path'),cp=require('child_process');const root=cp.execSync('git rev-parse --show-toplevel').toString().trim();const branch=process.argv[1];const slug=branch.replace(/[\\\\/]/g,'-');const dir=p.join(p.dirname(root),p.basename(root)+'-worktrees',slug);console.log(dir)" "<type>/<issue-number>-<short-desc>"

# 3. Create the worktree + branch off origin/main in one step (the printed path from step 2).
git worktree add -b <type>/<issue-number>-<short-desc> "<computed-path>" origin/main
```

Then `cd "<computed-path>"` and run **every** remaining phase (implement → tests → simplify →
commit → PR) from there. Report the worktree path to the user. Leave the worktree in place
after the PR — the user may want to inspect it; note that `git worktree remove "<path>"` cleans
it up when done.

If `git worktree add` fails because the path already exists (a prior run), reuse it:
`cd "<computed-path>" && git status` and continue, or pick a `-2` suffix — do not delete a dir
you did not just create.

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

### 5.1b Verify-before-done (default; skipped only with `--no-verify`)
**Delegate to the `/verify` skill** — `Skill({ skill: "verify" })`, passing the issue number or spec slug. That skill owns the mechanics (locate acceptance criteria → reuse Phase 4's already-green tests, no double verify → map each criterion → run only uncovered checks → record the outcome). Don't restate them here or verify in prose — *invoking* `/verify` is what records the run and satisfies the `check-before-done` gate.

**When it runs:** by default (`verify_before_done` now defaults true, #1294) and always under `--sdd`; `--no-verify` skips it for one run. See `./sdd.md` for triggers and `.claude/skills/verify/SKILL.md` for how verification is performed.

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

**Under `--sdd` (#1297):** when `sdd.embed_in_pr` is true (default), append the spec+plan to the PR body so the reasoning is reviewable in the PR even when specs stay local/gitignored. Run `flo sdd embed <slug>` and include its output at the end of the `--body`. For large specs, write the combined body to a file and use `--body-file <path>` (Rule #1 — no heredoc/`printf`). See `./sdd.md` step 7.

### 5.4 Update issue status
```bash
gh issue edit <issue-number> --remove-label "in-progress" --add-label "ready-for-review"
gh issue comment <issue-number> --body "PR created: <pr-url>"
```

If the story body carries an `Epic: #<n>` back-reference (decomposition writes it — `./ticket.md`) **and** `--epic-branch` is not set, sync the parent epic — check this story's box off and close the epic if it was the last:

```bash
flo epic checkoff <epic-number> <story-number>
```

Idempotent and safe to skip when there is no back-reference. `--epic-branch` runs skip it — the epic orchestrator owns checklist state there. The box flips when the work is delivered (PR opened), matching the orchestrator; if a PR is later rejected, reopen the epic manually.

### 5.3b Auto-merge the PR (`mergeMode` / `merge.auto`)

Runs only in **full** workflow mode, only when `mergeMode` is true, and only **after** the PR is open (5.3) and issue status is updated (5.4). Skipped entirely under `--epic-branch` and in `-t`/`-r` (the parser already cleared `mergeMode` there). Because it runs after `gh pr create`, every quality gate (tests, simplify, learnings, verify) has already passed — auto-merge never bypasses them.

**Never merge on red or unknown checks.** Only merge when required checks are affirmatively `SUCCESS` and the state is `MERGEABLE`/`CLEAN`. A green exit code is not proof (see the gotcha below).

Order of preference:

**1. GitHub native auto-merge (preferred).** If the repo allows it, queue the merge and let GitHub land it when required checks + reviews pass — no local polling:
```bash
# Is "Allow auto-merge" enabled on the repo?
gh repo view --json autoMergeAllowed --jq .autoMergeAllowed   # true | false
# If true:
gh pr merge <n> --auto --squash --delete-branch
```
`--auto` is not `--admin` and is not subject to the classifier denial below. If `autoMergeAllowed` is false or `gh` reports auto-merge is unavailable, fall through to (2).

**2. Poll-then-merge fallback.** Await preconditions locally, then merge. Do **not** rely on `gh pr checks --watch`'s exit code — inspect the rollup explicitly:
```bash
gh pr view <n> --json statusCheckRollup,mergeStateStatus,mergeable,reviewDecision,isDraft
```
Merge only when: every **required** entry in `statusCheckRollup` is `SUCCESS` (or `NEUTRAL`/`SKIPPED`), `mergeable == "MERGEABLE"`, `mergeStateStatus` is `CLEAN` (or `UNSTABLE` solely from non-required checks), and `isDraft == false`. Re-query on an interval until preconditions hold or a sensible cap elapses (a handful of checks over a few minutes; surface a timeout rather than looping forever). Use a Node timer or `gh ... --watch` for the wait — **never a bash-only `sleep` loop** (Rule #1: not on Windows). Then:
```bash
gh pr merge <n> --squash --delete-branch
```

**3. Admin override (review-required — auto-attempt, then hand off).** If the *only* remaining blocker is `reviewDecision == "REVIEW_REQUIRED"` on a repo the actor administers (e.g. a solo repo where GitHub blocks self-approval), an admin squash-merge is the sole path to land the PR — so under `mergeMode` **attempt it automatically** rather than stopping at a manual command:
```bash
gh pr merge <n> --squash --admin --delete-branch
```
**Precondition — re-confirm green first.** Before the `--admin` call, re-confirm checks are affirmatively green per the (2) rollup rule — `--admin` bypasses branch protection, so never `--admin` over a red or unknown X (learning `ci-watch-exit-code-not-proof-of-green`). Admin-attempt is scoped to the review-required case only; never `--admin` to skip a failing or pending required check.

**Fallback if denied — hand off, don't loop.** The Claude Code auto-mode permission classifier may DENY an unattended `gh pr merge --admin` (headless/cron runs especially). If the call is denied, do **not** silently swallow it or retry in a loop — surface a copy-paste command for the user and stop:
> Admin merge is required (review-required on an administered repo) but was blocked by the permission classifier. Run it manually:
> `! gh pr merge <n> --squash --admin --delete-branch`

On a successful merge the branch is deleted (`--delete-branch`) and the `Closes #<n>` reference auto-closes the issue. If merge does not complete (timeout, denied admin, red checks), leave the PR open, report why, and continue to 5.5 — a stuck merge is not a failed run.

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
