# MoFlo

**AI agent orchestration for Claude Code.** MoFlo gives your project semantic memory, workflow enforcement, learned routing, and automated issue execution — install it as a dev dependency and run `moflo init`.

Forked from [ruflo/claude-flow](https://github.com/ruvnet/ruflo) with all patches applied to source and wrapper scripts merged into the CLI.

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

## Quick Start

```bash
# Install as a dev dependency
npm install --save-dev github:eric-cielo/moflo

# Initialize your project (generates config, hooks, skill, CLAUDE.md section)
npx moflo init

# Index your project's knowledge base
npx moflo memory index-guidance
npx moflo memory code-map

# Verify everything works
npx moflo doctor
```

That's it. `moflo init` sets up everything:
- `moflo.yaml` — project config (auto-detects source dirs, languages, guidance paths)
- `.claude/settings.json` — workflow gate hooks
- `.claude/skills/flo/` — the `/flo` issue execution skill (with `/fl` alias)
- `CLAUDE.md` — appends a MoFlo workflow section so Claude knows how to use it
- `.gitignore` — adds state directories

## Commands

### Memory

```bash
moflo memory store -k "key" --value "data"    # Store with 384-dim embedding
moflo memory search -q "auth patterns"         # Semantic search
moflo memory index-guidance                    # Index guidance docs
moflo memory code-map                          # Index code structure
moflo memory rebuild-index                     # Regenerate all embeddings
moflo memory stats                             # Show statistics
```

### Routing & Learning

```bash
moflo hooks route --task "description"          # Route task to optimal agent
moflo hooks learn --pattern "..." --domain "."  # Store a pattern
moflo hooks patterns                            # List learned patterns
moflo hooks consolidate                         # Promote/prune patterns
```

### Workflow Gates

```bash
moflo gate check-before-scan       # Blocks Glob/Grep if memory not searched
moflo gate check-before-agent      # Blocks Agent tool if no TaskCreate
moflo gate prompt-reminder         # Context bracket tracking
moflo gate session-reset           # Reset workflow state
```

### System

```bash
moflo init                          # Initialize project (one-time setup)
moflo doctor                       # Health check
moflo --version                    # Show version
```

## Configuration

`moflo init` generates a `moflo.yaml` at your project root:

```yaml
project:
  name: "my-project"

guidance:
  directories: [.claude/guidance]    # Where your knowledge docs live
  namespace: guidance

code_map:
  directories: [src, packages]       # Source dirs to index
  extensions: [".ts", ".tsx"]        # Auto-detected from your project
  exclude: [node_modules, dist]
  namespace: code-map

gates:
  memory_first: true                 # Must search memory before file exploration
  task_create_first: true            # Must TaskCreate before Agent tool
  context_tracking: true             # Track context window depletion

auto_index:
  guidance: true                     # Auto-index docs on session start
  code_map: true                     # Auto-index code on session start

models:
  default: opus        # General tasks
  research: sonnet     # Research/exploration agents
  review: opus         # Code review agents
  test: sonnet         # Test-writing agents

# Optional: intelligent model routing (off by default)
model_routing:
  enabled: false                   # Set to true to enable
  confidence_threshold: 0.85
  cost_optimization: true
  circuit_breaker: true
```

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

### For Humans

MoFlo sits between Claude Code and your project. When Claude starts a session, MoFlo's hooks enforce good habits: search memory before exploring files, create tasks before spawning agents, and track how depleted the context window is. Over time, MoFlo learns which agent types work best for which tasks and routes accordingly.

The `/flo <issue>` skill (or `/fl`) gives Claude a full automated workflow for executing GitHub issues — from research through PR creation — with mandatory testing and code review gates.

### For Claude

When `moflo init` runs, it appends a workflow section to your CLAUDE.md that teaches Claude:
- Always search memory before Glob/Grep/Read (enforced by gates)
- Use `mcp__claude-flow__memory_search` for knowledge retrieval
- Use `/flo <issue>` (or `/fl`) for issue execution
- Follow the agent icon convention for task visibility
- Store learnings after task completion

## Architecture

MoFlo is a maintained fork of [ruflo v3.5.7](https://github.com/ruvnet/ruflo) with:

- **3 patches applied to TypeScript source** (no more monkey-patching node_modules):
  - 384-dim domain-aware embeddings for consistent CLI ↔ MCP search
  - `windowsHide: true` on all spawn/exec calls (Windows UX)
  - Routing learned patterns (task outcomes feed back into routing)
- **7 standalone bin scripts** shipped with npm: `moflo-search`, `moflo-embeddings`, `moflo-index`, `moflo-codemap`, `moflo-learn`, `moflo-setup`, plus the main `moflo` CLI
- **Project config system**: `moflo.yaml` for per-project settings
- **One-stop init**: `moflo init` generates everything needed for OOTB operation

Upstream remote preserved for cherry-picking future ruflo fixes.

## License

MIT (inherited from [upstream](https://github.com/ruvnet/ruflo))
