# MoFlo — Infographic Source Brief

> **Purpose of this document:** A structured, fact-checked description of MoFlo's main features, written to be handed to an AI image/infographic generator for a blog post. Each section gives a short label, a one-line hook, a plain-language description, and the concrete numbers/commands worth putting on the graphic. Suggested visual groupings are at the bottom.

---

## The one-liner (headline for the graphic)

**MoFlo makes Claude Code remember what it learns, check what it knows before exploring, and get smarter over time — automatically, and 100% locally.**

Sub-headline: *An opinionated AI-agent orchestration toolkit for Claude Code. `npm install`, `flo init`, restart — memory, indexing, gates, and routing are all live.*

## The elevator pitch (2 sentences)

MoFlo is a self-contained toolkit that plugs into Anthropic's Claude Code and upgrades it from a stateless assistant into one with durable memory, semantic search over your own code and docs, and enforcement gates that stop it wasting tokens on blind exploration. Everything runs on your machine — no cloud, no API keys, no native compilation — and it learns from every task so routing and recall keep improving.

---

## Core value props (the "why" — good for a top banner)

| Value prop | Payoff |
|---|---|
| 🧠 **Remembers** | Knowledge persists across sessions — patterns learned Monday are available Friday. |
| 🔍 **Knows your codebase** | Your docs, code, and tests are indexed by *meaning*, searchable instantly. |
| 🚦 **Stops waste** | Gates force "check what you know first" before blind file exploration. |
| 📈 **Gets smarter** | Task outcomes feed back into routing — it improves with use. |
| 🔒 **Fully local** | No cloud, no API keys, no external services. Runs entirely on your machine. |
| 💻 **Cross-platform** | Identical behavior on macOS, Linux, and Windows. |

---

## FEATURE BLOCKS

### 1. 🧠 Semantic Memory
**Hook:** *Store knowledge once, search it by meaning forever.*
A local SQLite database (Node 22's built-in `node:sqlite` — zero native dependencies) holds knowledge as **384-dimensional neural embeddings** (`all-MiniLM-L6-v2`). Search uses cosine similarity, so Claude retrieves the most *relevant* chunks — not keyword matches.
- **Key numbers:** 384-dim embeddings · **HNSW** approximate-nearest-neighbor index — the same class of algorithm production vector databases use, which stays fast as the store grows (a linear keyword scan slows down with every entry added).
- **Namespaces:** `guidance`, `code-map`, `tests`, `patterns`, `learnings`, `knowledge`.
- **Command:** `flo memory search -q "auth patterns"` / MCP tool `memory_search`.

### 2. 📚 Auto-Indexing (zero-touch knowledge)
**Hook:** *Your project is searchable by meaning before you type a word.*
On **every session start**, MoFlo indexes three content types in the background — no manual step:
- **Guidance** → chunks your markdown docs (`.claude/guidance/`, `docs/`) into searchable embeddings.
- **Code map** → structural index of exports, classes, functions, types → answers "where does X live?" without Glob/Grep.
- **Tests** → maps test files back to source → answers "what tests cover X?"
- **Key trait:** **Incremental & lazy** — only changed files re-process. First run: 1–few minutes on a big repo; every run after typically **under a second**.

### 3. 🚦 The Gate System (enforcement, not suggestions)
**Hook:** *Rules enforced by hooks — not hoped for in a prompt.*
Claude Code hooks fire on every tool call and create a feedback loop that blocks wasteful behavior:
| Gate | Enforces |
|---|---|
| **Memory-first** | Must search memory before Glob / Grep / reading guidance files. |
| **TaskCreate-first** | Must register a task before spawning a sub-agent (stops runaway agent sprawl). |
| **Context tracking** | Warns as the context window depletes: FRESH → MODERATE → DEPLETED → CRITICAL. |
| **Routing** | Recommends the right agent type + model tier per prompt. |
- **Smart:** simple directives ("commit", "yes") skip the gate; real tasks are enforced.
- **Escape hatch:** prefix a prompt with `@@` to bypass for one turn.

### 4. 🧭 Learned & Semantic Routing
**Hook:** *The right agent for the job — and it learns which one that is.*
MoFlo ships **12 built-in task patterns** (security-task → security-architect, testing-task → tester, bugfix-task → coder, etc.) and matches prompts to them with HNSW vector similarity, returning a ranked recommendation with confidence scores. **Every successful task outcome is recorded and fed back**, so routing sharpens over time and persists across sessions.
- **Commands:** `flo hooks route --task "..."` · `flo hooks patterns` · `flo hooks transfer` (move learning between projects).

### 5. 🎯 Model Selection (cost-aware)
**Hook:** *Haiku for typos, Opus for architecture — automatically.*
Optional intelligent model routing analyzes each task's complexity and picks the cheapest capable model:
| Complexity | Model | Example |
|---|---|---|
| Low | **Haiku** | typos, renames, config, formatting |
| Medium | **Sonnet** | features, tests, bug fixes |
| High | **Opus** | architecture, security audits, complex debugging |
- A **circuit breaker** penalizes a model that fails a task and escalates to a more capable one.
- Pin critical agents (e.g. `security-architect: opus`) even when routing is on.
- Default is *static* preference (predictable); enable with `model_routing.enabled: true`.

### 6. 🌱 Learning From Your Sessions (Reflection)
**Hook:** *Every hard-won lesson becomes durable, searchable memory.*
Lessons — reusable patterns, gotchas, decisions + rationale — land in the `learnings` namespace, embedded and semantically searchable in every future session. Two paths:
- **`/meditate`** — deliberate, curated retrospective you trigger at end of work.
- **Auto-meditate** — always-on background pass that distills durable lessons automatically (ships on by default, reuses your existing session, no extra API key).

### 7. 🤖 Full Learning Stack (wired up out of the box)
**Hook:** *A real adaptive-learning engine — local, no GPU, no API keys.*
All configured and functional from `flo init`:
- **SONA** (Self-Optimizing Neural Architecture) — learns from task trajectories.
- **MicroLoRA** — lightweight rank-2 weight adaptations from successful patterns (fine-grained adaptation without full retraining).
- **EWC++** (Elastic Weight Consolidation) — prevents catastrophic forgetting across sessions.
- **ReasoningBank** — semantic routing from learned patterns.
- **HNSW** vector search + **trajectory persistence** across sessions.

### 8. ⚡ The `flo` CLI + Semantic Search
**Hook:** *One command wires it all up; the rest runs itself.*
- **`flo init`** — scans your project, detects guidance/code/test dirs and languages, generates `moflo.yaml`, hooks, the `/flo` skill, and a CLAUDE.md section. One-time setup.
- **`flo-search`** — semantic search CLI.
- **`flo healer`** (alias `flo doctor`) — **38 parallel health checks**; `--fix` auto-repairs (memory DB, daemon, config, MCP, zombie processes).
- **9 bin entries** ship with the npm package (`flo`, `moflo`, `flo-search`, `flo-codemap`, `flo-embeddings`, `flo-index`, `flo-testmap`, etc.).

### 9. ✨ Spells (declarative automations)
**Hook:** *Reproducible local automation as reviewable YAML.*
Multi-step automations composed of pluggable step commands — shell, agent spawns, conditionals, loops, memory ops, browser automation, GitHub/IMAP/Outlook/Slack/MCP integrations. **Deterministic, reviewable, replayable.**
- **Least-privilege security:** each step declares capabilities (`shell`, `net`, `fs:read`, `fs:write`, `credentials`, `browser`, `agent`); undeclared access is rejected. Bash steps run in an OS sandbox (**Docker / bwrap / sandbox-exec / none**), network-off by default, with a destructive-command checker (blocks `rm -rf /`, unscoped force-push, etc.).
- **Scheduling:** cron, interval, or one-time — the daemon polls once a minute. No external cron.
- **Command:** `flo spell cast` · build them with the `/spell-builder` skill.

### 10. 🐝 Swarm & Hive-Mind Orchestration
**Hook:** *Multi-agent coordination — queen/worker hierarchy and consensus.*
Headline orchestration surface: `flo swarm`, `flo hive-mind`, and MCP tools (`swarm_*`, `agent_*`, `task_*`, `hive-mind_*`). Coordinated multi-agent execution with a queen/worker hierarchy and consensus-based decisions. Accessible from `/flo`: `-s` (swarm mode) and `-h` (hive-mind mode).

### 11. 🎫 The `/flo` Skill (GitHub issue execution)
**Hook:** *An issue number in; a tested PR out.*
Drives a full pipeline: **research → enhance → implement → test → simplify → PR.**
- Modes: `-t` ticket-only, `-r` research-only, `-s` swarm, `-h` hive-mind, `-n` normal.
- **Auto-detects epics** and runs each child story sequentially. `flo epic` adds persistent state, resume-from-failure, and per-story auto-merge.

### 12. 📊 The Daemon, Luminarium Dashboard & Status Line
**Hook:** *Live visibility into everything MoFlo is doing.*
- **Background daemon** — runs indexers, embedder, statusline, scheduler; installable as an OS autostart service (`flo daemon install`).
- **The Luminarium** — a localhost daemon dashboard (boots with the daemon, per-project port). Tabs: **Workers, Schedules, Executions, Memory, Claude Stats.** Ask `/luminarium` for the URL.
- **Status line** — live git branch, session state, memory stats, MCP status.

### 13. 🧰 Skills Catalog (slash commands that ship with init)
**Hook:** *Focused wizards for the moments that matter.*
Beyond `/flo`, MoFlo ships slash-command skills usable in any project after `flo init`:
- **`/eldar`** — audits how Claude is set up to use *your* project (guidance, CLAUDE.md, memory, hook/MCP wiring, stack→guidance gaps). *"The single highest-leverage thing after install."*
- **`/healer`** — full moflo diagnostics + auto-fix.
- **`/guidance`** — author/audit guidance docs.
- **`/quicken`** (perf audit) · **`/ward`** (test-gap audit) · **`/distill`** (code review).
- **`/commune`** (Socratic spec-building) · **`/divine`** (multi-hop web research) · **`/meditate`** (retrospective).

---

## Numbers worth featuring (stat call-outs)

*(All figures below are code-verified or countable structural facts — see the Accuracy notes at the end for provenance. No performance-multiplier claims are included, because none are backed by a benchmark in the repo.)*

- **384** — embedding dimensions (`all-MiniLM-L6-v2`)
- **9** — CLI bin entries shipped (verified in `package.json`)
- **26** — hook bindings installed across **8** Claude Code lifecycle events
- **12** — built-in task-routing patterns
- **38** — parallel health checks in `flo healer`
- **100+** — MCP tools exposed (schemas deferred by default to save context)
- **4** — context-depletion brackets (FRESH → MODERATE → DEPLETED → CRITICAL)
- **~340 MB / ~150 MB** — disk reclaimed on Linux / Windows by the postinstall runtime trim (the prune script measures and logs the actual bytes reclaimed)
- **3** — indexed content types (guidance, code map, tests) · **3** OS sandbox tiers (Docker / bwrap / sandbox-exec)

## The two-layer mental model (great as a diagram)

```
┌────────────────────────────────────────────┐
│  CLAUDE CODE  — Execution Layer            │
│  spawns agents, runs code, streams output  │
├────────────────────────────────────────────┤
│  MOFLO  — Knowledge Layer                  │
│  routes tasks · gates spawns · stores      │
│  patterns · learns from outcomes           │
└────────────────────────────────────────────┘
```
Flow: **Route → Gate → Execute (Claude Code) → Learn (MoFlo).**

---

## Suggested visual groupings for the infographic

1. **Hero band** — headline one-liner + the 6 core value-prop icons (Remembers / Knows / Stops waste / Gets smarter / Local / Cross-platform).
2. **"How it works" strip** — the 4-step loop: Route → Gate → Execute → Learn, over the two-layer diagram.
3. **Feature grid** — cards for the big four: Semantic Memory, Auto-Indexing, Gates, Learned Routing (with their key numbers).
4. **"Gets smarter" panel** — the learning stack (SONA, MicroLoRA, EWC++, ReasoningBank) + `/meditate` / auto-meditate.
5. **Power-user band** — Spells, Swarm/Hive-Mind, `/flo` pipeline, Luminarium dashboard.
6. **Stat ribbon** — the "Numbers worth featuring" as a row of big-number call-outs.
7. **Footer** — "100% local · no API keys · no cloud · macOS / Linux / Windows · `npm i moflo && flo init`".

## Accuracy notes (provenance — read before adding any number to the graphic)

Accuracy was prioritized over marketing. Every claim here is grounded as follows:

**Code-verified — safe to state as fact:**
- **384-dim embeddings** (`all-MiniLM-L6-v2`) — used throughout `src/cli/memory` and `embeddings`.
- **9 CLI bin entries** — counted directly from `package.json`.
- **26 hook bindings / 8 lifecycle events** — asserted by `verify-exports.test.ts`.
- **~340 MB (Linux) / ~150 MB (Windows) prune** — the postinstall script (`scripts/prune-native-binaries.mjs`) actually walks the tree and logs bytes reclaimed; the MB figures are its design estimate, and the *mechanism* is real.
- **4 context brackets, 3 sandbox tiers, 3 indexed content types** — enumerable in code/docs.

**Documentation claims — plausible but not independently benchmarked; state as "documented" not "measured":**
- **38 health checks**, **12 routing patterns** — from the README; countable in principle, not re-counted here.
- **MCP tool count** — the README says "80+", an internal guidance doc says "~125". They disagree, so the graphic uses the conservative "100+". Don't cite a precise number.

**DELIBERATELY OMITTED — unverified inherited vendor claims (do NOT add these to the graphic):**
- **"150×–12,500× faster search"** — a hardcoded constant repeated across the codebase, inherited from the upstream AgentDB/RuVector (Ruflo/Claude Flow) lineage. **No benchmark in the repo produces or verifies it**, and one code path literally flags it `verified: false, evidence: null`. Removed.
- **MicroLoRA "~1µs per adapt"** — the README says ~1µs; an internal doc says "<100µs / 508k ops/sec". Contradictory, no backing benchmark. The specific figure was stripped; only the qualitative behavior is described.
- **FlashAttention "2.49×–7.47×" and Int8 "3.92× memory reduction"** — same unverified upstream table. Not included.

The honest, defensible framing for performance is *qualitative and algorithmic*: HNSW is approximate-nearest-neighbor search (the same class production vector DBs use) that stays fast as the index grows, versus a linear keyword scan that slows with every entry. That claim is true by construction and needs no benchmark.

## Tone & brand notes
- Confident, developer-facing, no hype-for-hype's-sake. The differentiator is **local + automatic + enforced**, not "AI magic".
- Recurring motifs: memory/brain 🧠, gates/traffic 🚦, upward learning curve 📈, local/shield 🔒.
- MoFlo is *for Claude Code specifically* — it enhances it, it is not a standalone chatbot. Worth stating so the graphic isn't mistaken for a general LLM tool.
