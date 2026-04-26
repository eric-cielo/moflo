# Audit: `Float32Array` Producers in `src/` — IEmbeddingProvider Compliance

**Date:** 2026-04-23
**Scope:** Every production file under `src/` that produces a `Float32Array`
(or `number[]` used as an embedding).
**Out of scope:** `__tests__/`, `tests/__mocks__/`, `*.test.ts`, `*.bench.ts`,
`benchmarks/` test fixtures under vitest, ADRs and other Markdown docs.
**Driver:** Issue #546 — follow-up audit from epic #527 covering regressions the
*name*-based guard could not catch.
**Related:**
- Epic #527 — "Hard-require neural embeddings; remove all hash fallbacks"
- Issue #558 — "Purge remaining inline hash embeddings caught by unscoped guard"
- Issue #560 — "Pretrain benchmark ships hash-based embeddings" (resolved in PR #565; regression guard added under `src/modules/cli/__tests__/pretrain-no-hash-embeddings.test.ts`)
- ADR-EMB-001 — Neural embeddings mandatory

## Methodology

1. `Grep` the following patterns across `src/`:
   `new Float32Array`, `Float32Array(`, `\.embedding\b`, `\.embeddings\b`,
   `embed\(`, `batchEmbed\(`, `charCodeAt.*Math\.sin`, `hashToVector`,
   `textToVector`, `hashFeatures`.
2. For every hit outside test/benchmark/fixture paths, open the file and judge
   the *dominant* use of the `Float32Array`:
   - **PROVIDER** — produced by or flows through an `IEmbeddingProvider`
     (fastembed, OpenAI, injected `Embedder`).
   - **STORAGE / DESERIALIZATION** — re-materialises a vector previously emitted
     by a provider (JSON parse, binary-blob decode, HNSW index load).
   - **NON-SEMANTIC** — neural-net weights, RL state, attention buffers,
     optimiser state, or math helpers that expect pre-computed vectors as input.
   - **NEEDS-FIX** — produces a semantic (text → vector) embedding inline,
     without an `IEmbeddingProvider`.
3. Cross-reference `no-restricted-syntax` disables and commit history to confirm
   whether a NEEDS-FIX site is already tracked by #558.

## Summary

| Category | Files | Notes |
|---|---|---|
| PROVIDER | 13 | All reached via constructor/DI; none ambient. `benchmarkEmbeddingGeneration` now routes through `createEmbeddingService` (#560, PR #565). |
| STORAGE / DESERIALIZATION | 6 | Reconstitute provider output; safe. |
| NON-SEMANTIC | 35+ | RL, LoRA, attention, optimiser state, math helpers. Now includes `benchmarkPretrainPipeline`'s `Math.random` fixture vectors (pipeline-wiring measurement, not a text→vector; #560). |
| NEEDS-FIX (tracked in #558) | 4 | `eslint-disable` with `tracked by #558`. |
| **NEEDS-FIX (new, not in #558)** | **0** | `benchmarks/pretrain/index.ts` was promoted to PROVIDER + NON-SEMANTIC in PR #565 (issue #560). |

Net result: the name-based guard already caught everything #558 tracks. The
structural guard (`Float32Array + charCodeAt`) missed two hash-embedding sites
inside `src/modules/cli/src/benchmarks/pretrain/index.ts` because the rule exempts
paths under `benchmarks/`. Those were fixed in PR #565 and are now covered by a
dedicated `__tests__/` regression guard (`pretrain-no-hash-embeddings.test.ts`)
that is NOT subject to the `benchmarks/` exemption.

## PROVIDER — Flows through `IEmbeddingProvider`

| File | Evidence | Notes |
|---|---|---|
| `src/modules/guidance/src/retriever.ts:84,96,112` | `interface IEmbeddingProvider`; constructor throws without one. | Ground-truth interface definition. |
| `src/modules/cli/src/services/neural-embedding-provider.ts:28-46,74` | `FastembedBackedProvider` wraps cli's `createEmbeddingService` `embed()` / `embedBatch()`. | Returns real neural embeddings; hard-errors if module absent. |
| `src/modules/cli/src/embeddings/embedding-service.ts:106-185` | `BaseEmbeddingService` + `OpenAIEmbeddingService` + `LazyFastembedService`. | `createEmbeddingService()` is the only public factory. |
| `src/modules/cli/src/embeddings/fastembed-embedding-service.ts` | Fastembed ONNX implementation of `IEmbeddingService`. | Default production provider. |
| `src/modules/cli/src/embeddings/persistent-cache.ts` | SQLite-backed cache of provider output. | Wraps an existing provider. |
| `src/modules/memory/src/controllers/_shared.ts:67+` | `embedText(embedder, text)` throws if `embedder` is missing. | DI enforcement helper. |
| `src/modules/memory/src/controllers/hierarchical-memory.ts:119+` | `await embedText(this.embedder, ...)` — rejects missing embedder. | Per ADR-EMB-001. |
| `src/modules/memory/src/learning-bridge.ts:449-460` | `await this.embeddingService.embed(text)`; returns an empty `Float32Array(0)` on catch (not a hash fallback — an empty vector that downstream callers check). | Injected service via factory. |
| `src/modules/swarm/src/queen-coordinator.ts` | Accepts pre-computed embeddings on task/agent inputs; otherwise calls injected `IEmbeddingProvider.embed`. | PR #543. |
| `src/modules/swarm/src/attention-coordinator.ts:829,889,897,891` | Same pattern — prefers caller-supplied vector, otherwise delegates to `this.embeddingProvider.embed`. | PR #543. |
| `src/modules/cli/src/hooks/reasoningbank/index.ts:862-868,1022-1028` | `ensureEmbedding()` calls the injected `embeddingService`. | Constructor-injected. |
| `src/modules/cli/src/commands/embeddings.ts` | CLI wrapper over provider results. | Same DI path. |
| `src/modules/cli/src/benchmarks/pretrain/index.ts:290-313` (`benchmarkEmbeddingGeneration`) | `createEmbeddingService({ provider: 'fastembed' })` + `service.embed(...)`. | Shipped via `moflo benchmark pretrain`; the reported number now reflects real fastembed throughput (#560, PR #565). |

## STORAGE / DESERIALIZATION — Reconstitutes prior provider output

| File | Evidence |
|---|---|
| `src/modules/cli/src/services/learning-service.ts:677,706,777,788` | `new Float32Array(JSON.parse(row.embedding))` — rehydrates sqlite-stored provider vectors. |
| `src/modules/memory/src/rvf-backend.ts:427` | Parses journal entry; promotes `embedding` array to `Float32Array`. |
| `src/modules/memory/src/rvf-migration.ts:311` | Loads persisted entries during migration. |
| `src/modules/memory/src/sqljs-backend.ts:760` | `new Float32Array(new Uint8Array(row.embedding).buffer)` — binary blob decode. |
| `src/modules/memory/src/database-provider.ts:60-70` | Coerces stored `Buffer` / `Uint8Array` / array back into `Float32Array`. Symmetric counterpart of provider output. |
| `src/modules/memory/src/hnsw-index.ts` | Stores pre-normalised vectors supplied by callers; does not produce semantic vectors itself. |

## NON-SEMANTIC — Not a text → vector

Grouped by concern for readability.

### Neural / RL state & weights (`src/modules/neural/`)
| File | What the `Float32Array` holds |
|---|---|
| `src/modules/neural/src/sona-engine.ts` | LoRA A/B low-rank matrices (rank×dim / dim×rank). |
| `src/modules/neural/src/sona-manager.ts`, `sona-integration.ts` | RL state vectors + routing features. |
| `src/modules/neural/src/reasoning-bank.ts:1075+` | Weighted aggregation of trajectory step states. Input vectors originate upstream as RL state, not as text embeddings. |
| `src/modules/neural/src/reasoningbank-adapter.ts:649-669` | `computePatternEmbedding(trajectory)` — weighted average of `step.stateAfter`. No `charCodeAt` / hashing; purely RL-state aggregation. |
| `src/modules/neural/src/pattern-learner.ts:549-569` | Same as above — trajectory state aggregation. |
| `src/modules/neural/src/algorithms/{a2c,dqn,ppo,q-learning,sarsa,decision-transformer,curiosity}.ts` | Policy / value-head buffers, advantage vectors, replay-buffer tensors. |
| `src/modules/neural/src/modes/{balanced,batch,base,edge,real-time,research}.ts` | Per-mode RL feature tensors. |

### MoVector (routing / attention math, `src/modules/cli/src/movector/`)
| File | What the `Float32Array` holds |
|---|---|
| `src/modules/cli/src/movector/semantic-router.ts:29,178+` | L2-normalisation scratch buffer; `embeddings: Float32Array[]` field holds pre-computed vectors supplied by callers (not produced here). |
| `src/modules/cli/src/movector/moe-router.ts:71+` | `scoreBuffer`, `expBuffer` — softmax / routing scores, not text embeddings. |
| `src/modules/cli/src/movector/flash-attention.ts:37+` | `output` / `weights` — attention matrices. |
| `src/modules/cli/src/movector/q-learning-router.ts` | RL state/value buffers. |
| `src/modules/cli/src/movector/lora-adapter.ts` | LoRA adapter weights. |

### Training utilities
| File | What the `Float32Array` holds |
|---|---|
| `src/modules/cli/src/services/training-utils.ts:32-69,186-190` | Adam optimiser `m`/`v`, contrastive-loss gradient buffer. |
| `src/modules/cli/src/services/movector-training.ts:128,233` | MoE expert-weight init, synthetic gradient for reward-shaped adaptation. |

### Benchmark fixtures (pipeline-wiring measurement, not text→vector)
| File | What the `Float32Array` holds |
|---|---|
| `src/modules/cli/src/benchmarks/pretrain/index.ts:421-430` (`benchmarkPretrainPipeline`) | Random fixture vectors used to time index construction and pattern extraction. The embedder itself is covered by `benchmarkEmbeddingGeneration` in the PROVIDER table; this helper deliberately uses `Math.random` so it cannot be mistaken for a real embedding (#560, PR #565). |

### Test-only paths NOT classified

Skipped per audit scope. Listed here only so the audit is demonstrably complete.

- `src/modules/cli/src/hooks/reasoningbank/__mocks__/test-embedding-service.ts` — deterministic test mock.
- `src/modules/guidance/tests/__mocks__/deterministic-embedding-provider.ts` — deterministic test mock.
- `src/modules/memory/src/controllers/_test-embedder.ts` — test-only embedder helper.
- `src/modules/embeddings/__tests__/**`, `src/modules/memory/benchmarks/*.bench.ts`, `src/modules/neural/__tests__/**`, etc. — vitest / benchmark suites.

## NEEDS-FIX

### Already tracked by #558

All four carry `// eslint-disable-next-line no-restricted-syntax -- … tracked by #558` and are reproduced verbatim from #558's body:

| Site | Note |
|---|---|
| `src/modules/cli/src/mcp-tools/hooks-tools.ts:120` (`generateSimpleEmbedding`) | Called at `:323`, `:335`, `:861` — live MCP routing path. |
| `src/modules/cli/src/mcp-tools/hooks-tools.ts:2990+` (`hooks_intelligence_attention` MoE / Flash demo branches) | Inline `Math.sin(query.charCodeAt(...))`. |
| `src/modules/embeddings/src/embedding-service.ts:430` (`MockEmbeddingService.deterministicEmbedding`) | Class doc says "TEST-ONLY — never returned by createEmbeddingService", but `createEmbeddingService` still returns it for `provider: 'mock'`. |
| `src/modules/embeddings/src/migration/in-memory-store.ts:221` (`MockBatchEmbedder.seedVector`) | Migration-driver test fixture that leaks into `src/`. |

This audit does **not** duplicate those into fresh issues — #558 is their owner.

### #560 — RESOLVED (PR #565)

**Sites (original):**
- `src/modules/cli/src/benchmarks/pretrain/index.ts:290-312` — `benchmarkEmbeddingGeneration` built a 384-dim vector from `text.charCodeAt` + `Math.sin`.
- `src/modules/cli/src/benchmarks/pretrain/index.ts:432-465` — `benchmarkPretrainPipeline` generated 50 file embeddings via `Math.sin(file.path.charCodeAt(...))`.

**Why the guard missed it:** the `no-restricted-syntax` structural rule exempts
`benchmarks/` paths because benchmarks routinely compute synthetic vectors.
These two functions however were imported from `src/modules/cli/src/commands/benchmark.ts`
and are invoked by the user-facing `moflo benchmark` command — so `npm i moflo` shipped
them, and users saw "Embedding Generation: N ops/sec" numbers that measured a
hash function, not the real fastembed pipeline.

**Fix (option 1 — integrity):**
- `benchmarkEmbeddingGeneration` now calls `createEmbeddingService({ provider: 'fastembed' }).embed(...)`. The reported throughput is real fastembed.
- `benchmarkPretrainPipeline` keeps synthetic fixture vectors (its point is to time index/pattern wiring, not the embedder) but uses `Math.random` — an obviously synthetic generator that cannot be mistaken for a real embedding.

**Why a new guard was required after PR #565:** the repo-wide ESLint structural
rule still exempts `src/**/benchmarks/**`, so a future PR could re-introduce
`charCodeAt` + `Math.sin` here and lint would stay green. Consumer-smoke's
`verifyNoInlineHashEmbeddings` catches it at dist time but only on PR CI.
The regression is now also gated by
`src/modules/cli/__tests__/pretrain-no-hash-embeddings.test.ts`, which runs
in the normal unit suite and is NOT subject to the `benchmarks/` exemption
because it lives under `__tests__/`.

## Confidence

- High confidence that all 114 `Float32Array`-touching files under `src/` were
  classified — spot-checked every file listed in the grep index before writing
  this document.
- High confidence that no production hash-embedding path remains outside
  `hooks-tools.ts` (tracked by #558). `benchmarks/pretrain/index.ts` was fixed
  in PR #565 and is guarded at unit-test time by
  `pretrain-no-hash-embeddings.test.ts` (outside the `benchmarks/` ESLint exemption).
- Moderate confidence that `neural/src/{reasoning-bank,reasoningbank-adapter,pattern-learner}.ts`'s
  `computePatternEmbedding` variants are truly non-semantic — they average
  `step.stateAfter` vectors which originate as RL state, not text embeddings.
  If a future change feeds raw text through these, the DI-compliance test
  added alongside this audit will flag the regression.
