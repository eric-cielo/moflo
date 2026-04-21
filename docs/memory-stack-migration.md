# Design: sql.js + HNSW + moflo-owned controllers

Status: **draft — for discussion, not committed**
Date: 2026-04-20
Context: `agentdb@3.0.0-alpha.11` silently wrote `agentdb.rvf` to consumer project roots because `AgentDBConfig` has no way to route the vector-backend storage path. We reverted to `alpha.10`. This doc scopes whether we should keep agentdb or replace it.

## Goals

1. Stop inheriting unannounced behavior changes from alpha-versioned upstreams.
2. Keep moflo's memory/reasoning features working — no loss of user-visible capability.
3. Keep sql.js as the relational tier (portable, WASM, no native build).

## What agentdb is actually giving us today

Three call sites construct `new AgentDB(...)`:
- `src/modules/memory/src/controller-registry.ts:481`
- `src/modules/memory/src/agentdb-backend.ts:180`
- `src/modules/neural/src/reasoning-bank.ts:209`

From those we depend on three categories of value:

### A. Runtime plumbing — small and replaceable
- **SQLite database** (we could use sql.js directly).
- **Embedding service** — `Xenova/all-MiniLM-L6-v2` via `@xenova/transformers`. We already have this dep; trivial to move.
- **Vector index** — HNSW. We already have `src/modules/memory/src/hnsw-lite.ts` (pure TS HNSW) and `src/modules/memory/src/rvf-backend.ts` (persistent single-file). These are moflo-owned.

### B. Pre-built domain controllers — the real lock-in
From `controller-registry.ts:670-915`, moflo registers 21 agentdb-provided controllers. The ones actively consumed by `src/modules/cli/src/memory/memory-bridge.ts` (and surfaced via MCP tools) are:

| Controller | Purpose | Hard to reimplement? |
|---|---|---|
| `reflexion` | Reflexion-pattern failure memory | Medium — well-documented pattern |
| `skills` | Skill library | Medium — CRUD over embedded skills |
| `causalGraph` / `causalRecall` | Causal edges between memories | High — graph walks, scoring |
| `reasoningBank` | Trajectory storage + experience replay | Medium — we have a partial impl in `src/modules/neural/src/reasoning-bank.ts` |
| `hierarchicalMemory` | Tiered memory (short/long/meta) | Medium — already has a stub in `controller-registry.ts:createTieredMemoryStub` |
| `memoryConsolidation` | Promote short→long term | Medium — stub exists |
| `learningSystem` | Reward/gradient learning loop | High — proprietary algorithms |
| `nightlyLearner` | Batch offline learning | Medium — cron + `learningSystem` |
| `semanticRouter` | Route queries by semantics | Low — MMR + cosine |
| `mmrDiversityRanker` | MMR diversity ranker | Low — ~80 lines of TS |
| `contextSynthesizer` | Summarize retrieval for context | Low — mostly prompt template |
| `batchOperations` | Bulk insert/update | Low — SQL wrapper |
| `mutationGuard` | Detect anomalous vector writes | High — includes WASM proofs |
| `attestationLog` | Append-only audit log | Low — one SQL table |
| `guardedVectorBackend` | Wraps vector backend with guard | Low — decorator |
| `gnnService` | Graph neural net reasoning | High — external model weights |
| `rvfOptimizer` | Adaptive HNSW tuning | Medium |
| `sonaTrajectory` | SONA neural trajectories | High — internal to agentdb |

The `memory-bridge.ts` consumer surface hits roughly 15 of these via ~30 call sites.

### C. Opinion / assembly
agentdb gives us "one-line wiring" — `new AgentDB({ dbPath })` initializes SQLite + embedder + HNSW + every controller. Without it, we assemble the pieces ourselves.

## Proposed stack

```
┌──────────────────────────────────────────────────────────┐
│  @moflo/memory (exports unchanged public API)            │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  ControllerRegistry                              │   │
│  │  (unchanged consumer contract)                   │   │
│  └──────────────────────────────────────────────────┘   │
│         │                                                │
│    ┌────┴──────┬──────────┬──────────┬─────────┐        │
│    ▼           ▼          ▼          ▼         ▼        │
│  Reflexion   Skills   CausalGraph  Reasoning  …others   │
│  (moflo)     (moflo)  (moflo)      Bank                 │
│                                    (moflo)              │
│         │         │         │         │                 │
│         └─────────┴────┬────┴─────────┘                 │
│                        ▼                                 │
│                ┌───────────────┐    ┌──────────────┐    │
│                │  sql.js       │    │  HnswLite    │    │
│                │  (relational) │    │  (vectors,   │    │
│                │               │    │   moflo-     │    │
│                │               │    │   owned)     │    │
│                └───────────────┘    └──────────────┘    │
│                        │                                 │
│                        ▼                                 │
│                .swarm/memory.db + .swarm/vectors.rvf    │
└──────────────────────────────────────────────────────────┘
```

## Migration phases

### Phase 0 — Containment (0.5 day)
- [x] Revert agentdb to `alpha.10` (done).
- [x] `*.rvf` in `.gitignore` (done).
- [ ] Add CI guard: bumping agentdb requires an ADR.

### Phase 1 — Reclaim the easy controllers (2–3 days)
Replace the "Low" effort controllers above — they're thin enough that reimplementing is cleaner than wrapping. Ship each as its own small module under `src/modules/memory/src/controllers/`:
- `mmr-diversity-ranker.ts`
- `context-synthesizer.ts`
- `batch-operations.ts`
- `attestation-log.ts`
- `guarded-vector-backend.ts`
- `semantic-router.ts`

Keep `controller-registry.ts` as the dispatch layer — just flip cases to use the moflo implementations. No consumer-facing change.

### Phase 2 — Reclaim the medium controllers (1 week)
- `reflexion` — straightforward: table of `(timestamp, action, outcome, reflection, embedding)` with vector search.
- `skills` — table of `(name, description, code, embedding)` with vector search.
- `reasoning-bank` — we already have `src/modules/neural/src/reasoning-bank.ts`; finish it and drop the agentdb delegation path.
- `hierarchical-memory` — finish `createTieredMemoryStub` into the real thing.
- `memory-consolidation` — likewise.
- `nightly-learner` — cron loop over the above; simple when the below three exist.
- `rvf-optimizer` — optional; our `HnswLite` already auto-tunes.

### Phase 3 — Decide on the hard controllers (research spike, ~1 week)
- `causalGraph` / `causalRecall` — do we actually use the graph walks, or just pretend? Check `memory-bridge.ts:1385` usage depth. If shallow, reimplement as a sqlite edges table + BFS. If deep, keep agentdb for this narrow feature only.
- `learningSystem`, `gnnService`, `sonaTrajectory`, `mutationGuard` — these are agentdb's novel research work. Three options:
  1. **Drop them** — if they're aspirational but not yet delivering user value, cut and stop paying the upgrade tax.
  2. **Keep as optional** — gate behind a `features.agenticFlow.enabled` flag; default off. Moflo works without agentdb in the common case; advanced users opt in.
  3. **Reimplement** — only worth it if we have a real product-level reason. Each is weeks of work.

### Phase 4 — Remove the `agentdb` dependency (2 days)
- Drop from `package.json` optionalDependencies and `src/modules/memory/package.json` dependencies.
- Delete `agentdb-backend.ts`, simplify `controller-registry.ts`.
- Keep `@xenova/transformers` (we use it directly now).
- Keep `hnswlib-node` as an optional faster backend.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Silent behavior drift from our reimplementations | Medium | Snapshot tests on memory outputs before cutover; diff against agentdb-backed baseline |
| Losing a research feature (GNN, SONA) that a user cares about | Low–Medium | Phase 3 is a go/no-go; the doc forces the conversation |
| Migration drags; two code paths coexist | High | Ship Phase 1 behind a feature flag (`memory.backend: 'agentdb' | 'moflo'`), flip default at the end |
| sql.js performance ceiling on large memories | Medium | Offer `better-sqlite3` as an optional native upgrade, same API |

## Cost summary

| Path | Up-front effort | Ongoing cost |
|---|---|---|
| Stay on agentdb (status quo) | 0 | ~1 fire-drill per agentdb alpha bump; exposure to upstream-owned design decisions |
| Migrate Phases 0–2 only (cover everything most users touch) | ~1.5 weeks | Cut ~60% of agentdb surface area; keep it only for research controllers behind a flag |
| Full migration (Phases 0–4) | 3–5 weeks | Full semver control; no upstream surprises |

## Recommendation

**Phases 0–2 now, Phase 3 as a deliberate research decision.**

Rationale:
- Phase 0 is already half-done (revert + gitignore). Finishing it with a CI guard is ~1 hour.
- Phase 1 is cheap and uncontroversial — those controllers are small enough that wrapping them is more code than owning them.
- Phase 2 is where the real win lives: the controllers most consumer code actually touches become ours.
- Phase 3 forces the conversation about whether the research features are delivering user value today. That conversation is more valuable than any code.
- Full migration can wait until we have a pain point — don't pre-pay for decoupling we might not need.

## Open questions

1. Do any moflo features *outside* `memory-bridge.ts` use agentdb directly? (Brief audit shows `aidefence`, `plugins/integrations/agentic-flow.ts`, and docs only — all re-exports, not consumers.)
2. Is there a moflo user today who actively uses `gnnService` or `sonaTrajectory`? If the answer is "demo only," Phase 3 gets a lot easier.
3. Should the vector storage path become a first-class `moflo.yaml` setting (`memory.vectorPath: .swarm/vectors.rvf`) for consumer projects that want to relocate it?

## Not doing

- **`sqlite-vec`** — requires abandoning sql.js or a custom WASM rebuild. Rejected; see conversation log.
- **Forking agentdb** — ownership overhead too high for a one-developer upstream; we'd rather reimplement the slice we use.
- **Keeping agentdb auto-upgrades** — the alpha versioning means one more silent behavior change will land eventually. Pin or don't install.
