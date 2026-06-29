# Moflo CLI & MCP Reference

**Purpose:** Hub for moflo's consumer-facing surface — getting started, MCP setup, the comparison between Claude Code / MCP / CLI tools, the auto-learning protocol, and where to look for everything else. Read this first; deeper reference docs are linked from See Also.

**MCP-First Policy:** Always prefer MCP tools (`mcp__moflo__*`) over CLI commands. Use `ToolSearch` to load them, then call directly. CLI is fallback only.

---

## Runtime Target: Claude Code Only

**MoFlo targets Anthropic's Claude Code exclusively** — the CLI, IDE extensions (VS Code, JetBrains), and the web app at claude.ai/code. It is not a Claude Desktop integration and is never installed into Claude Desktop's config tree.

| Tool | Status | Config paths moflo touches |
|------|--------|----------------------------|
| Claude Code (CLI, IDE extensions, web) | Sole supported target | `<project>/.mcp.json`, `<project>/.claude/settings.json`, `<project>/.moflo/`, `<project>/moflo.yaml` |
| Claude Desktop (the macOS/Windows app) | **Out of scope — never** | None — moflo neither reads nor writes Claude Desktop config |
| Other MCP-capable clients (Cline, Continue, etc.) | Unsupported, may incidentally work | None — bug reports require Claude Code reproduction |

**Never** introduce a code path, search list, fixture, or doc that reads from or writes to `~/.claude/claude_desktop_config.json`, `~/Library/Application Support/Claude/`, or `%APPDATA%/Claude/`. Those are Claude **Desktop** paths. Including them in moflo's MCP-config search list caused issue #1126: a parseable Claude Desktop preferences file outranked a malformed project `.mcp.json`, masking the real failure and routing the auto-fixer down a no-op branch.

The one ambiguous-looking path is Claude Code's user-level config at `~/.claude.json` (where `claude mcp add` writes). MoFlo doesn't author or rewrite that file either; the project-local `.mcp.json` written by `flo init` is the canonical surface moflo owns end-to-end.

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
| Every 5+ file changes | `map` | Update codebase map |
| Complex debugging | `deepdive` | Deep code analysis |

### Worker Report Location

Headless workers (`optimize`, `testgaps`, `ultralearn`, `refactor`, `deepdive`) write the latest run's full output to `.moflo/reports/<workerType>.<ext>` (`.md` for markdown workers, `.json` for `ultralearn`). The path is overwritten each run; for history, see `.moflo/logs/headless/`. The directory is gitignored by `flo init`, so reports never reach a consumer's commit. When the user asks "what did testgaps find?" or "where's the optimize report?", read `.moflo/reports/<workerType>.md` directly — do NOT re-run the worker.

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

## Monorepo Layout

**Purpose:** prevent the most common moflo misconfig — daemon islands in monorepos (#1174).

| Rule | Why |
|------|-----|
| One `.moflo/` per monorepo, at the repo root | The daemon, MCP server, and CLI all walk up from `cwd` to locate state. Two `.moflo/` directories under one tree means two daemons with separate sockets, ports, and registries — the MCP server bound to one will not see tools/state from the other. |
| Never run `flo init` inside a sub-workspace of an existing moflo project | `flo init` refuses by default when an ancestor `.moflo/moflo.db` is detected. `--force` overrides if you genuinely want isolated state. |
| `flo doctor` flags every nested `.moflo/` it finds | Component name: `nested-moflo`. Status warns when any island exists. |
| `flo doctor --fix -c nested-moflo` archives each nested directory | Renames `<sub>/.moflo` → `<sub>/.moflo-archived-<ISO>` (never deletes). Manual review path: archived directories stay on disk. |

The resolver (`findProjectRoot`) prefers the topmost ancestor with `.moflo/moflo.db` so every cwd in the tree agrees on the canonical anchor. If `CLAUDE_PROJECT_DIR` is set explicitly, it overrides this — only use that override when you intend isolated state.

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
| `mcp__moflo__*` tools missing in monorepo session | Nested `.moflo/` directories spawned separate daemons (#1174) | Run `flo doctor -c nested-moflo`; if any are found, `flo doctor --fix -c nested-moflo` archives them. Restart Claude Code to reconnect. |

See `.claude/guidance/moflo-memory-strategy.md` for memory-specific troubleshooting and `.claude/guidance/moflo-spell-troubleshooting.md` for spell sandbox/network failures.

---

## See Also

- `.claude/guidance/moflo-skills-reference.md` — Slash-command skills catalog (`/flo`, `/commune`, `/meditate`, `/divine`, …) plus the automatic features (auto-meditate, session-continuity)
- `.claude/guidance/moflo-cli-reference.md` — CLI commands, agents, hooks, hive-mind, RuVector
- `.claude/guidance/moflo-yaml-reference.md` — `moflo.yaml` schema, environment variables, `.mcp.json` setup
- `.claude/guidance/moflo-subagents.md` — Subagents memory-first protocol and store patterns
- `.claude/guidance/moflo-claude-swarm-cohesion.md` — Task & swarm coordination with TaskCreate/TaskUpdate
- `.claude/guidance/moflo-memory-strategy.md` — Database schema, namespaces, search commands, RAG linking
- `.claude/guidance/moflo-memorydb-maintenance.md` — Reindexing, namespace purging, recovery
- `.claude/guidance/moflo-cross-install-memory-sharing.md` — Sharing durable `learnings` across worktrees / machines / teams (`memory.durable_path`, `flo memory sync`, the team artifact) and the `flo doctor -c shared-db` check
- `.claude/guidance/moflo-settings-injection.md` — What moflo writes into `.claude/` and how surgical self-heal works
- `.claude/guidance/moflo-cross-platform.md` — Windows/macOS/Linux portability rules for any code change
- `.claude/guidance/moflo-verbose-command-filtering.md` — Filter long verbose commands at the source; never tee-then-grep
