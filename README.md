# MoFlo

AI agent orchestration for Claude Code. Forked from [ruflo/claude-flow](https://github.com/ruvnet/ruflo) with patches applied directly to source.

## What It Does

MoFlo enhances Claude Code with:

- **Semantic memory** — 384-dim domain-aware embeddings for fast knowledge retrieval
- **Code navigation** — Structural code maps indexed for instant "where does X live?" queries
- **Guidance indexing** — Project docs chunked and searchable via semantic search
- **Workflow gates** — Enforces memory-first patterns and task creation before agent spawning
- **Learned routing** — Task-to-agent routing that improves from session outcomes
- **Feature orchestration** — Sequence multi-issue features through `/mf` with dependency ordering

## Quick Setup

### 1. Install

```bash
npm install --save-dev github:eric-cielo/moflo
```

### 2. Initialize

```bash
npx moflo init
```

This creates `moflo.yaml` at your project root with auto-detected settings:

```yaml
project:
  name: "my-project"

guidance:
  directories:
    - .claude/guidance
  namespace: guidance

code_map:
  directories:
    - src
    - packages
  extensions: [".ts", ".tsx", ".js", ".jsx"]
  exclude: [node_modules, dist, .git]
  namespace: code-map

gates:
  memory_first: true
  task_create_first: true
  context_tracking: true

auto_index:
  guidance: true
  code_map: true

models:
  default: opus
  review: opus
```

### 3. Index your project

```bash
npx moflo memory index-guidance   # Index docs for semantic search
npx moflo memory code-map         # Index code structure for navigation
```

### 4. Add the `/mf` skill

Copy the `/mf` skill directory into your project's `.claude/skills/mf/`. This gives Claude the `/mf <issue>` command for executing GitHub issues through a full workflow (research → enhance → implement → test → simplify → PR).

## Commands

```bash
# Memory
moflo memory store -k "key" --value "data"    # Store with 384-dim embedding
moflo memory search -q "auth patterns"         # Semantic search
moflo memory index-guidance                    # Index .claude/guidance/ docs
moflo memory code-map                          # Generate structural code map
moflo memory rebuild-index                     # Regenerate all embeddings
moflo memory stats                             # Show DB statistics

# Routing & Learning
moflo hooks route --task "description"         # Route task to optimal agent
moflo hooks learn --pattern "..." --domain "." # Store a learned pattern
moflo hooks patterns                           # List learned patterns
moflo hooks consolidate                        # Promote/prune patterns

# System
moflo doctor                                   # Health check
moflo --version                                # Show version
```

## Configuration Reference

### `moflo.yaml`

| Key | Default | Description |
|-----|---------|-------------|
| `project.name` | Directory name | Project display name |
| `guidance.directories` | `[.claude/guidance]` | Where to find knowledge docs |
| `guidance.namespace` | `guidance` | Memory namespace for indexed docs |
| `code_map.directories` | `[src, packages]` | Source dirs to map |
| `code_map.extensions` | `[.ts, .tsx, .js, .jsx]` | File types to scan |
| `code_map.exclude` | `[node_modules, dist, ...]` | Dirs to skip |
| `code_map.namespace` | `code-map` | Memory namespace for code map |
| `gates.memory_first` | `true` | Require memory search before Glob/Grep |
| `gates.task_create_first` | `true` | Require TaskCreate before Agent tool |
| `gates.context_tracking` | `true` | Track FRESH/MODERATE/DEPLETED/CRITICAL |
| `auto_index.guidance` | `true` | Index guidance on session start |
| `auto_index.code_map` | `true` | Index code map on session start |
| `models.default` | `opus` | Default Claude model |
| `models.review` | `opus` | Model for architect reviews |

## For Claude

When a user asks you to "set up MoFlo" or "initialize MoFlo" in a project:

1. Run `npx moflo init` — this generates `moflo.yaml` with auto-detected paths
2. Run `npx moflo memory index-guidance` — indexes knowledge docs
3. Run `npx moflo memory code-map` — indexes code structure
4. Add `moflo.yaml` to the project's git (it's config, not state)
5. Add `.moflo/` to `.gitignore` (state DB and logs)
6. Verify with `npx moflo doctor`

The `moflo.yaml` file tells MoFlo where your project's guidance docs and source code live. Edit it if the auto-detection got paths wrong.

## Architecture

MoFlo is a fork of [ruflo v3.5.7](https://github.com/ruvnet/ruflo) with:

- **3 patches applied to source** (were previously monkey-patched post-install):
  - 384-dim domain-aware embeddings (consistent CLI ↔ MCP dimensions)
  - `windowsHide: true` on all spawn/exec calls (no phantom console windows)
  - Routing learned patterns (persisted task→agent outcomes feed back into routing)
- **Wrapper scripts merged into CLI**: semantic-search, build-embeddings, index-guidance, generate-code-map, workflow-gate, learning-service, agent-router
- **Feature orchestrator** (`moflo orc`): sequences GitHub issues through `/mf` workflow

Upstream remote is preserved for cherry-picking future ruflo fixes.

## License

MIT (inherited from upstream)
