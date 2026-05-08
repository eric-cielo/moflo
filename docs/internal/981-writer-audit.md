# #981 Writer Chokepoint Audit

**Story:** #984 (Bridge daemon-write client + writer chokepoint audit)
**Epic:** #981 (sql.js multi-process clobber)

## Goal

Identify every code path that writes to `.moflo/moflo.db` from `src/cli/`, then determine whether a single chokepoint covers all writes (so Story #985 / #986 can wire daemon-routing in one place) or whether per-site wiring is required.

## Conclusion

**A single chokepoint exists: `storeEntry` / `deleteEntry` / `storeEntries` in `src/cli/memory/memory-initializer.ts`.** Every spell-engine, MCP-server, CLI, and swarm/hive-mind writer calls into this trio either directly or through one indirection. Story #985 / #986 can wire daemon-routing by adding a small preamble inside these three functions.

**Two specific writers bypass the chokepoint and need explicit per-site wiring in Story #986:**

1. `src/cli/mcp-tools/aidefence-moflodb-store.ts` calls `bridgeStoreEntry` / `bridgeDeleteEntry` directly. These are MCP-server-process writers (the aidefence_* tools). **Action:** swap to `storeEntry` / `deleteEntry`.
2. Direct `bridgeStoreEntry` callers inside `src/cli/memory/memory-bridge.ts` are bridge-internal — they only run inside whichever process loaded the bridge. They are NOT cross-process writers. **No action.**

## Inventory

### Layer 1 — Chokepoint functions (target for Story #985 wrapping)

| File:Line | Function | Notes |
|-----------|----------|-------|
| `src/cli/memory/memory-initializer.ts:1890` | `storeEntry()` | Top-level writer. Already routes through `bridgeStoreEntry` (preferred) or raw sql.js (fallback). |
| `src/cli/memory/memory-initializer.ts:2066` | `storeEntries()` | Bulk variant. Routes through `bridgeStoreEntries` or sequential `storeEntry()` fallback. |
| `src/cli/memory/memory-initializer.ts:2491` | `deleteEntry()` | Top-level deleter. Routes through `bridgeDeleteEntry` or raw sql.js fallback. |

### Layer 2 — Callers that funnel through Layer 1 (covered automatically once Layer 1 routes)

#### Spell engine writers (Story #985 verification target)

| File:Line | Caller | Namespace |
|-----------|--------|-----------|
| `src/cli/spells/core/runner.ts:564` | `SpellCaster.storeProgress` → `memory.write('tasklist', …)` | `tasklist` |
| `src/cli/services/daemon-dashboard.ts:343` | `storeFloRunRecord` → `memory.write('tasklist', …)` | `tasklist` |
| `src/cli/spells/scheduler/scheduler.ts:192–583` | `SpellScheduler.{create,cancel,enable,run}Schedule` → `memory.write('scheduled-spells'/'schedule-executions', …)` | `scheduled-spells`, `schedule-executions` |
| `src/cli/spells/factory/pause-resume.ts:61–221` | `pauseSpell/resumeSpell/clearPaused` → `memory.write(PAUSE_NAMESPACE, …)` | `spell-paused`, legacy `paused` |
| `src/cli/spells/commands/memory-command.ts:102` | `memory_store` step command → `context.memory.write(...)` | user-supplied |

All of these go through `MemoryAccessor.write` → `createDashboardMemoryAccessor` → `storeEntry`. Wrapping `storeEntry` covers all of them.

#### MCP server writers (Story #986 wiring target — funnel-routed)

| File:Line | Caller | Namespace |
|-----------|--------|-----------|
| `src/cli/mcp-tools/memory-tools.ts:175` | `memory_store` MCP handler | user-supplied |
| `src/cli/mcp-tools/memory-tools.ts:232` | `moflodb_pattern-store` / hierarchical-store | user-supplied |
| `src/cli/mcp-tools/memory-tools.ts:425` | `memory_delete` MCP handler | user-supplied |
| `src/cli/mcp-tools/hive-mind-tools.ts:196,212` | hive-mind `store` / `delete` (DI'd `memFns.storeEntry/deleteEntry`) | `hive-mind:*` |
| `src/cli/swarm/swarm-persistence.ts:116,189` | swarm coordinator persistence (DI'd `this.fns.{storeEntry,deleteEntry}`) | `swarm:*` |
| `src/cli/swarm/message-bus/write-through-adapter.ts:147,162,209` | `WriteThroughAdapter` (DI'd `this.{storeEntry,deleteEntry}`) | `unified:*` |

All of these route through `storeEntry` / `deleteEntry`. Wrapping the chokepoint covers them automatically — **but the protected swarm/hive-mind handlers must continue to coordinate through `UnifiedSwarmCoordinator` / `MessageBus` exactly as today**. Per `feedback_swarm_hive_never_regress.md`, no behavior change here beyond the routed-write addition.

#### CLI commands (Story #986 — also funnel-routed)

| File:Line | Caller |
|-----------|--------|
| `src/cli/commands/memory.ts:127, 560` | `flo memory store/delete` |
| `src/cli/commands/diagnose.ts:85, 86, 137` | `flo doctor diagnose` self-test (writes + deletes a probe entry) |
| `src/cli/commands/benchmark.ts:315` | `flo benchmark` |
| `src/cli/commands/performance.ts:196` | `flo performance` |

All funnel through `storeEntry` / `deleteEntry`.

### Layer 3 — Bypass writers (Story #986 explicit wiring target)

| File:Line | Caller | Why it bypasses | Action |
|-----------|--------|-----------------|--------|
| `src/cli/mcp-tools/aidefence-moflodb-store.ts:48, 92` | `MofloDbAIDefenceStore.{store,delete}` | Calls `bridgeStoreEntry` / `bridgeDeleteEntry` directly | **Swap to `storeEntry` / `deleteEntry` (Story #986).** |
| `src/cli/memory/memory-bridge.ts:242, 328, 429` | Bridge-internal writers | Only invoked from inside the bridge's host process | **No action — bridge-internal, not a cross-process writer.** |

### Layer 4 — Launcher-only / migration-only writers (already safe)

These run BEFORE long-lived sql.js consumers spawn (per `bin/session-start-launcher.mjs`) and are not subject to the multi-process clobber. **No action needed.**

| File | Purpose |
|------|---------|
| `src/cli/services/ephemeral-namespace-purge.ts` | Session-start tasklist trim + ephemeral purge (#727, #968) |
| `src/cli/services/soft-delete-purge.ts` | Periodic soft-delete cleanup |
| `src/cli/services/sqljs-migration-store.ts` | One-time DB schema migration |
| `src/cli/embeddings/migration/sqljs-helpers.ts` | One-time embedding migration |
| `src/cli/services/cherry-pick-learnings.ts` | One-time cherry-pick of learnings |

### Layer 5 — Separate DB (not `.moflo/moflo.db`)

`src/cli/embeddings/persistent-cache.ts` writes to `.cache/embeddings.db` (per `embedding-service.ts:121`). **Not affected by #981.**

## Wiring strategy for Story #985 / #986

**One small preamble inside `storeEntry`, `deleteEntry`, `storeEntries`** (in that order of priority):

```ts
// At the top of storeEntry, before any other work:
if (process.env.MOFLO_IS_DAEMON !== '1') {
  const routed = await tryDaemonStore({
    namespace: options.namespace ?? 'default',
    key: options.key,
    value: options.value,
    tags: options.tags,
    ttl: options.ttl,
  });
  if (routed.routed && routed.ok) {
    return { success: true, id: routed.id ?? '' };
  }
  // Otherwise fall through to existing logic — daemon unavailable, or
  // we explicitly want the local-write fallback.
}
```

The `MOFLO_IS_DAEMON=1` env var prevents the daemon from routing its own writes back through HTTP to itself (infinite loop). The launcher / `bin/cli.js daemon start` sets this before importing memory-initializer.

**Story #986 also touches:**
- `src/cli/mcp-tools/aidefence-moflodb-store.ts` — swap `bridgeStoreEntry` → `storeEntry`, `bridgeDeleteEntry` → `deleteEntry`. After the swap, aidefence writes funnel through the chokepoint.

## What this means for Stories #985 / #986

- **Story #985 (spell engine)** — wraps the chokepoint. Wiring is one preamble in three functions. Spell engine writers are covered automatically. Verification target: the #981 reproduction (`flo cast` → `/api/spells`).
- **Story #986 (MCP server)** — same chokepoint wrap covers `memory_store`, `memory_delete`, hive-mind, swarm, write-through-adapter. Plus one explicit edit to `aidefence-moflodb-store.ts` for the bypass writer. Verification target: cross-process write/read smoke + protected-surface tests.

## Risk & verification

- Wrapping at this depth means every test that exercises `storeEntry` / `deleteEntry` now has a routing preamble. The preamble must be a no-op when:
  1. `MOFLO_IS_DAEMON=1` (daemon's own process)
  2. Daemon is unreachable / disabled
  3. `daemon-write-client` itself errors
- All three short-circuit paths return `{ routed: false }` → falls through to existing logic. **No behavior change for existing test fixtures**, which run without a daemon and without the env var.
- **Verification:** the full test suite (8179 tests on commit `b18390445`) must stay green after Story #985 wiring lands. Any test that fails is a routing-preamble bug, not a downstream regression.

## Open questions for the user (none blocking)

None. The chokepoint is clean, the bypass set is small (1 file), and the wiring strategy is incremental. Proceeding with `daemon-write-client.ts` implementation in Story #984; the wiring lands in #985 / #986.
