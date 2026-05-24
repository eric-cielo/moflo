# Moflo Skills & Automatic Features

**Purpose:** Router for moflo's user-facing surface — which slash-command skill to reach for, and which features run automatically with no command. Each skill's full instructions live in its own `SKILL.md` (indexed in the `guidance` namespace, so memory search surfaces it); this doc maps intent → the right skill or feature so Claude suggests or invokes the correct one instead of reimplementing it by hand.

---

## Invoking skills

Skills are slash commands the user types (`/meditate`, `/commune`, …) and that Claude can run via the `Skill` tool when a request matches one. When a user's request matches a skill below, **prefer invoking the skill over hand-rolling its behavior** — the skill encodes moflo's correct protocol (memory-first, dedup, gates).

`flo init` installs each skill into `.claude/skills/<name>/SKILL.md` and the session-start indexer re-indexes them, so a memory search in the `guidance` namespace returns the matching skill for an intent query. Run any skill with no arguments to print its full usage.

---

## Planning, research, and learning skills

These bookend execution — open a unit of work, inform it, or close it.

| Skill | Use it when |
|-------|-------------|
| `/commune` | The goal is still fuzzy — turn a rough idea into a concrete spec through a short Socratic Q&A, then hand off to a ticket, spell, or memory. Use it to *open* work. |
| `/divine` | One web search won't settle a question — multi-hop web research with confidence gating and a cited synthesis, remembered for next time. |
| `/meditate` | A meaningful chunk of work just finished — distill durable lessons into the `learnings` memory namespace, deduped. Use it to *close* work. |

## Project execution skills

These drive code changes against GitHub issues and the working tree.

| Skill | Use it when |
|-------|-------------|
| `/flo` (alias `/fl`) | Execute a GitHub issue end to end: research → ticket → implement → test → simplify → PR. Detects and processes epics automatically. |
| `/flo-simplify` | Review the current diff for reuse, quality, and efficiency, then fix what it finds. Effort scales to the diff size. |

## Setup, health, and audit skills

These verify and tune how moflo and Claude are wired into the project.

| Skill | Use it when |
|-------|-------------|
| `/eldar` | Audit how Claude is set up to *use* the project — guidance, CLAUDE.md, memory, stack→guidance gaps. Best first move in a new project; `--fix` walks through repairs. |
| `/healer` | Verify moflo *itself* is wired correctly — config, daemon, hooks, MCP, embeddings. `--fix` auto-repairs. |
| `/luminarium` | Print the localhost URL for moflo's daemon dashboard (schedules, executions, memory, worker health). |
| `/guidance` | Author or audit guidance docs against moflo's universal rules. `-h` targets a human audience, `--html` emits HTML, `-a` audits the guidance directory. |

## Spell-authoring skills

These build and schedule moflo spells (declarative YAML automations).

| Skill | Use it when |
|-------|-------------|
| `/spell-builder` | Create, edit, or validate a spell definition — composes connectors and step commands into an end-to-end automation. |
| `/connector-builder` | Scaffold a new spell step command or connector (a new I/O transport, or a platform needing complex multi-step interaction). |
| `/spell-schedule` | Schedule one of your spells on the local moflo daemon (cron, interval, or one-time). |

## Memory and intelligence skills

These help build retrieval and stateful-agent layers on moflo's memory stack.

| Skill | Use it when |
|-------|-------------|
| `/memory-patterns` | Build stateful agents that remember across runs — session memory, long-term knowledge, pattern learning. |
| `/memory-optimization` | Tune the memory stack for speed/RAM/index quality (HNSW params, quantization) at scale (100k+ entries). |
| `/vector-search` | Build a retrieval layer — RAG over your own docs, similarity matching, context assembly. |
| `/reasoningbank-intelligence` | Add adaptive cross-run learning to agents — trajectory storage, verdict judgment, memory distillation, MMR retrieval. |

---

## Auto-meditate — automatic lesson capture

**Auto-meditate distills durable lessons from each session into the `learnings` namespace with no slash command and no prompting.** A `UserPromptSubmit` hook recognizes when a durable lesson emerges in the live session (a correction, an error→fix, a decision); at the next session start a brief background pass distills the queued lessons into `learnings`, applying the same durability bar and dedup-then-store protocol as `/meditate`.

- **Ships on by default.** Opt out with `auto_meditate.enabled: false` in `moflo.yaml`.
- **Complementary to `/meditate`.** Auto-meditate is the always-on safety net; `/meditate` is the deliberate, curated pass. Both dedup against existing `learnings`, so neither pollutes the other.
- Stored lessons are embedded and surface in every future `memory_search` over `learnings`.

## Session-continuity — pick up where you left off

**Session-continuity captures a compact "where you left off" digest at the end of each session and re-injects the most relevant one at the next session start.** Capture runs on the `Stop` hook (git state, recent learnings, the session goal — secrets scrubbed) into a `.moflo/continuity/` JSON store; injection is relevance-gated, so an unrelated fresh session injects nothing.

- **Ships on by default.** Toggle `session_continuity.capture` / `session_continuity.inject` in `moflo.yaml`; `max_age_hours` bounds how old a digest can be and still inject.
- The injected block is a **verifiable lead, not ground truth** — confirm current git/test state before acting on it.
- Add `<private>` anywhere in a session to opt that session out of capture.

---

## When to use which

| Situation | Reach for |
|-----------|-----------|
| "I have a vague idea, not a spec yet" | `/commune` |
| "I need to settle a question the web can answer" | `/divine` |
| "Implement this GitHub issue" | `/flo` |
| "Tidy up the diff before I push" | `/flo-simplify` |
| "I just finished something worth remembering" | `/meditate` (or let auto-meditate catch it) |
| "Claude feels lost in this project" | `/eldar` |
| "Is moflo itself healthy?" | `/healer` |
| "Why does Claude already know where I left off?" | session-continuity (automatic) |

---

## See Also

- `.claude/guidance/moflo-core-guidance.md` — Hub: getting started, MCP setup, session-start automation, the auto-learning protocol
- `.claude/guidance/moflo-cli-reference.md` — The non-skill surface: CLI commands, agents, hooks, and workers
- `.claude/guidance/moflo-memory-strategy.md` — Namespaces (including `learnings`) and how memory search / RAG retrieval works
- `.claude/guidance/moflo-yaml-reference.md` — `moflo.yaml` schema, including the `auto_meditate` and `session_continuity` blocks
- `.claude/skills/meditate/SKILL.md` — Full `/meditate` protocol (the manual counterpart to auto-meditate)
- `.claude/skills/commune/SKILL.md` — Full `/commune` Socratic protocol
