# Neural + hooks audit — agentdb removal impact

> **Historical — pre-epic #527 (2026-04-22).** This audit describes the 3-tier embedding fallback (`agentic-flow → transformers → mock`) that existed before epic #527 removed every hash-fallback path and swapped `@xenova/transformers` for `fastembed`. The "embeddings" section below no longer reflects the live system. Kept as a point-in-time snapshot of the agentdb removal decision; see [ADR-EMB-001](../src/modules/embeddings/docs/adrs/ADR-EMB-001-neural-embeddings-mandatory.md) for the current embedding architecture.

Date: 2026-04-20
Epic: #464 Gate 2

## Executive summary

Verdict: **Green for Option B** (remove + rely on fallbacks), with two caveats noted below.

| Feature | On removal | Risk | Notes |
|---|---|---|---|
| Embeddings | Works | L | 3-tier auto fallback (`agentic-flow → transformers → mock`) is wired end-to-end in `embedding-service.ts` |
| Pattern-learning hooks | Degrades silently | M | In-memory fallback works; persistence + HNSW lost |
| Trajectory recording | Degrades silently | M | In-memory fallback; trajectories lost across process restart |
| SONA | Unaffected | — | Persists to `.swarm/sona-patterns.json`; never touched agentdb |
| ReasoningBank (neural/) | Unified on @moflo/memory | L | Consolidated on the bridge-backed AgentDBAdapter in C4 (issue #468); brute-force fallback retained for `enableAgentDB: false` |
| agentic-flow subprocess | Unaffected | — | Zero static imports; only 6 lazy `import('agentic-flow/…').catch(() => null)` sites |

Two caveats for the decision memo:
1. **Silent degradation, not visible errors.** Every fallback returns `null` / empty array / no-op rather than throwing. Users on Option B won't see a warning unless we add one.
2. **No tests exercise the "agentdb completely absent" path.** Unit tests either mock embeddings or initialize agentdb in-memory. A Gate 3 smoke test is how we actually prove these fallbacks.

---

## Per-feature deep dive

### 1. Embeddings

**Entry points**
- MCP tools: `embeddings_generate`, `embeddings_search`, `embeddings_hyperbolic`, `embeddings_init`, `embeddings_compare`, `embeddings_status`, `embeddings_neural` (`src/modules/cli/src/mcp-tools/embeddings-tools.ts`, 869 LOC)
- CLI: `flo embeddings …` (`src/modules/cli/src/commands/embeddings.ts`)

**Code path**
Call → `@moflo/embeddings` `EmbeddingService` → provider selection. Providers declared in `embedding-service.ts:22` as: `'openai' | 'transformers' | 'mock' | 'agentic-flow' | 'rvf'`.

**Fallback path** (`embedding-service.ts:893-1006`)
- `provider: 'auto'` ranks: agentic-flow > transformers > mock.
- If agentic-flow load fails (bridge returns null at `agentic-flow-bridge.ts:39`), falls through to `@xenova/transformers` with `Xenova/all-MiniLM-L6-v2`.
- If transformers also unavailable, falls to mock with a visible console warning: `"[embeddings] Using mock provider - install agentic-flow or @xenova/transformers for real embeddings"` (line 986).
- Transformers is a direct `dependencies` entry (`embeddings/package.json:20`: `@xenova/transformers: ^2.17.0`), so it is always present on fresh installs.

**Tested?**
`src/modules/embeddings/src/embedding-service.test.ts` exists; it exercises the transformers path with mocked imports. No explicit test for "agentdb absent" because the embeddings module never talks to agentdb — the dependency is on agentic-flow/embeddings, not agentdb.

**Consumer-visible on removal**
- If `@xenova/transformers` is present (it always is): works identically.
- If users force-disable transformers: they get a clearly-worded mock-provider warning at init.

**Risk: LOW.** Embeddings do not require agentdb removal to be gated. The only observable change would be that `embeddings_status` stops showing agentic-flow as the top-ranked provider.

---

### 2. Pattern-learning hooks

**Entry points**
- MCP tools: `hooks_intelligence`, `hooks_intelligence_learn`, `hooks_intelligence_pattern-search`, `hooks_intelligence_pattern-store`, `hooks_intelligence_stats`, `hooks_intelligence_attention`, `hooks_intelligence_trajectory-start/step/end`, `hooks_intelligence-reset` (`src/modules/cli/src/mcp-tools/hooks-tools.ts`)
- CLI: `flo hooks intelligence …` (`src/modules/cli/src/commands/hooks.ts`)
- Auto-invoked by: `hooks_post-task`, `hooks_post-edit` from `.claude/settings.json` hooks configuration

**Code path**
`mcp-tools/hooks-tools.ts` → `@moflo/hooks` `reasoningbank/index.ts` (1164 LOC) → optional `agentdb` backend via `memoryBridge.bridgeStorePattern()` / `bridgeSearchPatterns()` / `bridgeRecordFeedback()` (memory-bridge.ts:1189, 1234, 1302).

**Fallback path**
`memory-bridge.ts` wraps every `reasoningBank.*` call in `if (controller) { try … } else { fallback }`. Fallback for pattern-store/search is `bridgeStoreEntry()` / `bridgeSearchEntries()`, which writes to `memory_entries` via sql.js directly (audit Gate 1 confirmed).

**Tested?**
- `src/modules/memory/src/learning-bridge.test.ts` — exercises with agentdb in-memory, not with agentdb absent
- `src/modules/memory/src/controller-registry.test.ts` — similar
- No test explicitly sets `agentdb = undefined` or stubs the module to missing

**Consumer-visible on removal**
- `hooks_intelligence_pattern-store`: works; writes go to `memory_entries` sql.js table. Vector search becomes a substring/keyword match instead of HNSW.
- `hooks_intelligence_pattern-search`: returns keyword matches, not semantic matches. Expect recall to drop on semantically-similar-but-lexically-different queries.
- `hooks_intelligence_stats`: reports lower counts (no pattern-distillation happening).
- `hooks_intelligence_learn` / `attention`: no-ops when learningSystem absent.

**Risk: MEDIUM.** The degradation is silent and gradual — users with meaningful pattern volume will notice recall quality drop, but the tool calls don't error. A deprecation notice on removal would help.

---

### 3. Trajectory recording

**Entry points**
- MCP tools: `hooks_intelligence_trajectory-start`, `hooks_intelligence_trajectory-step`, `hooks_intelligence_trajectory-end`
- Indirectly via: `agentdb_session-start` / `agentdb_session-end`, which Gate 1 found route through `bridgeSessionStart/End` (memory-bridge.ts:1424, 1475)

**Code path**
Trajectory-start call → `memoryBridge.bridgeSessionStart` → `reflexion.recordSession()` or fallback.

**Fallback path**
`memory-bridge.ts:1424-1470` wraps `reflexion.recordSession` with `if (reflexion)`; on miss, routes to `bridgeStoreEntry` (Gate 1 confirmed). Session metadata survives; episodic replay features (retrieval by similarity to current trajectory) downgrade to keyword search.

**Tested?**
No standalone "trajectory-without-agentdb" test. Hooks tests use the registry in its real mode.

**Consumer-visible on removal**
- Trajectories persist (sql.js table).
- Replay/retrieval of prior trajectories by semantic similarity is degraded.
- `trajectory-end` still fires.

**Risk: MEDIUM.** Identical shape to pattern-learning: silent degradation, no crash.

---

### 4. SONA

**Entry points**
- MCP tools: `hooks_pretrain`, neural training paths
- CLI: `flo neural …` (`src/modules/cli/src/commands/neural.ts`)
- Exposed via `@moflo/neural` `createSONAManager` (`src/modules/neural/src/index.ts:201`)

**Code path**
`createSONAManager(mode)` returns a SONAManager instance. Actual implementation in `src/modules/cli/src/memory/sona-optimizer.ts:122`:

```ts
const DEFAULT_PERSISTENCE_PATH = '.swarm/sona-patterns.json';
```

SONA reads/writes a JSON file, not a SQLite/vector database. The `sonaMode` config setting is threaded through `learning-bridge.ts:404` and `reasoningbank-adapter.ts:145`, but only as a mode flag — storage is filesystem-local.

**Fallback path**
No fallback needed. Agentdb removal has zero impact on SONA.

**Tested?**
`src/modules/cli/__tests__/memory-movector-deep.test.ts:277, 305, 315, 325` assert `sonaEnabled` toggling works. No agentdb-absence variant needed.

**Consumer-visible on removal**
None.

**Risk: ZERO.** This is the surprise: the feature that *sounds* most agentdb-coupled is in fact completely independent.

---

### 5. ReasoningBank (neural module)

> **Update 2026-04-20 (C4, issue #468):** consolidated on the moflo-owned
> `AgentDBAdapter` from `@moflo/memory`. The neural ReasoningBank no longer
> imports the external `agentdb` package; both neural/ and hooks/ paths now
> share the same adapter + HNSW index. `optionalDependencies.agentdb` was
> removed from `@moflo/neural`. Brute-force fallback retained for
> `enableAgentDB: false`. The divergence noted below in "known gaps" #2 is
> closed.

**Entry points**
- `src/modules/neural/src/reasoning-bank.ts` (~1290 LOC) — the 4-step RETRIEVE/JUDGE/DISTILL/CONSOLIDATE pipeline
- Imported by: `src/modules/neural/src/index.ts` (NeuralLearningSystem), `src/modules/neural/__tests__/patterns.test.ts`
- No external consumers outside `@moflo/neural` (grep-verified)

**Code path**
`ReasoningBank.initialize()` → `ensureAgentDBAdapterImport()` → dynamic `import('@moflo/memory')` via a variable specifier (same pattern as hooks/). If the module resolves, constructs `new AgentDBAdapter({ dimensions, defaultNamespace, persistenceEnabled, persistencePath })`. On any throw, `this.agentdbAvailable = false`.

Retrieval (`reasoning-bank.ts:251-290`):
```ts
if (this.agentdb && this.agentdbAvailable) {
  try {
    const results = await this.searchWithAgentDB(queryEmbedding, retrieveK * 3);
    …
  } catch {
    // Fall through to brute-force
  }
}
// Fallback: brute-force search
if (candidates.length === 0) {
  for (const entry of this.memories.values()) {
    const relevance = this.cosineSimilarity(queryEmbedding, entry.memory.embedding);
    …
  }
}
```

The fallback is **wired, not stubbed**. `this.memories` is a `Map<id, MemoryEntry>` held in-process; `cosineSimilarity` is a local implementation.

**Fallback path**
In-memory `Map` of memories + brute-force cosine. No persistence without agentdb; every process start begins with an empty bank unless the agentdb path is taken.

**Tested?**
`src/modules/neural/src/reasoning-bank.test.ts` exists and tests the brute-force path (small memory set, no agentdb initialized because `enableAgentDB: false` is a config). The fallback is thus exercised, though not under the name "agentdb absent".

**Consumer-visible on removal**
- Module works; responses are correct.
- **Data does not persist across process restarts.** This is the sharpest user-visible change.
- Retrieval latency on large `memories` sets scales O(N) vs HNSW's ~O(log N). At N=1000 the brute-force is sub-100ms; at N=10k it becomes perceptible.

**Risk: MEDIUM.** The persistence loss is the real issue. If the hooks-layer ReasoningBank (item 2) writes patterns via the bridge (which does persist via sql.js), this in-process one may be fine for short-lived workflows but not for long-running daemons.

---

### 6. agentic-flow subprocess integration

**Entry points**
- `src/modules/cli/src/services/agentic-flow-bridge.ts` (120 LOC) — lazy loader
- `src/modules/cli/src/movector/enhanced-model-router.ts` — router subprocess
- `src/modules/cli/src/update/validator.ts` — version check
- `src/modules/cli/src/init/executor.ts` — project bootstrap

**Code path**
All six usages of `agentic-flow` in the `src/` tree (outside of docs) are either:
1. `await import('agentic-flow/…').catch(() => null)` — dynamic imports with guard (5 sites, verified by grep)
2. A comment referencing the module as documentation (`queen-coordinator.ts:1021`)
3. String literals (epic-doc references)

**Zero static imports** were found: the grep for `from ['"]agentic-flow` and `require\(['"]agentic-flow` returned no results.

**Fallback path**
`agentic-flow-bridge.ts` is entirely built around the fallback. Every loader returns `null` if the dynamic import throws:
- `getReasoningBank()`: `import('agentic-flow/reasoningbank').catch(() => null)` (line 39)
- `getRouter()`: line 50
- `getOrchestration()`: line 63 (uses `'agentic-flow' + '/orchestration'` concat to dodge Vite static analysis)

Callers check `if (!rb?.computeEmbedding) return null;` (line 77) — everything degrades to null.

**Tested?**
`isAvailable()` test path at line 93-96 is straightforward. Test coverage of the `null` branch is indirect — most call sites check `if (!x) …` so they naturally exercise the missing path when run without agentic-flow installed.

**Consumer-visible on removal**
- If `agentic-flow` is not in `node_modules/`: `isAvailable()` returns false; consumers that check this degrade gracefully.
- Users relying on `agentic-flow/router` for model routing fall back to whatever the local router is.
- Spell orchestration via `agentic-flow/orchestration` disables; moflo has its own spell engine that does not depend on it (`cli/spells`).

**Risk: ZERO for direct imports, LOW for feature completeness.** Nothing crashes; some "advanced" paths disappear.

---

## agentic-flow inventory

All references to `agentic-flow` in `src/` (minus docs/tests):

| File | Line | Type | Keep/Drop-safe |
|---|---|---|---|
| `cli/src/services/agentic-flow-bridge.ts` | 39 | lazy import | safe (catches to null) |
| `cli/src/services/agentic-flow-bridge.ts` | 50 | lazy import | safe |
| `cli/src/services/agentic-flow-bridge.ts` | 63 | lazy import | safe |
| `embeddings/src/neural-integration.ts` | 85 | lazy import | safe |
| `embeddings/src/neural-integration.ts` | 256, 274 | lazy import | safe |
| `embeddings/src/neural-integration.ts` | 293 | lazy import | safe |
| `embeddings/src/embedding-service.ts` | 831 | lazy import | safe |
| `swarm/src/queen-coordinator.ts` | 1021 | comment | n/a |

Eight total. Zero are static imports. All dynamic imports are either wrapped in `.catch(() => null)` or surrounded by try/catch.

---

## Known gaps / open questions

1. **No "agentdb-absent" integration test.** Every test that exercises agentdb-dependent code initializes it in-memory or mocks the sub-components. Gate 3 (consumer smoke harness) is the right venue to prove the fallback end-to-end.

2. **In-process vs. bridge-backed ReasoningBank divergence.** ✅ RESOLVED in C4 (issue #468, 2026-04-20). Both neural/ and hooks/ ReasoningBank now share `@moflo/memory`'s `AgentDBAdapter` + `HNSWIndex`. Persistence behaviour is uniform (whatever the adapter provides — currently in-memory; real disk persistence is scheduled for a later C-phase). The external `agentdb` package is no longer referenced from either module.

3. **Silent degradation vs. visible warning.** Every fallback path returns `null` / `[]` / no-op. No console warning is emitted when agentdb is missing at runtime. If we land Option B, a single init-time warning ("agentdb not available; using sql.js fallback with reduced features") would massively help users understand what changed.

4. **optionalDependencies behaviour under npm strict-peer-deps.** Some consumer installs (pnpm with `--strict-peer-deps`) may not install optionalDependencies at all, while others always do. Worth confirming in Gate 3 which mode the reference consumer uses.

5. **`causalGraph` walk depth.** Gate 1 noted that `causalGraph` has a SQL fallback but graph walks become O(N²). If real consumers are doing multi-hop causal queries, the brute-force fallback may be unacceptable. Needs a Gate 3 workload to measure.

---

## Summary of claims & evidence

| Claim | Evidence |
|---|---|
| Embeddings have a 3-tier auto fallback | `embedding-service.ts:893-1006` |
| Zero static imports of `agentic-flow` | grep for `from 'agentic-flow` and `require('agentic-flow` — no matches |
| SONA persists to `.swarm/sona-patterns.json` | `sona-optimizer.ts:11, 122` |
| ReasoningBank has a wired brute-force fallback | `reasoning-bank.ts:220, 262-290` |
| `memory-bridge.ts` wraps every controller with fallback | Gate 1 audit, `memory-bridge.ts:282-322, 1189-1823` |
| No "agentdb absent" integration test | grep of test files — every test initializes agentdb in-memory or mocks sub-components |
