# Moflo CLI & MCP Reference

**Purpose:** Hub for moflo's consumer-facing surface — getting started, MCP setup, the comparison between Claude Code / MCP / CLI tools, the auto-learning protocol, and where to look for everything else. Read this first; deeper reference docs are linked from See Also.

**MCP-First Policy:** Always prefer MCP tools (`mcp__moflo__*`) over CLI commands. Use `ToolSearch` to load them, then call directly. CLI is fallback only.

---

## Getting Started

### Installation

```bash
npm install moflo
npx flo init          # Interactive setup wizard
```

`flo init` creates `moflo.yaml`, sets up `.claude/settings.json` hooks, configures `.mcp.json` for MCP tools, copies bootstrap guidance to `.claude/guidance/`, and injects a memory-search section into `CLAUDE.md`.

### Post-Install

```bash
npx flo-setup         # Re-copy bootstrap guidance, re-inject CLAUDE.md section
npx flo doctor --fix  # Verify everything is working
```

For the full schema of `moflo.yaml` and env-var overrides, see `.claude/guidance/moflo-yaml-reference.md`. (Building moflo itself from source is a maintainer concern — see `docs/BUILD.md`.)

---

## Session Start Automation

When a Claude Code session starts, moflo automatically runs three background indexers:

| Indexer | Command | Namespace | What it does |
|---------|---------|-----------|--------------|
| Guidance | `npx flo-index` | `guidance` | Chunks markdown, builds RAG links, generates 384-dim embeddings |
| Code Map | `npx flo-codemap` | `code-map` | Scans source for types, interfaces, exports, directory structure |
| Learning | `npx flo-learn` | `patterns` | Pattern research on codebase for cross-session learning |

These run in background and are incremental (unchanged files are skipped). Controlled by `auto_index` in `moflo.yaml`.

### Session-Start Cost Expectations

The launcher does more than copy helpers — it also heals the memory DB, runs embeddings migrations, recycles the daemon when the install changes, and self-heals `.claude/settings.json` hook wiring. Expected timing:

| Scenario | Cost | What you'll see |
|----------|------|-----------------|
| Steady-state start (no version change) | < 200 ms | Silent; no `moflo:` lines |
| First start after `npm install moflo` | A few seconds (one-shot) | `moflo:` lines reporting synced files, daemon recycle, manifest write |
| Major upgrade with embeddings migration | 30–60 s (one-shot) | Progress bar on stderr; cannot be skipped |
| Slow on every start | Manifest drift loop | Run `flo doctor --fix` |

For the contract on what moflo writes into `.claude/settings.json` and how surgical hook-wiring rewrites work, see `.claude/guidance/moflo-settings-injection.md`.

### Bundled Guidance

Moflo ships its own guidance files inside the package. When installed as a dependency they are **automatically indexed** alongside the consumer project's guidance under the `guidance` namespace — agents can search for moflo system docs (swarm patterns, memory commands, etc.) without extra setup.

---

## Bin Commands

| Command | Script | Purpose |
|---------|--------|---------|
| `npx flo-index` | `bin/index-guidance.mjs` | Index guidance docs with RAG linking + embeddings |
| `npx flo-codemap` | `bin/generate-code-map.mjs` | Generate structural code map (types, interfaces, directories) |
| `npx flo-learn` | Learning service | Pattern research on codebase |
| `npx flo-setup` | `bin/setup-project.mjs` | Copy bootstrap guidance, inject CLAUDE.md memory section |
| `npx flo-search` | `bin/semantic-search.mjs` | Standalone semantic search with detailed output |

### Common Flags

| Flag | Applies to | Effect |
|------|-----------|--------|
| `--force` | flo-index, flo-codemap | Reindex everything (ignore hash cache) |
| `--file <path>` | flo-index | Index a specific file only |
| `--no-embeddings` | flo-index | Skip embedding generation |
| `--verbose` | flo-index | Show detailed chunk-level output |
| `--namespace <ns>` | flo-search | Filter search to specific namespace |
| `--limit <n>` | flo-search | Number of results (default: 5) |

---

## MCP Tools Setup

`flo init` writes `.mcp.json` in the project root automatically (see `.claude/guidance/moflo-yaml-reference.md` for the file's content and the global-registration alternative). This gives Claude access to ~125 MCP tools (`mcp__moflo__memory_*`, `mcp__moflo__hooks_*`, `mcp__moflo__swarm_*`, `mcp__moflo__moflodb_*`, etc.) without any global installation.

**Every shipped MCP tool has a real consumer call site** (skill, agent, doc, CLI code, or allowlist entry with justification). The drift-guard test in `src/cli/__tests__/mcp-tools-drift-guard.test.ts` fails CI if a new tool is registered with no consumer — moflo does not ship speculative tools.

---

## Project Config (Anti-Drift Defaults)

- **Topology:** hierarchical (prevents drift)
- **Max Agents:** 8 (smaller = less drift)
- **Strategy:** specialized (clear roles)
- **Consensus:** raft
- **Memory:** hybrid
- **HNSW:** Enabled
- **Neural:** Enabled

For the full `moflo.yaml` schema, gate toggles, model routing, and sandbox config, see `.claude/guidance/moflo-yaml-reference.md`. For the catalog of commands, agents, hooks, and consensus topologies these defaults shape, see `.claude/guidance/moflo-cli-reference.md`.

---

## Auto-Learning Protocol

### Before Starting Coding Tasks

**MCP (preferred):** `mcp__moflo__memory_search` — `query: "[task keywords]"`, `namespace: "patterns"`.

**CLI fallback:** `npx flo memory search --query '[task keywords]' --namespace patterns`.

### After Completing Any Task

| Step | MCP Tool | Key Params |
|------|----------|------------|
| Store pattern | `mcp__moflo__memory_store` | `namespace: "patterns", key: "[name]", value: "[what worked]"` |
| Train neural | `mcp__moflo__hooks_post-edit` | `file: "[main-file]", trainNeural: true` |
| Record completion | `mcp__moflo__hooks_post-task` | `taskId: "[id]", success: true, storeResults: true` |

### Continuous Improvement Triggers

| Trigger | Worker | Use For |
|---------|--------|---------|
| After major refactor | `optimize` | Performance optimization |
| After adding features | `testgaps` | Find missing test coverage |
| After security changes | `audit` | Security analysis |
| After API changes | `document` | Update documentation |
| Every 5+ file changes | `map` | Update codebase map |
| Complex debugging | `deepdive` | Deep code analysis |

### Memory-Enhanced Development

| Action | When |
|--------|------|
| Search memory before writing code | Starting a new feature, debugging an issue, refactoring, performance work |
| Store in memory after solving | Tricky bug, completed feature, perf fix, security finding |

For namespaces, embedding model, indexing pipeline, and writing guidance that retrieves well, see `.claude/guidance/moflo-memory-strategy.md`.

---

## Claude Code vs MCP vs CLI

| Layer | Handles | Examples |
|-------|---------|----------|
| Claude Code (execution) | Spawning agents, file ops, code, bash, git | `Task`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash` |
| MCP tools (coordination — preferred) | Swarm/agent orchestration, memory, hooks | `mcp__moflo__swarm_init`, `mcp__moflo__agent_spawn`, `mcp__moflo__memory_store`, `mcp__moflo__hooks_*` |
| CLI (fallback only) | Same coordination via shell when MCP unavailable | `npx flo <command> [options]` |

**Key:** MCP tools coordinate strategy; Claude Code's `Task` tool executes with real agents.

---

## Doctor Health Checks

**MCP:** `mcp__moflo__system_health` | **CLI:** `npx flo doctor`

Checks: Node version (20+), Git, config validity, daemon status, memory database, API keys, MCP servers, disk space, TypeScript.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No MCP tools available | `.mcp.json` missing or moflo not installed | Run `npx flo init` or manually create `.mcp.json` |
| Memory search returns nothing | Indexer hasn't run yet | Run `npx flo-index --force` |
| Low search quality | Guidance docs missing `**Purpose:**` lines or generic headings | See `.claude/guidance/moflo-guidance-rules.md` |
| Session start slow | All three indexers running | Set `auto_index.code_map: false` in `moflo.yaml` if not needed |
| Status line not showing | `statusline.cjs` error or `status_line.enabled: false` | Run `node .claude/helpers/statusline.cjs` to test, check `moflo.yaml` |
| Embeddings fail offline / air-gapped | `fastembed` model cache missing | Pre-populate `~/.cache/fastembed` or set `FASTEMBED_CACHE` (see `docs/modules/embeddings.md`) |
| `flo` command not found | Not in PATH | Use `npx flo` or `node node_modules/moflo/bin/index-guidance.mjs` |
| Bundled guidance not indexed | Running inside the moflo repo | Bundled guidance only indexes when installed as a dependency in a different project |

See `.claude/guidance/moflo-memory-strategy.md` for memory-specific troubleshooting and `.claude/guidance/moflo-spell-troubleshooting.md` for spell sandbox/network failures.

---

## See Also

- `.claude/guidance/moflo-cli-reference.md` — CLI commands, agents, hooks, hive-mind, RuVector
- `.claude/guidance/moflo-yaml-reference.md` — `moflo.yaml` schema, environment variables, `.mcp.json` setup
- `.claude/guidance/moflo-subagents.md` — Subagents memory-first protocol and store patterns
- `.claude/guidance/moflo-claude-swarm-cohesion.md` — Task & swarm coordination with TaskCreate/TaskUpdate
- `.claude/guidance/moflo-memory-strategy.md` — Database schema, namespaces, search commands, RAG linking
- `.claude/guidance/moflo-memorydb-maintenance.md` — Reindexing, namespace purging, recovery
- `.claude/guidance/moflo-settings-injection.md` — What moflo writes into `.claude/` and how surgical self-heal works
- `.claude/guidance/moflo-cross-platform.md` — Windows/macOS/Linux portability rules for any code change
- `.claude/guidance/moflo-verbose-command-filtering.md` — Filter long verbose commands at the source; never tee-then-grep
