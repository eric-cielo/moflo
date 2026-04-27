# Spell Engine & Messaging Architecture

**Purpose:** Architectural decisions and analysis findings for Epic #100 (Generalized Spell Engine) and Epic #110 (Messaging Migration). Reference when working on stories #100-#117.

---

## Epic #100: Generalized Spell Engine

**Ships as part of moflo** — not a separate project. Heavy deps (Playwright, isolated-vm) are optional peer dependencies, same pattern as cli's embeddings module requiring `sql.js`.

### Command Pattern for Steps

Every spell step type implements a `StepCommand` interface with `execute()`, `validate()`, `describeOutputs()`, and optional `rollback()`. Register step commands via a plugin-style `StepCommandRegistry` — follow the existing `PluginRegistry` pattern in `src/cli/plugins/`.

### Spell Definitions

Spells are YAML/JSON files in `workflows/` or `.claude/workflows/`. Each declares:
- `name` and `abbreviation` (short name for `/flo -wf {abbrev}`)
- Typed `arguments` with `required`, `default`, `enum`, `description`
- Ordered `steps` with `{stepId.outputKey}` variable interpolation

### MoFlo Integration Levels Per Step

| Level | Capabilities | Default For |
|-------|-------------|-------------|
| `none` | No MoFlo access | `bash`, `condition`, `wait` |
| `memory` | search/store/list | `agent` steps |
| `hooks` | Above + pre/post task hooks | — |
| `full` | Above + swarm/hive-mind spawning | — |
| `recursive` | Above + nested `/flo -wf` invocation | — |

Capabilities only narrow going deeper — a nested spell cannot escalate beyond its parent.

### Sandboxing Tiers

| Tier | Mechanism | Status |
|------|-----------|--------|
| 1 | Capability declarations + enforcement | Build first |
| 2 | Node `--experimental-permission` for bash steps | Build second |
| 3 | `isolated-vm` for expression evaluation | Build third |
| 4 | Linux namespaces (optional) | Defer |
| 5 | WASM sandbox for community commands | Defer |

### Build Order (no circular dependencies)

| Phase | Stories | Can Start |
|-------|---------|-----------|
| 1 | #101 (Interface), #103 (Schema) | Immediately |
| 2 | #102 (Commands), #106 (Credentials) | After Phase 1 |
| 3 | #104 (Runner) | After Phase 2 |
| 4 | #105 (Registry), #108 (Sandboxing T1-2), #107 (Playwright) | After Phase 3 |
| 5 | #109 (Integration Levels), #117 (Scheduling) | After Phase 4 + Epic #110 |

### Critical Findings

- **Existing `spell_execute` is a no-op placeholder.** The engine is greenfield.
- **`js-yaml` already a dependency** — used in `moflo-config.ts` and `epic.ts`.
- **Plugin registry pattern is directly reusable** for `StepCommandRegistry`.
- **No cron support exists** — needs `node-cron` dependency for #117.
- **Retry logic is consumer-side**, not bus-side. Steps implement their own retry.

---

## Epic #110: Messaging Migration to Memory DB

**Migrate inter-agent messaging** from in-memory EventEmitter bus to memory DB namespace. The current bus only works within a single process — spawned subagents cannot participate.

### Session Isolation

All messages scoped by `sessionId`. Queries implicitly filter by current session. `endSession()` expires unhandled messages. `gc()` cleans up abandoned sessions after configurable TTL.

### Build Order

| Phase | Stories |
|-------|---------|
| 1 | #111 (Schema + CRUD) |
| 2 | #112 (Notification/Pub-Sub) |
| 3 | #113, #114, #115 (parallel) |
| 4 | #116 (Deprecate old bus — last) |

**Minimum viable to unblock Epic #100:** #111 + #112 only.

### Critical Findings

- **`queen-coordinator.ts` does NOT use MessageBus.** Hive-mind operates via MCP tools. Story #114 is greenfield, not migration.
- **`unified-coordinator.ts` is coupled to concrete `MessageBus` class**, not `IMessageBus` interface. Must refactor.
- **Zero existing message bus tests.** Write baseline suite first, then verify both backends pass.
- **Two competing Message types:** `SwarmMessage` (shared/types.ts) vs `Message` (swarm/types.ts). Story #111 must reconcile.
- **Memory DB supports namespaces and TTL** but needs queue semantics and metadata indexing added.
- **`enablePersistence` config flag exists but was never implemented** — now being properly built.

### Interface Incompatibility: Not a Clean Swap

The `MemoryDbMessageBus` adapter (~300 lines) must handle:

| Aspect | Current `IMessageBus` | New `MessageStore` |
|--------|----------------------|-------------------|
| Subscribe | Push-based callback | Pull-based `receive()` |
| Acknowledge | `acknowledge(ack)` | `markRead()` |
| Timestamps | `Date` objects | `number` (epoch ms) |
| Sessions | None | `sessionId` required |
| Channels | None (per-agent queues) | Channel-based routing |

---

## Epic #118: Consolidate Messaging Systems (Pre-req for #110)

**Three messaging systems → one layered broker.** Must complete before Epic #110 migration.

| Story | What | Depends On |
|-------|------|------------|
| #119 | Unified Message Type & Extended IMessageBus | — |
| #120 | SwarmCommunication → MessageBus consumer | #119 |
| #121 | Hive-Mind → MessageBus + Memory DB write-through | #119, #120 |

**Key decisions:**
- MessageBus keeps its Deque hot path for delivery (~1000+ msg/sec)
- Memory DB write-through is fire-and-forget, initially only for hive-mind namespace
- TTL reaper lives in the broker (60s sweep), not the daemon
- Daemon can do deeper GC pass but system must not depend on it

**Build order:** Epic #118 → remaining #110 stories (#111, #115, #116) → Epic #100 Phase 5.

---

## Cross-Epic Dependencies

**Most of Epic #100 can proceed without Epic #110.** Only two things are hard-blocked:

| Blocked Story | Needs from #110 | Why |
|--------------|-----------------|-----|
| #109 `full` tier | #113 (Swarm Migration) | Swarm spawning needs DB-backed messaging |
| #109 `recursive` tier | #113 + #114 | Nested spells with hive-mind need consensus messaging |

Stories #101-#108, #105, #117 have no dependency on Epic #110.

**Epic #118 simplifies #110:** #112 (pub/sub) largely solved, #113 (swarm) done via #120, #114 (hive-mind) done via #121.

---

## See Also

- `.claude/guidance/shipped/moflo-core-guidance.md` — CLI, hooks, swarm, memory reference
- `.claude/guidance/shipped/moflo-claude-swarm-cohesion.md` — Task & swarm coordination
- `.claude/guidance/shipped/moflo-subagents.md` — Subagents protocol
