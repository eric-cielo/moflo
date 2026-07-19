# Native Checkpoints vs. MoFlo Continuity — Who Owns Undo and Resume

**Purpose:** Decide which layer owns a given "undo" or "resume" — Claude Code's native checkpoints (`/rewind`, agent-tree checkpointing) or moflo's session-continuity + epic-state — so the two coexist by layering, never by competing. Read this before wiring any resume/rollback behavior into a moflo workflow.

---

## Ownership Decision Table

The two systems solve different problems. Never route a job to the wrong layer or build a moflo mechanism that duplicates a native one.

| You want to… | Owner | Mechanism |
|--------------|-------|-----------|
| Undo code edits from earlier THIS session | Native | `/rewind` code checkpoints |
| Pause/resume a multi-hour agent tree WITHIN a session | Native | Agent-tree checkpointing (beta) |
| Pick up context ACROSS sessions ("where you left off") | MoFlo | Session-continuity digest |
| Resume an interrupted `flo epic` from real progress | MoFlo | `epic-state` reconciled against git + the GitHub checklist |
| Fail over to another model when a tier is unavailable | Native | `fallbackModel` — moflo's router emits the chain |

**Rule:** native checkpoints govern *in-session* rollback of code and agent trees; moflo governs *cross-session* coordination and the durable learning record. They layer; they do not overlap.

---

## Native Checkpoints Are Runtime-Only — Never Couple MoFlo to Them

Native `/rewind`, code checkpoints, and agent-tree checkpoint state live entirely inside the Claude Code runtime. There is **no stable public file or API** for them, and moflo library code (the `flo` CLI, MCP server, hooks, launcher, daemon) is never handed a reference to that state.

**Never read or write native checkpoint state from moflo code.** Coupling to an undocumented runtime format violates the cross-platform rule and the consumer-blast-radius rule — it would break silently on any Claude Code update, in every consumer install. Treat native checkpoints as a black box the human drives; moflo reacts to committed results (git, GitHub), not to session snapshots.

---

## MoFlo Session-Continuity — The Cross-Session Digest

Session-continuity is moflo's narrative bridge between sessions, distinct from native checkpoints. At session end it captures a scrubbed digest — `{goal, decisions, gitState}` — to a rotated JSON store under `.moflo/`. At session start it scores digests by branch match, changed-file overlap, and recency, then injects the best one as a **"Where you left off"** lead.

**Treat the injected digest as a verifiable lead, not ground truth.** It reflects what was true when it was written — re-check the current branch, working tree, and files before acting on it. Configure via `session_continuity: {capture, inject, max_age_hours}` in `moflo.yaml`; both flags default on.

---

## Epic Resume Is Checkpoint-Agnostic — Git Is the Source of Truth

`flo epic` records progress in the `epic-state` memory namespace, but that namespace is an **in-session cache, hard-deleted on every session start** — never rely on it as the durable resume store. The durable sources of truth are the **git epic branch + commits** and the **GitHub issue checklist** (`[ ]` vs `[x]`).

On resume, `epic.ts` reconciles memory against git: it recomputes the `epic/{n}-{slug}` branch and, if the branch is missing or has no commits ahead of the base, discards the memory record and starts fresh. This makes epic resume **independent of native checkpoints** — it works identically whether or not the user used `/rewind`, because truth is re-derived from committed state, not a session snapshot. Do not add native-checkpoint detection to epic resume; it would be unverifiable noise.

---

## Swarm and Hive-Mind Are a Logical Layer Native Nesting Does Not Replace

MoFlo's `UnifiedSwarmCoordinator` is a **logical coordination layer** — an agent registry plus MessageBus routing, consensus voting, and workload-balanced task distribution. "Spawn" registers a tracked record; it never launches a process. Hive-mind is one level deep (queen → flat worker list; workers never spawn sub-workers).

Native 3-level nested subagents solve **process and context isolation for real, executing agents** — an orthogonal concern. Native nesting does not replace the registry, MessageBus, consensus, or task distribution.

**Never rewire swarm/hive-mind onto native nesting.** Reducing coordinator handlers to stubs to "map onto native primitives" is exactly the disconnection the protected-functionality rule forbids, for zero functional gain. The only seam between the two — the subagent bootstrap directive — is already carried in every spawn's metadata and response. Keep every handler wired to the coordinator.

---

## Model Routing Emits Native `fallbackModel` Chains

MoFlo's model router already tracks per-tier circuit-breaker state. Its routing result carries a `fallbackModel` chain: an ordered, circuit-breaker-aware failover list that excludes the primary, drops `inherit` and zero-score tiers, and demotes any open-circuit tier to the tail.

The chain is **advisory** — surfaced to the orchestrator via `hooks_model-route` and `agent_spawn`, then applied when spawning a real subagent. MoFlo never auto-launches a model itself; the orchestrator (or the native `Task` spawn) consumes the chain and maps it onto Claude Code's native `fallbackModel`. A healthy lower tier is always tried before a failing one.

---

## See Also

- `.claude/guidance/moflo-epic-processing.md` — Epic orchestration whose `epic-state` + git reconciliation this doc frames against native checkpoints
- `.claude/guidance/moflo-claude-swarm-cohesion.md` — Swarm/hive coordination model the "logical layer" note protects
- `.claude/guidance/moflo-core-guidance.md` — CLI, hooks, swarm, memory, and config hub
- `src/cli/movector/model-router.ts` — Router that emits the `fallbackModel` chain
- `src/cli/commands/epic.ts` — Epic resume + git-branch reconciliation
