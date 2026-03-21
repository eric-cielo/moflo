<p align="center">
  <img src="https://raw.githubusercontent.com/eric-cielo/moflo/main/docs/Moflo_md.png?v=5" alt="MoFlo" />
</p>

# MoFlo

**An opinionated fork of [Ruflo/Claude Flow](https://github.com/ruvnet/ruflo), optimized for local development.**

MoFlo adds automatic code and guidance cataloging along with memory gating on top of the original Ruflo/Claude Flow orchestration engine. Where the upstream project provides raw building blocks, MoFlo ships opinionated defaults — workflow gates that enforce memory-first patterns, semantic indexing that runs at session start, and learned routing that improves over time — so you get a productive setup from `flo init` without manual tuning.

Install it as a dev dependency and run `flo init`.

## Opinionated Defaults

MoFlo makes deliberate choices so you don't have to:

- **Fully self-contained** — No external services, no cloud dependencies, no API keys. Everything runs locally on your machine.
- **Node.js runtime** — Targets Node.js specifically. All scripts, hooks, and tooling are JavaScript/TypeScript. No Python, no Rust binaries, no native compilation.
- **sql.js (WASM)** — The memory database uses sql.js, a pure WebAssembly build of SQLite. No native `better-sqlite3` bindings to compile, no platform-specific build steps. Works identically on Windows, macOS, and Linux.
- **Simplified embeddings pipeline** — 384-dimensional neural embeddings via Transformers.js (MiniLM-L6-v2, WASM). Same model and precision as the upstream multi-provider pipeline, but simpler — two scripts instead of an abstraction layer. Runs locally, no API calls.
- **Full learning stack wired up OOTB** — The following are all configured and functional from `flo init`, no manual setup:
  - **SONA** (Self-Optimizing Neural Architecture) — learns from task trajectories via `@ruvector/sona` (Rust/NAPI)
  - **MicroLoRA** — rank-2 LoRA weight adaptations at ~1µs per adapt via `@ruvector/learning-wasm` (WASM)
  - **EWC++** (Elastic Weight Consolidation) — prevents catastrophic forgetting across sessions
  - **HNSW Vector Search** — fast nearest-neighbor search via `@ruvector/core` VectorDb
  - **Semantic Routing** — maps tasks to agents via `@ruvector/router` SemanticRouter
  - **Trajectory Persistence** — outcomes stored in `routing-outcomes.json`, survive across sessions
  - All WASM/NAPI-based, no GPU, no API keys, no external services.
- **Memory-first workflow** — Claude must search what it already knows before exploring files. Enforced by hooks, not just instructions.
- **Task registration before agents** — Sub-agents can't spawn until work is tracked. Prevents runaway agent proliferation.
- **Learned routing** — Task outcomes feed back into the routing system automatically. No manual configuration needed — it gets smarter with use.
- **Incremental indexing** — Guidance and code map indexes run on every session start but skip unchanged files. Fast after the first run.
- **AI client agnostic** — Works with any MCP-capable AI client. We develop and test with Claude Code, but the MCP tools, memory system, and hooks are client-independent.
- **GitHub-oriented** — The `/flo` skill, PR workflows, and issue tracking are built around GitHub. With Claude's help, you can adapt them to your own issue tracker and source control system.
- **Cross-platform** — Forward-slash path normalization, no `sh -c` shell commands, `windowsHide` on all spawn calls.

## Features

| Feature | What It Does |
|---------|-------------|
| **Semantic Memory** | 384-dim domain-aware embeddings. Store knowledge, search it instantly. |
| **Code Navigation** | Indexes your codebase structure so Claude can answer "where does X live?" without Glob/Grep. |
| **Guidance Indexing** | Chunks your project docs (`.claude/guidance/`, `docs/`) and makes them searchable. |
| **Workflow Gates** | Enforces memory-first and task-creation patterns via Claude Code hooks. Prevents Claude from skipping steps. |
| **Learned Routing** | Routes tasks to the right agent type. Learns from outcomes — gets better over time. |
| **`/flo` Skill** | Execute GitHub issues through a full workflow: research → enhance → implement → test → simplify → PR. (Also available as `/fl`.) |
| **Context Tracking** | Monitors context window usage (FRESH → MODERATE → DEPLETED → CRITICAL) and advises accordingly. |
| **Cross-Platform** | Works on macOS, Linux, and Windows. |

## Getting Started

### 1. Install and init

```bash
npm install --save-dev moflo
npx flo init
```

`flo init` automatically scans your project to find where your guidance and code live, then writes the results into `moflo.yaml`. It looks for:

| What | Directories it checks | Default if none found |
|------|----------------------|----------------------|
| **Guidance** | `.claude/guidance`, `docs/guides`, `docs`, `architecture`, `adr`, `.cursor/rules` | `.claude/guidance` |
| **Source code** | `src`, `packages`, `lib`, `app`, `apps`, `services`, `server`, `client` | `src` |
| **Languages** | Scans detected source dirs for file extensions | `.ts`, `.tsx`, `.js`, `.jsx` |

It also generates:

| Generated File | Purpose |
|----------------|---------|
| `moflo.yaml` | Project config with detected guidance/code locations |
| `.claude/settings.json` | Workflow gate hooks for Claude Code |
| `.claude/skills/flo/` | The `/flo` issue execution skill (also `/fl`) |
| `CLAUDE.md` section | Teaches Claude how to use MoFlo |
| `.gitignore` entries | Excludes MoFlo state directories |

In interactive mode (`flo init` without `--yes`), it shows what it found and lets you confirm or adjust before writing.

### 2. Review your guidance and code settings

Open `moflo.yaml` to see what init detected. The two key sections:

**Guidance** — documentation that helps Claude understand your project (conventions, architecture, domain context):

```yaml
guidance:
  directories:
    - .claude/guidance    # project rules, patterns, conventions
    - docs                # general documentation
```

**Code map** — source files to index for "where does X live?" navigation:

```yaml
code_map:
  directories:
    - src                 # your source code
    - packages            # shared packages (monorepo)
  extensions: [".ts", ".tsx"]
  exclude: [node_modules, dist, .next, coverage]
```

MoFlo chunks your guidance files into semantic embeddings and indexes your code structure, so Claude searches your knowledge base before touching any files. Adjust these directories to match your project:

```yaml
# Monorepo with shared docs
guidance:
  directories: [.claude/guidance, docs, packages/shared/docs]
code_map:
  directories: [packages, apps, libs]

# Backend + frontend
code_map:
  directories: [server/src, client/src]
```

### 3. Index and verify

```bash
npx flo memory index-guidance    # Index your guidance docs
npx flo memory code-map          # Index your code structure
npx flo doctor                   # Verify everything works
```

Both indexes run automatically at session start after this, so you only need to run them manually on first setup or after major structural changes.

## The `/flo` Skill

Inside your AI client, the `/flo` (or `/fl`) slash command drives GitHub issue workflows:

```
/flo <issue>                  # Full workflow (research → implement → test → PR)
/flo -t <issue>               # Ticket only (research and update ticket, then stop)
/flo -r <issue>               # Research only (analyze issue, output findings)
/flo -s <issue>               # Swarm mode (default, multi-agent coordination)
/flo -h <issue>               # Hive-mind mode (consensus-based coordination)
/flo -n <issue>               # Normal mode (single agent, no swarm)
```

For full options and details, type `/flo` with no arguments — your AI client will display the complete skill documentation. Also available as `/fl`.

### Epic handling

When you pass an issue number, `/flo` automatically checks if it's an epic — no extra flag needed. An issue is treated as an epic if any of these are true:

- It has a label matching `epic`, `tracking`, `parent`, or `umbrella` (case-insensitive)
- Its body contains a `## Stories` or `## Tasks` section
- Its body has checklist-linked issues: `- [ ] #101`
- Its body has numbered issue references: `1. #101`
- The issue has GitHub sub-issues (via the API)

When an epic is detected, `/flo` processes each child story sequentially — full workflow per story (research → implement → test → PR), one at a time, in the order listed.

For simple epics with independent stories, `/flo <epic>` is all you need. For complex features where you want state tracking, resume capability, and auto-merge between stories, use `flo orc` instead.

### Feature Orchestration (`flo orc`)

`flo orc` is the robust epic runner — it adds persistent state, resume from failure, and auto-merge between stories on top of `/flo`. It accepts either a GitHub issue number or a YAML file:

```bash
# From a GitHub epic (auto-detects stories)
flo orc run 42                        # Fetch epic #42, run all stories sequentially
flo orc run 42 --dry-run              # Preview execution plan without running
flo orc run 42 --no-merge             # Skip auto-merge between stories

# From a YAML definition (explicit dependencies)
flo orc run feature.yaml              # Execute stories in dependency order
flo orc run feature.yaml --dry-run    # Show execution plan
flo orc run feature.yaml --verbose    # Stream Claude output to terminal

# State management
flo orc status epic-42                # Check progress (which stories passed/failed)
flo orc reset epic-42                 # Reset state for re-run
```

When given an issue number, `flo orc` fetches the epic from GitHub, extracts child stories from checklists and numbered references, then runs each through `/flo` with state tracking. If a story fails, you can fix the issue and `flo orc run 42` again — it resumes from where it left off, skipping already-passed stories.

For features with inter-story dependencies (story B requires story A to be merged first), use a YAML definition:

```yaml
feature:
  id: my-feature
  name: "My Feature"
  repository: /path/to/project
  base_branch: main

  stories:
    - id: story-1
      name: "Entity and service"
      issue: 101

    - id: story-2
      name: "Routes and tests"
      issue: 102
      depends_on: [story-1]
```

| | `/flo <epic>` | `flo orc run <epic>` |
|---|---|---|
| **State tracking** | No | Yes (`.claude-orc/state.json`) |
| **Resume from failure** | No | Yes (skips passed stories) |
| **Auto-merge PRs** | No | Yes (between stories) |
| **Dry-run preview** | No | Yes |
| **Dependency ordering** | No (top-to-bottom) | Yes (YAML only, topological sort) |

## Commands

You don't need to run these for normal use — `flo init` sets everything up, and the hooks handle memory, routing, and learning automatically. These commands are here for manual setup, debugging, and tweaking.

### Memory

```bash
flo memory store -k "key" --value "data"    # Store with 384-dim embedding
flo memory search -q "auth patterns"         # Semantic search
flo memory index-guidance                    # Index guidance docs
flo memory code-map                          # Index code structure
flo memory rebuild-index                     # Regenerate all embeddings
flo memory stats                             # Show statistics
```

### Routing & Learning

```bash
flo hooks route --task "description"          # Route task to optimal agent
flo hooks learn --pattern "..." --domain "."  # Store a pattern
flo hooks patterns                            # List learned patterns
flo hooks consolidate                         # Promote/prune patterns
```

### Workflow Gates

```bash
flo gate check-before-scan       # Blocks Glob/Grep if memory not searched
flo gate check-before-agent      # Blocks Agent tool if no TaskCreate
flo gate prompt-reminder         # Context bracket tracking
flo gate session-reset           # Reset workflow state
```

### System

```bash
flo init                          # Initialize project (one-time setup)
flo doctor                       # Health check
flo --version                    # Show version
```


## Full Configuration Reference

`flo init` generates a `moflo.yaml` at your project root. Here's the complete set of options:

```yaml
project:
  name: "my-project"

guidance:
  directories: [.claude/guidance]
  namespace: guidance

code_map:
  directories: [src, packages]
  extensions: [".ts", ".tsx"]
  exclude: [node_modules, dist]
  namespace: code-map

gates:
  memory_first: true                 # Must search memory before file exploration
  task_create_first: true            # Must TaskCreate before Agent tool
  context_tracking: true             # Track context window depletion

auto_index:
  guidance: true                     # Auto-index docs on session start
  code_map: true                     # Auto-index code on session start

mcp:
  tool_defer: true                   # Defer 150+ tool schemas; loaded on demand via ToolSearch
  auto_start: false                  # Auto-start MCP server on session begin

hooks:
  pre_edit: true                     # Track file edits for learning
  post_edit: true                    # Record edit outcomes
  pre_task: true                     # Agent routing before task spawn
  post_task: true                    # Record task results for learning
  gate: true                         # Workflow gate enforcement
  route: true                        # Intelligent task routing
  stop_hook: true                    # Session-end persistence
  session_restore: true              # Restore session state on start

models:
  default: opus
  research: sonnet
  review: opus
  test: sonnet

model_routing:
  enabled: false                     # Set to true for automatic model selection
  confidence_threshold: 0.85
  cost_optimization: true
  circuit_breaker: true

status_line:
  enabled: true
  branding: "MoFlo V4"
  mode: compact                      # single-line, compact, or dashboard
  show_dir: true                      # current directory name (compact/dashboard only)
  show_git: true
  show_session: true
  show_swarm: true
  show_agentdb: true
  show_mcp: true
```

### Tool Deferral

By default, `tool_defer` is `true`. MoFlo exposes 150+ MCP tools — loading all their schemas at conversation start consumes significant context. With deferral enabled, only tool **names** are listed at startup (compact), and full schemas are fetched on demand via `ToolSearch` when actually needed. Hooks and CLI commands continue to work normally since they call the daemon directly, not through MCP tool schemas.

Set `tool_defer: false` if you want all tool schemas available immediately (useful for offline/air-gapped environments where `ToolSearch` may not work).

### Model Routing

By default, MoFlo uses **static model preferences** — each agent role uses the model specified in `models:`. This is predictable and gives you full control.

Set `model_routing.enabled: true` to enable **intelligent routing**, which analyzes each task's complexity and auto-selects the cheapest capable model:

| Complexity | Model | Example Tasks |
|-----------|-------|---------------|
| Low | Haiku | Typos, renames, config changes, formatting |
| Medium | Sonnet | Implement features, write tests, fix bugs |
| High | Opus | Architecture, security audits, complex debugging |

The router learns from outcomes — if a model fails a task, the circuit breaker penalizes it and escalates to a more capable model.

You can pin specific agents even when routing is enabled:

```yaml
model_routing:
  enabled: true
  agent_overrides:
    security-architect: opus     # Never downgrade security work
    researcher: sonnet           # Pin research to sonnet
```

## How It Works

MoFlo sits between Claude Code and your project. It uses Claude Code's native hook system to enforce good habits, store knowledge, and learn from outcomes — so Claude gets better at working in your codebase over time.

### The Gate System

MoFlo installs Claude Code hooks that run on every tool call. Together, these gates create a **feedback loop** that prevents Claude from wasting tokens on blind exploration and ensures it builds on prior knowledge.

**Memory-first gate** — Before Claude can use Glob, Grep, or Read on guidance files, it must first search the memory database. This forces Claude to check what it already knows (or what was learned in prior sessions) before re-exploring from scratch. The gate automatically classifies each prompt — simple directives like "commit" or "yes" skip the gate, while task-oriented prompts like "fix the auth bug" enforce it.

**Task-create gate** — Before Claude can spawn sub-agents via the Task tool, it must call TaskCreate first. This ensures every agent spawn is tracked, preventing runaway agent proliferation and making it possible to review what work was delegated.

**Context tracking** — Each interaction increments a counter. As the conversation grows, MoFlo warns Claude about context depletion (FRESH → MODERATE → DEPLETED → CRITICAL) and advises it to checkpoint progress, compact, or start a fresh session before quality degrades.

**Routing** — On each prompt, MoFlo's route hook analyzes the task and recommends the optimal agent type and model tier (haiku for simple tasks, sonnet for moderate, opus for complex). This saves cost without sacrificing quality.

All gates are configurable via `moflo.yaml` — you can disable any individual hook if it doesn't suit your workflow.

### Intelligent Agent Routing

MoFlo ships with 12 built-in task patterns that map common work to the right agent type:

| Pattern | Keywords | Primary Agent |
|---------|----------|---------------|
| security-task | auth, password, encryption, CVE | security-architect |
| testing-task | test, spec, coverage, e2e | tester |
| database-task | schema, migration, SQL, ORM | architect |
| feature-task | implement, add, create, build | architect → coder |
| bugfix-task | bug, fix, error, crash, debug | coder |
| api-task | endpoint, REST, route, handler | architect → coder |
| ... | | *(12 patterns total)* |

When you route a task (`flo hooks route --task "..."` or via MCP), MoFlo runs semantic similarity against these patterns using HNSW vector search and returns a ranked recommendation with confidence scores.

**The routing gets smarter over time.** Every time a task completes successfully, MoFlo's post-task hook records the outcome — the full task description, which agent handled it, and whether it succeeded. These learned patterns are combined with the built-in seeds on every future route call. Because learned patterns contain rich task descriptions (not just short keywords), they discriminate better as they accumulate.

Routing outcomes are stored in `.claude-flow/routing-outcomes.json` and persist across sessions. You can inspect them with `flo hooks patterns` or transfer them between projects with `flo hooks transfer`.

### What Ships Out of the Box

`flo init` wires up the following systems automatically — no configuration needed:

| System | What It Does | Technology |
|--------|-------------|------------|
| **Semantic Memory** | Store and search knowledge with 384-dim embeddings | sql.js (WASM SQLite) + Transformers.js (MiniLM-L6-v2) |
| **HNSW Vector Search** | Fast nearest-neighbor search across all stored knowledge | `@ruvector/core` VectorDb |
| **Semantic Routing** | Match tasks to agent types using vector similarity | `@ruvector/router` SemanticRouter |
| **SONA Learning** | Learn from task trajectories — what agent handled what, and whether it succeeded | `@ruvector/sona` SonaEngine (Rust/NAPI) |
| **MicroLoRA Adaptation** | Rank-2 LoRA weight updates from successful patterns (~1µs per adapt) | `@ruvector/learning-wasm` |
| **EWC++ Consolidation** | Prevent catastrophic forgetting — new learning doesn't overwrite old patterns | Built into hooks-tools |
| **Workflow Gates** | Memory-first and task-registration enforcement via Claude Code hooks | `.claude/settings.json` hooks |
| **Context Tracking** | Monitor context window depletion (FRESH → CRITICAL) | Session interaction counter |
| **Guidance Indexing** | Chunk and embed your project docs on session start | `flo-index` bin script |
| **Code Map** | Index source file structure (types, exports, functions) on session start | `flo-codemap` bin script |
| **Learned Routing** | Task outcomes feed back into routing — gets smarter over time | `routing-outcomes.json` persistence |
| **Status Line** | Live dashboard showing git, swarm, memory, and MCP status | `statusline.cjs` hook |

All of these run locally with zero external dependencies. The SONA, MicroLoRA, and HNSW components are WASM/NAPI binaries that ship with the npm package — no compilation, no GPU, no API keys.

### The Two-Layer Task System

MoFlo doesn't replace your AI client's task system — it wraps it. Your client (Claude Code, Cursor, or any MCP-capable tool) handles spawning agents and running code. MoFlo adds a coordination layer on top that handles memory, routing, and learning.

```
┌──────────────────────────────────────────────────┐
│  YOUR AI CLIENT (Execution Layer)                │
│  Spawns agents, runs code, streams output        │
│  TaskCreate → Agent → TaskUpdate → results       │
├──────────────────────────────────────────────────┤
│  MOFLO (Knowledge Layer)                         │
│  Routes tasks, gates agent spawns, stores        │
│  patterns, learns from outcomes                  │
└──────────────────────────────────────────────────┘
```

Here's how a typical task flows through both layers:

1. **MoFlo routes** — Before work starts, MoFlo analyzes the prompt and recommends an agent type and model tier via hook or MCP tool.
2. **MoFlo gates** — Before an agent can spawn, MoFlo verifies that memory was searched and a task was registered. This prevents blind exploration.
3. **Your client executes** — The actual agent runs through your client's native task system. MoFlo doesn't manage the agent — your client handles execution, output, and completion.
4. **MoFlo learns** — After the agent finishes, MoFlo records what worked (or didn't) in its memory database. Successful patterns feed into future routing.

The key insight: **your client handles execution, MoFlo handles knowledge.** Your client is good at spawning agents and running code. MoFlo is good at remembering what happened, routing to the right agent, and ensuring prior knowledge is checked before exploring from scratch.

For complex work, MoFlo structures tasks into waves — a research wave discovers context, then an implementation wave acts on it — with dependencies tracked through both the client's task system and MoFlo's coordination layer. The full integration pattern is documented in `.claude/guidance/task-swarm-integration.md`.

The `/flo` skill ties both systems together for GitHub issues — driving a full workflow (research → enhance → implement → test → simplify → PR) with your client's agents for execution and MoFlo's memory for continuity.

### Memory & Knowledge Storage

MoFlo uses a SQLite database (via sql.js/WASM — no native deps) to store three types of knowledge:

| Namespace | What's Stored | How It Gets There |
|-----------|---------------|-------------------|
| `guidance` | Chunked project docs (`.claude/guidance/`, `docs/`) with 384-dim embeddings | `flo-index` on session start |
| `code-map` | Structural index of source files (exports, classes, functions) | `flo-codemap` on session start |
| `patterns` | Learned patterns from successful task outcomes | Post-task hooks after agent work |

**Semantic search** uses cosine similarity on neural embeddings (MiniLM-L6-v2, 384 dimensions). When Claude searches memory, it gets the most relevant chunks ranked by semantic similarity — not keyword matching.

**Session start indexing** — Three background processes run on every session start: the guidance indexer, the code map generator, and the learning service. All three are incremental (unchanged files are skipped) and run in parallel so they don't block the session.

**Cross-session persistence** — Everything stored in the database survives across sessions. Patterns learned on Monday are available on Friday. The stop hook exports session metrics, and the session-restore hook loads prior state.

### For Claude

When `flo init` runs, it appends a workflow section to your CLAUDE.md that teaches Claude:
- Always search memory before Glob/Grep/Read (enforced by gates)
- Use `mcp__claude-flow__memory_search` for knowledge retrieval
- Use `/flo <issue>` (or `/fl`) for issue execution
- Store learnings after task completion

## Architecture

- **7 standalone bin scripts** shipped with npm: `flo-search`, `flo-embeddings`, `flo-index`, `flo-codemap`, `flo-learn`, `flo-setup`, plus the main `flo` CLI
- **Project config system**: `moflo.yaml` for per-project settings
- **One-stop init**: `flo init` generates everything needed for OOTB operation

## Ruflo / Claude Flow

MoFlo builds on top of the full [Ruflo/Claude Flow](https://github.com/ruvnet/ruflo) engine. For detailed documentation on the underlying capabilities — swarm topologies, hive-mind consensus, HNSW vector search, neural routing, MCP server internals, and more — check out the [Ruflo repository](https://github.com/ruvnet/ruflo).

## License

MIT (inherited from [Ruflo/Claude Flow](https://github.com/ruvnet/ruflo))
