## ⚠ MoFlo is a library shipped to other projects — READ FIRST, every change

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

Your first tool call MUST be `mcp__moflo__memory_search` — before any Glob/Grep/Read. Search `guidance`, `patterns`, and `learnings` every prompt; add `code-map` when navigating code, `tests` when looking for test inventory or coverage. When the user says "remember this", call `mcp__moflo__memory_store` with namespace `learnings`.

### Traverse chunks, don't bulk-retrieve

Search results carry a compact `navigation` crumb (parentDoc, prev/next, chunkTitle). For adjacent/sibling/hierarchical context use `mcp__moflo__memory_get_neighbors`; for full chunk content use `mcp__moflo__memory_retrieve`; `Read` the source doc only via `parentPath` when truly needed. Full protocol: `.claude/guidance/moflo-memory-protocol.md`.

### Auto-enforced gates

- **TaskCreate-first**: Call `TaskCreate` before spawning the Agent tool
- **Task Icons**: `TaskCreate` entries MUST use ICON+[Role] format — see `.claude/guidance/moflo-task-icons.md`

### Tools

Prefer MCP (`mcp__moflo__*` — memory, swarm, agent, task, hooks, hive-mind, neural) over the CLI. CLI binaries: `flo` (main), `flo-search` (semantic search), `flo doctor --fix` (heal). Full catalog: `.claude/guidance/moflo-core-guidance.md`.

### After upgrading MoFlo

After `npm install` touches moflo, check `.moflo/restart-pending.json` — if present, surface its `message` field to the user verbatim, then delete the file. (Claude Code only loads new hooks/MCP/launcher at session start.)

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
