# Moflo CLI & MCP Reference

**Purpose:** Complete CLI and MCP reference for moflo — hooks, memory, agents, swarm, neural, and doctor commands. Read when using moflo features or debugging agent coordination.

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
| `src/modules/cli/.claude/helpers/` | `.claude/helpers/` | `auto-memory-hook.mjs`, `statusline.cjs`, `subagent-start.cjs`, `pre-commit`, `post-commit` |

When adding a new helper script: generate it once, save it to `bin/`, and add it to the appropriate list in `session-start-launcher.mjs`.

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

MCP tools are the preferred way for Claude to interact with moflo. `flo init` creates a `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "moflo": {
      "command": "node",
      "args": ["node_modules/moflo/src/modules/cli/bin/cli.js", "mcp", "start"]
    }
  }
}
```

This gives Claude access to 200+ MCP tools (`mcp__moflo__memory_*`, `mcp__moflo__hooks_*`, `mcp__moflo__swarm_*`, etc.) without any global installation.

---

## Project Config (Anti-Drift Defaults)

- **Topology**: hierarchical (prevents drift)
- **Max Agents**: 8 (smaller = less drift)
- **Strategy**: specialized (clear roles)
- **Consensus**: raft
- **Memory**: hybrid
- **HNSW**: Enabled
- **Neural**: Enabled

---

## CLI Commands (26 Commands, 140+ Subcommands)

### Core Commands

| Command     | Subcommands | Description                                                              |
|-------------|-------------|--------------------------------------------------------------------------|
| `init`      | 4           | Project initialization with wizard, presets, skills, hooks               |
| `agent`     | 8           | Agent lifecycle (spawn, list, status, stop, metrics, pool, health, logs) |
| `swarm`     | 6           | Multi-agent swarm coordination and orchestration                         |
| `memory`    | 11          | AgentDB memory with vector search (150x-12,500x faster)                  |
| `mcp`       | 9           | MCP server management and tool execution                                 |
| `task`      | 6           | Task creation, assignment, and lifecycle                                 |
| `session`   | 7           | Session state management and persistence                                 |
| `config`    | 7           | Configuration management and provider setup                              |
| `status`    | 3           | System status monitoring with watch mode                                 |
| `workflow`  | 6           | Workflow execution and template management                               |
| `hooks`     | 17          | Self-learning hooks + 12 background workers                              |
| `hive-mind` | 6           | Queen-led Byzantine fault-tolerant consensus                             |

### Advanced Commands

| Command       | Subcommands | Description                                                                   |
|---------------|-------------|-------------------------------------------------------------------------------|
| `daemon`      | 5           | Background worker daemon (start, stop, status, trigger, enable)               |
| `neural`      | 5           | Neural pattern training (train, status, patterns, predict, optimize)          |
| `security`    | 6           | Security scanning (scan, audit, cve, threats, validate, report)               |
| `performance` | 5           | Performance profiling (benchmark, profile, metrics, optimize, report)         |
| `providers`   | 5           | AI providers (list, add, remove, test, configure)                             |
| `plugins`     | 5           | Plugin management (list, install, uninstall, enable, disable)                 |
| `deployment`  | 5           | Deployment management (deploy, rollback, status, environments, release)       |
| `embeddings`  | 4           | Vector embeddings (embed, batch, search, init) - 75x faster with agentic-flow |
| `claims`      | 4           | Claims-based authorization (check, grant, revoke, list)                       |
| `migrate`     | 5           | V2 to V3 migration with rollback support                                      |
| `epic`        | 3           | Epic orchestrator — run/status/reset with single-branch or auto-merge strategy |
| `doctor`      | 1           | System diagnostics with health checks                                         |
| `completions` | 4           | Shell completions (bash, zsh, fish, powershell)                               |

### Quick Examples (MCP Preferred)

| Task | MCP Tool | CLI Fallback |
|------|----------|-------------|
| Search memory | `mcp__moflo__memory_search` | `memory search --query "..."` |
| Spawn agent | `mcp__moflo__agent_spawn` | `agent spawn -t coder --name my-coder` |
| Init swarm | `mcp__moflo__swarm_init` | `swarm init --v3-mode` |
| System health | `mcp__moflo__system_health` | `doctor --fix` |
| Benchmark | `mcp__moflo__performance_benchmark` | `performance benchmark --suite all` |

**CLI-only (no MCP equivalent — setup tasks):**
```bash
npx flo init --wizard
npx flo daemon start
```

---

## Available Agents (60+ Types)

### Core Development
`coder`, `reviewer`, `tester`, `planner`, `researcher`

### Specialized Agents
`security-architect`, `security-auditor`, `memory-specialist`, `performance-engineer`

### Swarm Coordination
`hierarchical-coordinator`, `mesh-coordinator`, `adaptive-coordinator`, `collective-intelligence-coordinator`, `swarm-memory-manager`

### Consensus & Distributed
`byzantine-coordinator`, `raft-manager`, `gossip-coordinator`, `consensus-builder`, `crdt-synchronizer`, `quorum-manager`, `security-manager`

### Performance & Optimization
`perf-analyzer`, `performance-benchmarker`, `task-orchestrator`, `memory-coordinator`, `smart-agent`

### GitHub & Repository
`github-modes`, `pr-manager`, `code-review-swarm`, `issue-tracker`, `release-manager`, `workflow-automation`, `project-board-sync`, `repo-architect`, `multi-repo-swarm`

### SPARC Methodology
`sparc-coord`, `sparc-coder`, `specification`, `pseudocode`, `architecture`, `refinement`

### Specialized Development
`backend-dev`, `mobile-dev`, `ml-developer`, `cicd-engineer`, `api-docs`, `system-architect`, `code-analyzer`, `base-template-generator`

### Testing & Validation
`tdd-london-swarm`, `production-validator`

### Agent Routing (Anti-Drift)

| Code | Task        | Agents                                          |
|------|-------------|-------------------------------------------------|
| 1    | Bug Fix     | coordinator, researcher, coder, tester          |
| 3    | Feature     | coordinator, architect, coder, tester, reviewer |
| 5    | Refactor    | coordinator, architect, coder, reviewer         |
| 7    | Performance | coordinator, perf-engineer, coder               |
| 9    | Security    | coordinator, security-architect, auditor        |
| 11   | Docs        | researcher, api-docs                            |

**Codes 1-9: hierarchical/specialized (anti-drift). Code 11: mesh/balanced**

---

## Hooks System (27 Hooks + 12 Workers)

### All Available Hooks

| Hook               | Description                              | Key Options                                 |
|--------------------|------------------------------------------|---------------------------------------------|
| `pre-edit`         | Get context before editing files         | `--file`, `--operation`                     |
| `post-edit`        | Record editing outcome for learning      | `--file`, `--success`, `--train-neural`     |
| `pre-command`      | Assess risk before commands              | `--command`, `--validate-safety`            |
| `post-command`     | Record command execution outcome         | `--command`, `--track-metrics`              |
| `pre-task`         | Record task start, get agent suggestions | `--description`, `--coordinate-swarm`       |
| `post-task`        | Record task completion for learning      | `--task-id`, `--success`, `--store-results` |
| `session-start`    | Start/restore session                    | `--session-id`, `--auto-configure`          |
| `session-end`      | End session and persist state            | `--generate-summary`, `--export-metrics`    |
| `session-restore`  | Restore a previous session               | `--session-id`, `--latest`                  |
| `route`            | Route task to optimal agent              | `--task`, `--context`, `--top-k`            |
| `explain`          | Explain routing decision                 | `--topic`, `--detailed`                     |
| `pretrain`         | Bootstrap intelligence from repo         | `--model-type`, `--epochs`                  |
| `build-agents`     | Generate optimized agent configs         | `--agent-types`, `--focus`                  |
| `metrics`          | View learning metrics dashboard          | `--v3-dashboard`, `--format`                |
| `transfer`         | Transfer patterns via IPFS registry      | `store`, `from-project`                     |
| `intelligence`     | RuVector intelligence system             | `trajectory-*`, `pattern-*`, `stats`        |
| `worker`           | Background worker management             | `list`, `dispatch`, `status`, `detect`      |
| `coverage-route`   | Route based on test coverage gaps        | `--task`, `--path`                          |
| `coverage-suggest` | Suggest coverage improvements            | `--path`                                    |
| `coverage-gaps`    | List coverage gaps with priorities       | `--format`, `--limit`                       |

### 12 Background Workers

| Worker        | Priority | Description                |
|---------------|----------|----------------------------|
| `ultralearn`  | normal   | Deep knowledge acquisition |
| `optimize`    | high     | Performance optimization   |
| `consolidate` | low      | Memory consolidation       |
| `predict`     | normal   | Predictive preloading      |
| `audit`       | critical | Security analysis          |
| `map`         | normal   | Codebase mapping           |
| `preload`     | low      | Resource preloading        |
| `deepdive`    | normal   | Deep code analysis         |
| `document`    | normal   | Auto-documentation         |
| `refactor`    | normal   | Refactoring suggestions    |
| `benchmark`   | normal   | Performance benchmarking   |
| `testgaps`    | normal   | Test coverage analysis     |

### Essential Hook Commands (MCP Preferred)

| Hook | MCP Tool | Key Params |
|------|----------|------------|
| Pre-task | `mcp__moflo__hooks_pre-task` | `description` |
| Post-task | `mcp__moflo__hooks_post-task` | `taskId`, `success` |
| Post-edit | `mcp__moflo__hooks_post-edit` | `file`, `trainNeural` |
| Session-start | `mcp__moflo__hooks_session-start` | `sessionId` |
| Session-end | `mcp__moflo__hooks_session-end` | `exportMetrics` |
| Route | `mcp__moflo__hooks_route` | `task` |
| Worker-dispatch | `mcp__moflo__hooks_worker-dispatch` | `trigger` |

---

## Hive-Mind Consensus

### Topologies
- `hierarchical` - Queen controls workers directly
- `mesh` - Fully connected peer network
- `hierarchical-mesh` - Hybrid (recommended)
- `adaptive` - Dynamic based on load

### Consensus Strategies
- `byzantine` - BFT (tolerates f < n/3 faulty)
- `raft` - Leader-based (tolerates f < n/2)
- `gossip` - Epidemic for eventual consistency
- `crdt` - Conflict-free replicated data types
- `quorum` - Configurable quorum-based

---

## RuVector Integration (HNSW Vector Search)

| Feature | Performance | Description |
|---------|-------------|-------------|
| **HNSW Index** | 150x-12,500x faster | Hierarchical Navigable Small World search |
| **MicroLoRA** | <100us adaptation | Fast model adaptation (508k+ ops/sec) |
| **FlashAttention** | 2.49x-7.47x speedup | Optimized attention computation |
| **Int8 Quantization** | 3.92x memory reduction | Compressed weight storage |

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

## Environment Variables

```bash
# Configuration
CLAUDE_FLOW_CONFIG=./claude-flow.config.json
CLAUDE_FLOW_LOG_LEVEL=info

# MCP Server
CLAUDE_FLOW_MCP_PORT=3000
CLAUDE_FLOW_MCP_HOST=localhost
CLAUDE_FLOW_MCP_TRANSPORT=stdio

# Memory
CLAUDE_FLOW_MEMORY_BACKEND=hybrid
CLAUDE_FLOW_MEMORY_PATH=./data/memory
```

---

## Quick Setup

### Project-Level MCP (Recommended)

Configure `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "moflo": {
      "command": "node",
      "args": ["node_modules/moflo/src/modules/cli/bin/cli.js", "mcp", "start"]
    }
  }
}
```

### Alternative: Global MCP Registration

```bash
claude mcp add moflo -- npx @moflo/cli@alpha
npx flo daemon start
npx flo doctor --fix
```

---

## Project Configuration (moflo.yaml)

Moflo reads `moflo.yaml` (or `moflo.config.json`) from the project root. All fields have sensible defaults — the file is optional.

### Full Reference

```yaml
project:
  name: "my-project"              # Project name (default: directory name)

# Guidance/knowledge docs to index for semantic search
guidance:
  directories:                    # Directories to scan for .md files
    - .claude/guidance            # Default
    - docs/guides                 # Default
  namespace: guidance             # Memory namespace for indexed docs

# Source directories for code navigation map
code_map:
  directories:                    # Directories to scan for source files
    - src                         # Default
    - packages
    - lib
    - app
  extensions: [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java"]
  exclude: [node_modules, dist, .next, coverage, build, __pycache__, target, .git]
  namespace: code-map

# Workflow gates (enforced via Claude Code hooks)
# Memory-first is enforced at the scan/read layer (Glob, Grep, Read gates).
# Agent spawning is never blocked — SubagentStart hook injects guidance directive.
gates:
  memory_first: true              # Block Glob/Grep/Read until memory is searched
  task_create_first: true         # Advisory reminder before Agent tool (not blocking)
  context_tracking: true          # Track context bracket (FRESH/MODERATE/DEPLETED/CRITICAL)

# Auto-index on session start
auto_index:
  guidance: true                  # Run flo-index (guidance RAG indexer)
  code_map: true                  # Run flo-codemap (structural code index)

# Memory backend
memory:
  backend: sql.js                 # sql.js (WASM) | agentdb | json
  embedding_model: Xenova/all-MiniLM-L6-v2   # 384-dim neural embeddings
  namespace: default              # Default namespace for memory operations

# Hook toggles (all on by default — disable to slim down)
hooks:
  pre_edit: true                  # Track file edits for learning
  post_edit: true                 # Record edit outcomes, train neural patterns
  pre_task: true                  # Get agent routing before task spawn
  post_task: true                 # Record task results for learning
  gate: true                      # Workflow gate enforcement (memory-first at scan/read layer)
  route: true                     # Intelligent task routing on each prompt
  stop_hook: true                 # Session-end persistence and metric export
  session_restore: true           # Restore session state on start
  notification: true              # Hook into Claude Code notifications

# Model preferences (haiku, sonnet, opus)
models:
  default: opus                  # General tasks
  research: sonnet               # Research/exploration agents
  review: opus                   # Code review agents
  test: sonnet                   # Test-writing agents

# Intelligent model routing (auto-selects haiku/sonnet/opus per task)
model_routing:
  enabled: false                 # Set true to enable dynamic routing
  confidence_threshold: 0.85     # Min confidence before escalating
  cost_optimization: true        # Prefer cheaper models when confident
  circuit_breaker: true          # Penalize models that fail repeatedly
  # agent_overrides:
  #   security-architect: opus
  #   researcher: sonnet

# Status line display
status_line:
  enabled: true                  # Show status line at all
  branding: "Moflo V4"          # Text in status bar
  mode: single-line              # single-line (default) or dashboard (multi-line)
  show_git: true                 # Git branch, changes, ahead/behind
  show_model: true               # Current model name
  show_session: true             # Session duration
  show_intelligence: true        # Intelligence % indicator
  show_swarm: true               # Active swarm agents count
  show_hooks: true               # Enabled hooks count
  show_mcp: true                 # MCP server count
  show_security: true            # CVE/security status (dashboard only)
  show_adrs: true                # ADR compliance (dashboard only)
  show_agentdb: true             # AgentDB vectors/size (dashboard only)
  show_tests: true               # Test file count (dashboard only)

# Spell step sandboxing (OS-level process isolation for bash steps)
# Platform support: macOS (sandbox-exec), Linux/WSL (bwrap). Windows has no OS sandbox.
sandbox:
  enabled: false                 # Set to true to wrap bash steps in an OS sandbox
  tier: auto                     # auto | denylist-only | full
```

If your `moflo.yaml` predates the `sandbox:` block, it is auto-appended on the next session start — you never need to re-run `moflo init` after a version bump.

### Key Behaviors

| Config | Effect |
|--------|--------|
| `auto_index.guidance: false` | Skip guidance indexing on session start |
| `auto_index.code_map: false` | Skip code map generation on session start |
| `gates.memory_first: true` | Block Glob/Grep/Read until memory is searched first |
| `gates.task_create_first: true` | Advisory reminder before Agent tool (not blocking) |
| `gates.context_tracking: true` | Show FRESH/MODERATE/DEPLETED/CRITICAL context bracket |
| `hooks.pre_edit: false` | Disable file-edit tracking (skips pre-edit hook) |
| `hooks.post_edit: false` | Disable edit outcome recording and neural training |
| `hooks.pre_task: false` | Disable agent routing recommendations before spawn |
| `hooks.post_task: false` | Disable task result recording for learning |
| `hooks.gate: false` | Disable all workflow gates (memory-first, task-create-first) |
| `hooks.route: false` | Disable intelligent task routing on each prompt |
| `hooks.stop_hook: false` | Disable session-end persistence and metric export |
| `hooks.notification: false` | Disable notification hook |
| `model_routing.enabled: true` | Auto-select haiku/sonnet/opus based on task complexity |
| `status_line.mode: dashboard` | Switch to multi-line status display |
| `status_line.show_swarm: false` | Hide swarm agent count from status bar |
| `sandbox.enabled: true` | Wrap bash steps in an OS sandbox (macOS/Linux/WSL) — absolute disable when `false`, regardless of tier |
| `sandbox.tier: full` | Require OS sandbox; throw at runtime if the platform tool is unavailable |
| `sandbox.tier: denylist-only` | Keep Layer 1 denylist only; skip OS isolation even when enabled |

---

## Cross-Platform Compatibility

All code changes MUST work on Windows, macOS, and Linux. Follow these rules:

- **Paths**: Use `path.join()` / `path.resolve()`, never hardcoded `/` or `\\` separators
- **Process spawning**: Use `detached: !isWin` for background processes; on Windows use `shell: true, windowsHide: true` instead
- **Process killing**: Use `taskkill /F /PID` on Windows, `process.kill(pid, signal)` on POSIX
- **Process inspection**: Use PowerShell `Get-CimInstance` on Windows, `/proc/<pid>/cmdline` on Linux, `ps -p <pid>` on macOS
- **Shell commands**: Never assume bash — use `child_process.spawn` with explicit args instead of shell string interpolation
- **File locking**: Use `fs.writeFileSync(path, data, { flag: 'wx' })` for atomic locks (works cross-platform)
- **Signals**: SIGHUP/SIGTERM are POSIX-only; on Windows use `taskkill` or process exit events
- **Line endings**: Use `\n` in code; let git handle CRLF conversion
- **Temp dirs**: Use `os.tmpdir()`, not `/tmp`
- **PID recycling**: Windows recycles PIDs aggressively — always verify process command line, not just PID liveness

## Troubleshooting Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| No MCP tools available | `.mcp.json` missing or moflo not installed | Run `npx flo init` or manually create `.mcp.json` |
| Memory search returns nothing | Indexer hasn't run yet | Run `npx flo-index --force` to index guidance |
| Low search quality | Guidance docs missing `**Purpose:**` lines or generic headings | Follow guidance optimization rules in `guidance-memory-strategy.md` |
| Session start slow | All three indexers running | Set `auto_index.code_map: false` in `moflo.yaml` if code map not needed |
| Status line not showing | `statusline.cjs` error or `status_line.enabled: false` | Run `node .claude/helpers/statusline.cjs` to test, check `moflo.yaml` |
| Embeddings falling back to hash | Transformers.js not available | Install `@xenova/transformers` — moflo includes it but some environments strip it |
| `flo` command not found | Not in PATH | Use `npx flo` or `node node_modules/moflo/bin/index-guidance.mjs` |
| Bundled guidance not indexed | Running inside moflo repo (same dir) | Bundled guidance only indexes when installed as a dependency in a different project |

See `moflo-memory-strategy.md` for memory-specific troubleshooting.

---

## See Also

- `.claude/guidance/moflo-subagents.md` - Subagents memory-first protocol and store patterns
- `.claude/guidance/moflo-claude-swarm-cohesion.md` - Task & swarm coordination with TaskCreate/TaskUpdate
- `.claude/guidance/moflo-memory-strategy.md` - Database schema, namespaces, search commands, RAG linking
- `.claude/guidance/guidance-memory-strategy.md` - How to write guidance docs that index well for RAG
