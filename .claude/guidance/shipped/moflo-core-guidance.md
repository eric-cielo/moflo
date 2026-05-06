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

`flo init` does the following:

1. Creates `moflo.yaml` with detected project settings
2. Sets up `.claude/settings.json` hooks (SessionStart, pre-edit, etc.)
3. Configures `.mcp.json` for MCP tool access
4. Copies the agent bootstrap guide to `.claude/guidance/`
5. Injects a memory search section into CLAUDE.md

### Post-Install

```bash
npx flo-setup         # Copy bootstrap guidance, inject CLAUDE.md section
npx flo doctor --fix  # Verify everything is working
```

For the full schema of `moflo.yaml` and the env-var overrides, see `moflo-yaml-reference.md`.

---

## Building from Source

**Full instructions: [`docs/BUILD.md`](../../../docs/BUILD.md)** — the canonical, step-by-step build/test/publish process. Always follow it.

Quick reference (from project root only):

```bash
git pull origin main                   # ALWAYS pull first
npm run build                          # tsc -b (project references)
npm test                               # 0 failures required
npm version patch --no-git-tag-version # Bump + sync cli version
npm run build                          # Rebuild with new version
npm publish --otp=XXX                  # Requires 2FA OTP
```

**Critical rules:**

- npm only — no pnpm, yarn, or bun
- Always build from root (`npm run build`) — never cd into subdirectories
- Never publish without a successful build — `prepublishOnly` masks failures
- Never publish without tests passing

---

## Session Start Automation

When a Claude Code session starts, moflo automatically runs three background indexers:

| Indexer | Command | Namespace | What it does |
|---------|---------|-----------|--------------|
| Guidance | `npx flo-index` | `guidance` | Chunks markdown docs, builds RAG links, generates 384-dim embeddings |
| Code Map | `npx flo-codemap` | `code-map` | Scans source for types, interfaces, exports, directory structure |
| Learning | `npx flo-learn` | `patterns` | Pattern research on codebase for cross-session learning |

These run in background and are incremental (unchanged files are skipped). Controlled by `auto_index` in `moflo.yaml`.

### Helper Script Auto-Sync

On version change, `session-start-launcher.mjs` copies helper scripts from the installed moflo package to the consumer project's `.claude/helpers/` and `.claude/scripts/` directories. This ensures hooks always run the latest version.

**Rule: static files, not dynamic generation.** If a helper script has no dynamic content (no per-project interpolation), it must be shipped as a pre-built static file in `bin/` and synced via the session-start file lists. Do not generate static content dynamically at runtime — it adds fragile moving parts (background `init --upgrade`, race conditions with session-start exit) and causes stale scripts when the sync list is incomplete.

| Source | Target | Files |
|--------|--------|-------|
| `bin/` | `.claude/scripts/` | `hooks.mjs`, `session-start-launcher.mjs`, `index-guidance.mjs`, `build-embeddings.mjs`, `generate-code-map.mjs`, `semantic-search.mjs` |
| `bin/` | `.claude/helpers/` | `gate.cjs`, `gate-hook.mjs`, `prompt-hook.mjs`, `hook-handler.cjs` |
| `src/cli/.claude/helpers/` | `.claude/helpers/` | `auto-memory-hook.mjs`, `statusline.cjs`, `subagent-start.cjs`, `pre-commit`, `post-commit` |

When adding a new helper script: generate it once, save it to `bin/`, and add it to the appropriate list in `session-start-launcher.mjs`.

**The full picture.** Helper sync is one of several things the launcher does on every session start. For the complete lifecycle (DB heal, embeddings migration, daemon recycling, settings.json self-heal, etc.) see `moflo-session-start.md`. For the contract on what moflo writes into `.claude/settings.json` and how surgical hook-wiring rewrites work, see `moflo-settings-injection.md`.

### Bundled Guidance

Moflo ships its own guidance files (in `.claude/guidance/` within the package). When installed as a dependency, these are **automatically indexed** alongside the consumer project's guidance under the `guidance` namespace. This means agents in your project can search for moflo system docs (swarm patterns, memory commands, etc.) without any extra setup.

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

MCP tools are the preferred way for Claude to interact with moflo. `flo init` writes `.mcp.json` in the project root automatically (see `moflo-yaml-reference.md` for the file's content and the global-registration alternative).

This gives Claude access to ~125 MCP tools (`mcp__moflo__memory_*`, `mcp__moflo__hooks_*`, `mcp__moflo__swarm_*`, `mcp__moflo__moflodb_*`, etc.) without any global installation.

### Policy: every shipped MCP tool must have a real consumer (#693)

We do not ship speculative tools. Every tool registered in `src/cli/mcp-tools/` must satisfy at least one of these:

1. Referenced as `mcp__moflo__<name>` in a skill, agent file, doc, or guidance .md
2. Called via `callMCPTool('<name>')` from CLI command code
3. On the explicit allowlist in `src/cli/__tests__/mcp-tools-drift-guard.test.ts` with a justification (e.g. "expert API for `moflodb_*` controllers" or "advertised in `moflo-init.ts` CLAUDE.md fragment")

The drift-guard test fails CI if a new tool is registered with no consumer and no allowlist entry. If you ship a tool, ship a real call site for it (or document why it has none).

---

## Project Config (Anti-Drift Defaults)

- **Topology**: hierarchical (prevents drift)
- **Max Agents**: 8 (smaller = less drift)
- **Strategy**: specialized (clear roles)
- **Consensus**: raft
- **Memory**: hybrid
- **HNSW**: Enabled
- **Neural**: Enabled

For the full `moflo.yaml` schema, gate toggles, model routing, and sandbox config, see `moflo-yaml-reference.md`. For the catalog of commands, agents, hooks, and consensus topologies these defaults shape, see `moflo-cli-reference.md`.

---

## Auto-Learning Protocol

### Before Starting Coding Tasks

**MCP (Preferred):** `mcp__moflo__memory_search` — `query: "[task keywords]", namespace: "patterns"`

**CLI Fallback:**

```bash
npx flo memory search --query '[task keywords]' --namespace patterns
```

### After Completing Any Task Successfully (MCP Preferred)

| Step | MCP Tool | Key Params |
|------|----------|------------|
| 1. Store pattern | `mcp__moflo__memory_store` | `namespace: "patterns", key: "[name]", value: "[what worked]"` |
| 2. Train neural | `mcp__moflo__hooks_post-edit` | `file: "[main-file]", trainNeural: true` |
| 3. Record completion | `mcp__moflo__hooks_post-task` | `taskId: "[id]", success: true, storeResults: true` |

### Continuous Improvement Triggers

| Trigger                | Worker     | When to Use                |
|------------------------|------------|----------------------------|
| After major refactor   | `optimize` | Performance optimization   |
| After adding features  | `testgaps` | Find missing test coverage |
| After security changes | `audit`    | Security analysis          |
| After API changes      | `document` | Update documentation       |
| Every 5+ file changes  | `map`      | Update codebase map        |
| Complex debugging      | `deepdive` | Deep code analysis         |

### Memory-Enhanced Development

**ALWAYS check memory before:**

- Starting a new feature (search for similar implementations)
- Debugging an issue (search for past solutions)
- Refactoring code (search for learned patterns)
- Performance work (search for optimization strategies)

**ALWAYS store in memory after:**

- Solving a tricky bug (store the solution pattern)
- Completing a feature (store the approach)
- Finding a performance fix (store the optimization)
- Discovering a security issue (store the vulnerability pattern)

---

## Memory Commands Reference (MCP Preferred)

### Store Data

**MCP:** `mcp__moflo__memory_store`

- Required: `key`, `value`
- Optional: `namespace` (default: "default"), `ttl`, `tags`

**CLI Fallback:**

```bash
npx flo memory store --key "pattern-auth" --value "JWT with refresh tokens" --namespace patterns
```

### Search Data (semantic vector search)

**MCP:** `mcp__moflo__memory_search`

- Required: `query`
- Optional: `namespace`, `limit`, `threshold`

**CLI Fallback:**

```bash
npx flo memory search --query "authentication patterns" --namespace patterns --limit 5
```

### List Entries

**MCP:** `mcp__moflo__memory_list`

- Optional: `namespace`, `limit`

### Retrieve Specific Entry

**MCP:** `mcp__moflo__memory_retrieve`

- Required: `key`
- Optional: `namespace` (default: "default")

---

## Claude Code vs MCP vs CLI Tools

### Claude Code Handles ALL EXECUTION:

- **Task tool**: Spawn and run agents concurrently
- File operations (Read, Write, Edit, Glob, Grep)
- Code generation and programming
- Bash commands and system operations
- Git operations

### MCP Tools Handle Coordination (Preferred):

| Operation | MCP Tool |
|-----------|----------|
| Swarm init | `mcp__moflo__swarm_init` |
| Agent spawn | `mcp__moflo__agent_spawn` |
| Memory store | `mcp__moflo__memory_store` |
| Memory search | `mcp__moflo__memory_search` |
| Hooks (all) | `mcp__moflo__hooks_<hook-name>` |

### CLI Commands (Fallback Only):

Only use CLI via Bash when MCP tools are unavailable:

```bash
npx flo <command> [options]
```

**KEY**: MCP tools coordinate strategy, Claude Code's Task tool executes with real agents.

---

## Doctor Health Checks

**MCP:** `mcp__moflo__system_health` | **CLI:** `npx flo doctor`

Checks: Node version (20+), Git, config validity, daemon status, memory database, API keys, MCP servers, disk space, TypeScript.

---

## Troubleshooting Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| No MCP tools available | `.mcp.json` missing or moflo not installed | Run `npx flo init` or manually create `.mcp.json` |
| Memory search returns nothing | Indexer hasn't run yet | Run `npx flo-index --force` to index guidance |
| Low search quality | Guidance docs missing `**Purpose:**` lines or generic headings | Follow guidance optimization rules in `moflo-memory-strategy.md` |
| Session start slow | All three indexers running | Set `auto_index.code_map: false` in `moflo.yaml` if code map not needed |
| Status line not showing | `statusline.cjs` error or `status_line.enabled: false` | Run `node .claude/helpers/statusline.cjs` to test, check `moflo.yaml` |
| Embeddings fail on first run (offline / air-gapped) | `fastembed` model cache missing | Pre-populate `~/.cache/fastembed` or set `FASTEMBED_CACHE` to a pre-baked cache dir — see `docs/modules/embeddings.md` "Sandbox & air-gapped first-run" |
| `flo` command not found | Not in PATH | Use `npx flo` or `node node_modules/moflo/bin/index-guidance.mjs` |
| Bundled guidance not indexed | Running inside moflo repo (same dir) | Bundled guidance only indexes when installed as a dependency in a different project |

See `moflo-memory-strategy.md` for memory-specific troubleshooting.

---

## See Also

- `.claude/guidance/moflo-cli-reference.md` — CLI commands, agents, hooks, hive-mind, RuVector
- `.claude/guidance/moflo-yaml-reference.md` — `moflo.yaml` schema, environment variables, `.mcp.json` setup
- `.claude/guidance/moflo-subagents.md` — Subagents memory-first protocol and store patterns
- `.claude/guidance/moflo-claude-swarm-cohesion.md` — Task & swarm coordination with TaskCreate/TaskUpdate
- `.claude/guidance/moflo-memory-strategy.md` — Database schema, namespaces, search commands, RAG linking
- `.claude/guidance/moflo-memorydb-maintenance.md` — Reindexing, namespace purging, recovery
- `.claude/guidance/moflo-memory-hygiene.md` — When and how to retire stale auto-memory entries (every entry costs per-prompt tokens)
- `.claude/guidance/moflo-session-start.md` — Complete session-start lifecycle (DB heal, sync, migrations, daemon)
- `.claude/guidance/moflo-settings-injection.md` — What moflo writes into `.claude/` and how surgical self-heal works
- `.claude/guidance/moflo-cross-platform.md` — Windows/macOS/Linux portability rules for any code change
- `.claude/guidance/moflo-verbose-command-filtering.md` — Filter long verbose commands at the source; never tee-then-grep
