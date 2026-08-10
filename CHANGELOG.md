# Changelog

All notable changes to MoFlo are documented here. Pre-2026-03 entries below describe Claude Flow → Ruflo releases from before MoFlo forked off; they're preserved for historical context.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed — task lists shipped stale, and the reminder that was supposed to catch it was invisible (#1435)

A `/flo` run on a consumer project created four tasks, completed all four items of work, verified,
committed, and shipped a green PR with `TaskUpdate` called **zero** times. All four tasks ended the
run at `pending`. #1374 had already added the check that was supposed to catch exactly this.

It was running. It just could not be heard. The open-task count is written to **stdout**, and
`check-before-pr` exits 0 when the other gates pass — and Claude Code surfaces a passing
PreToolUse hook's stdout in transcript mode only. The model never sees it, and the user sees it
only by opening the transcript. It reached anyone at all only when some *other* gate blocked, because
`gate-hook.mjs` re-routes a failed gate's stdout to stderr. So the closing half of #1374 fired
solely on runs that had already been stopped for another reason, and was a no-op on every clean one.

Both halves are fixed:

- **Passing-gate advisories now reach Claude.** `gate-hook.mjs` emits exit-0 stdout on `PreToolUse`
  and `PostToolUse` as `hookSpecificOutput.additionalContext`, the documented channel into the
  model's context. This repairs every advisory on that path, not just this one — the TaskCreate
  reminder, the pre-Agent memory reminder, the namespace hint, and the docs-only / simplify-auto-pass
  notes were all equally unheard. `SessionStart` and `UserPromptSubmit` already inject their stdout
  as context and are deliberately untouched.
- **Open tasks now block the PR.** New `gates.task_status_gate`: `block` (default), `warn` (the old
  report-only behaviour, now actually delivered), or `off`. Deliberate deferrals stay legitimate —
  the block prints `node "<abs path>/.claude/helpers/gate.cjs" record-tasks-acknowledged`, which
  credits the gate without closing anything, so the honest outcome costs one command and no task is
  ever marked `completed` to clear a gate. The gate stays subordinate to `task_create_first`, so a
  project that turned the nag off is not blocked about the other end of it, and it fails **open**:
  a missing, oversized, or unreadable transcript, or a session with no `TaskCreate` at all, blocks
  nothing.

**Consumer impact.** After upgrading, a session that opens tasks and leaves them open will be stopped
at `gh pr create` until they are closed, deleted, or acknowledged. Set `gates: task_status_gate: warn`
to keep report-only behaviour, or `off` to silence it.

### Fixed — the learnings gate manufactured filler instead of lessons (#1434)

`check-before-pr` blocked `gh pr create` until some `memory_store` had run, and credited any write
regardless of namespace or content. That made a memory write mandatory once per `/flo` run whether
or not the run had learned anything. When it hadn't, the run wrote a summary of itself — audit
exhaust: one ticket, one commit, applicable never again. Because `memory_search` returns a bounded
result set, every such entry permanently displaced a reusable lesson from every future search. The
cost was retrieval quality, not disk.

The namespace was the least of it. `/flo` Phase 5.2 was headed *"Store learnings"* and told the
agent to record *"what was learned"*, while its worked example filled the value with
`"<files changed, patterns used, decisions made>"` — a description of the run. The block message
(*"learnings have not been stored (call memory_store)"*) named a mechanism and no quality bar. And
with nothing durable to say, no honest path existed: inventing something was the only route to the
PR. A mandatory write with nothing to say produces filler by construction.

So the mandate is gone rather than re-homed. A run that learned nothing declares it —
`node .claude/helpers/gate.cjs record-no-durable-lesson` credits the gate with no write at all — and
the block message now states the bar (*would this help a future session working on a **different**
task?*), names that escape, and points run narration at the PR body where it belongs. Phase 5.2 and
the shipped agent rules carry the same bar, and Phase 5.2's example is now a real durable lesson
instead of a template describing the run. Note that on a default run `/verify`'s verdict write
already satisfied this gate, so the prescribed second write was redundant besides.

Run records were never the problem and keep their existing home in `flo runs`. Consumers pick this
up on upgrade; no migration, and existing `learnings` entries are left alone.

### Fixed — the post-upgrade badge outlived the upgrade, and `flo status` denied working installs (#1363)

Two unrelated defects, both cases of moflo misreporting its own state.

The statusline kept showing the upgrade badge — often with the `(updating…)`
suffix — for minutes after an upgrade finished. The TTL check itself was correct;
the problem was where completion got recorded. The flip to `completed` ran at the
very end of the launcher's stage 3, past every best-effort stage including the
memory re-index that advertises 30-60 s. The SessionStart hook budget is 5 s, so on
a slow upgrade the launcher was killed before reaching it, the notice stayed
`in-progress`, and the badge advertised work nothing was doing for the full 5-minute
in-progress TTL. Completion now rides with the version-stamp commit — the point
where the upgrade has functionally landed — so a kill during the tail leaves a
truthful terminal badge. A run that dies *before* that point keeps `in-progress` on
purpose, and the statusline now reports it as `upgrade interrupted (run /healer)`
rather than implying progress. `repair` notices are untouched: the bootstrap
sentinel deliberately holds one open to keep the healer prompt visible.

One thing this does not change: the statusline evaluates its TTL only when Claude
Code invokes it, and Claude Code repaints on activity rather than on a timer. A
correct badge still persists on screen through an idle session. What's fixed is
*which* badge gets frozen there.

Separately, `flo status` and `flo start` reported *"MoFlo is not initialized in this
directory"* on installs with a healthy `.moflo/`, a running daemon, and a live MCP
server. Both gated solely on `.moflo/config.yaml`, which `flo init` writes only
under `components.runtime` — so any consumer who initialized with a component subset
was turned away by two commands over an optional file nothing else reads. They now
share one predicate that accepts any genuine init marker.

Consumers pick both up on upgrade. No migration, and `.moflo/` state keeps its shape
— `upgrade-notice.json` is unchanged, only when it is written and how it renders.

### Fixed — the verify and simplify gates invalidated each other before a PR (#1348)

Opening a PR needs both `/flo-simplify` and `/verify` to have run, and satisfying
one could clear the other. Every individual block was correct, so the loop was
invisible from any single message; the reporter escaped only by discovering an
undocumented ordering by trial.

Two mechanisms produced it. `reset-edit-gates` treated **any** `Write`/`Edit` as a
code edit — including a scratch probe under the OS temp dir, which can never reach
the branch diff — so a `/verify` run that jotted one cleared the `/flo-simplify`
stamp it had nothing to do with. And `record-verify-outcome` wrote its verdict
without checking the run was still live, so a store arriving after an edit-reset
produced the self-contradictory `verifyRun: false` beside `verifyOutcome: 'PASS'`,
a state `check-before-done`'s message chain has no branch for.

Now: writes under the OS temp dir and into moflo's own gitignored `.moflo/` state
directory no longer reset a gate (reusing the predicate the memory-first gate
already trusts for these paths, #1294); a verdict for an invalidated run is refused
with a stderr crumb instead of recorded; and both blocking gates print the working
order — tests → `/flo-simplify` → `/verify` → its `memory_store` verdict → PR —
rather than naming only whichever gate happens to be missing. The "ran but recorded
no verdict" branch also states that re-invoking `/verify` clears the prior verdict
(#1332, by design), which is why the obvious recovery used to land back in the same
place.

Consumers pick this up with the gate itself; no migration, and no `.moflo/` state
changes shape.

### Fixed — the TaskCreate reminder claimed to block, and shipped that claim (#1326)

`check-before-agent` printed *"Task tool is blocked until then"* on stdout with no
`process.exit(2)` behind it. Nothing was blocked. The same overstatement reached
every install through the CLAUDE.md block `flo init` injects, which filed the
advisory TaskCreate reminder under a heading reading *"Auto-enforced gates"*.

The correction is not "delete the word blocked": the same handler contains a real
hard block (#952 — an Agent spawn under `/fl -s|-h` before `swarm_init` /
`hive-mind_init` exits 2), and the comment above it still claimed *"agent spawning
is never blocked"*, predating that change. Message, comment, and behaviour
disagreed in three directions at once.

The reminder is now plain (`REMINDER: Use TaskCreate before spawning agents.`)
across all five copies, the comment describes what the handler actually does, and
the injected CLAUDE.md block distinguishes blocking gates from advisory ones in the
same four lines it used before — consumers get the correction automatically via the
#1142 injection-drift refresh, without re-running `flo init`.

A guard test pins the invariant to Claude Code's hook contract rather than to any
sentence: stderr + `exit 2` may claim to block, stdout may not, and any case
emitting blocking language must contain the exit that backs it.

### Fixed — a masked test failure satisfied the testing gate (#1322)

`record-test-run` set `testsRun = true` from the submitted command string alone,
never looking at what the run produced. `gate-hook.mjs` parsed the hook payload's
`tool_response` and then discarded it, so no gate could observe an outcome.

The exposure is narrower than it first appears, and the ticket was rewritten
around a probe rather than the original filing. Claude Code's PostToolUse hook
does not fire at all when a Bash command exits non-zero, so an ordinary red suite
already left the flag false — by accident of the hook lifecycle, not by design.
What did defeat the gate is a **masked** exit: `npm test | tail -20`,
`npm test || true`, `npm test 2>&1 | grep -i fail`. The pipeline exits 0,
PostToolUse fires with a clean-looking response, and a red suite credited the
gate.

`tool_response.stdout` / `.stderr` (tail-kept, bounded to 4 KB / 2 KB so the
Windows ~32 KB environment-block limit is never risked — runners print their
summary last) and `.interrupted` now reach `gate.cjs` as `TOOL_RESPONSE_*`. A
matched test command whose output carries a failure summary is not credited, and
**clears** a `testsRun` an earlier green run had earned.

There is no exit status anywhere in the payload, so this is output inspection,
not exit-code fidelity — a genuinely weaker signal, and the code says so. Only
summary shapes count (`2 failed`, `1 failing`, line-start `FAIL`/`FAILED`,
`--- FAIL:`, `test result: FAILED`, `npm ERR!`); a bare "fail" never does,
because it occurs constantly in ordinary passing test names. An explicit
`0 failed` does not match, and empty output still credits — a quiet green
`npm test > /dev/null` is indistinguishable from a silently-masked red one, so
absent stays unknown.

Also fixes pre-existing drift in the third copy of the bridge: `flo init` wrote
a `gate-hook.mjs` that never received #1332's structured-input forwarding and
still shelled out via `execSync` string concatenation, so consumers ran one
bridge after init and another after the next session start. The generator now
emits `bin/gate-hook.mjs` byte-for-byte, pinned by
`tests/guards/gate-hook-parity-guard.test.ts`.

### Fixed — Windows worker daemon had no CPU backpressure (#1358)

`os.loadavg()` is a Unix concept; Node documents it as always returning
`[0, 0, 0]` on Windows. `WorkerDaemon.canRunWorker()` gated dispatch on
`loadavg()[0] > maxCpuLoad`, and `maxCpuLoad` is validated `> 0`, so on Windows
that branch was unreachable — the daemon dispatched workers regardless of load
while still appearing to throttle, because the memory gate below it kept firing.

**Behaviour change for Windows consumers.** The CPU gate is now explicitly
skipped rather than accidentally satisfied, and the daemon logs one warn line
per run naming the platform and the threshold that is no longer being applied.
Memory backpressure is unchanged and still applies on every platform. Workers
that previously always dispatched may now defer under memory pressure with a
clearer reason attached.

Substituting `os.cpus()` tick deltas was considered and rejected: they measure
utilisation percentage where `maxCpuLoad` is run-queue depth (default
`cores * 0.8`, scaled against cgroup quotas by `getEffectiveCpuCount()`), so
feeding one into the other would silently re-scale every configured value.

Three reporting surfaces stop printing a fabricated `0.00` on Windows and emit
`null` / `not measured` instead — `flo performance metrics` (both text and
`--format json`), and the built-in `performance` and `health` workers.

The worker statusline's `⚡` segment now shows the load average the performance
worker actually measured (`⚡n/a` where there is none). It previously rendered
`⚡1.0x` from a `speedup` field that was the literal `'1.0x'` — nothing ever
computed a speedup. `StatuslineData.performance.speedup: string` is replaced by
`performance.loadAvg: string | null`; the shipped `statusline.cjs` never read
this shape, so consumer statuslines are unaffected.

### Removed — five MCP tools that fabricated their entire output (#1353)

**Breaking for anyone calling these five.** `github_repo_analyze`,
`github_pr_manage`, `github_issue_track`, `github_metrics`, and `neural_train`
are deleted; the advertised registry goes 127 → 122.

#1324/#1325 had labelled them with a synthetic-data notice, which was always a
holding position: a notice is a *description*, so an agent that has already
selected the tool and received `{"merged": true}` may never weight it. None of
these five had an honest half to keep. The four `github_*` tools made no GitHub
API call at all — they wrote local JSON and returned `Math.random()` counts, so
`merged` / `approved` described nothing that had happened — and `neural_train`
slept 100ms and persisted a random accuracy in [0.85, 0.95). `github-tools.ts`
is gone entirely, along with the tools' drift-guard ALLOWLIST entries: an
allowlist is for a tool that works and lacks a caller, not for keeping a
fabricating one registered.

**There is no replacement.** Use the `gh` CLI for GitHub work. If you called one
of these, the result you were given was invented — treat prior output as
unreliable rather than porting it forward.

### Fixed — three MCP tools that mixed real data with invented data (#1354)

Unlike the five above, these had a real half worth keeping, so the invented
fields were removed rather than the tool.

- **`system_health`** now probes. Every status but one was the literal
  `'healthy'` and every latency a `Math.random()` draw, so a failing component
  reported healthy. It calls `checkMemoryInitialization`, `getMCPServerStatus`,
  `getDaemonLockHolder` and `isSwarmCoordinatorInitialized`, times each, and
  reports what it observed. A dormant lazily-started component gets its own
  `not-running` status instead of counting as a failure, and `score` is `null`
  rather than `0` when nothing was judgeable. The `deep` and `fix` parameters —
  both accepted and ignored — are gone.
- **`neural_predict`** keeps the real embedding it always computed and drops
  `predictions`: a fixed label list with random confidences that ignored the
  input entirely.
- **`performance_report`** keeps the measured CPU/memory/heap and drops the
  seeded latency percentiles, the throughput counter that was counting calls to
  this tool, the literal `errors: 0`, and the hardcoded `status: 'healthy'`.

`neural_status.avgAccuracy` and the `accuracy` field on a returned model record
also go — `neural_train` was their only writer, so they could only ever average
the placeholders it had persisted.

### Fixed — 23 CLI subcommands called MCP tools that were never registered (#1352)

The failure was not uniform: 18 errored visibly, two swallowed the error and
reported SUCCESS for work never performed, and three left `flo status` rendering
a fabricated all-zeros fallback on every run.

19 handlers are now registered over infrastructure that already existed — the
wrapper had simply never been written (`coverage-router.ts` even carried a
section headed *"Additional Exports for MCP Tools (coverage-tools.ts)"* for a
file that did not exist): `progress_*`, `hooks_coverage-*`, `analyze_diff`,
`mcp_status`, `memory_export`/`import`/`cleanup`/`compress`/`detailed-stats`,
`session_current`/`export`/`import`, `task_retry`/`summary`, and
`hive-mind_task`. Four surfaces with no backing at all are removed instead:
`flo agent logs`, `flo hive-mind optimize-memory`, `flo hooks task-completed`,
`flo hooks teammate-idle`.

Found while verifying the above, each its own consumer-visible bug:

- `movector/{coverage-router,diff-classifier}.ts` used CommonJS `require()` in an
  ESM build, so every code path through them threw at runtime.
- `task_list` treated the `'all'` sentinel as a literal status, so
  `flo status tasks` reported none while `flo status` reported them.
- `memory_cleanup` deleted on the same call that counted candidates — declining
  *"Delete N entries?"* printed "cancelled" after the rows were already gone.
  Deletion is now opt-in via `apply: true`; the CLI counts, prompts, then
  applies. Its unusable-entry rule also keyed on `embedding IS NULL` with no age
  gate, which matched **every row** on a project whose embedding model never
  loaded; an explicit `--older-than` cutoff is now required.
- `progress_*` would have reported "28/28 commands, 419 files" in consumer
  projects with no `src/` at all, because `V3ProgressService` answers an
  unreadable tree with invented values. The handlers now refuse instead.

### Fixed — `flo config` wrote nothing, and the option parser made 45 flags unusable (#1346)

`flo config` had no filesystem import at all: `init` printed *"Creating
claude-flow.config.json…"*, a settings table, and `[OK] Configuration
initialized`, then returned success without writing anything. The healer's
`Config File` auto-fix took that exit code verbatim, so `--fix` reported
`applied: true` on every run while the warning never cleared.

Config now does real read/write through a new `.moflo/config.json` store shared
with the doctor check, so the two cannot disagree about whether a config exists.
The healer derives its verdict from the file existing rather than from an exit
code.

Verifying that fix surfaced the parser defects underneath it:

- A command option now **shadows** a same-named global instead of stacking with
  it. Stacking made all 45 collisions unsatisfiable — `--format yaml` had to
  satisfy both the command's choices and the global's, so it failed with the
  flag and without it. Unblocks `memory export --format csv`,
  `analyze boundaries --format dot`, `session export --format yaml`, and others.
- A global boolean redefined as value-taking is now parsed as value-taking.
  `plugins install pkg --version 1.2.3` came out as `version: true` with
  `'1.2.3'` stranded in positionals, which tripped the global `--version`
  handler: it printed the moflo version and exited without installing anything.
  Also affected `plugins upgrade` and `deployment deploy`/`rollback`.
- 63 options declared a default contradicting their own type (26 booleans as the
  truthy string `'false'`, 37 numbers as `'100'`). Dormant today, but they would
  flip flags like `--force` ON the moment default-application widens. Guarded.
- `embeddings chunk --file` was documented as the alternative to `--text` and
  carried its own example, but `--text` was `required` so the example died at the
  parser, and the action never read `ctx.flags.file` — it chunked the empty
  string. It now reads the file, normalizing CRLF so a Windows-authored document
  chunks identically to its POSIX twin.

Command defaults are applied **only** where they shadow a global. The general
"apply every command default" pass was deliberately not taken: 455 command
options declare defaults the parser has never applied, and enabling them
wholesale would change behaviour across the CLI.

### Security — three advisories resolved via lockfile refresh (#1350)

`hono` 4.12.27 → 4.13.0 (GHSA-8j4g-w8fx-2239), `brace-expansion` 5.0.8 → 5.0.9
(GHSA-rgw5-rvv9-x895), `postcss` 8.5.20 → 8.5.25. Every patched version already
satisfied its parent's existing range, so none of this needed an `overrides`
pin, a major bump, or an upstream release — the lockfile was simply pinned below
the fix.

`hono` is the only one that reaches consumers, transitively via
`@modelcontextprotocol/sdk`. `brace-expansion` arrives through eslint → minimatch
and `postcss` through vitest → vite, so both are dev-only. `npm audit` goes from
3 vulnerabilities (1 high, 2 moderate) to 0, both with and without `--omit=dev`.
`package.json` is untouched.

### Changed — Verify-before-done is now ON by default (#1294)

`gates.verify_before_done` now defaults to **true** (was opt-in/false). Every
`/flo` run now runs the verify-before-done step, delegating to the new `/verify`
skill, before `gh pr create`. `/flo` reuses its Tests phase rather than
re-running it (no double verify), so the added cost is the acceptance-criteria
mapping, not a second suite run. Docs-only diffs remain exempt, so a pure-docs
PR is never blocked.

- **Opt out** per project with `gates: verify_before_done: false` in
  `moflo.yaml`, or per run with `--no-verify`.
- **Migration (automatic, one-time):** on the first session-start after upgrade,
  moflo carries existing projects onto the new default:
  - No `gates.verify_before_done` key → enforces via the new default.
  - The **auto-written template default** (`verify_before_done: false` still
    carrying its generated `opt-in` comment — from the brief window when `flo
    init` shipped it false) is flipped to `true` **once**, recorded in
    `.moflo/migrations.json`. Erring toward *more* verification is safe; silently
    dropping it is the dangerous direction.
  - A **deliberately hand-set** `false` (bare, or with your own comment) is
    **left untouched** — and because the flip is ledger-gated to run exactly
    once, turning verify off later is never overwritten by a future upgrade.
  - To keep verify off, set `gates: verify_before_done: false`.

### Added — `/verify` skill + configurable SDD spec location (#1294)

- New `/verify` skill exercises a change end-to-end against its acceptance
  criteria (the SDD plan's, else the ticket's) and reports a per-criterion
  PASS/FAIL. It is the concrete action that satisfies the verify-before-done
  gate; `/flo` delegates to it (single source of truth for verify mechanics).
- New `sdd.specs_dir` config (default `.moflo/specs`, local + gitignored). Point
  it at a tracked path (e.g. `docs/specs`) to make spec/plan artifacts reviewable
  in PRs. Resolved cross-platform; the session-start indexer honors it and skips
  a double-index when it sits inside a guidance directory.

### Fixed — Daemon orphan-reap cross-kill across shared installs (#1249)

When a project root's `node_modules/moflo` was a symlink sharing another
root's physical install — a git-worktree / Conductor workspace linking
`node_modules` back to the main checkout, or `npm link moflo` across projects
— starting a daemon in one root reaped (killed) the other root's running
daemon as a bogus "same-project orphan". `acquireDaemonLock`'s pre-acquire
reap SIGTERM/SIGKILL'd it. Normal `npm install` consumers (separate physical
copies) were unaffected.

- `projectCliCandidates` (`src/cli/services/daemon-lock.ts`) realpathed the
  full cli.js candidate path, resolving the `node_modules/moflo` symlink and
  collapsing distinct roots onto one path. Fix: realpath the project-ROOT
  PREFIX only (keeps #1145's macOS `/var`→`/private/var` matching), then
  append the relative CLI path literally — a daemon's identity is its project
  root, not the shareable binary it executes.
- Same-root orphan reaping (#1150) preserved; regression tests added in
  `daemon-lock-orphan.test.ts`.

### Fixed — Session-start mutation pluralization

The launcher's `plural()` helper appended a bare `s`, rendering "durable
entrys" instead of "entries" in #1232 durable-sync session-start mutations.

### Fixed — Daemon port collision (#1145, CRITICAL)

Pre-#1145, moflo's daemon HTTP server defaulted to a fixed port (3117). The server retried 3117→3126 on `EADDRINUSE`; the client always POSTed to 3117. When two moflo-using projects ran daemons concurrently on the same machine, the second project's clients routed to the first project's daemon — silently. `flo memory stats`, `flo memory list`, `memory_search`, MCP `memory_store`, `flo memory store/delete`, swarm persistence, aidefence, and write-through-adapter all crossed projects.

#### What changed

- New shared port resolver `src/cli/services/daemon-port.ts` (JS twin at `bin/lib/daemon-port.mjs`). Both server bind site and client RPC route through `resolveProjectPort(projectRoot)` — deterministic `33000 + sha256(path) % 1000` so every project gets its own port.
- `.moflo/daemon.lock` gained a `port` field. Server stamps the actually-bound port after `listen()`; clients read it to discover the daemon without guessing.
- New `GET /api/health` endpoint on the daemon returns `{status, projectRoot, pid, version, uptimeMs}`. Clients probe it on every reachability check; a confirmed `projectRoot` mismatch downgrades the call to direct-SQL (the path that's been provably correct) and emits ONE stderr warn per mismatched port.
- Daemon now hard-fails if the dashboard can't bind any candidate port — pre-#1145 the daemon stayed alive doing internal-worker-only work while HTTP was dead.
- New healer subcheck: `flo healer --fix -c daemon-identity` (alias `identity`). Detects identity mismatches, kills the local daemon, clears the lock, respawns on the per-project port.
- Regression guard at `tests/system/no-fixed-3117-port.test.ts` rejects any new shipped code that references the legacy literal outside the central resolver.

#### Compatibility

- `MOFLO_DAEMON_PORT` env override still wins. Consumers pinning the env keep the pre-#1145 behavior.
- Clients running against pre-#1145 daemons (no `/api/health`, no lock-file `port`) fall through to `LEGACY_DEFAULT_PORT` (3117) — no breakage during the upgrade window.
- Daemons running against pre-#1145 clients keep working; the new port is just announced through the lock file the old client will ignore.

#### Data-integrity advisory

moflo versions ≤4.10.7 had a daemon-routing bug (#1145) where two moflo-using projects on the same machine could silently cross-write each other's databases during any overlap window. If you ran `flo memory store`, MCP `memory_store`, or `flo swarm` across multiple projects concurrently, audit `.moflo/moflo.db` in each project for foreign entries (especially in the `learnings`, `default`, `swarm-*`, and `tasklist` namespaces — indexer-populated namespaces like `guidance`, `code-map`, `tests`, `patterns` are safe because they bypass HTTP). See `docs/internal/1145-daemon-port-collision-analysis.md` §10.2 for the manual reconciliation procedure.

## [3.5.0] - 2026-02-27

### Ruflo v3.5 — First Major Stable Release

This release marks the official rebranding from **Claude Flow** to **Ruflo** and represents the first major stable release after 5,800+ commits, 55 alpha iterations, and 10 months of development.

### Highlights

- **Rebranding**: Claude Flow → Ruflo across all packages (`@moflo/cli`, `claude-flow`, `ruflo`)
- **agentic-flow v3.0.0-alpha.1 Integration**: Full deep integration with 10 subpath exports (ReasoningBank, Router, Orchestration, Agent Booster, SDK, Security, QUIC transport)
- **AgentDB v3.0.0-alpha.9**: 8 new controllers (HierarchicalMemory, MemoryConsolidation, SemanticRouter, GNNService, RVFOptimizer, MutationGuard, AttestationLog, GuardedVectorBackend) + 6 MCP tools
- **215 MCP Tools**: Full Model Context Protocol server with vector memory, neural training, swarm coordination
- **Security Hardening**: Command injection fix, TOCTOU race fix, eliminated hardcoded HMAC keys, timing attack fixes
- **Doctor Health Check**: New `agentic-flow` diagnostic (filesystem-based, ESM-compatible)
- **0 Production Vulnerabilities**: Clean `npm audit` across all packages

### Added

- `agentic-flow-bridge.ts` — Unified lazy-loading bridge for all agentic-flow v3 modules
- Tiered embedding resolution: ReasoningBank WASM (Tier 1) → @moflo/embeddings (Tier 2) → mock fallback (Tier 3)
- Agent Booster local import with npx fallback
- `checkAgenticFlow()` doctor health check
- 7 TypeScript module declarations for agentic-flow subpath exports
- ADR-056: agentic-flow v3 Integration Architecture

### Fixed

- Command injection vulnerability in enhanced-model-router.ts (SAFE_LANGUAGES whitelist)
- TOCTOU race condition in bridge singleton initialization (Promise-based caching)
- 22 agent/skill files updated from stale v1.5.11/v2.0.0-alpha to v3.0.0-alpha.1
- ESM compatibility for doctor checks (filesystem-based instead of `require.resolve`)
- (since removed) @ruvector/gnn pinned to 0.1.25 to fix fatal process crash (issue #216)

### Changed

- All 3 packages bumped from `3.1.0-alpha.55` to `3.5.0`
- Publish tags changed from `alpha`/`v3alpha` to `latest`
- agentic-flow minimum version: `0.1.0` → `3.0.0-alpha.1`
- agentdb minimum version: `2.0.0-alpha.3.4` → `3.0.0-alpha.10`

---

## [3.1.0-alpha.55] - 2026-02-27

### AgentDB 3.0.0-alpha.9 Integration (ADR-053/ADR-055)

- Activated 8 AgentDB v3 controllers with MutationGuard proof engine
- Added 6 new MCP tools: `agentdb_hierarchical_*`, `agentdb_consolidation_*`, `agentdb_semantic_*`
- Fixed controller registry activation bugs (ADR-055)
- Statusline fixes for real-time controller status
- (since removed) Pinned @ruvector/gnn@0.1.25 to fix fatal process crash

## [3.1.0-alpha.43] - 2026-02-15

### Ruflo Branding Fix

- Fixed CLI branding: show 'ruflo' instead of 'claude-flow' when run via `npx ruflo`
- Fixed Windows ESM import crash with `pathToFileURL`
- Fixed init hook prompt overflow and description field

## [3.1.0-alpha.36] - 2026-02-10

### Stability & Compatibility

- Fixed hooks backward compatibility: `--success` and `--file` made optional
- Fixed Windows npm install crash (404 optional dependencies)
- Bumped agentdb to 2.0.0-alpha.3.6
- Fixed V3 build errors (missing helmet, VERSION type, vitest spy)

## [3.1.0-alpha.29] - 2026-02-01

### Security & Agent Teams

- Security fixes, backward compatibility, and Agent Teams hooks
- Added `--settings` flag to upgrade command for Agent Teams
- Fixed npm 11 install crash by pinning agentdb

---

## v3.0.0-alpha Series (2025-10 to 2026-02)

### v3.0.0-alpha.184 — CLI Help & Categorization (2025-12)

- Fixed CLI help categorization across 26 commands
- Published install optimizations
- curl-style installer script
- SEO-optimized npm packages for discovery

### v3.0.0-alpha.170 — Plugins & Marketplace (2025-12)

- **Plugin Marketplace**: 8 official plugins + IPFS registry via Pinata
- **Gas Town Bridge Plugin**: WASM-accelerated orchestrator integration
- **10 RuVector WASM Plugins**: 50 MCP tools for neural computation
- **@moflo/teammate-plugin**: MCP tools for Agent Teams coordination

### v3.0.0-alpha.150 — SONA & SemanticRouter (2025-11)

- **SemanticRouter**: SONA WASM integration with verified benchmarks
- Fixed phantom Claude popups on Windows
- Fixed statusline safe multi-line output for Claude Desktop
- Fixed MCP tool naming (`/` → `_`) for Claude Desktop compatibility
- Memory namespace support in delete command

### v3.0.0-alpha.100 — @moflo/guidance (2025-11)

- **@moflo/guidance Control Plane**: Governance, compliance, and policy enforcement
- Wave 1: Proof, gateway, memory-gate, coherence, hooks, persistence primitives
- Wave 2: Conformance kit, capability algebra, evolution pipeline, artifact ledger
- Wave 3: Civilization-grade primitives (trust, truth, uncertainty, time, authority)
- **Rust WASM Policy Kernel**: SIMD128-accelerated policy evaluation
- **ContinueGate**: Safety gate for agent continuation decisions
- 22-benchmark suite with before/after performance reporting
- CLAUDE.md generators, analyzer, and auto-optimizer
- Content-aware executor with statistical validation (Spearman ρ, Cohen's d)

### v3.0.0-alpha.50 — Core V3 Implementation (2025-10)

- Complete V3 implementation across all ADRs
- ADR-003: Coordinator consolidation + security tests
- Complete hooks system with AgentDB, HNSW, tests
- ReasoningBank guidance system with CLI
- V2→V3 migration documentation
- MCP memory tools upgraded to sql.js + HNSW backend
- Claims-based authorization (ADR-016)
- Node.js worker daemon system
- Auto-update system for @claude-flow packages (ADR-025)
- Replaced all mock implementations with real functionality

### v3.0.0-alpha.1 — Foundation (2025-10)

- Complete V3 monorepo structure (`@moflo/cli`, `shared`, `memory`, `hooks`, `security`)
- 26 CLI commands with 140+ subcommands
- 215 MCP tools via FastMCP 3.x
- RuVector intelligence system (SONA, MoE, HNSW, EWC++, Flash Attention)
- Hive-Mind consensus (Byzantine, Raft, Gossip, CRDT, Quorum)
- 17 hooks + 12 background workers
- 60+ specialized agent types
- Cross-platform helper system

---

## v2.7.x Series (2025-08 to 2025-10)

### v2.7.34 — PostgreSQL & Neural Persistence

- PostgreSQL Bridge with attention, GNN, hyperbolic embeddings
- Neural pattern persistence to disk
- Hive-mind `--claude` flag for spawn command
- Real statusline data, hive-mind shutdown fixes, daemon persistence
- Multi-platform builds (Linux, macOS, Windows) in CI/CD

### v2.7.0 — agentic-flow Integration

- Deep integration with agentic-flow coordination engine
- SDK architecture analysis and hooks & learning integration
- Modular installation strategy
- Optimized v3 migration plan

---

## v2.0.0-alpha Series (2025-05 to 2025-08)

### v2.0.0-alpha.128 — Maturity

- Comprehensive hive-mind optimization
- Database schema robustness (missing columns, optimization errors)
- Auto-rebuild better-sqlite3 on NODE_MODULE_VERSION mismatch
- InMemoryStore interval cleanup for clean process exit

### v2.0.0-alpha.53 — Hook Safety

- Critical hook safety system
- Hive-mind optimization command
- Safety & security features documentation
- Neural Link System with safety protocols

### v2.0.0-alpha.33 — Windows & WSL

- Windows/WSL compatibility fixes
- Module import error resolution
- README restructure for v2.0.0 features
- Comprehensive test suite

---

## v1.x Series (2025-01 to 2025-05)

### v1.0.71 — Final v1 Release

- npm publishing compatibility
- Full CLI command functionality
- SPARC integration with full prompt loading
- Cross-platform support

### v1.0.50 — Swarm & SPARC

- Parallel execution for swarm tasks
- Background task management
- Swarm command with improved error handling
- Claude Code slash commands integration

### v1.0.28 — Project Management

- CLI project management commands
- System monitoring and SPARC commands
- Orchestration templates (monitoring, optimization, security review)

### v1.0.1 — Initial Release (2025-01-01)

- Complete Claude-Flow AI Agent Orchestration System
- Configuration guide and comprehensive tests
- Initial commit

---

## Milestone Summary

| Milestone | Version | Date | Key Feature |
|-----------|---------|------|-------------|
| Initial Release | v1.0.1 | 2025-01 | AI agent orchestration system |
| SPARC Integration | v1.0.50 | 2025-03 | Swarm + SPARC methodology |
| Alpha Foundation | v2.0.0-alpha.33 | 2025-05 | V2 alpha with hook safety |
| agentic-flow | v2.7.0 | 2025-08 | agentic-flow coordination engine |
| V3 Foundation | v3.0.0-alpha.1 | 2025-10 | V3 monorepo, 215 MCP tools |
| Plugin Marketplace | v3.0.0-alpha.170 | 2025-12 | 8 plugins + IPFS registry |
| Guidance Control Plane | v3.0.0-alpha.100 | 2026-01 | WASM policy kernel, ContinueGate |
| AgentDB v3 | v3.1.0-alpha.55 | 2026-02 | 8 controllers, MutationGuard |
| **Ruflo v3.5** | **v3.5.0** | **2026-02-27** | **First stable release, rebranding** |
