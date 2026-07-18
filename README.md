<p align="center">
  <img src="https://raw.githubusercontent.com/eric-cielo/moflo/main/docs/Moflo_md.png?v=6" alt="MoFlo" />
</p>

# MoFlo

**A standalone, opinionated AI agent orchestration toolkit for Claude Code, optimized for local development.**

**[Website](https://cielolimitada.com/moflo)** · [npm](https://www.npmjs.com/package/moflo) · [GitHub](https://github.com/eric-cielo/moflo)

## TL;DR

MoFlo makes Claude Code remember what it learns, check what it knows before exploring files, and get smarter over time — all automatically. Install it, run `flo init`, restart Claude Code, and everything just works: your docs and code are indexed on session start so Claude can search them instantly, gates prevent Claude from wasting tokens on blind exploration, task outcomes feed back into routing so it picks the right agent type next time, and context depletion warnings tell you when to start a fresh session. No configuration, no API keys, no cloud services — it all runs locally on your machine.

## Quickstart

```bash
npm install --save-dev moflo
flo init
```

Restart Claude Code. That's it — memory, indexing, gates, and routing are all active.

Or — just ask Claude to install MoFlo into your project and initialize it!

To verify everything is running, run the **`/healer`** skill inside Claude Code (or `flo healer` from the CLI) after restarting — it runs full diagnostics. If anything fails, run **`/healer --fix`** to automatically fix issues.

## Next Step: Consult the Eldar

After installing moflo, the single highest-leverage thing you can do for the best experience is run **`/eldar`** inside a Claude Code session.

Where `/healer` (or `flo healer` from the CLI) verifies that *moflo itself* is wired up correctly, **`/eldar` audits how Claude is set up to actually use your project** — guidance docs, CLAUDE.md, memory namespaces, hook/MCP wiring, model routing, and whether every technology in your stack (TypeScript, Python, Rust, Go, etc.) has matching guidance for Claude to lean on. The stack → guidance cross-reference alone is often the difference between *"Claude feels lost in this codebase"* and *"Claude knows this codebase"*.

```
/eldar          # Read-only audit; categorized findings, severity-ranked
/eldar --fix    # Interactive triage — pick what to fix and the Eldar walk you through it
```

Run it on day one in any new project, any time Claude feels off, or as a periodic health check. Outside of the core install, this is the most impactful thing moflo offers — full details in the **`/eldar`** section [further down](#eldar--consult-the-eldar-project-setup-audit--wizard).

## Opinionated Defaults

MoFlo makes deliberate choices so you don't have to:

- **Fully self-contained** — No external services, no cloud dependencies, no API keys. Everything runs locally on your machine.
- **Minimal dependencies** — small runtime dep set, all WASM or prebuilt binaries. No native compilation, no `node-gyp`, no platform-specific build steps.
- **Node.js runtime** — Targets Node.js specifically. All scripts, hooks, and tooling are JavaScript/TypeScript. No Python, no Rust binaries, no native compilation.
- **node:sqlite (built-in)** — The memory database uses Node 22's built-in SQLite engine. No `better-sqlite3` native bindings to compile, no WASM round-trip, no platform-specific build steps. Works identically on Windows, macOS, and Linux.
- **Neural embeddings by default** — 384-dimensional embeddings using `all-MiniLM-L6-v2`. No hash fallback, no peer-optional setup, no install prompts — real semantic search works out of the box. A `postinstall` step trims the embedding runtime to your platform and strips GPU-only libraries the runtime never loads, reclaiming roughly 340 MB on Linux and 150 MB on Windows from a fresh install. Set `MOFLO_NO_PRUNE=1` to skip the trim, or `ONNXRUNTIME_NODE_INSTALL_CUDA=true` to keep CUDA GPU support.
- **Full learning stack wired up OOTB** — All configured and functional from `flo init`, no manual setup:
  - **SONA** (Self-Optimizing Neural Architecture) — learns from task trajectories
  - **MicroLoRA** — fast rank-2 weight adaptations from successful patterns
  - **EWC++** (Elastic Weight Consolidation) — prevents catastrophic forgetting across sessions
  - **HNSW Vector Search** — fast nearest-neighbor search over your knowledge base
  - **Semantic Routing** — maps tasks to the right agent via learned patterns (ReasoningBank)
  - **Trajectory Persistence** — outcomes survive across sessions
  - All local, no GPU, no API keys, no external services.
- **Memory-first** — Claude must search what it already knows before exploring files. Enforced by hooks, not just instructions.
- **Task registration before agents** — Sub-agents can't spawn until work is tracked. Prevents runaway agent proliferation.
- **Learned routing** — Task outcomes feed back into the routing system automatically. No manual configuration needed — it gets smarter with use.
- **Incremental indexing** — Guidance and code map indexes run on every session start but skip unchanged files. Fast after the first run.
- **Claude Code is the only target** — MoFlo is built and shipped for Anthropic's Claude Code (CLI, IDE extensions, web). It is **not** a Claude Desktop integration: nothing reads from or writes to `~/.claude/claude_desktop_config.json` or `%APPDATA%/Claude/`, and adding paths there is always a bug. The MCP tools, memory system, and hooks could in principle work with any MCP-capable client, but Claude Code is the *only* surface we author for, test against, or accept bug reports on.
- **GitHub-oriented** — The `/flo` skill, PR automation, and issue tracking are built around GitHub. With Claude's help, you can adapt them to your own issue tracker and source control system.
- **Cross-platform** — Works identically on macOS, Linux, and Windows.

## Features

| Feature | What It Does |
|---------|-------------|
| **Semantic Memory** | 384-dim domain-aware embeddings. Store knowledge, search it instantly. |
| **Reflection** | Distills durable lessons from your sessions into searchable memory — automatically (auto-meditate), or on demand with `/meditate`. |
| **Cross-Install Sharing** | Durable `learnings` follow you across git worktrees **automatically** (no setup) — and across your own machines or a whole team via `flo memory sync` or a git-tracked artifact. Structural namespaces stay local. [Full documentation →](.claude/guidance/shipped/moflo-cross-install-memory-sharing.md) |
| **Code Navigation** | Indexes your codebase structure so Claude can answer "where does X live?" without Glob/Grep. |
| **Guidance Indexing** | Chunks your project docs (`.claude/guidance/`, `docs/`) and makes them searchable. |
| **Gates** | Enforces memory-first and task-creation patterns via Claude Code hooks. Prevents Claude from skipping steps. |
| **Learned Routing** | Routes tasks to the right agent type. Learns from outcomes — gets better over time. |
| **Spell Engine** | Define multi-step automations as YAML — shell commands, agent spawns, conditionals, loops, memory ops. [Full documentation →](docs/SPELLS.md) |
| **`/flo` Skill** | Execute GitHub issues through a full process: research → enhance → implement → test → simplify → PR. (Also available as `/fl`.) |
| **Spec-Driven Development** | `/flo -sd` runs a spec → plan → implement → verify cycle with reviewable, memory-indexed artifacts; `/flo -v` enforces verify-before-done on its own. Both opt-in. [Details →](#spec-driven-development-sdd) |
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
| `.claude/settings.json` | Gate hooks for Claude Code |
| `.claude/skills/flo/` | The `/flo` issue execution skill (also `/fl`) |
| `CLAUDE.md` section | Teaches Claude how to use MoFlo |
| `.gitignore` entries | Excludes MoFlo state directories |

In interactive mode (`flo init` without `--yes`), it shows what it found and lets you confirm or adjust before writing.

#### Migrating from Claude Flow / Ruflo

If `flo init` detects an existing `.claude/settings.json` or `.claude-flow/` directory (from a prior Claude Flow or Ruflo installation), it treats the project as already initialized and runs in **update mode** — merging MoFlo's hooks and configuration into your existing setup without overwriting your data. Specifically:

- **Hooks** — If your `.claude/settings.json` already has MoFlo-style gate hooks (`flo gate`), the hooks step is skipped. Otherwise, MoFlo's hooks are written into the file (existing non-MoFlo hooks are not removed).
- **MCP servers** — MoFlo registers itself as the `moflo` server in `.mcp.json`. If you had `claude-flow` or `ruflo` MCP servers configured previously, those entries remain untouched — you can remove them manually once you've verified MoFlo is working. The `/healer` skill (or `flo healer` from the CLI) checks for the `moflo` server specifically.
- **Config files** — `moflo.yaml`, `CLAUDE.md`, and `.claude/skills/flo/` follow the same skip-if-exists logic. Use `--force` to regenerate them.

To force a clean re-initialization over an existing setup:

```bash
flo init --force
```

#### First-run heads-up: brief CPU spike during initial indexing

The **very first time** MoFlo runs in your project — typically right after `flo init` and the next session start — it builds the initial guidance, code map, and test indexes from scratch and generates 384-dim embeddings for every chunk. On a medium-sized project this takes **one to a few minutes** and you may see elevated CPU during that window. It runs in the background, so you can start working immediately; you just might hear your fans for a bit.

After that first pass, indexing is **incremental and lazy** — every subsequent session start only re-processes files that actually changed since the last run, which typically finishes in under a second with no perceptible CPU activity. The big one-time cost is a deliberate trade: pay it once, then every future session opens with your project already searchable by meaning.

> **Tip:** Let that initial indexing finish before running **`/healer`** (or `flo healer`). Healer's embeddings and semantic-quality checks expect the indexes to exist — if you run it mid-build it may flag warnings that resolve themselves the moment indexing completes.

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
flo healer                   # Verify everything works (alias: flo doctor)
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

1. **Session start hook** — When Claude Code starts a new session, MoFlo's `SessionStart` hook launches the indexers sequentially in a single background process. This runs silently — you can start working immediately.
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

Without auto-indexing, Claude Code starts every session with a blank slate — it doesn't know what documentation exists, where code lives, or what tests cover which files. It resorts to Glob/Grep exploration, which burns tokens and context window on rediscovery.

With auto-indexing, Claude can search semantically ("how does auth work?") and get relevant documentation chunks ranked by similarity, or ask "where is the user model defined?" and get a direct answer from the code map — all without touching the filesystem.

## Learning From Your Sessions

MoFlo turns the work you do into durable knowledge. A lesson worth keeping — a reusable pattern, a gotcha that cost you an hour, a decision and the rationale behind it — lands in the `learnings` memory namespace, where it's embedded and semantically searchable in every future session. Two paths feed that namespace: one you trigger, one that runs on its own.

### `/meditate` — deliberate retrospective

Run **`/meditate`** at the end of a meaningful chunk of work. It reviews the session, distills the handful of lessons that would help a *future* session on a *different* task, deduplicates them against what's already stored, and writes the survivors to `learnings`. It's the curated pass — you choose when to capture, and it keeps only high-signal items (an empty reflection is a valid result, not a failure to pad).

```
/meditate                  # Review the whole session and store durable lessons
/meditate --preview        # Show the candidate lessons without writing anything
/meditate <focus>          # Scope the retrospective to one thread, e.g. "the auth refactor"
```

### Auto-meditate — the automatic counterpart

**Auto-meditate** does the same job without being asked. While you work, a lightweight hook notices when a durable lesson emerges — a correction, an error you fixed, a decision you made. At the next session start, a brief background pass distills those into `learnings` using the same durability bar and dedup-then-store protocol as `/meditate`. It reuses your existing Claude Code session (no extra API key), runs in the background, and **ships on by default**.

```yaml
auto_meditate:
  enabled: true            # Set to false to opt out — /meditate still works manually
```

The two are complementary: auto-meditate is the always-on safety net, `/meditate` is the deliberate, curated pass. Both write to the same `learnings` namespace and both deduplicate, so neither pollutes the other — and anything they store is available to semantic search from then on.

### Sharing learnings across installations

The `learnings` (and `knowledge`) namespaces are the **durable** slice of memory — user-authored and worth carrying across checkouts. The rest of the DB (code-map, guidance chunks, run state) is structural or ephemeral and rebuilds cheaply, so it stays local. For ongoing sync MoFlo shares only the durable slice — **never *live-shares* the whole `moflo.db`** between two daemons, which would make each daemon's in-memory search index diverge.

Pick the mechanism by topology:

| You want to share across… | Use | How |
|---------------------------|-----|-----|
| Git worktrees / Conductor workspaces (same machine) | **Automatic** — nothing to set | Learnings converge across worktrees at session-start (stored at `<git-common-dir>/moflo/durable.db`). Override with `memory.durable_path`; opt out with `memory.worktree_sharing: false` |
| Your own laptop + desktop + CI | `flo memory sync --to/--from <file>` | Export to a synced folder (Dropbox/iCloud) or a copied file, import on the other machine |
| A whole team on one repo | `flo memory team-export` → commit `.moflo/shared/learnings.jsonl` | Teammates' session-start import-merges it after `git pull` (first-write-wins; author provenance retained) |
| A fresh workspace that must be ready fast | `flo memory backup/restore` or `memory.hydrate_from` | Seed a new workspace from a **whole-DB snapshot** so it's searchable on session one — no cold reindex. Safe because each workspace owns its own copy (a one-time restore, not live sharing) |

Verify your setup with `flo doctor -c shared-db` (it warns if you've accidentally pointed at a full `moflo.db` for *live* sharing). Full guide: [`moflo-cross-install-memory-sharing.md`](.claude/guidance/shipped/moflo-cross-install-memory-sharing.md).

## The Gate System

MoFlo installs Claude Code hooks that run on every tool call. Together, these gates create a **feedback loop** that prevents Claude from wasting tokens on blind exploration and ensures it builds on prior knowledge.

### Gates explained

| Gate | What it enforces | When it triggers | Why it matters |
|------|-----------------|------------------|----------------|
| **Memory-first** | Claude must search the memory database before using Glob, Grep, or Read on guidance files | Before every Glob/Grep call, and before Read calls targeting `.claude/guidance/` | Prevents the AI from re-exploring files it (or a previous session) already indexed. Forces it to check what it knows first, saving tokens and context window. |
| **TaskCreate-first** | Claude must call TaskCreate before spawning sub-agents via the Task tool | Before every Task (agent spawn) call | Ensures every piece of delegated work is tracked. Prevents runaway agent proliferation where Claude spawns agents without a clear plan. |
| **Context tracking** | Tracks conversation length and warns about context depletion | On every user prompt (UserPromptSubmit hook) | As conversations grow, AI quality degrades. MoFlo tracks interaction count and assigns a bracket (FRESH → MODERATE → DEPLETED → CRITICAL), advising Claude to checkpoint progress or start a fresh session before quality drops. |
| **Routing** | Analyzes each prompt and recommends the optimal agent type and model tier | On every user prompt (UserPromptSubmit hook) | Saves cost by suggesting haiku for simple tasks, sonnet for moderate ones, opus for complex reasoning — without you having to think about model selection. |
| **Verify-before-done** *(opt-in)* | Claude must verify the change end-to-end (native `/verify`) before `gh pr create` | Before `gh pr create`, only when `gates.verify_before_done: true` | Enforces "prove it works before done." Off by default, so it never surprises an existing install. Pairs with the [Spec-Driven Development](#spec-driven-development-sdd) cycle, which gives verification its acceptance criteria. |

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
  verify_before_done: false   # Set to true to require /verify before `gh pr create`
```

You can also disable individual hooks in `.claude/settings.json` by removing the corresponding hook entries.

## The `/flo` Skill

Inside Claude Code, the `/flo` (or `/fl`) slash command drives GitHub issue execution:

```
/flo <issue>                  # Full process (research → implement → test → PR)
/flo -t <issue>               # Ticket only (research and update ticket, then stop)
/flo -r <issue>               # Research only (analyze issue, output findings)
/flo -s <issue>               # Swarm mode (multi-agent coordination)
/flo -h <issue>               # Hive-mind mode (consensus-based coordination)
/flo -n <issue>               # Normal mode (default, single agent, no swarm)
/flo -sd <issue>              # SDD: spec → plan → implement → verify (implies --verify)
/flo -v <issue>               # Verify-before-done only (no spec/plan front-half)
```

For full options and details, type `/flo` with no arguments — Claude Code will display the complete skill documentation. Also available as `/fl`.

### Spec-Driven Development (SDD)

`/flo` can run the full **spec → plan → (review) → implement → verify** cycle — the 2026 agentic-coding pattern — with two independent, opt-in modifiers:

- **`-sd` / `--sdd`** — author a **spec** (the *what* + acceptance criteria) and a **plan** (the *steps*), with a review checkpoint between each stage, before implementing. Artifacts persist as reviewable Markdown at `.moflo/specs/<slug>/{spec,plan}.md` and are indexed into memory, so prior specs are searchable across sessions. Implies `--verify`.
- **`-v` / `--verify`** — the verify half on its own: a normal run plus the [verify-before-done gate](#the-gate-system). Separable from SDD so you can enforce "prove it works" without the spec ceremony.

Both compose with execution mode (`-n`/`-s`/`-h`) and `--worktree`, and default from `moflo.yaml`:

```yaml
sdd:
  default: false              # true → every /flo run uses the SDD cycle unless --no-sdd
gates:
  verify_before_done: false   # true → require /verify before `gh pr create` unless --no-verify
```

`--sdd` implies `--verify` (a spec/plan without an enforced verify step drifts). Manage artifacts directly with `flo sdd` (`spec`, `plan`, `review`, `check`, `list`), and start from a fuzzy idea with **`/commune`**, which can hand its synthesized spec straight into the SDD spine. Wiring status is reported by **`/healer`** (and `/eldar`).

### Epic handling

When you pass an issue number, `/flo` automatically checks if it's an epic — no extra flag needed. An issue is treated as an epic if any of these are true:

- It has a label matching `epic`, `tracking`, `parent`, or `umbrella` (case-insensitive)
- Its body contains a `## Stories` or `## Tasks` section
- Its body has checklist-linked issues: `- [ ] #101`
- Its body has numbered issue references: `1. #101`
- The issue has GitHub sub-issues (via the API)

When an epic is detected, `/flo` processes each child story sequentially — full process per story (research → implement → test → PR), one at a time, in the order listed.

For simple epics with independent stories, `/flo <epic>` is all you need. For complex features where you want state tracking, resume capability, and auto-merge between stories, use `flo epic` instead.

### Feature Orchestration (`flo epic`)

`flo epic` is the robust epic runner — it adds persistent state, resume from failure, and per-story auto-merge on top of `/flo`. It takes a GitHub epic issue number:

```bash
flo epic 42                                # Fetch epic #42, run all stories sequentially
flo epic 42 --dry-run                      # Preview execution plan without running
flo epic 42 --strategy auto-merge          # Per-story PRs with auto-merge between stories
flo epic status 42                         # Check progress (which stories passed/failed)
flo epic reset 42                          # Reset state for re-run
```

`flo epic` fetches the epic from GitHub, extracts child stories from checklists, numbered references, and `## Stories` / `## Tasks` sections, then runs each through `/flo` with state tracking. If a story fails, you can fix the issue and re-run `flo epic 42` — it resumes from where it left off, skipping already-passed stories. (`flo epic run 42` is an explicit alias for the same shorthand.)

| | `/flo <epic>` | `flo epic <epic>` |
|---|---|---|
| **State tracking** | No | Yes (`epic-state` memory namespace) |
| **Resume from failure** | No | Yes (skips passed stories) |
| **Auto-merge PRs** | No | Yes (`--strategy auto-merge`) |
| **Dry-run preview** | No | Yes |

## Spells

### What are spells?

Spells are declarative YAML automations composed of pluggable step commands. They exist because shell scripts drift, ad-hoc prompts aren't reproducible, and CI/CD pipelines are the wrong tool for local automation. A spell is **deterministic** (same inputs → same steps), **reviewable** (a YAML file you read like a recipe), and **replayable** (re-cast it tomorrow and it behaves the same). Spells run from the CLI (`flo spell cast`), from an MCP tool call inside Claude Code, or on a schedule.

### How do they work?

Each cast goes through the same lifecycle:

1. **Parse & validate** — YAML is parsed and every step's `config` is checked against its command's schema.
2. **Resolve capabilities** — every step declares what it needs (`shell`, `net`, `fs:read`, `fs:write`, `memory`, `credentials`, `browser`, `agent`). Undeclared access is rejected before execution.
3. **Execute the step graph** — steps run sequentially by default, or in parallel groups, with `depends_on` for ordering and `condition`/`loop` for flow control.
4. **Outputs flow forward** — any step can reference a prior step's output as `{stepId.field}`, so later steps can consume earlier results.
5. **Persistence** — memory writes, artifacts, and per-step logs persist between runs; pause/resume and dry-run are supported.

```bash
flo spell cast -n development            # Cast a named spell
flo spell cast -f ./my-spell.yaml        # Cast from a file
flo spell cast -n sa --dry-run           # Validate without casting
flo spell list                           # List available spells and recent runs
flo spell grimoire list                  # Browse built-in spell templates
flo spell schedule list                  # List scheduled spells
```

### Defining spells

```yaml
name: my-spell
steps:
  - name: lint
    command: npm run lint
  - name: test
    command: npm test
  - name: deploy
    command: ./deploy.sh
    depends_on: [lint, test]
```

Steps support shell (`bash`), agent spawns, memory reads/writes, conditionals, loops, parallel groups, browser automation, GitHub/IMAP/Outlook/Slack/MCP integrations, prompts, waits, graphs, and composite steps. See [docs/SPELLS.md](docs/SPELLS.md) for the full schema.

### Sandboxing and security

Spells run with **least-privilege access**. Each step command declares the capabilities it needs (`shell`, `net`, `fs:read`, `fs:write`, `memory`, `credentials`, `browser`, `browser:evaluate`, `agent`), and the runner blocks any undeclared access. Spell authors can further restrict capabilities per step — e.g. `fs:read: ["./config/"]` or `shell: ["cat", "jq"]` — but never expand them.

Bash steps also run inside an OS sandbox when one is available. MoFlo auto-selects the best tier installed on your machine:

| Tier | Platform | Isolation |
|------|----------|-----------|
| Docker | all | Container, strictest |
| bwrap | Linux | User namespaces |
| sandbox-exec | macOS | Apple seatbelt profile |
| none | fallback | Capability-only enforcement |

The sandbox is `network-off` by default; a step must explicitly declare `net` to reach the outside world. Credentials referenced as `{credentials.X}` are resolved from the encrypted credential store, masked in logs, and never written to disk. A destructive-pattern checker refuses to run bash commands that look like `rm -rf /`, unscoped `git push --force`, and similar footguns. See [docs/SPELL-SANDBOXING.md](docs/SPELL-SANDBOXING.md) for the full model.

### Reusability

You interact with spells at three tiers:

1. **Shipped spells** — bundled with MoFlo and ready to cast. Browse them with `flo spell grimoire list`.
2. **User spells** — YAML files you drop in `.claude/spells/`. Override the location in `moflo.yaml`:
   ```yaml
   spells:
     userDirs:
       - .claude/spells
       - my/project/spells
   ```
   A user spell with the same `name` as a shipped one wins — that's how you customize a shipped spell without forking.
3. **Custom step commands and connectors** — drop TypeScript/JavaScript files in `.claude/spells/steps/` (new step types) and `.claude/spells/connectors/` (new connectors). They're auto-discovered at startup. Connectors that wrap heavy SDKs (IMAP, MCP) declare those SDKs as `optionalDependencies`; install them only if your spells use them.

### Scheduling

Spells can run on a schedule. The MoFlo background daemon polls for due spells once a minute and casts them — no external cron, no extra services.

**Three timing options:**

```bash
# Cron (5 fields: minute hour day-of-month month day-of-week)
flo spell schedule create -n nightly-audit --cron "0 2 * * *"

# Interval (e.g., 90s, 30m, 6h, 1d)
flo spell schedule create -n health-check --interval 30m

# One-time (ISO 8601 datetime)
flo spell schedule create -n migration --at 2026-04-15T09:00:00Z
```

You can also declare a schedule directly inside the spell YAML — that registers it on every daemon start:

```yaml
name: nightly-audit
schedule:
  cron: "0 2 * * *"
steps:
  - id: audit
    type: bash
    config:
      command: ./scripts/audit.sh
```

**Daemon prerequisite.** Schedules only fire while the daemon is running. To survive reboot:

```bash
flo daemon install   # registers an OS-level autostart service
flo daemon status    # shows whether the service is registered AND running
```

`flo spell schedule create` warns when the daemon isn't installed so you don't quietly miss runs.

**Monitoring.** **[The Luminarium](#the-luminarium)** — moflo's localhost daemon dashboard — surfaces live schedules, recent executions, and per-schedule controls (disable / re-enable / run now), alongside worker health, memory stats, and Claude Code session stats. Ask `/luminarium` in your Claude session and it'll print the link.

For full configuration (`scheduler:` block in `moflo.yaml`), event types, and the catch-up window after restarts, see [docs/SPELLS.md#scheduling](docs/SPELLS.md#scheduling).

### Building spells with the `/spell-builder` skill

Inside Claude Code, use the `/spell-builder` skill to create, edit, and validate spell definitions interactively. The skill understands the full spell schema and available step commands, so you can describe what you want in natural language and it will generate the YAML:

```
/spell-builder                           # Start the spell builder
```

### Other AI-client skills shipped with MoFlo

Beyond `/flo`, `/spell-builder`, and `/eldar`, MoFlo ships a handful of focused slash-command skills that work in any consumer project once you `flo init`:

| Skill | Purpose |
|-------|---------|
| `/guidance` | Author and audit guidance docs. Default writes guidance for Claude into `.claude/guidance/` as Markdown applying moflo's universal rules. `-h` switches the audience to humans (lighter ruleset, writes into `docs/`). `--html` emits HTML with a minimal default stylesheet instead of Markdown. `-a` audits every doc in `.claude/guidance/` against the universal rules. |
| `/flo-simplify` (alias `/distill`) | Adaptive code review on the current diff. Tier-based fan-out — trivial edits get a self-review, small diffs get one routed agent, cross-cutting refactors get three parallel agents. Routes through the moflo model router for cost-aware execution. (Named `/flo-simplify` to avoid colliding with Claude Code's built-in `/simplify`; also available as `/distill` for a more wizardy feel.) |
| `/quicken` (alias `/perf-audit`) | Ad-hoc performance audit — "quicken the codebase". Reveals N+1 queries, needless re-renders, missing caching, memory leaks, and redundant computation, then prescribes the fix **inline in the session**. Scopes to your current diff by default (or a path you name), so it never re-audits the whole tree. Replaces the old always-on `optimize` daemon worker. |
| `/ward` (alias `/test-gaps`) | Ad-hoc test-gap audit — "ward the codebase". Reveals untested functions, uncovered edge cases, and missing error-handling/integration tests, then conjures ready-to-paste test skeletons in your framework **inline in the session**. Scopes to your current diff by default (or a path you name). Replaces the old always-on `testgaps` daemon worker. |
| `/commune` | Socratic requirements elicitation. Turns a fuzzy "I'm not sure exactly what I want yet" idea into a concrete spec through a short Q&A, then hands the result off to a `/flo` ticket, a spell, or memory. The pre-execution counterpart to `/meditate` — use it to *open* a unit of work. |
| `/divine` | Multi-hop web research with explicit confidence gating. Plans the inquiry, searches the web, scores its own confidence, and keeps digging until the answer is well-supported (or a hop cap is hit) — then returns a cited synthesis and remembers what worked so the next research run starts smarter. |
| `/meditate` | Deliberate session retrospective — distills durable lessons into the `learnings` memory namespace, deduped against what's already there. See [Learning From Your Sessions](#learning-from-your-sessions) for the full picture, including its automatic counterpart, auto-meditate. |
| `/spell-schedule` | Schedule a spell on the local moflo daemon (cron, interval, or one-time) without leaving the chat. For remote Anthropic-cloud agents on a schedule, use Claude Code's built-in `/schedule` instead. |

Run any of them with no arguments to see full usage, or browse the source in `.claude/skills/` (each skill is a single `SKILL.md` file).

### Epics

Epics are a specialized process for handling GitHub issues that contain multiple child stories. When you pass a GitHub issue to `/flo` and it's detected as an epic, MoFlo processes each child story sequentially through the full `/flo` process (research → implement → test → PR).

For simple epics, `/flo <epic-number>` is all you need. For complex features requiring state tracking, resume from failure, and auto-merge between stories, use the dedicated `flo epic` command:

```bash
flo epic 42                              # Run all stories in epic #42
flo epic 42 --strategy auto-merge        # Per-story PRs with auto-merge
flo epic 42 --dry-run                    # Preview execution plan
flo epic status 42                       # Check progress
flo epic reset 42                        # Reset state for re-run
```

See the [Epic handling](#epic-handling) section above for detection criteria and the comparison between `/flo <epic>` and `flo epic run`.

## The Luminarium

The Luminarium is moflo's localhost daemon dashboard. It boots automatically with the background daemon (no extra service to install) and stays running as long as the daemon is up.

### Finding the URL

Inside a Claude Code session in a moflo project, ask **`/luminarium`** — the skill prints the dashboard URL for the current project. `flo daemon status` prints the same URL alongside the health summary. Each project binds its own port so two projects on the same machine never collide.

### What it shows

| Tab | What you see |
|-----|--------------|
| **Workers** | Live agent processes the daemon is running (statusline updater, indexer, embedder, etc.) |
| **Schedules** | All registered spell schedules (cron / interval / one-time), with run-now and disable controls |
| **Executions** | Recent spell runs — duration, exit code, step-by-step output |
| **Memory** | Memory namespace breakdown, vector count, embedder backend, HNSW index health |
| **Claude Stats** | Per-session Claude Code transcript stats — tokens, tools called, files touched (local primary sessions only) |

### Flags

- `flo daemon start --no-dashboard` — disable the HTTP server entirely (the daemon itself still runs)
- `flo daemon start --dashboard-port <N>` — pin to a specific port, overriding the per-project default. Also accepts the `MOFLO_DAEMON_PORT` env var, which the rest of moflo respects when talking to the daemon

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

### Gates

```bash
flo gate check-before-scan       # Blocks Glob/Grep if memory not searched
flo gate check-before-agent      # Blocks Agent tool if no TaskCreate
flo gate prompt-reminder         # Context bracket tracking
flo gate session-reset           # Reset gate state
```

### Diagnostics

```bash
flo healer                       # Quick health check (environment, deps, config)
flo healer --fix                 # Auto-fix issues (memory DB, daemon, config, MCP, zombies)
flo diagnose                     # Full integration test (memory, swarm, hive, hooks, neural)
flo diagnose --suite memory      # Run only memory tests
flo diagnose --json              # JSON output for CI/automation
```

`flo doctor` is still accepted as an alias for `flo healer` — every flag and subcommand below works under either name.

#### `flo healer` — Health Check

`flo healer` runs 38 parallel health checks against your environment and reports pass/warn/fail for each:

| Check | What it verifies |
|-------|-----------------|
| **Version Freshness** | Whether your installed MoFlo version matches the latest on npm (detects stale npx cache) |
| **Node.js Version** | Node.js >= 20 installed |
| **npm Version** | npm >= 9 installed |
| **Claude Code CLI** | `claude` command available |
| **Git** | Git installed |
| **Git Repository** | Project is inside a git repository |
| **Config File** | Valid `moflo.yaml` exists |
| **Status Line** | `statusLine` config wired in `.claude/settings.json` (auto-fixes when missing) |
| **Daemon Status** | Background daemon running (checks PID, cleans stale locks) |
| **Memory Database** | SQLite memory DB exists and is accessible |
| **Embeddings** | Vectors indexed in memory DB, HNSW index present |
| **Embedding Hygiene** | Indexer writes preserve existing embeddings instead of clobbering them |
| **Test Directories** | Test dirs from `moflo.yaml` exist on disk, reports auto-index status |
| **MCP Servers** | `moflo` MCP server configured in `.mcp.json` |
| **Disk Space** | Sufficient free disk space (warns at 80%, fails at 90%) |
| **TypeScript** | TypeScript compiler available |
| **Semantic Quality** | Semantic search returns relevant, varied results with acceptable similarity scores |
| **Intelligence** | SONA, ReasoningBank, PatternLearner, LoRA, EWC++, and RL subsystems are loaded |
| **Spell Engine** | Core spell modules, step commands, loaders, and index are present |
| **Zombie Processes** | No orphaned MoFlo node processes running |
| **Subagent Health** | Agent lifecycle (spawn → status → terminate) completes successfully |
| **Spell Execution** | End-to-end spell probe runs a real step and captures output |
| **MCP Tool Invocation** | MCP tool schemas are loaded and callable |
| **MCP Spell Integration** | Bridge between MCP tools and spell engine functions correctly |
| **Hook Execution** | Hook executor is functional and can fire hooks |
| **Gate Health** | All gate cases, hook bindings, and state file are intact |
| **MofloDb Bridge** | Memory DB adapter (node:sqlite + HNSW) is wired and routable |
| **Sandbox Tier** | Detects which sandbox backend is available (Docker / bwrap / sandbox-exec / none) |

**Auto-fix mode** (`flo healer --fix`) attempts to repair each failing check automatically:

| Issue | What `--fix` does |
|-------|------------------|
| Missing memory database | Creates `.swarm/` directory and initializes the SQLite DB |
| Embeddings not initialized | Initializes memory DB and runs `embeddings init` |
| Missing config file | Runs `config init` to generate defaults |
| Status line not wired | Adds `statusLine` config block to `.claude/settings.json` |
| Stale daemon lock | Removes stale `.moflo/daemon.lock` and restarts daemon |
| Malformed `.mcp.json` (e.g. unescaped Windows paths) | Backs up the broken file as `.mcp.json.malformed-<ts>`, regenerates a clean one, verifies it parses (#1126) |
| MCP server missing from a valid `.mcp.json` | Runs `claude mcp add moflo` to register the server |
| Claude Code CLI missing | Installs `@anthropic-ai/claude-code` globally |
| Zombie processes | Kills orphaned MoFlo processes (tracked + OS-level scan) |

After auto-fixing, healer re-runs all checks and shows the updated results. Issues that can't be fixed automatically are listed with manual fix commands.

Additional flags:

```bash
flo healer --install             # Auto-install missing Claude Code CLI
flo healer --kill-zombies        # Find and kill orphaned MoFlo processes
flo healer -c memory             # Check only a specific component
flo healer -c embeddings         # Check only embeddings health
flo healer --verbose             # Verbose output
```

#### `/eldar` — Consult the Eldar (project setup audit + wizard)

Where the Healer checks your moflo install, `/eldar` audits how Claude is set up to *use* the project — guidance, CLAUDE.md, memory namespaces, hook/MCP wiring, model routing, and stack-aware guidance gaps — then walks you through fixing whichever findings you pick. Use it when starting in a new project, when Claude feels lost or inefficient, or as a periodic health check.

```
/eldar                           # Read-only audit; categorized report + top-3 ranked recommendation
/eldar --fix                     # Audit, then interactive triage menu — pick which findings to address
```

The Eldar **consult** the Healer (they call `flo healer --json` as one of the audit checks) — they don't replace it. Categories audited include setup health, index freshness, version skew, model/token routing, CLAUDE.md size + reference integrity, guidance content + structure, memory health, hook/MCP wiring, settings sanity, spell + subagent inventory, **stack → guidance cross-reference** (detects tech from package.json/pyproject.toml/Cargo.toml/go.mod and flags every detected technology with no matching guidance doc — the highest-leverage finding for new adopters), and best-effort anti-pattern detection from history.

In `--fix` mode, each chosen finding drives the appropriate sub-flow: Healer for setup repair, the `/guidance` skill for guidance authoring (wizard, never autogen), a stack-aware scaffold for missing CLAUDE.md, `flo init --upgrade` for hook/MCP wiring. Every write is confirmed before it lands.

#### `flo diagnose` — Integration Tests

While `healer` checks your environment, `diagnose` exercises every subsystem end-to-end: memory CRUD, embedding generation, semantic search, swarm lifecycle, hive-mind consensus, task management, hooks, config, neural patterns, and init idempotency. All test data is cleaned up after each test — nothing is left behind.

### GitHub Repository Setup

```bash
flo github setup                  # One-shot: generate CI + apply repo settings + branch protection
flo github setup --dry-run        # Preview everything without making changes
flo github ci                     # Generate .github/workflows/ci.yml from project config
flo github ci --dry-run           # Print CI config to stdout
flo github settings               # Apply repo settings + branch protection via gh CLI
flo github settings --dry-run     # Preview settings changes
```

`flo github ci` auto-detects your package manager (npm/pnpm/yarn/bun), TypeScript, and test directories from `moflo.yaml` and `package.json`, then generates a GitHub Actions CI pipeline with install, build, lint, type-check, and test steps.

`flo github settings` applies recommended defaults via `gh` CLI: delete-branch-on-merge, squash merge with PR title/body, auto-merge, linear history, and configurable branch protection (required reviews, dismiss stale reviews, block force pushes). Requires `gh auth login`.

### System

```bash
flo init                          # Initialize project (one-time setup)
flo --version                    # Show version
```

## What Ships Out of the Box

`flo init` wires up the following systems automatically. Here's what each one does, why it matters, and whether it's enabled by default.

### Hooks (enabled OOTB)

Hooks are shell commands that Claude Code runs automatically at specific points in its lifecycle. MoFlo installs 26 hook bindings across 8 lifecycle events. You don't invoke these — they fire automatically.

| Hook Event | What fires | What it does | Enabled OOTB |
|------------|-----------|-------------|:---:|
| **PreToolUse: Write/Edit** | `flo hooks pre-edit` | Records which file is about to be edited, captures before-state for learning | Yes |
| **PreToolUse: Glob/Grep** | `flo gate check-before-scan` | Memory-first gate — blocks file exploration until memory is searched | Yes |
| **PreToolUse: Read** | `flo gate check-before-read` | Blocks reading guidance files directly until memory is searched | Yes |
| **PreToolUse: Bash** | `flo gate check-dangerous-command` | Safety check on shell commands | Yes |
| **PreToolUse: Bash** | `flo gate check-before-pr` | Validates PR readiness before `gh pr create` | Yes |
| **PostToolUse: Write/Edit** | `flo hooks post-edit` | Records edit outcome, optionally trains neural patterns | Yes |
| **PostToolUse: Write/Edit** | `flo gate reset-edit-gates` | Resets edit-related gate state after the write completes | Yes |
| **PostToolUse: Agent** | `flo hooks post-task` | Records task completion, feeds outcome into routing learner | Yes |
| **PostToolUse: TaskCreate** | `flo gate record-task-created` | Records that a task was registered (clears TaskCreate gate) | Yes |
| **PostToolUse: Bash** | `flo gate check-bash-memory` | Detects memory search commands in Bash (clears memory gate) | Yes |
| **PostToolUse: Bash** | `flo gate record-test-run` | Records test runs from Bash for the test-output gate | Yes |
| **PostToolUse: Skill** | `flo gate record-skill-run` | Records that a skill was invoked (clears skill-related gates) | Yes |
| **PostToolUse: memory_search** | `flo gate record-memory-searched` | Records that memory was searched (clears memory-first gate) | Yes |
| **PostToolUse: TaskUpdate** | `flo gate check-task-transition` | Validates task state transitions (prevents skipping states) | Yes |
| **PostToolUse: memory_store** | `flo gate record-learnings-stored` | Records that learnings were persisted to memory | Yes |
| **UserPromptSubmit** | `prompt-hook.mjs` | Resets per-prompt gate state, tracks context bracket, routes task to agent | Yes |
| **UserPromptSubmit** | `meditate-capture.mjs meditate-detect` | Auto-meditate: notices when a durable lesson emerges in the live session and queues it for distillation | Yes |
| **SubagentStart** | `subagent-start` | Injects context and guidance into spawned sub-agents | Yes |
| **SessionStart** | `session-start-launcher.mjs` | Launches auto-indexers (guidance, code map, tests), restores session state, fires the auto-meditate distillation pass | Yes |
| **SessionStart** | `auto-memory-hook.mjs` | Imports auto-memory entries from Claude's persistent memory | Yes |
| **Stop** | `flo hooks session-end` | Persists session metrics, exports learning data | Yes |
| **Stop** | `auto-memory-hook.mjs` | Syncs auto-memory state on session close | Yes |
| **Stop** | `session-continuity.mjs capture` | Captures a "where you left off" session digest for relevance-gated injection at the next session start | Yes |
| **Stop** | `meditate-capture.mjs meditate-scrape` | Auto-meditate: scrapes the lessons recognized this session into the distillation queue | Yes |
| **PreCompact** | `flo gate compact-guidance` | Injects guidance summary before context compaction | Yes |
| **Notification** | `flo hooks notification` | Routes Claude Code notifications through MoFlo | Yes |

### Systems (enabled OOTB)

These are the backend systems that hooks and commands interact with.

| System | What It Does | Why It Matters | Enabled OOTB |
|--------|-------------|----------------|:---:|
| **Semantic Memory** | SQLite database (Node's built-in `node:sqlite`) storing knowledge entries with 384-dim vector embeddings | Your AI assistant accumulates project knowledge across sessions instead of starting from scratch each time | Yes |
| **HNSW Vector Search** | Hierarchical Navigable Small World index for fast nearest-neighbor search | Searches across thousands of stored entries return in milliseconds instead of scanning linearly | Yes |
| **Guidance Indexing** | Chunks markdown docs into overlapping segments, embeds each with MiniLM-L6-v2 | Your project documentation becomes searchable by meaning ("how does auth work?") not just keywords | Yes |
| **Code Map** | Parses source files for exports, classes, functions, types | The AI can answer "where is X defined?" from the index instead of running Glob/Grep | Yes |
| **Test Indexing** | Maps test files to their source targets based on naming patterns | The AI can answer "what tests cover X?" and identify untested code | Yes |
| **Gates** | Hook-based enforcement of memory-first and task-registration patterns | Prevents the AI from wasting tokens on blind exploration and untracked agent spawns | Yes |
| **Context Tracking** | Interaction counter with bracket classification (FRESH/MODERATE/DEPLETED/CRITICAL) | Warns before context quality degrades, suggests when to checkpoint or start fresh | Yes |
| **Semantic Routing** | Matches task descriptions to agent types using vector similarity against 12 built-in patterns | Routes work to the right specialist (security-architect, tester, coder, etc.) automatically | Yes |
| **Learned Routing** | Records task outcomes (agent type + success/failure) and feeds them back into routing | Routing gets smarter over time — successful patterns are weighted higher in future recommendations | Yes |
| **SONA Learning** | Self-Optimizing Neural Architecture that learns from task trajectories | Adapts routing weights based on actual outcomes, not just keyword matching | Yes |
| **MicroLoRA Adaptation** | Rank-2 LoRA weight updates from successful patterns | Fine-grained model adaptation without full retraining | Yes |
| **EWC++ Consolidation** | Elastic Weight Consolidation that prevents catastrophic forgetting | New learning doesn't overwrite patterns from earlier sessions | Yes |
| **Session Persistence** | Stop hook exports session metrics; SessionStart hook restores prior state | Patterns learned on Monday are available on Friday | Yes |
| **Auto-Meditate** | Recognizes durable lessons in the live session and distills them into the `learnings` namespace in a background pass at the next session start | The high-signal lessons from each session are kept automatically — no need to remember to run `/meditate` | Yes |
| **Status Line** | Live dashboard showing git branch, session state, memory stats, MCP status | At-a-glance visibility into what MoFlo is doing | Yes |
| **MCP Tool Server** | 80+ MCP tools for memory, hooks, coordination, spells, swarm, etc. (schemas deferred by default) | Lets Claude Code call MoFlo functionality directly | Yes (deferred) |

### Systems (available but off by default)

| System | What It Does | How to Enable |
|--------|-------------|---------------|
| **Model Routing** | Auto-selects haiku/sonnet/opus per task based on complexity analysis | `model_routing.enabled: true` in `moflo.yaml` |
| **MCP Auto-Start** | Starts MCP server automatically on session begin | `mcp.auto_start: true` in `moflo.yaml` |
| **Tool Schema Eager Loading** | Loads all MCP tool schemas (100+) at startup (instead of on-demand) | `mcp.tool_defer: false` in `moflo.yaml` |

## The Two-Layer Task System

MoFlo doesn't replace Claude Code's task system — it wraps it. Claude Code handles spawning agents and running code. MoFlo adds a coordination layer on top that handles memory, routing, and learning.

```
┌──────────────────────────────────────────────────┐
│  CLAUDE CODE (Execution Layer)                   │
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
3. **Claude Code executes** — The actual agent runs through Claude Code's native task system. MoFlo doesn't manage the agent — Claude Code handles execution, output, and completion.
4. **MoFlo learns** — After the agent finishes, MoFlo records what worked (or didn't) in its memory database. Successful patterns feed into future routing.

The key insight: **Claude Code handles execution, MoFlo handles knowledge.** Claude Code is good at spawning agents and running code. MoFlo is good at remembering what happened, routing to the right agent, and ensuring prior knowledge is checked before exploring from scratch.

For complex work, MoFlo structures tasks into waves — a research wave discovers context, then an implementation wave acts on it — with dependencies tracked through both Claude Code's task system and MoFlo's coordination layer. The full integration pattern is documented in `.claude/guidance/moflo-claude-swarm-cohesion.md`.

The `/flo` skill ties both systems together for GitHub issues — driving the full process (research → enhance → implement → test → simplify → PR) with Claude Code's agents for execution and MoFlo's memory for continuity.

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

Routing outcomes persist across sessions. You can inspect them with `flo hooks patterns` or transfer them between projects with `flo hooks transfer`.

### Memory & Knowledge Storage

MoFlo uses a SQLite database (via Node 22's built-in `node:sqlite` — no native deps) to store three types of knowledge:

| Namespace | What's Stored | How It Gets There |
|-----------|---------------|-------------------|
| `guidance` | Chunked project docs (`.claude/guidance/`, `docs/`) with 384-dim embeddings | `flo-index` on session start |
| `code-map` | Structural index of source files (exports, classes, functions) | `flo-codemap` on session start |
| `tests` | Test file → source target reverse mapping | `flo-testmap` on session start |
| `patterns` | Learned patterns from successful task outcomes | Post-task hooks after agent work |

**Semantic search** uses cosine similarity on neural embeddings (MiniLM-L6-v2, 384 dimensions). When Claude searches memory, it gets the most relevant chunks ranked by semantic similarity — not keyword matching.

**Session start indexing** — Background indexers (guidance, code map, tests) run on every session start. They're incremental — unchanged files are skipped — and run in parallel so they don't block the session.

**Cross-session persistence** — Everything stored in the database survives across sessions. Patterns learned on Monday are available on Friday. The stop hook exports session metrics, and the session-restore hook loads prior state.

### For Claude

When `flo init` runs, it appends a section to your CLAUDE.md that teaches Claude:
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

auto_meditate:
  enabled: true                      # Distill durable session lessons into the learnings namespace

mcp:
  tool_defer: true                   # Defer MCP tool schemas (100+); loaded on demand via ToolSearch
  auto_start: false                  # Auto-start MCP server on session begin

hooks:
  pre_edit: true                     # Track file edits for learning
  post_edit: true                    # Record edit outcomes
  pre_task: true                     # Agent routing before task spawn
  post_task: true                    # Record task results for learning
  gate: true                         # Gate enforcement
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
  show_mcp: true
```

### Tool Deferral

By default, `tool_defer` is `true`. MoFlo exposes 100+ MCP tools — loading all their schemas at conversation start consumes significant context. With deferral enabled, only tool **names** are listed at startup (compact), and full schemas are fetched on demand via `ToolSearch` when actually needed. Hooks and CLI commands continue to work normally since they call the daemon directly, not through MCP tool schemas.

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

## Background

MoFlo began as a fork of Claude Flow but is now an independent project. The two share some early roots and a few namespace conventions, but the codebases, runtime, and design priorities have fully diverged.

MoFlo narrows the focus to one scenario: day-to-day local coding with Claude Code on a single project. Instead of a broad, highly configurable orchestration framework, it bakes in sensible defaults, adds automatic indexing and memory gating at session start, and tunes the out-of-box experience so that `npm install` and `flo init` get you straight to coding. Over time it grew its own architecture — workspace collapse, in-tree fastembed runtime, node:sqlite + HNSW memory layer, spell engine, daemon-driven scheduling — and ships as a single npm package.

## Contributing

Contributions are welcome — bug reports, documentation, tests, and code. See **[CONTRIBUTING.md](./CONTRIBUTING.md)** for setup, conventions, and how to open a pull request. By participating, you agree to abide by our **[Code of Conduct](./CODE_OF_CONDUCT.md)**.

## License

MIT
