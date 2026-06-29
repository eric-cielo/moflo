# Moflo CLI Surface — Commands, Agents, Hooks

**Purpose:** Reference for moflo's CLI command surface, available agents, hooks, and consensus topologies. Use this when picking a command/agent/hook by name; for higher-level workflow guidance see `moflo-core-guidance.md`, and for `moflo.yaml` knobs that gate this surface see `moflo-yaml-reference.md`.

---

## CLI Commands (26 Commands, 140+ Subcommands)

### Core Commands

| Command     | Subcommands | Description                                                              |
|-------------|-------------|--------------------------------------------------------------------------|
| `init`      | 4           | Project initialization with wizard, presets, skills, hooks               |
| `agent`     | 8           | Agent lifecycle (spawn, list, status, stop, metrics, pool, health, logs) |
| `swarm`     | 6           | Multi-agent swarm coordination and orchestration                         |
| `memory`    | 11          | node:sqlite + HNSW vector search, 150x-12,500x faster                    |
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
| `embeddings`  | 4           | Vector embeddings (embed, batch, search, init) — fastembed runtime            |
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

## Available Agents

The shipped agent roster — each is invoked via the `Agent` tool with `subagent_type: <name>`. The canonical handle is the `name:` frontmatter inside `.claude/agents/**/*.md` (filename may differ from agent name). Aspirational agents that never shipped were retired in #932 — `retired-files.json` enforces auto-prune on consumer upgrade.

### Core Development
`coder`, `reviewer`, `tester`, `planner`, `researcher`, `analyst`

### Specialized Development
`backend-dev`, `frontend-dev`, `database-dev`, `cicd-engineer`, `api-docs`, `system-architect`, `code-analyzer`, `base-template-generator`

### Quality & Security
`security-auditor`, `test-long-runner`

### Agent Routing (Anti-Drift)

The orchestrator is the calling Claude, not a named agent. Pick specialists from the roster above.

| Code | Task        | Agents                                            |
|------|-------------|---------------------------------------------------|
| 1    | Bug Fix     | researcher, coder, tester                         |
| 3    | Feature     | system-architect, coder, tester, reviewer         |
| 5    | Refactor    | analyst, coder, reviewer                          |
| 7    | Performance | analyst, coder                                    |
| 9    | Security    | security-auditor, code-analyzer                   |
| 11   | Docs        | researcher, api-docs                              |

**Codes 1-9: hierarchical/specialized (anti-drift). Code 11: mesh/balanced.**

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

### Background Workers

The daemon ships nine workers — four scheduled by default plus five
manual-trigger only. The pre-#970 `audit`, `predict`, and `document`
workers were removed because they ran without a surfacing layer for
findings; if AI-driven security scanning returns it should be an opt-in
`flo doctor` one-shot, not a recurring background task.

| Worker        | Priority | Default       | Description                |
|---------------|----------|---------------|----------------------------|
| `map`         | normal   | scheduled 15m | Codebase mapping           |
| `optimize`    | high     | scheduled 15m | Performance optimization   |
| `consolidate` | low      | scheduled 30m | Memory consolidation       |
| `testgaps`    | normal   | scheduled 20m | Test coverage analysis     |
| `ultralearn`  | normal   | manual        | Deep knowledge acquisition |
| `refactor`    | normal   | manual        | Refactoring suggestions    |
| `deepdive`    | normal   | manual        | Deep code analysis         |
| `benchmark`   | normal   | manual        | Performance benchmarking   |
| `preload`     | low      | manual        | Resource preloading        |

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

- `hierarchical` — Queen controls workers directly
- `mesh` — Fully connected peer network
- `hierarchical-mesh` — Hybrid (recommended)
- `adaptive` — Dynamic based on load

### Consensus Strategies

- `byzantine` — BFT (tolerates f < n/3 faulty)
- `raft` — Leader-based (tolerates f < n/2)
- `gossip` — Epidemic for eventual consistency
- `crdt` — Conflict-free replicated data types
- `quorum` — Configurable quorum-based

---

## RuVector Integration (HNSW Vector Search)

| Feature | Performance | Description |
|---------|-------------|-------------|
| **HNSW Index** | 150x–12,500x faster | Hierarchical Navigable Small World search |
| **MicroLoRA** | <100µs adaptation | Fast model adaptation (508k+ ops/sec) |
| **FlashAttention** | 2.49x–7.47x speedup | Optimized attention computation |
| **Int8 Quantization** | 3.92x memory reduction | Compressed weight storage |

---

## See Also

- `.claude/guidance/moflo-skills-reference.md` — The slash-command surface (skills) that complements these CLI commands, plus moflo's automatic features
- `.claude/guidance/moflo-core-guidance.md` — Hub: getting started, MCP setup, troubleshooting, comparison table
- `.claude/guidance/moflo-yaml-reference.md` — `moflo.yaml` schema and runtime env-var overrides for the surfaces listed here
- `.claude/guidance/moflo-claude-swarm-cohesion.md` — How TaskCreate + swarm coordinators cooperate (uses the agent codes above)
- `.claude/guidance/moflo-subagents.md` — Subagent memory-first protocol and store-back rules
- `.claude/guidance/moflo-memory-strategy.md` — Memory namespaces, RAG linking, and search query patterns
- `.claude/guidance/moflo-memorydb-maintenance.md` — How the namespaces above are populated and refreshed
- `.claude/guidance/moflo-cross-install-memory-sharing.md` — `flo memory sync` / `team-export` / `team-import` and `flo doctor -c shared-db` for sharing durable learnings across worktrees, machines, and teams
