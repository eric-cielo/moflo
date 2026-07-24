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

# Auto-meditate — distill durable session lessons into the learnings namespace
auto_meditate:
  enabled: true                   # On by default; recognizes lessons live, distills at next session start

# Session-continuity — capture a "where you left off" digest, re-inject when relevant
session_continuity:
  capture: true                   # Write a per-session digest on the Stop hook
  inject: true                    # Relevance-gated injection at next session start
  max_age_hours: 72               # Ignore digests older than this when injecting

# Memory backend
memory:
  backend: node-sqlite            # node-sqlite (default) | rvf (pure-TS fallback) | json (last resort). Passed to createDatabase() as the preferred provider (#1144).
  embedding_model: Xenova/all-MiniLM-L6-v2   # 384-dim neural embeddings
  namespace: default              # Default namespace for memory operations
  # worktree_sharing: false                            # opt-OUT (#1231): automatic durable-learning sharing across git worktrees is ON by default (derived at <git-common-dir>/moflo/durable.db, active only when worktrees exist; a single checkout is untouched). Set false to disable.
  # durable_path: ~/.moflo-shared/team-learnings.db   # opt-in (#1232): OVERRIDE the auto worktree store — a custom durable-only path for learnings/knowledge, or to converge separate clones. Point at a DEDICATED store, never a full moflo.db. Env override: MOFLO_DURABLE_PATH.
  # team_artifact: .moflo/shared/learnings.jsonl       # opt-in (#1234): git-tracked JSONL the team commits; session-start import-merges it. Env override: MOFLO_TEAM_ARTIFACT. See moflo-cross-install-memory-sharing.md.
  # hydrate_from: /abs/path/to/moflo-snapshot.db       # opt-in (#1244): whole-DB snapshot to seed a fresh/empty workspace on session-start (skips the cold reindex). No-op once the local DB has content. Take one with "flo memory backup --to <path>". Env override: MOFLO_HYDRATE_FROM.

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

# Auto-update on session start (refreshes consumer assets when moflo upgrades)
auto_update:
  enabled: true                          # Master toggle for version-change auto-sync
  scripts: true                          # Sync .claude/scripts/ from moflo bin/
  helpers: true                          # Sync .claude/helpers/ from moflo source
  hook_block_drift: regenerate           # warn | regenerate | off (default: regenerate since #1227)
  claudemd_injection_drift: regenerate   # warn | regenerate | off

# Which skill categories to install (OPTIONAL — omit to get every skill)
skills:
  categories: [core, memory, spells]     # core | memory | spells
```

If your `moflo.yaml` predates the `sandbox:` or `auto_update:` blocks, they are auto-appended on the next session start — you never need to re-run `moflo init` after a version bump.

### Narrowing Installed Skills with `skills.categories`

**Omit the `skills:` block entirely to receive every moflo skill — that is the default and the recommended setting.** Add `skills.categories` only when you want a smaller always-resident skill listing, and expect to lose the commands in the categories you drop.

Every installed skill's name and description sit in Claude's context in every session, so a project that will never author a spell can reclaim that space. The cost is real but small — the full set is roughly 2,000 tokens.

| Category | Skills | Drop it when |
|----------|--------|--------------|
| `core` | `/fl`, `/healer`, `/verify`, `/flo-simplify`, `/eldar`, `/quicken`, `/ward`, `/divine`, `/meditate`, `/guidance`, `/commune`, `/luminarium` | Never — these are the everyday commands |
| `memory` | `/memory-patterns`, `/vector-search`, `/memory-optimization`, `/memory-team`, `/memory-worktree` | You are not building on moflo's memory stack and have finished any team/worktree sharing setup |
| `spells` | `/spell-builder`, `/spell-schedule`, `/connector-builder` | You do not author or schedule spells in this project |

Both YAML list styles work:

```yaml
skills:
  categories: [core, memory]
```

```yaml
skills:
  categories:
    - core
    - memory
```

**Key behaviors:**

- **Omitting `skills:` means no restriction.** Every shipped skill syncs on every session start, exactly as before this option existed.
- **`/flo` and `/fl` are never gated.** The ticket spell is the primary entry point and installs regardless of selection.
- **An unknown category name is ignored, not fatal.** A typo narrows nothing rather than silently stripping your skills.
- **Narrowing stops future syncing; it does not delete.** Skills already on disk stay until you remove them — moflo will not re-add them once excluded, so delete the directories under `.claude/skills/` to reclaim the context.
- **Re-widening is instant.** Add the category back and the next session start restores its skills.

### Key Behaviors

| Config | Effect |
|--------|--------|
| `skills.categories` omitted | Install every skill (default) |
| `skills.categories: [core]` | Install only core skills; `memory` + `spells` stop syncing |
| `auto_index.guidance: false` | Skip guidance indexing on session start |
| `auto_index.code_map: false` | Skip code map generation on session start |
| `auto_meditate.enabled: false` | Opt out of automatic session-lesson distillation (`/meditate` still works manually) |
| `session_continuity.capture: false` | Stop writing per-session "where you left off" digests |
| `session_continuity.inject: false` | Keep capturing digests but never auto-inject them at session start |
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
| `auto_update.enabled: false` | Disable all on-session auto-sync (scripts, helpers, drift checks) |
| `auto_update.hook_block_drift: regenerate` | Auto-repair drift in `.claude/settings.json` hook block on session start (#881, default since #1227 — basename guard from #1180 keeps user-owned hooks safe). |
| `auto_update.hook_block_drift: warn` | Print drift notice but leave settings.json unchanged. Opt-out from auto-regen. |
| `auto_update.hook_block_drift: off` | Skip hook-block drift detection entirely |
| `auto_update.claudemd_injection_drift: regenerate` | Auto-refresh the MoFlo block in `CLAUDE.md` when it drifts from the current generator (#1142, default) |
| `auto_update.claudemd_injection_drift: warn` | Print a drift notice on session start but leave `CLAUDE.md` unchanged |
| `auto_update.claudemd_injection_drift: off` | Skip CLAUDE.md injection drift detection entirely |

---

## Environment Variables

Config is loaded from `moflo.yaml` at the project root — there is no env var that points at a config file. The variables below override specific values at runtime:

```bash
# Logging
MOFLO_LOG_LEVEL=info               # debug | info | warn | error

# MCP Server (stdio transport — no port)
MOFLO_MCP_TRANSPORT=stdio

# Memory backend (legacy SystemConfig env vars — moflo.yaml `memory.backend` is the modern surface)
MOFLO_MEMORY_BACKEND=sqlite        # informational only; not consumed by selectProvider
MOFLO_MEMORY_TYPE=sqlite           # SystemConfig override (legacy)
```

These use the canonical `MOFLO_` prefix. The pre-rebrand `CLAUDE_FLOW_` names are still read as a fallback for one deprecation cycle, so consumers upgraded from `claude-flow` keep working without a manual rename.

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
