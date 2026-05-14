# moflo.yaml + Runtime Environment Reference

**Purpose:** Complete schema for `moflo.yaml`, runtime environment variable overrides, and `.mcp.json` setup. Reference this when configuring a moflo project, debugging "why is gate X not firing", or wiring moflo into a fresh repo.

---

## Project Configuration (moflo.yaml)

Moflo reads `moflo.yaml` (or `moflo.config.json`) from the project root. All fields have sensible defaults — the file is optional. If it's missing on first run, `flo init` writes one with the defaults below.

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
  backend: sql.js                 # sql.js (WASM) | json
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
  default: opus                   # General tasks
  research: sonnet                # Research/exploration agents
  review: opus                    # Code review agents
  test: sonnet                    # Test-writing agents

# Intelligent model routing (auto-selects haiku/sonnet/opus per task)
model_routing:
  enabled: false                  # Set true to enable dynamic routing
  confidence_threshold: 0.85      # Min confidence before escalating
  cost_optimization: true         # Prefer cheaper models when confident
  circuit_breaker: true           # Penalize models that fail repeatedly
  # agent_overrides:
  #   security-auditor: opus
  #   researcher: sonnet

# Status line display
status_line:
  enabled: true                   # Show status line at all
  branding: "Moflo V4"            # Text in status bar
  mode: single-line               # single-line (default) or dashboard (multi-line)
  show_git: true                  # Git branch, changes, ahead/behind
  show_model: true                # Current model name
  show_session: true              # Session duration
  show_intelligence: true         # Intelligence % indicator
  show_swarm: true                # Active swarm agents count
  show_hooks: true                # Enabled hooks count
  show_mcp: true                  # MCP server count
  show_security: true             # CVE/security status (dashboard only)
  show_adrs: true                 # ADR compliance (dashboard only)
  show_tests: true                # Test file count (dashboard only)

# Spell step sandboxing (OS-level process isolation for bash steps)
# Platform support: macOS (sandbox-exec), Linux/WSL (bwrap). Windows has no OS sandbox.
sandbox:
  enabled: false                  # Set to true to wrap bash steps in an OS sandbox
  tier: auto                      # auto | denylist-only | full
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

## Environment Variables

Config is loaded from `moflo.yaml` at the project root — there is no env var that points at a config file. The variables below override specific values at runtime:

```bash
# Logging
CLAUDE_FLOW_LOG_LEVEL=info               # debug | info | warn | error

# MCP Server (stdio transport — no port)
CLAUDE_FLOW_MCP_TRANSPORT=stdio

# Memory backend
CLAUDE_FLOW_MEMORY_BACKEND=hybrid        # hybrid | sqlite | agentdb (legacy)
CLAUDE_FLOW_MEMORY_TYPE=sqlite           # storage type override
```

Variable names retain the `CLAUDE_FLOW_` prefix for backward compatibility with consumers upgraded from claude-flow.

---

## .mcp.json — MCP Tool Wiring

### Project-Level (Recommended)

Configure `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "moflo": {
      "command": "node",
      "args": ["node_modules/moflo/bin/cli.js", "mcp", "start"]
    }
  }
}
```

`flo init` writes this file automatically; only edit it if you need a non-default invocation (custom node binary, alternate `args`, etc.).

### Alternative: Global MCP Registration

```bash
claude mcp add moflo -- npx moflo@alpha
npx flo daemon start
npx flo doctor --fix
```

Global registration is useful for ad-hoc projects where you don't want to commit `.mcp.json`. For long-lived projects, prefer the project-level form so the configuration is version-controlled with the code.

---

## See Also

- `.claude/guidance/moflo-core-guidance.md` — Hub: getting started, anti-drift defaults, troubleshooting
- `.claude/guidance/moflo-cli-reference.md` — Commands, agents, hooks, hive-mind, ruvector — the surfaces this config gates
- `.claude/guidance/moflo-spell-sandboxing.md` — What `sandbox:` actually does at the bash-step boundary, with capability/permission interaction
- `.claude/guidance/moflo-settings-injection.md` — What moflo writes into `.claude/settings.json` (the hook wiring; complementary to `moflo.yaml` toggles)
