## ⚠ Rule #1 — All shipped code MUST be cross-platform (Linux + macOS + Windows)

**Hard requirement, no exceptions.** Consumers run moflo on Windows dev boxes, macOS laptops, and Linux CI runners. Any code that ships in `bin/`, `src/cli/`, `.claude/scripts/`, or `node_modules/moflo/` MUST work identically on all three. The smoke harness runs on all three CI platforms specifically to catch divergence.

**Before any change, audit it against the cross-platform checklist:**

1. **Paths** — use `path.join`, `path.sep`, `path.resolve`. NEVER hardcode `/` or `\`. NEVER hardcode `/tmp`, `/usr/local`, `C:\\Users`, etc.
2. **Symlinks** — POSIX has them; Windows mostly doesn't. If you compare two paths for identity, `fs.realpathSync` BOTH sides first (otherwise `/var/folders/...` ≠ `/private/var/folders/...` on macOS — see #1145).
3. **Case sensitivity** — POSIX FS is case-sensitive; macOS APFS + Windows NTFS are case-insensitive by default. Don't write `Foo.ts` and `foo.ts` in the same directory.
4. **Line endings** — files written by moflo MUST use platform-appropriate EOL or be marked `text=auto` in `.gitattributes`. Tests that hash file contents must normalize.
5. **Shell commands** — `bash`/`grep`/`sed`/`cat`/`find` don't exist on Windows out of the box. Use Node primitives (`fs`, `child_process` with `spawn` not shell, `Glob`/`Grep` tools) instead of shelling out. If you MUST shell, branch on `process.platform`.
6. **Process introspection** — `tasklist`/`wmic`/`Get-CimInstance` on Windows vs `ps`/`/proc/<pid>/cmdline` on POSIX. See `daemon-lock.ts:isDaemonProcess*` for the right shape.
7. **Spawning daemons** — Windows requires `shell: true` + quoted strings (Node 24 DEP0190); POSIX uses `detached: true`. See `commands/daemon.ts:startBackgroundDaemon`.
8. **Tempdir + Windows port reservations** — `os.tmpdir()` is platform-correct; ports 49152-65535 are reserved on Windows (EACCES) — use 40000-44999 in tests.
9. **`rm`/`cp`/`mkdir`** in spell bash steps — Windows lacks these on PATH. Use `node -e` with `fs`/`os` for file ops in cross-platform spells.

**Verify before pushing — don't trust your local OS:**

- The smoke harness (`harness/consumer-smoke/run.mjs`) covers all three platforms in CI. Watch macOS + Ubuntu runs, not just Windows.
- `tests/system/` runs cross-platform; `tests/bin/` has explicit Windows + POSIX branches.
- If your local OS is Windows, mentally simulate the POSIX path (symlinks, case-sensitivity, missing `tasklist`). If POSIX, simulate Windows.

**Concrete examples of what cross-platform misses look like in practice:**

- **#1145 follow-up (this session)** — `normalizeProjectRoot` didn't `realpathSync` → macOS daemon resolved `/var/folders/...` → `/private/var/folders/...` while client saw the unresolved path → identity check false-positived → smoke failed on macOS + Ubuntu, passed on Windows. Shipped because verification was Windows-only.
- **`feedback_spell_bash_minimal_path.md`** — spell bash steps on Windows lack `mkdir`/`rm`/`cp` on PATH; use `node -e` with fs/os.
- **`feedback_docker_sandbox_git_safe_directory.md`** — `git config --global safe.directory` gets overridden by bind-mounted `.gitconfig`; must use `--system`.

See `feedback_cross_platform_mandatory.md` (auto-memory) for the running list.

---

## ⚠ Rule #2 — MoFlo is a library shipped to other projects — READ FIRST, every change

**This is an open-source library.** The package is installed as a `devDependency` into consumer projects to make Claude Code more effective in those projects. It is NOT a standalone application — every change you make ships to N consumers via `npm install moflo` and runs from their `node_modules/moflo/...` on their machines.

**Before writing any code or opening any PR**, articulate three things to yourself (and to the user, if non-trivial):

1. **Consumer surface touched** — which file class is this? `bin/`, `src/cli/`, `.claude/scripts/`, `mcp-tools/`, hook handlers, init/, settings-generator, `claudemd-generator.ts`, anything synced to `node_modules/moflo/`. Editing a test or internal helper has near-zero blast radius. Editing the launcher, a hook, or anything `flo init` writes touches every consumer.
2. **Failure mode for the on-the-current-version consumer** — what breaks for someone on `moflo@<previous>` who picks this change up via `npm install moflo@<latest>`? Is there a migration? Does the consumer need to do anything? Will their existing `.moflo/` state still parse? Their hooks still wire?
3. **Round-trip cost** — does this require *publish-then-reinstall* before it takes effect (most runtime fixes do — see the dogfood note below), or does the source edit alone suffice (build/test/internal code)?

**Concrete examples of what "consumer impact" looks like in practice:**

- **#860** — missing `CLAUDE_CODE_HEADLESS` guard in the launcher → daemon-spawned headless Claude in *every* consumer triggered the indexer chain, pegging CPU on a 15-min loop. Cost: a stale-since-shipped guard fired in N consumer environments before anyone noticed.
- **#854** — silent `catch {}` in launcher upgrade flow → consumers stuck across moflo 4.8.x → 4.9.2 with partial migrations and no diagnostic crumbs. Cost: 4+ versions worth of consumer-invisible breakage.
- **#586 / collapse epic** — workspace renamed `@claude-flow/*` → `@moflo/*` → every consumer with bare imports needed coordinated migration; 5-invariant drift guard now blocks regressions.
- **#798** — MCP swarm/agent handlers stubbed out as a "simplification" → headline product surface broke in every consumer; 10-story epic to repair.

If you can't name the consumer surface and failure mode for a non-trivial change, **stop and re-scope** before writing code. "I'll just clean this up while I'm here" is the antipattern that produced every bullet above.

See `feedback_consumer_blast_radius.md` (auto-memory) for the full posture.

---

## ⚠ Dogfooding & local-vs-installed delivery — mandatory reading

MoFlo dogfoods itself: the daemon, hooks, statusline, MCP server, and embeddings indexer ALL run from `node_modules/moflo/...` (NOT from the source tree). Source edits don't take effect for those runtime layers until publish + reinstall + Claude Code restart. Resolving paths between the source tree and the installed package has dist-vs-source depth pitfalls that bite every consumer if you get them wrong.

**Before** any of the following, you MUST read `.claude/guidance/internal/dogfooding.md`:

- Diagnosing any "X is broken" symptom visible in the editor (statusline, daemon, hooks, indexer, upgrade UI) — see § Runtime Symptom Diagnosis
- Adding a new file in `bin/`, `bin/lib/`, `src/cli/`, `dist/`, or anything synced to `.claude/scripts/` — see § Delivering Changes That Work Both Local AND Installed (manifest scope + sync layers)
- Resolving any path between TS code and `bin/*.mjs` (e.g. `dist/src/cli/services/...` → `bin/lib/...`) — see § Delivering Changes That Work Both Local AND Installed § 2 (the `../../../../` anti-pattern that broke #1126's first iteration)
- Adding cross-process daemon coordination, atomic file swaps, or any platform-sensitive primitive — see § Delivering Changes That Work Both Local AND Installed § 6
- Touching the smoke harness or chasing local-vs-CI smoke divergence — see § Smoke Harness Reality

Skip this and you'll either waste a session debugging code that isn't running, ship a change that works in dogfood but breaks every consumer install, or break a consumer's `.moflo/` state in a way that takes a full publish-rollback-cycle to recover from.

---

<!-- MOFLO:INJECTED:START -->
## MoFlo — AI Agent Orchestration

### FIRST ACTION ON EVERY PROMPT: Search Memory

Your first tool call MUST be `mcp__moflo__memory_search` — before any Glob/Grep/Read. Pick the namespace by question shape: `code-map` for "where is symbol X defined", `tests` for "what tests cover Y", `patterns` for "what's our pattern for Z", `guidance` for project rules, `learnings` for "did we hit this before". Pivot on the bare symbol/keyword (not a natural-language question), and trust similarity ≥ 0.80 as a confident hit. When the user says "remember this", call `mcp__moflo__memory_store` with namespace `learnings`.

### Traverse chunks, don't bulk-retrieve

Search results carry a compact `navigation` crumb (parentDoc, prev/next, chunkTitle). For adjacent/sibling/hierarchical context use `mcp__moflo__memory_get_neighbors`; for full chunk content use `mcp__moflo__memory_retrieve`; `Read` the source doc only via `parentPath` when truly needed. Full protocol + worked examples per namespace: `.claude/guidance/moflo-memory-protocol.md`.

### Auto-enforced gates

- **TaskCreate-first**: Call `TaskCreate` before spawning the Agent tool
- **Task Icons**: `TaskCreate` entries MUST use ICON+[Role] format — see `.claude/guidance/moflo-task-icons.md`

### Tools

Prefer MCP (`mcp__moflo__*` — memory, swarm, agent, task, hooks, hive-mind, neural) over the CLI. CLI binaries: `flo` (main), `flo-search` (semantic search), `flo doctor --fix` (heal). Full catalog: `.claude/guidance/moflo-core-guidance.md`.

### After upgrading MoFlo

After `npm install` touches moflo, check `.moflo/restart-pending.json` — if present, surface its `message` field to the user verbatim, then delete the file. (Claude Code only loads new hooks/MCP/launcher at session start.)

### Monorepos

Moflo state lives at the monorepo root `.moflo/` — never run `flo init` inside a sub-workspace of an existing moflo project, or the MCP server and CLI silently bind to different daemons (issue #1174).

### Full Reference

- Universal agent rules (memory protocol, git/PR conventions, file org, build/test): `.claude/guidance/moflo-agent-rules.md`
- Subagent spawn protocol: `.claude/guidance/moflo-subagents.md`
- Task + swarm coordination: `.claude/guidance/moflo-claude-swarm-cohesion.md`
- CLI, hooks, swarm, memory, moflo.yaml: `.claude/guidance/moflo-core-guidance.md`
<!-- MOFLO:INJECTED:END -->

## ⚠ Editing guidance — read both rule sets first

Before creating, rewriting, or editing any `.claude/guidance/**/*.md` file, MUST read both:

1. `.claude/guidance/shipped/moflo-guidance-rules.md` — universal writing rules (Purpose line, imperative voice, decision tables, concrete examples, 500-line cap, specific H2 headings, anti-patterns, RAG chunking, See Also).
2. `.claude/guidance/internal/guidance-rules.md` — moflo-only extensions (`moflo-` prefix on shipped files, shipped/internal partition contract, bucket-decision rules).

Drive-by edits count too. Auto-memory files under `~/.claude/projects/.../memory/` follow the universal rules where they apply.

---

## Broken Window Theory (mandatory — moflo repo only)

Zero tolerance for unresolved failures. Every failing test, every warning, every bug gets fixed before moving on — no exceptions by severity, no "probably flaky" without individual re-verification. If a test fails in the full suite, retest individually to distinguish real failures from flaky ones. If flaky, fix the flakiness itself (tight timeouts, resource contention, etc.) — don't just re-run and move on. A red signal is never acceptable as background noise.

## ⛔ Protected functionality — swarm + hive-mind (mandatory)

**Swarm and hive-mind are CRITICAL moflo product surface.** They are headline capabilities (`flo swarm`, `flo hive-mind`, MCP tools `swarm_*` / `agent_*` / `task_*` / `hive-mind_*`, queen/worker hierarchy, consensus). They MUST remain wired and functional across every refactor, migration, collapse, rename, and "cleanup".

**Regression includes — not just deletion — but also:**
- **Disconnection** — leaving infrastructure in place but reducing MCP handlers to stubs returning hardcoded literals (e.g. `{ swarmId: 'swarm-' + Date.now() }`, `{ agentCount: 0, taskCount: 0 }`, file-based JSON writes that bypass the coordinator). This is the silent failure mode that triggered epic #798.
- **Stubbing / "simplification"** — replacing real coordinator calls with synthetic returns under "we'll wire it later".
- **Migration drift** — completing one half of a migration (e.g. hive-mind to MessageBus) without the matching swarm/agent half.

**Mandatory verification on any change to** `src/cli/mcp-tools/{swarm,agent,task,hive-mind}-tools.ts`, `src/cli/swarm/**`, `src/cli/commands/{swarm,agent,hive-mind}.ts`, or related MCP wiring:

1. `agent_spawn` invokes `coordinator.spawnAgent(...)` — not a JSON store write
2. `swarm_init` invokes `coordinator.initialize(...)` — not literal `swarm-${Date.now()}`
3. `swarm_status` / `swarm_health` query the coordinator — not hardcoded values
4. `task_*` invokes `coordinator.distributeTasks` / `executeTask` / `cancelTask`
5. `hive-mind_*` routes through `MessageBus` + `WriteThroughAdapter` (Story #121); workers register with the shared coordinator
6. End-to-end system tests at `tests/system/swarm-restoration-e2e.test.ts` exercise the wired path

**If a refactor seems to require disconnecting handlers temporarily, STOP and surface it.** Load-bearing change requiring explicit owner sign-off — never an in-passing tidy-up. Default to preservation.

**Cost of violation:** Epic #798 (10 stories) exists solely to repair this regression. The user described it as "costing critical time and money to repair when it NEVER should have been necessary." This rule is non-negotiable.

See `feedback_swarm_hive_never_regress.md` in auto-memory for full detail.
