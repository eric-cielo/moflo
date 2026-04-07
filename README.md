<p align="center">
  <img src="https://raw.githubusercontent.com/eric-cielo/moflo/main/docs/Moflo_md.png?v=6" alt="MoFlo" />
</p>

# MoFlo

**An opinionated fork of [Ruflo/Claude Flow](https://github.com/ruvnet/ruflo), optimized for local development.**

## TL;DR

MoFlo makes your AI coding assistant remember what it learns, check what it knows before exploring files, and get smarter over time — all automatically. Install it, run `flo init`, restart your AI client, and everything just works: your docs and code are indexed on session start so the AI can search them instantly, workflow gates prevent the AI from wasting tokens on blind exploration, task outcomes feed back into routing so it picks the right agent type next time, and context depletion warnings tell you when to start a fresh session. No configuration, no API keys, no cloud services — it all runs locally on your machine.

## Quickstart

```bash
npm install --save-dev moflo
flo init
```

Restart Claude Code (or your MCP client). That's it — memory, indexing, gates, and routing are all active.

Or — just ask Claude to install MoFlo into your project and initialize it!

To verify everything is running, ask Claude to run `flo doctor` with full diagnostics after restarting. If anything fails, ask Claude to fix it with `flo doctor --fix`.

## Opinionated Defaults

MoFlo makes deliberate choices so you don't have to:

- **Fully self-contained** — No external services, no cloud dependencies, no API keys. Everything runs locally on your machine.
- **Minimal dependencies** — 4 runtime dependencies (`js-yaml`, `semver`, `sql.js`, `valibot`). The upstream Ruflo/Claude Flow packages pull in multiple internal scoped packages (`@claude-flow/cli`, `@claude-flow/mcp`, `@claude-flow/shared`) plus native crypto libraries. MoFlo consolidates everything into a single package with zero native bindings.
- **Node.js runtime** — Targets Node.js specifically. All scripts, hooks, and tooling are JavaScript/TypeScript. No Python, no Rust binaries, no native compilation.
- **sql.js (WASM)** — The memory database uses sql.js, a pure WebAssembly build of SQLite. No native `better-sqlite3` bindings to compile, no platform-specific build steps. Works identically on Windows, macOS, and Linux.
- **Simplified embeddings pipeline** — 384-dimensional neural embeddings via Transformers.js (MiniLM-L6-v2, WASM). Same model and precision as the upstream multi-provider pipeline, but simpler — two scripts instead of an abstraction layer. Runs locally, no API calls.
- **Full learning stack wired up OOTB** — The following are all configured and functional from `flo init`, no manual setup:
  - **SONA** (Self-Optimizing Neural Architecture) — learns from task trajectories via pure TypeScript SONA implementation in `@moflo/neural`
  - **MicroLoRA** — rank-2 LoRA weight adaptations at ~1µs per adapt via pure TypeScript MicroLoRA in `@moflo/neural`
  - **EWC++** (Elastic Weight Consolidation) — prevents catastrophic forgetting across sessions
  - **HNSW Vector Search** — fast nearest-neighbor search via HNSW indexing with sql.js (WASM SQLite)
  - **Semantic Routing** — maps tasks to agents via learned routing in `@moflo/hooks`
  - **Trajectory Persistence** — outcomes stored in `routing-outcomes.json`, survive across sessions
  - All pure TypeScript/WASM-based, no GPU, no API keys, no external services.
- **Memory-first workflow** — Claude must search what it already knows before exploring files. Enforced by hooks, not just instructions.
- **Task registration before agents** — Sub-agents can't spawn until work is tracked. Prevents runaway agent proliferation.
- **Learned routing** — Task outcomes feed back into the routing system automatically. No manual configuration needed — it gets smarter with use.
- **Incremental indexing** — Guidance and code map indexes run on every session start but skip unchanged files. Fast after the first run.
- **Built for Claude Code, works with others** — We develop and test exclusively with Claude Code. The MCP tools, memory system, and hooks are client-independent and should work with any MCP-capable AI client, but Claude Code is the only tested target.
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
| **Workflow Engine** | Define multi-step automations as YAML — shell commands, agent spawns, conditionals, loops, memory ops. [Full documentation →](docs/WORKFLOWS.md) |
| **`/flo` Skill** | Execute GitHub issues through a full workflow: research → enhance → implement → test → simplify → PR. (Also available as `/fl`.) |
| **Context Tracking** | Monitors context window usage (FRESH → MODERATE → DEPLETED → CRITICAL) and advises accordingly. |
| **Cross-Platform** | Works on macOS, Linux, and Windows. |

## Getting Started

### 1. Install and init

```bash
npm install --save-dev moflo
flo init
```

`flo init` automatically scans your project to find where your guidance, code, and tests live, then writes the results into `moflo.yaml`. It looks for:

| What | Directories it checks | Default if none found |
|------|----------------------|----------------------|
| **Guidance** | `.claude/guidance`, `docs/guides`, `docs`, `architecture`, `adr`, `.cursor/rules` | `.claude/guidance` |
| **Source code** | `src`, `packages`, `lib`, `app`, `apps`, `services`, `server`, `client` | `src` |
| **Tests** | `tests`, `test`, `__tests__`, `spec`, `e2e`, plus `__tests__` dirs inside `src/` | `tests` |
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

#### Migrating from Claude Flow / Ruflo

If `flo init` detects an existing `.claude/settings.json` or `.claude-flow/` directory (from a prior Claude Flow or Ruflo installation), it treats the project as already initialized and runs in **update mode** — merging MoFlo's hooks and configuration into your existing setup without overwriting your data. Specifically:

- **Hooks** — If your `.claude/settings.json` already has MoFlo-style gate hooks (`flo gate`), the hooks step is skipped. Otherwise, MoFlo's hooks are written into the file (existing non-MoFlo hooks are not removed).
- **MCP servers** — MoFlo registers itself as the `moflo` server in `.mcp.json`. If you had `claude-flow` or `ruflo` MCP servers configured previously, those entries remain untouched — you can remove them manually once you've verified MoFlo is working. The `flo doctor` command checks for the `moflo` server specifically.
- **Config files** — `moflo.yaml`, `CLAUDE.md`, and `.claude/skills/flo/` follow the same skip-if-exists logic. Use `--force` to regenerate them.

To force a clean re-initialization over an existing setup:

```bash
flo init --force
```

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

**Tests** — test files to index for "what tests cover X?" reverse mapping:

```yaml
tests:
  directories:
    - tests               # your test files
    - __tests__            # jest-style test dirs
  patterns: ["*.test.*", "*.spec.*", "*.test-*"]
  extensions: [".ts", ".tsx", ".js", ".jsx"]
  exclude: [node_modules, coverage, dist]
  namespace: tests
```

MoFlo chunks your guidance files into semantic embeddings, indexes your code structure, and maps test files back to their source targets — so Claude searches your knowledge base before touching any files. Adjust these directories to match your project:

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
flo memory index-guidance    # Index your guidance docs
flo memory code-map          # Index your code structure
flo doctor                   # Verify everything works
```

Both indexes run automatically at session start after this, so you only need to run them manually on first setup or after major structural changes. The first index may take a minute or two on large codebases (1,000+ files) but runs in the background — you can start working immediately. Subsequent indexes are incremental and typically finish in under a second. To reindex everything at once:

```bash
flo memory refresh           # Reindex all content, rebuild embeddings, cleanup, vacuum
```

## Auto-Indexing

MoFlo automatically indexes three types of content on every session start, so your AI assistant always has up-to-date knowledge without manual intervention.

### What gets indexed

| Index | Content | What it produces | Namespace |
|-------|---------|------------------|-----------|
| **Guidance** | Markdown files in your guidance directories (`.claude/guidance/`, `docs/`, etc.) | Chunked text with 384-dim semantic embeddings — enables natural-language search across your project documentation | `guidance` |
| **Code map** | Source files in your code directories (`src/`, `packages/`, etc.) | Structural index of exports, classes, functions, and types — enables "where does X live?" navigation without Glob/Grep | `code-map` |
| **Tests** | Test files matching configured patterns (`*.test.*`, `*.spec.*`) | Reverse mapping from test files to their source targets — enables "what tests cover X?" lookups | `tests` |

### How it works

1. **Session start hook** — When your AI client starts a new session, MoFlo's `SessionStart` hook launches the indexers sequentially in a single background process. This runs silently — you can start working immediately.
2. **Incremental** — Each indexer tracks file modification times. Only files that changed since the last index run are re-processed. The first run on a large codebase may take a minute or two; subsequent runs typically finish in under a second.
3. **Embedding generation** — Guidance chunks are embedded using MiniLM-L6-v2 (384 dimensions, WASM). These vectors are stored in the SQLite memory database and used for semantic search.
4. **No blocking** — The indexers run in the background and don't block your session from starting. You can begin working immediately.

### Configuration

Each indexer can be toggled independently in `moflo.yaml`:

```yaml
auto_index:
  guidance: true     # Index docs on session start
  code_map: true     # Index code structure on session start
  tests: true        # Index test files on session start
```

Set any to `false` to disable that indexer. The underlying data remains in memory — you just stop refreshing it automatically. You can still run indexers manually:

```bash
flo memory index-guidance    # Manual guidance reindex
flo memory code-map          # Manual code map reindex
flo memory refresh           # Reindex everything + rebuild embeddings + vacuum
```

### Why this matters

Without auto-indexing, your AI assistant starts every session with a blank slate — it doesn't know what documentation exists, where code lives, or what tests cover which files. It resorts to Glob/Grep exploration, which burns tokens and context window on rediscovery.

With auto-indexing, the AI can search semantically ("how does auth work?") and get relevant documentation chunks ranked by similarity, or ask "where is the user model defined?" and get a direct answer from the code map — all without touching the filesystem.

## The Gate System

MoFlo installs Claude Code hooks that run on every tool call. Together, these gates create a **feedback loop** that prevents Claude from wasting tokens on blind exploration and ensures it builds on prior knowledge.

### Gates explained

| Gate | What it enforces | When it triggers | Why it matters |
|------|-----------------|------------------|----------------|
| **Memory-first** | Claude must search the memory database before using Glob, Grep, or Read on guidance files | Before every Glob/Grep call, and before Read calls targeting `.claude/guidance/` | Prevents the AI from re-exploring files it (or a previous session) already indexed. Forces it to check what it knows first, saving tokens and context window. |
| **TaskCreate-first** | Claude must call TaskCreate before spawning sub-agents via the Task tool | Before every Task (agent spawn) call | Ensures every piece of delegated work is tracked. Prevents runaway agent proliferation where Claude spawns agents without a clear plan. |
| **Context tracking** | Tracks conversation length and warns about context depletion | On every user prompt (UserPromptSubmit hook) | As conversations grow, AI quality degrades. MoFlo tracks interaction count and assigns a bracket (FRESH → MODERATE → DEPLETED → CRITICAL), advising Claude to checkpoint progress or start a fresh session before quality drops. |
| **Routing** | Analyzes each prompt and recommends the optimal agent type and model tier | On every user prompt (UserPromptSubmit hook) | Saves cost by suggesting haiku for simple tasks, sonnet for moderate ones, opus for complex reasoning — without you having to think about model selection. |

### Smart classification

The memory-first gate doesn't blindly block every request. It classifies each prompt:

- **Simple directives** (e.g., "commit", "yes", "continue", "looks good") — skip the gate entirely, no memory search required
- **Task-oriented prompts** (e.g., "fix the auth bug", "add pagination to the API") — gate enforced, must search memory first

### Escape hatch

Prefix any prompt with `@@` to bypass the memory-first gate for that turn. Useful for conversational questions, thinking out loud, or discussions that don't need prior context:

```
@@ what do you think about this approach?
@@ question — is there a better way to handle auth tokens?
```

The `@@` prefix is stripped before Claude sees the prompt, so it won't affect the response.

### Disabling gates

All gates are configurable in `moflo.yaml`:

```yaml
gates:
  memory_first: true          # Set to false to disable memory-first enforcement
  task_create_first: true     # Set to false to disable TaskCreate enforcement
  context_tracking: true      # Set to false to disable context bracket warnings
```

You can also disable individual hooks in `.claude/settings.json` by removing the corresponding hook entries.

## The `/flo` Skill

Inside your AI client, the `/flo` (or `/fl`) slash command drives GitHub issue workflows:

```
/flo <issue>                  # Full workflow (research → implement → test → PR)
/flo -t <issue>               # Ticket only (research and update ticket, then stop)
/flo -r <issue>               # Research only (analyze issue, output findings)
/flo -s <issue>               # Swarm mode (multi-agent coordination)
/flo -h <issue>               # Hive-mind mode (consensus-based coordination)
/flo -n <issue>               # Normal mode (default, single agent, no swarm)
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

For simple epics with independent stories, `/flo <epic>` is all you need. For complex features where you want state tracking, resume capability, and auto-merge between stories, use `flo epic` instead.

### Feature Orchestration (`flo epic`)

`flo epic` is the robust epic runner — it adds persistent state, resume from failure, and auto-merge between stories on top of `/flo`. It accepts either a GitHub issue number or a YAML file:

```bash
# From a GitHub epic (auto-detects stories)
flo epic run 42                        # Fetch epic #42, run all stories sequentially
flo epic run 42 --dry-run              # Preview execution plan without running
flo epic run 42 --no-merge             # Skip auto-merge between stories

# From a YAML definition (explicit dependencies)
flo epic run feature.yaml              # Execute stories in dependency order
flo epic run feature.yaml --dry-run    # Show execution plan
flo epic run feature.yaml --verbose    # Stream Claude output to terminal

# State management
flo epic status epic-42                # Check progress (which stories passed/failed)
flo epic reset epic-42                 # Reset state for re-run
```

When given an issue number, `flo epic` fetches the epic from GitHub, extracts child stories from checklists and numbered references, then runs each through `/flo` with state tracking. If a story fails, you can fix the issue and `flo epic run 42` again — it resumes from where it left off, skipping already-passed stories.

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

| | `/flo <epic>` | `flo epic run <epic>` |
|---|---|---|
| **State tracking** | No | Yes (`.claude-epic/state.json`) |
| **Resume from failure** | No | Yes (skips passed stories) |
| **Auto-merge PRs** | No | Yes (between stories) |
| **Dry-run preview** | No | Yes |
| **Dependency ordering** | No (top-to-bottom) | Yes (YAML only, topological sort) |

## Workflows

MoFlo includes a general-purpose workflow engine that executes multi-step automations defined in YAML. Workflows can run shell commands, spawn agents, perform memory operations, use conditionals and loops, and chain steps together with dependency ordering.

```bash
flo workflow run -n development          # Run a named workflow
flo workflow run -f ./my-workflow.yaml   # Run from a file
flo workflow list                        # List available workflows and recent runs
flo workflow validate -f ./workflow.yaml # Validate a definition without running it
flo workflow template list               # Browse built-in workflow templates
flo workflow schedule list               # List scheduled workflows
```

### Defining workflows

Workflows are YAML files with steps that run sequentially or in parallel:

```yaml
name: my-workflow
steps:
  - name: lint
    command: npm run lint
  - name: test
    command: npm test
  - name: deploy
    command: ./deploy.sh
    depends_on: [lint, test]
```

Steps support shell commands (`bash`), agent spawns, memory reads/writes, conditionals, loops, and parallel execution groups. For the full workflow definition format, see [docs/WORKFLOWS.md](docs/WORKFLOWS.md).

### Building workflows with the `/workflow-builder` skill

Inside your AI client, use the `/workflow-builder` skill to create, edit, and validate workflow definitions interactively. The skill understands the full workflow schema and available step commands, so you can describe what you want in natural language and it will generate the YAML:

```
/workflow-builder                        # Start the workflow builder
```

### Epics

Epics are a specialized workflow for processing GitHub issues that contain multiple child stories. When you pass a GitHub issue to `/flo` and it's detected as an epic, MoFlo processes each child story sequentially through the full `/flo` workflow (research → implement → test → PR).

For simple epics, `/flo <epic-number>` is all you need. For complex features requiring state tracking, resume from failure, and auto-merge between stories, use the dedicated `flo epic` command:

```bash
flo epic 42                              # Run all stories in epic #42
flo epic 42 --strategy auto-merge        # Per-story PRs with auto-merge
flo epic 42 --dry-run                    # Preview execution plan
flo epic status 42                       # Check progress
flo epic reset 42                        # Reset state for re-run
```

For features with inter-story dependencies, define them in a YAML file with `depends_on` fields for topological ordering. See the [Epic handling](#epic-handling) section above for detection criteria and the full comparison between `/flo <epic>` and `flo epic run`.

## Commands

You don't need to run these for normal use — `flo init` sets everything up, and the hooks handle memory, routing, and learning automatically. These commands are here for manual setup, debugging, and tweaking.

### Memory

```bash
flo memory store -k "key" --value "data"    # Store with 384-dim embedding
flo memory search -q "auth patterns"         # Semantic search
flo memory index-guidance                    # Index guidance docs
flo memory code-map                          # Index code structure
flo memory rebuild-index                     # Regenerate all embeddings
flo memory refresh                           # Reindex all + rebuild + cleanup + vacuum
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

### Diagnostics

```bash
flo doctor                       # Quick health check (environment, deps, config)
flo doctor --fix                 # Auto-fix issues (memory DB, daemon, config, MCP, zombies)
flo diagnose                     # Full integration test (memory, swarm, hive, hooks, neural)
flo diagnose --suite memory      # Run only memory tests
flo diagnose --json              # JSON output for CI/automation
```

#### `flo doctor` — Health Check

`flo doctor` runs 26 parallel health checks against your environment and reports pass/warn/fail for each:

| Check | What it verifies |
|-------|-----------------|
| **Version Freshness** | Whether your installed MoFlo version matches the latest on npm (detects stale npx cache) |
| **Node.js Version** | Node.js >= 20 installed |
| **npm Version** | npm >= 9 installed |
| **Claude Code CLI** | `claude` command available |
| **Git** | Git installed |
| **Git Repository** | Project is inside a git repository |
| **Config File** | Valid `moflo.yaml` or `.claude-flow/config.yaml` exists |
| **Status Line** | `statusLine` config wired in `.claude/settings.json` (auto-fixes when missing) |
| **Daemon Status** | Background daemon running (checks PID, cleans stale locks) |
| **Memory Database** | SQLite memory DB exists and is accessible |
| **Embeddings** | Vectors indexed in memory DB, HNSW index present |
| **Test Directories** | Test dirs from `moflo.yaml` exist on disk, reports auto-index status |
| **MCP Servers** | `moflo` MCP server configured in `.mcp.json` |
| **Disk Space** | Sufficient free disk space (warns at 80%, fails at 90%) |
| **TypeScript** | TypeScript compiler available |
| **agentic-flow** | Optional agentic-flow package installed (for enhanced embeddings/routing) |
| **Semantic Quality** | Semantic search returns relevant, varied results with acceptable similarity scores |
| **Intelligence** | SONA, ReasoningBank, PatternLearner, LoRA, EWC++, and RL subsystems are loaded |
| **Workflow Engine** | Core workflow modules, step commands, loaders, and index are present |
| **Zombie Processes** | No orphaned MoFlo node processes running |
| **Subagent Health** | Agent lifecycle (spawn → status → terminate) completes successfully |
| **Workflow Execution** | End-to-end workflow probe runs a real step and captures output |
| **MCP Tool Invocation** | MCP tool schemas are loaded and callable |
| **MCP Workflow Integration** | Bridge between MCP tools and workflow engine functions correctly |
| **Hook Execution** | Hook executor is functional and can fire hooks |
| **Gate Health** | All gate cases, hook bindings, and state file are intact |

**Auto-fix mode** (`flo doctor --fix`) attempts to repair each failing check automatically:

| Issue | What `--fix` does |
|-------|------------------|
| Missing memory database | Creates `.swarm/` directory and initializes the SQLite DB |
| Embeddings not initialized | Initializes memory DB and runs `embeddings init` |
| Missing config file | Runs `config init` to generate defaults |
| Status line not wired | Adds `statusLine` config block to `.claude/settings.json` |
| Stale daemon lock | Removes stale `.claude-flow/daemon.lock` and restarts daemon |
| MCP server not configured | Runs `claude mcp add moflo` to register the server |
| Claude Code CLI missing | Installs `@anthropic-ai/claude-code` globally |
| Zombie processes | Kills orphaned MoFlo processes (tracked + OS-level scan) |

After auto-fixing, doctor re-runs all checks and shows the updated results. Issues that can't be fixed automatically are listed with manual fix commands.

Additional flags:

```bash
flo doctor --install             # Auto-install missing Claude Code CLI
flo doctor --kill-zombies        # Find and kill orphaned MoFlo processes
flo doctor -c memory             # Check only a specific component
flo doctor -c embeddings         # Check only embeddings health
flo doctor --verbose             # Verbose output
```

#### `flo diagnose` — Integration Tests

While `doctor` checks your environment, `diagnose` exercises every subsystem end-to-end: memory CRUD, embedding generation, semantic search, swarm lifecycle, hive-mind consensus, task management, hooks, config, neural patterns, and init idempotency. All test data is cleaned up after each test — nothing is left behind.

### GitHub Repository Setup

```bash
flo github setup                  # One-shot: generate CI + apply repo settings + branch protection
flo github setup --dry-run        # Preview everything without making changes
flo github ci                     # Generate .github/workflows/ci.yml from project config
flo github ci --dry-run           # Print workflow to stdout
flo github settings               # Apply repo settings + branch protection via gh CLI
flo github settings --dry-run     # Preview settings changes
```

`flo github ci` auto-detects your package manager (npm/pnpm/yarn/bun), TypeScript, and test directories from `moflo.yaml` and `package.json`, then generates a CI workflow with install, build, lint, type-check, and test steps.

`flo github settings` applies recommended defaults via `gh` CLI: delete-branch-on-merge, squash merge with PR title/body, auto-merge, linear history, and configurable branch protection (required reviews, dismiss stale reviews, block force pushes). Requires `gh auth login`.

### System

```bash
flo init                          # Initialize project (one-time setup)
flo --version                    # Show version
```

## What Ships Out of the Box

`flo init` wires up the following systems automatically. Here's what each one does, why it matters, and whether it's enabled by default.

### Hooks (enabled OOTB)

Hooks are shell commands that Claude Code runs automatically at specific points in its workflow. MoFlo installs 21 hook bindings across 8 lifecycle events. You don't invoke these — they fire automatically.

| Hook Event | What fires | What it does | Enabled OOTB |
|------------|-----------|-------------|:---:|
| **PreToolUse: Write/Edit** | `flo hooks pre-edit` | Records which file is about to be edited, captures before-state for learning | Yes |
| **PreToolUse: Glob/Grep** | `flo gate check-before-scan` | Memory-first gate — blocks file exploration until memory is searched | Yes |
| **PreToolUse: Read** | `flo gate check-before-read` | Blocks reading guidance files directly until memory is searched | Yes |
| **PreToolUse: Bash** | `flo gate check-dangerous-command` | Safety check on shell commands | Yes |
| **PreToolUse: Bash** | `flo gate check-before-pr` | Validates PR readiness before `gh pr create` | Yes |
| **PostToolUse: Write/Edit** | `flo hooks post-edit` | Records edit outcome, optionally trains neural patterns | Yes |
| **PostToolUse: Agent** | `flo hooks post-task` | Records task completion, feeds outcome into routing learner | Yes |
| **PostToolUse: TaskCreate** | `flo gate record-task-created` | Records that a task was registered (clears TaskCreate gate) | Yes |
| **PostToolUse: Bash** | `flo gate check-bash-memory` | Detects memory search commands in Bash (clears memory gate) | Yes |
| **PostToolUse: memory_search** | `flo gate record-memory-searched` | Records that memory was searched (clears memory-first gate) | Yes |
| **PostToolUse: TaskUpdate** | `flo gate check-task-transition` | Validates task state transitions (prevents skipping states) | Yes |
| **PostToolUse: memory_store** | `flo gate record-learnings-stored` | Records that learnings were persisted to memory | Yes |
| **UserPromptSubmit** | `flo hooks prompt` + `flo gate prompt-reminder` | Resets per-prompt gate state, tracks context bracket, routes task to agent | Yes |
| **SubagentStart** | `subagent-start` | Injects context and guidance into spawned sub-agents | Yes |
| **SessionStart** | `session-start-launcher.mjs` | Launches auto-indexers (guidance, code map, tests), restores session state | Yes |
| **SessionStart** | `auto-memory-hook.mjs` | Imports auto-memory entries from Claude's persistent memory | Yes |
| **Stop** | `flo hooks session-end` | Persists session metrics, exports learning data | Yes |
| **Stop** | `auto-memory-hook.mjs` | Syncs auto-memory state on session close | Yes |
| **PreCompact** | `flo gate compact-guidance` | Injects guidance summary before context compaction | Yes |
| **Notification** | `flo hooks notification` | Routes Claude Code notifications through MoFlo | Yes |

### Systems (enabled OOTB)

These are the backend systems that hooks and commands interact with.

| System | What It Does | Why It Matters | Enabled OOTB |
|--------|-------------|----------------|:---:|
| **Semantic Memory** | SQLite database (sql.js/WASM) storing knowledge entries with 384-dim vector embeddings | Your AI assistant accumulates project knowledge across sessions instead of starting from scratch each time | Yes |
| **HNSW Vector Search** | Hierarchical Navigable Small World index for fast nearest-neighbor search | Searches across thousands of stored entries return in milliseconds instead of scanning linearly | Yes |
| **Guidance Indexing** | Chunks markdown docs into overlapping segments, embeds each with MiniLM-L6-v2 | Your project documentation becomes searchable by meaning ("how does auth work?") not just keywords | Yes |
| **Code Map** | Parses source files for exports, classes, functions, types | The AI can answer "where is X defined?" from the index instead of running Glob/Grep | Yes |
| **Test Indexing** | Maps test files to their source targets based on naming patterns | The AI can answer "what tests cover X?" and identify untested code | Yes |
| **Workflow Gates** | Hook-based enforcement of memory-first and task-registration patterns | Prevents the AI from wasting tokens on blind exploration and untracked agent spawns | Yes |
| **Context Tracking** | Interaction counter with bracket classification (FRESH/MODERATE/DEPLETED/CRITICAL) | Warns before context quality degrades, suggests when to checkpoint or start fresh | Yes |
| **Semantic Routing** | Matches task descriptions to agent types using vector similarity against 17 built-in patterns | Routes work to the right specialist (security-architect, tester, coder, etc.) automatically | Yes |
| **Learned Routing** | Records task outcomes (agent type + success/failure) and feeds them back into routing | Routing gets smarter over time — successful patterns are weighted higher in future recommendations | Yes |
| **SONA Learning** | Self-Optimizing Neural Architecture that learns from task trajectories | Adapts routing weights based on actual outcomes, not just keyword matching | Yes |
| **MicroLoRA Adaptation** | Rank-2 LoRA weight updates from successful patterns (~1µs per adapt) | Fine-grained model adaptation without full retraining | Yes |
| **EWC++ Consolidation** | Elastic Weight Consolidation that prevents catastrophic forgetting | New learning doesn't overwrite patterns from earlier sessions | Yes |
| **Session Persistence** | Stop hook exports session metrics; SessionStart hook restores prior state | Patterns learned on Monday are available on Friday | Yes |
| **Status Line** | Live dashboard showing git branch, session state, memory stats, MCP status | At-a-glance visibility into what MoFlo is doing | Yes |
| **MCP Tool Server** | 140+ MCP tools for memory, hooks, coordination, etc. (schemas deferred by default) | Enables AI clients to interact with MoFlo programmatically | Yes (deferred) |

### Systems (available but off by default)

| System | What It Does | How to Enable |
|--------|-------------|---------------|
| **Model Routing** | Auto-selects haiku/sonnet/opus per task based on complexity analysis | `model_routing.enabled: true` in `moflo.yaml` |
| **MCP Auto-Start** | Starts MCP server automatically on session begin | `mcp.auto_start: true` in `moflo.yaml` |
| **Tool Schema Eager Loading** | Loads all 140+ MCP tool schemas at startup (instead of on-demand) | `mcp.tool_defer: false` in `moflo.yaml` |

## The Two-Layer Task System

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

For complex work, MoFlo structures tasks into waves — a research wave discovers context, then an implementation wave acts on it — with dependencies tracked through both the client's task system and MoFlo's coordination layer. The full integration pattern is documented in `.claude/guidance/moflo-claude-swarm-cohesion.md`.

The `/flo` skill ties both systems together for GitHub issues — driving a full workflow (research → enhance → implement → test → simplify → PR) with your client's agents for execution and MoFlo's memory for continuity.

### Intelligent Agent Routing

MoFlo ships with 17 built-in task patterns that map common work to the right agent type:

| Pattern | Keywords | Primary Agent |
|---------|----------|---------------|
| security-task | auth, password, encryption, CVE | security-architect |
| testing-task | test, spec, coverage, e2e | tester |
| database-task | schema, migration, SQL, ORM | architect |
| feature-task | implement, add, create, build | architect → coder |
| bugfix-task | bug, fix, error, crash, debug | coder |
| api-task | endpoint, REST, route, handler | architect → coder |
| ... | | *(17 patterns total)* |

When you route a task (`flo hooks route --task "..."` or via MCP), MoFlo runs semantic similarity against these patterns using HNSW vector search and returns a ranked recommendation with confidence scores.

**The routing gets smarter over time.** Every time a task completes successfully, MoFlo's post-task hook records the outcome — the full task description, which agent handled it, and whether it succeeded. These learned patterns are combined with the built-in seeds on every future route call. Because learned patterns contain rich task descriptions (not just short keywords), they discriminate better as they accumulate.

Routing outcomes are stored in `.claude-flow/routing-outcomes.json` and persist across sessions. You can inspect them with `flo hooks patterns` or transfer them between projects with `flo hooks transfer`.

### Memory & Knowledge Storage

MoFlo uses a SQLite database (via sql.js/WASM — no native deps) to store three types of knowledge:

| Namespace | What's Stored | How It Gets There |
|-----------|---------------|-------------------|
| `guidance` | Chunked project docs (`.claude/guidance/`, `docs/`) with 384-dim embeddings | `flo-index` on session start |
| `code-map` | Structural index of source files (exports, classes, functions) | `flo-codemap` on session start |
| `tests` | Test file → source target reverse mapping | `flo-testmap` on session start |
| `patterns` | Learned patterns from successful task outcomes | Post-task hooks after agent work |

**Semantic search** uses cosine similarity on neural embeddings (MiniLM-L6-v2, 384 dimensions). When Claude searches memory, it gets the most relevant chunks ranked by semantic similarity — not keyword matching.

**Session start indexing** — Four background processes run on every session start: the guidance indexer, the code map generator, the test mapper, and the learning service. All four are incremental (unchanged files are skipped) and run in parallel so they don't block the session.

**Cross-session persistence** — Everything stored in the database survives across sessions. Patterns learned on Monday are available on Friday. The stop hook exports session metrics, and the session-restore hook loads prior state.

### For Claude

When `flo init` runs, it appends a workflow section to your CLAUDE.md that teaches Claude:
- Always search memory before Glob/Grep/Read (enforced by gates)
- Use `mcp__moflo__memory_search` for knowledge retrieval
- Use `/flo <issue>` (or `/fl`) for issue execution
- Store learnings after task completion

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

tests:
  directories: [tests, __tests__]
  patterns: ["*.test.*", "*.spec.*", "*.test-*"]
  extensions: [".ts", ".tsx", ".js", ".jsx"]
  exclude: [node_modules, coverage, dist]
  namespace: tests

gates:
  memory_first: true                 # Must search memory before file exploration
  task_create_first: true            # Must TaskCreate before Agent tool
  context_tracking: true             # Track context window depletion

auto_index:
  guidance: true                     # Auto-index docs on session start
  code_map: true                     # Auto-index code on session start
  tests: true                        # Auto-index test files on session start

mcp:
  tool_defer: true                   # Defer 140+ tool schemas; loaded on demand via ToolSearch
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

By default, `tool_defer` is `true`. MoFlo exposes 140+ MCP tools — loading all their schemas at conversation start consumes significant context. With deferral enabled, only tool **names** are listed at startup (compact), and full schemas are fetched on demand via `ToolSearch` when actually needed. Hooks and CLI commands continue to work normally since they call the daemon directly, not through MCP tool schemas.

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

## Architecture

- **9 bin entries** shipped with npm: `flo` (main CLI), `moflo`, `claude-flow` (aliases), `flo-setup`, `flo-codemap`, `flo-search`, `flo-embeddings`, `flo-index`, `flo-testmap`
- **Project config system**: `moflo.yaml` for per-project settings
- **One-stop init**: `flo init` generates everything needed for OOTB operation

## Ruflo / Claude Flow

MoFlo originated as a fork of [Ruflo/Claude Flow](https://github.com/ruvnet/ruflo) and has since diverged significantly. The upstream project distributes functionality across multiple scoped packages (`@claude-flow/cli`, `@claude-flow/mcp`, `@claude-flow/shared`) with native crypto dependencies. MoFlo consolidates everything into a single package with 4 runtime dependencies and zero native bindings — the entire stack runs on pure JavaScript/TypeScript and WASM.

For documentation on the underlying capabilities that both projects share — swarm topologies, hive-mind consensus, HNSW vector search, neural routing, MCP server internals — see the [Ruflo repository](https://github.com/ruvnet/ruflo).

## Why I Made This

[Ruflo/Claude Flow](https://github.com/ruvnet/ruflo) is an incredible piece of work. The engineering that [rUv](https://github.com/ruvnet) and the contributors have put into it — swarm topologies, hive-mind consensus, HNSW vector search, neural routing, and so much more — makes it one of the most comprehensive agent orchestration frameworks available. It's a massive, versatile toolbox built to support a wide range of scenarios: distributed systems, multi-agent swarms, enterprise orchestration, research workflows, and beyond.

My use case was just one of those many scenarios: day-to-day local coding, enhancing my normal Claude Code experience on a single project. Claude Flow absolutely supports this — it's all in there — but because the project serves so many different needs, I found myself spending time configuring and tailoring things for my specific workflow each time I pulled in updates. That's not a shortcoming of the project; it's the natural trade-off of a tool designed to be that flexible and powerful.

So I forked the excellent foundation and narrowed the focus to my particular corner of it. I baked in the defaults I kept setting manually, added automatic indexing and memory gating at session start, and tuned the out-of-box experience so that `npm install` and `flo init` gets you straight to coding.

If you're exploring the full breadth of what agent orchestration can do, go use [Ruflo/Claude Flow](https://github.com/ruvnet/ruflo) directly — it's the real deal. But if your needs are similar to mine — a focused, opinionated local dev setup that just works — then hopefully MoFlo saves you the same configuration time it saves me.

## License

MIT (inherited from [Ruflo/Claude Flow](https://github.com/ruvnet/ruflo))
