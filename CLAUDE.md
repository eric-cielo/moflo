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

## ⚠ This repo dogfoods MoFlo — read before any diagnostic

**MoFlo IS the project AND the installed devDependency that drives the editor.** Two layers exist and they routinely diverge:

| Layer | Location | Role |
|-------|----------|------|
| **Source** | `src/cli/...`, `bin/...` (working tree) | What's being edited |
| **Installed** | `node_modules/moflo/...` | What's actually running — Claude Code's SessionStart hooks, daemon, statusline, indexers, embeddings migration all execute from here |

When diagnosing any "X is broken" symptom (statusline numbers, daemon spam, missing upgrade UI, indexer behavior, hook output, anything observable in the editor) the symptom is produced by the **installed** bits — NOT by the source. Diagnostic instinct of "open the source file and read the code" is wrong here unless the install was just refreshed.

**Before opening issues for runtime symptoms, verify the install state:**

```bash
node -p "require('./node_modules/moflo/package.json').version"  # what's running
node -p "require('./package.json').version"                     # source version
git log --oneline -5                                            # what's in source not yet shipped
```

If installed lags source, **publish + reinstall first** (use `/publish`), then re-test. Most "the code is buggy" symptoms turn out to be stale-install artifacts in this repo specifically because of the dogfood loop.

**Corollary:** features must work from `node_modules/moflo/...` paths (consumer perspective), not from source paths anchored on `process.cwd()`. See `feedback_consumer_path_resolution.md`.

---

<!-- MOFLO:INJECTED:START -->
## MoFlo — AI Agent Orchestration

This project uses [MoFlo](https://github.com/eric-cielo/moflo) for AI-assisted development spells.

### FIRST ACTION ON EVERY PROMPT: Search Memory

MUST call `mcp__moflo__memory_search` BEFORE any Glob/Grep/Read/file exploration. Namespaces: `guidance`+`patterns`+`learnings` every prompt; `code-map` when navigating code. When the user says "remember this": `mcp__moflo__memory_store` with namespace `learnings`.

### Spell Gates (enforced automatically)

- **Memory-first**: Must search memory before Glob/Grep/Read
- **TaskCreate-first**: Must call TaskCreate before spawning Agent tool

- **Task Icons**: `TaskCreate` MUST use ICON+[Role] format — see `.claude/guidance/shipped/moflo-task-icons.md`

### MCP Tools (preferred over CLI)

| Tool | Purpose |
|------|---------|
| `mcp__moflo__memory_search` | Semantic search across indexed knowledge |
| `mcp__moflo__memory_store` | Store patterns and decisions |

### CLI Fallback

```bash
flo-search "[query]" --namespace guidance   # Semantic search
flo doctor --fix                             # Health check
```

### After upgrading MoFlo

After running `npm install moflo@*` (or `npm install` that touches moflo), check `.moflo/restart-pending.json`. If it exists, surface the `message` field to the user verbatim (Claude Code can't pick up new hooks/MCP tools/launcher mid-session — they're only loaded at session-start), then delete the file.

### Full Reference

- **Subagents protocol:** `.claude/guidance/shipped/moflo-subagents.md`
- **Task + swarm coordination:** `.claude/guidance/shipped/moflo-claude-swarm-cohesion.md`
- **CLI, hooks, swarm, memory, moflo.yaml:** `.claude/guidance/shipped/moflo-core-guidance.md`
<!-- MOFLO:INJECTED:END -->

## ⚠ Writing or editing guidance — both rule sets are mandatory

**Whenever you create, rewrite, or edit any `.claude/guidance/**/*.md` file, BOTH rule sets MUST be followed:**

1. **`.claude/guidance/shipped/moflo-guidance-rules.md`** — Universal writing rules (#1–#9): required `**Purpose:**` line, imperative voice, decision tables, concrete examples, 500-line cap, specific H2 headings, anti-patterns, RAG chunking, mandatory `## See Also` section.
2. **`.claude/guidance/internal/guidance-rules.md`** — Moflo-only extensions (#1–#3): the `moflo-` prefix on shipped files, the shipped/internal partitioning contract, and the decision rules for which bucket new docs go in.

This applies to:

- New shipped guidance (`.claude/guidance/shipped/moflo-*.md`)
- New internal guidance (`.claude/guidance/internal/*.md`)
- Edits to existing guidance — drive-by edits must not introduce drift from either rule set
- Auto-memory files under `~/.claude/projects/.../memory/` (the universal rules apply where they make sense)

If you find yourself writing prose preambles, generic headings, hedged "should/might" language, or omitting See Also — stop and re-read the rules.

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
