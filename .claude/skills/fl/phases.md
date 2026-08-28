# Workflow Phases

Phase-by-phase notes for the full `/flo <issue>` run. Phase 2 (Ticket) lives in `./ticket.md`.

## Phase 0: Record run start (Flo Runs dashboard)

Before research, open a run record so the Luminarium "Flo Runs" tab shows this run live and after the next session restart, and so Phase 5.5 can price it. Skip this phase ONLY when `--epic-branch` is set — the epic orchestrator owns the parent record and the per-story spell engine writes its own row.

One command. It builds the record, derives the run id, and picks up the session id `gate.cjs` stamped on this prompt:

```bash
flo runs start --issue <n> --title "<issue title>" --exec-mode <normal|swarm|hive>
```

Flag the mode when it isn't a plain ticket run: `--research` (`-r`), `--new-ticket --title "<t>"` (`-t` with no issue yet), `--epic`, or `--spell <name>` (`-wf`). It prints one JSON line — **remember the `runId` for Phase 5.5**:

```
[INFO] {"runId":"flo-1333-1785891035226","startedAt":1785891035226,"sessionId":"52d160f9-…"}
```

`sessionId: null` means no session id was stamped (the gate has not seen a prompt yet, or you are outside Claude Code). The run still records; only its token cost will be unmeasurable.

Do **not** hand-write a `memory_store` call for this. The record shape lives in `storeFloRunRecord` (`src/cli/services/daemon-dashboard.ts`) and `flo runs start` is its only caller — it replaced a copy of the schema that once lived here in prose, which produced exactly one record across the whole retained corpus because it depended on remembering to perform it.

The session-start launcher retains the most recent ~200 tasklist rows, so this record outlives the session and renders in the Flo Runs tab on subsequent restarts.

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

### 1.4 Reach guidance via memory (only if memory was thin)
If the §1.3 search above (the memory-first step named `SKILL.md` Step 0) returned fewer than three relevant results, widen the query — **still through `mcp__moflo__memory_search` (namespace `guidance`)**, not a direct `Read` of `.claude/guidance/*.md`. Guidance docs are indexed; search returns the relevant chunk, and `mcp__moflo__memory_get_neighbors` traverses adjacent context far more cheaply than reading the whole doc (don't bulk-read `.claude/guidance/moflo-sdd.md` et al.). Angle the query by change type:
- Bug → testing patterns, error handling
- Feature → domain model, architecture
- UI → frontend patterns, components

Only the skill's own `./*.md` companion files (`sdd.md`, `phases.md`, …) are `Read` directly — they live under `.claude/skills/` and are not indexed.

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

Use `flo worktree add`. It computes the path, creates the branch off the repo's default
branch, and **provisions** the tree per the optional `worktree:` block in `moflo.yaml` — copying
gitignored `.env` material, linking `node_modules`, running a `setup` command. A fresh worktree is
otherwise a valid checkout and an unrunnable workspace. Do not hand-roll the path or shell
`git worktree add` directly: the path computation and the copy/link/setup steps are
platform-sensitive (Rule #1) and live in tested code.

```bash
cd "<repo-root>" && flo worktree add "<type>/<issue-number>-<short-desc>" --json
```

Bind the repo root to the call. `flo worktree` resolves the repo from its working directory, and in
Claude Code that resets between calls — run it from the wrong place and it silently targets a
different repository (`Not a registered worktree of this repo` on the good day, the wrong repo's
worktree on the bad one).

It prints one JSON object — read `path` from it:

```json
{"path":"/abs/path/to/repo-worktrees/type-123-slug","branch":"type/123-slug","index":0,"provisioned":true}
```

Then run **every** remaining phase (implement → tests → simplify → commit → PR) against that
`path`, and report it to the user.

**A bare `cd` does not stick.** In Claude Code the Bash working directory resets to the project root
after each call, so `cd <path>` in one call and `npm test` in the next runs the test in the WRONG
tree — the primary checkout — and everything looks fine until the PR contains no changes. Bind the
directory to each command instead:

- shell commands — put the `cd` in the *same* call: `cd "<path>" && npm test`
- git — prefer `git -C "<path>" status` over cd'ing at all
- file edits — use the absolute path under `<path>`; never a repo-relative one

**Fallback — `flo worktree` not available.** The command ships in the same package as this skill,
so normally they move together. They can still drift apart: a `flo` binary on PATH older than the
synced `.claude/skills/`, or a moflo source checkout whose change has not been published and
reinstalled yet. If the command errors with `Unknown command: worktree`, do NOT stop — create the
worktree the plain way and continue the run, noting to the user that provisioning was skipped:

```bash
git fetch origin
node -e "const p=require('path'),cp=require('child_process');const root=cp.execSync('git rev-parse --show-toplevel').toString().trim();const branch=process.argv[1];const dir=p.join(p.dirname(root),p.basename(root)+'-worktrees',branch.replace(/[\\/]/g,'-'));console.log(dir)" "<type>/<issue-number>-<short-desc>"
git worktree add -b "<type>/<issue-number>-<short-desc>" "<computed-path>" origin/main
```

The tree is then a valid checkout with no `node_modules` and no gitignored `.env` files — fine for a
typecheck-only ticket, and not for one that runs the app.

Notes:
- `--from <ref>` overrides the base ref (default: the repo's default branch via `origin/HEAD`).
- `provisioned: false` means a copy/link/setup step failed — the worktree is still a usable
  checkout. Surface the failing step to the user rather than silently continuing to run tests that
  will fail for want of a dependency.
- If the branch's worktree already exists (a prior run), `add` reuses it rather than deleting it.
- Leave the worktree in place after the PR — the user may want to inspect it. Clean up with
  `flo worktree remove "<branch>"` (it refuses a tree with uncommitted changes unless `--force`).
  `flo worktree list` shows every worktree and its provisioning state.

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

Closes #<issue-number>"
```

**No attribution trailer.** Do not add `Co-Authored-By:`, `Generated with …`, or any
other tool-attribution line to commits or PR bodies. This is the consumer's
repository and their git history is permanent — moflo does not sign their commits.

### 5.1b Verify-before-done (default; skipped only with `--no-verify`)
**Delegate to the `/verify` skill** — `Skill({ skill: "verify" })`, passing the issue number or spec slug. That skill owns the mechanics (locate acceptance criteria → reuse Phase 4's already-green tests, no double verify → map each criterion → run only uncovered checks → record the outcome). Don't restate them here or verify in prose — *invoking* `/verify` is what records the run and satisfies the `check-before-done` gate.

**When it runs:** by default (`verify_before_done` now defaults true) and always under `--sdd`; `--no-verify` skips it for one run. See `./sdd.md` for triggers and `.claude/skills/verify/SKILL.md` for how verification is performed.

### 5.2 Record a durable lesson — or declare there isn't one

**A run summary is not a learning.** What this run changed — files touched, the fix applied,
the decision taken for this ticket — is git history and belongs in the PR body. Writing it to
memory instead is audit exhaust: one ticket, one commit, applicable never again. `memory_search`
returns a **bounded** result set, so every such entry permanently displaces a reusable lesson
from every future search. That cost is retrieval quality, not disk.

Apply the **durability bar** — the same one `/meditate` uses:

> *Would this help a future session working on a **different** task?*

| Store it | Where | Skip it — it is not a lesson |
|----------|-------|------------------------------|
| A reusable pattern: "for X, do Y because Z" | `learnings` | "Fixed #<n> by editing `<file>`" → PR body |
| A trap: "W silently fails when V" | `learnings` | "Added tests for Z" → the test records itself |
| A decision + rationale future work must honor | `learnings` | "Ran tests, they passed" → the run records itself |
| A reusable code shape this repo should copy | `patterns` | Restating an existing CLAUDE.md / guidance rule |

Key the entry on the **symptom or rule**, not the ticket. A future session hits the symptom
without knowing the issue number, so a ticket-shaped key is unfindable exactly when it is needed.
(An incident narrative may carry the issue as provenance — `1145-daemon-port-collision-fix` — but
the searchable words must still be the symptom.) A real entry from this repo, abridged:

```
mcp__moflo__memory_store:
  key: "wal-defeats-db-mtime-as-change-signal"
  namespace: "learnings"
  value: "In WAL mode SQLite writes land in the -wal sidecar, so the .db file's mtime
          stops advancing on write. Any cache or staleness check keyed on db mtime
          silently never invalidates. Hash the schema+row count, or stat the -wal too."
  tags: ["sqlite", "caching", "gotcha"]
```

Note what makes it durable: it states a rule that holds beyond the ticket that discovered it,
and a future session hitting a stale-cache symptom finds it without knowing the issue existed.

**If this run taught nothing new, do not invent something.** Declare it and move on — the
`check-before-pr` gate accepts the declaration in place of a write:

```bash
node .claude/helpers/gate.cjs record-no-durable-lesson    # from the project root
```

(When the gate has already blocked, it prints this command with an absolute path — use that
verbatim and the cwd stops mattering.)

Most runs land here, and that is the expected outcome: a routine fix in a well-understood area
produces no transferable lesson. One real lesson beats five manufactured ones.

Either path satisfies the gate, and either way it happens before `gh pr create`, not after.
Note that when `/verify` ran (5.1b, the default), its verdict write has **already** satisfied
this gate — so reach for `memory_store` here only when you genuinely have a lesson, never to
unblock the PR.

### 5.3 Create the PR

**Close the task list first.** `TaskUpdate` every task this run opened to `completed`, or to `deleted` where it no longer applies; `check-before-pr` blocks `gh pr create` while any stay open, because a list that still reads *pending* over merged work is the user's only view of what shipped.

| Task state at PR time | Action |
|-----------------------|--------|
| Work finished | `TaskUpdate({ taskId: "<id>", status: "completed" })` |
| No longer applies | `TaskUpdate({ taskId: "<id>", status: "deleted" })` |
| Deliberately deferred past this PR | Run the acknowledgement command printed in the block message — it credits the gate and leaves the tasks open |

Never mark a task `completed` to clear the gate. Declaring the deferral takes one command and keeps the list true.

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

**Under `--sdd`:** when `sdd.embed_in_pr` is true (default), append the spec+plan to the PR body so the reasoning is reviewable in the PR even when specs stay local/gitignored. Run `flo sdd embed <slug>`, read its printed output from the tool result, and paste it as literal text at the end of the PR body — do **not** use shell command substitution (`$(...)`) or heredoc/`printf`, none of which are portable (Rule #1). The robust path on every OS: write the full body (summary + embed block) to a file with the Write tool, then `gh pr create --body-file <path>`. See `./sdd.md` step 7.

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

### 5.5 Close the run record

Close the record Phase 0 opened, using the `runId` it printed. This is what snapshots the run's token cost — `finalize` reads the session transcript for the run's window and stores the rollup **in the same record**, so cost and outcome finally share a key:

```bash
flo runs finalize --run-id <runId>            # or: --status failed --error "<summary>"
```

Run it after the PR is open (5.3) so the rollup covers the whole run. Skipped under `--epic-branch` along with Phase 0.

Snapshot rather than compute-on-read because Claude Code prunes `~/.claude/projects/**` — measured at roughly two days of history, so a cost joined at read time would be correct today and zero next week.

`tokens.transcripts: 0` in the stored record means the run's cost could **not** be measured (no transcript, or no session id was stamped), which is not the same as a run that cost nothing. `success` means the run reached a terminal state without reporting an error — it is not a verification that the work was correct, and nothing here should be described as one.

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
