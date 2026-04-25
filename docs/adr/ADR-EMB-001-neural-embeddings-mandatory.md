# ADR-EMB-001: Neural Embeddings Are Mandatory — Swap to fastembed, Remove All Hash Fallbacks

## Status
Accepted

## Date
2026-04-22

## Context

Prior to epic #527, `@moflo/embeddings` (and every upstream memory, guidance, and ReasoningBank consumer) shipped with a hash-based pseudo-embedding fallback. The neural path was backed by `@xenova/transformers`, marked as `peerDependenciesMeta.optional` in the root `package.json`. Because `npm install moflo` does not install optional peers, **most users ran entirely on FNV-1a hash vectors without ever knowing**.

Hash embeddings have no semantic meaning: synonymous sentences hash to unrelated vectors. Every downstream feature that depends on cosine similarity — `memory_search`, guidance shard retrieval, ReasoningBank RETRIEVE/JUDGE/DISTILL — silently degraded to near-random-quality results. ADR-G002 and ADR-G026 flagged `HashEmbeddingProvider` as test-only, but nothing in the runtime path enforced that constraint, and the README never documented `@xenova/transformers` as an install prerequisite. This amounted to a packaging lie about a core feature.

Additional pressure from the `@xenova/transformers` choice:

- **Archived upstream.** `@xenova/transformers` is a read-only repo; no security updates, no model compatibility fixes.
- **45 MB of JS + ~66 MB onnxruntime-web + `sharp`.** Heavy for what moflo actually needs (one embeddings model).
- **Multi-provider abstraction that moflo never used.** `@xenova/transformers` ships support for classification, translation, vision, etc. Moflo only calls `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')`.

A replacement needed three properties: actively maintained, embeddings-only minimal footprint, and the same underlying model (`all-MiniLM-L6-v2`, 384-dim) so vectors stay interchangeable across the migration.

## Decision

### 1. Hard-require neural embeddings

Remove every hash-embedding code path from the production tree atomically in a single PR (epic #527, story #531). No gradual deprecation, no feature flag, no `if (neuralAvailable) else fallback`. If the embedding service fails to initialize, the caller throws — silent degradation to hash vectors is a correctness hazard.

- Delete `HashEmbeddingProvider`, `createHashEmbedding`, `generateHashEmbedding`, `RvfEmbeddingService`, `RvfEmbeddingCache`, and any `domain-aware-hash-*` helpers from `src/`.
- Keep the deterministic test fixture in `tests/__mocks__/deterministic-embedding-provider.ts` — unreachable from production factories, only used in unit tests that explicitly inject it.
- Every embedding consumer (`@moflo/memory`, `@moflo/guidance`, `@moflo/hooks`, `@moflo/neural`, CLI bridge) now throws on a missing provider instead of falling through.

### 2. Swap `@xenova/transformers` → `fastembed`

Replace `@xenova/transformers` with [`fastembed`](https://www.npmjs.com/package/fastembed) (Qdrant's embeddings-only client):

| Property | `@xenova/transformers` | `fastembed` |
|---|---|---|
| Status | Archived | Actively maintained |
| JS payload | ~45 MB | ~109 KB |
| Runtime deps | `onnxruntime-web` (~66 MB), `sharp` | `onnxruntime-node`, `@anush008/tokenizers` (prebuilt binaries) |
| Model | `Xenova/all-MiniLM-L6-v2` (384-dim) | `fast-all-MiniLM-L6-v2` (384-dim — same architecture) |
| Tokenizer | JavaScript | Native Rust (no `rustup` on user machines) |

Same model architecture → same vector space → vectors from both runtimes are interchangeable within a single model version. The DB migration driver (epic #527, story #529) uses an `embeddings_version` marker to re-embed when the model is bumped; it does not re-embed when only the runtime changes.

### 3. Move from `peerDependenciesMeta.optional` → `dependencies`

`fastembed` lives in root `dependencies`. No `peerDependencies`, no `peerDependenciesMeta.optional`, no install prompts, no doctor checks, no recovery path. The library depends on it, period.

### 4. Platform-specific ONNX runtime pruning

`onnxruntime-node` ships binaries for every supported platform (~230 MB across all binaries). A `postinstall` script (`scripts/prune-native-binaries.mjs`) deletes binaries for non-matching platforms on the current host, reducing install size to ~80 MB.

**Ownership-scoped (#552, architect review of this epic).** The walker only prunes ORT installs that moflo owns via its dependency graph: every `fastembed` install is resolved to its `onnxruntime-node` via Node's standard upward `node_modules/` walk. Two ownership rails keep us off foreign ORT copies:

1. **Nested** `…/fastembed/node_modules/onnxruntime-node` — always pruned (private to fastembed, cannot be shared).
2. **Hoisted** `<root>/node_modules/onnxruntime-node` resolved by fastembed — pruned **only** when no other top-level package declares `onnxruntime-node` in `dependencies` / `optionalDependencies` / `peerDependencies`. If another consumer is present (e.g. an Electron cross-compile packager that needs binaries for a non-current platform), the hoisted copy is left intact.

**GPU provider stripping.** The postinstall also removes GPU-only provider libraries that fastembed (CPU-only inference) never loads: `libonnxruntime_providers_{cuda,tensorrt,shared}.*`, `DirectML.dll`, and the Windows `onnxruntime_providers_*.dll` variants. Matters most on Linux/x64 where ORT 1.21 *downloads* a 327 MB CUDA provider during its own postinstall; moflo plants a zero-byte `libonnxruntime_providers_cuda.so` stub so ORT's `CUDA_DLL_EXISTS` check short-circuits the fetch entirely. Result: Linux installs drop from ~430 MB to ~100 MB, Windows from ~80 MB to ~60 MB.

**Escape hatches.** Set `MOFLO_NO_PRUNE=1` before `npm install` to disable the prune entirely — useful for cross-compile packagers, CI that ships multi-platform artifacts, or debugging a broken ORT install. To keep moflo's prune but force ORT to fetch CUDA anyway (GPU inference), also set `ONNXRUNTIME_NODE_INSTALL_CUDA=true`. The script no-ops inside the moflo source repo itself (detected via nearest-ancestor `package.json` name) and under Yarn PnP (no `node_modules/` present).

### 5. Permanent regression guard

Five layers prevent hash-fallback code from re-entering the tree. Layers 1 and 2 shipped with this ADR; layers 3–5 were added as **behaviour-based** augmentation after anonymous inline hash producers were discovered slipping past the identifier-only guard (see the **Post-decision correction** section below for the full history):

1. **ESLint identifier rule** (`.eslintrc.cjs`) — flags any occurrence of the banned identifiers above (`HashEmbeddingProvider`, `createHashEmbedding`, `generateHashEmbedding`, `RvfEmbedding*`, `domain-aware-hash-*`) in `src/` and `bin/`.
2. **Consumer-smoke banned-identifier check** (`harness/consumer-smoke/`) — a fresh `npm install moflo` in a scratch consumer project asserts `fastembed` is present and no banned identifiers leak into the published `dist/` tree.
3. **ESLint structural rule** (`.eslintrc.cjs`, added in PR #543, unscoped across `src/**/*.ts` in #545) — `no-restricted-syntax` with `:has()` selectors flags any function that both constructs a `Float32Array` and calls `charCodeAt(...)`. Catches the anti-pattern regardless of method name.
4. **Consumer-smoke dist-walker** (`harness/consumer-smoke/lib/checks.mjs::verifyNoInlineHashEmbeddingsInSwarm`, added in PR #543) — walks the published `dist/` tree and rejects any file containing both `new Float32Array(` and `charCodeAt(`; defends against source-tree lint bypasses.
5. **DI-compliance test** (`src/modules/cli/__tests__/embeddings/provider-di-compliance.test.ts`, added in #546) — pins the positive contract: every known semantic-embedding entry point (`ShardRetriever`, hierarchical-memory controller, attention/queen coordinators, hooks ReasoningBank) must reject a missing `IEmbeddingProvider` at construction or first `embed()` call. Catches the anti-pattern when someone reintroduces an ambient / default-constructed provider.

### 6. CI model cache

`actions/cache@v4` caches `~/.cache/fastembed` across CI runs (this ADR, epic #527, story #534). First CI run warms the cache; subsequent runs on the same lockfile skip the ~90 MB model download.

## Post-decision correction

The regression guard shipped with the original decision (section 5 above) was **identifier-based** — ESLint flagged occurrences of `HashEmbeddingProvider`, `createHashEmbedding`, `generateHashEmbedding`, `RvfEmbedding*`, and `domain-aware-hash-*`. It could not see anonymous inline hash producers — methods that constructed a `Float32Array` and populated it from `charCodeAt()` under innocuous names like `getOrCreateEmbedding` or `createSimpleEmbedding`. Several live paths slipped through:

- **2026-04-23 — #542 / PR #543.** Two inline hash embedders discovered in `src/modules/swarm/attention-coordinator.ts` (`getOrCreateEmbedding`, 64-dim) and `src/modules/swarm/queen-coordinator.ts` (`createSimpleEmbedding`, 768-dim). Both were removed; both coordinators now take an injected `IEmbeddingProvider`. PR #543 also shipped the **first behaviour-based guard** — an ESLint `no-restricted-syntax` rule that flags any function combining `new Float32Array(...)` with `charCodeAt(...)`, initially scoped to `src/modules/swarm/**`, plus a smoke dist-walker (`harness/consumer-smoke/lib/checks.mjs::verifyNoInlineHashEmbeddingsInSwarm`) that rejects the same pattern in compiled output.
- **2026-04-23 — #545.** Architect review unscoped the `Float32Array + charCodeAt` structural rule across the entire `src/` tree (not just swarm) and added the newly found method names to the banned-identifier list. This surfaced additional live paths in `src/modules/cli/src/mcp-tools/hooks-tools.ts` (`generateSimpleEmbedding` + inline MoE / Flash-Attention demo branches) and `src/modules/cli/src/embeddings/embedding-service.ts` (`MockEmbeddingService.deterministicEmbedding` reachable via factory `case 'mock'`).
- **2026-04-23 — #546.** Full audit of every `Float32Array` producer under `src/` at [`./audits/2026-04-23-float32array-producers.md`](./audits/2026-04-23-float32array-producers.md). Classifies every producer as **PROVIDER** (flows through `IEmbeddingProvider`), **NON-SEMANTIC** (RL state, SONA LoRA, MoE weights, HNSW index), or **NEEDS-FIX**. Adds `src/modules/cli/__tests__/embeddings/provider-di-compliance.test.ts` — a DI-compliance test that pins the contract: every known semantic-embedding entry point must reject a missing provider at construction or first `embed()` call.
- **2026-04-24 — #558 / #560.** Purge of the remaining NEEDS-FIX sites surfaced by the strengthened guard. #558 covered the known `hooks-tools.ts` + migration fixture sites; #560 tracks the newly discovered `src/modules/cli/src/benchmarks/pretrain/index.ts` benchmark that reported hash-based "embeddings" as real `ops/sec` in a user-visible CLI metric.

**Root cause.** Name-based guards enforce a vocabulary, not a behaviour. An engineer writing a new anonymous hash producer under a generic name passes the guard by construction. Every site listed above compiled, tested, and lint-cleaned under the original epic #527 guard.

**Remediation.** Three behaviour-based layers that are blind to identifier choice:

1. **Structural AST rule** — ESLint `no-restricted-syntax` with `:has()` selectors for the `Float32Array` + `charCodeAt` co-occurrence, unscoped across `src/**/*.ts`.
2. **Compiled-dist smoke walker** — consumer-smoke harness walks the published `dist/` tree and rejects any file containing both patterns; catches the anti-pattern even when source-tree lint is skipped.
3. **DI-compliance test** — `provider-di-compliance.test.ts` asserts every known semantic-embedding entry point requires an `IEmbeddingProvider` via constructor or factory and throws when the caller omits it. Catches the anti-pattern when someone reintroduces an ambient / default-constructed provider.

**Lesson.** Atomic-removal ADRs must ship **behaviour-based** guards in the same PR as the removal, not name-based guards. Name-based guards are cheap and look thorough, but they enforce the spelling of the old mistake, not the shape of it. The four-day tail of #542 → #558 → #560 is the cost of having only identifier coverage on the day the epic closed; the final guard stack above is what the epic should have shipped on day one.

## Consequences

### Positive

- **Semantic search actually works.** Every consumer install gets real 384-dim neural embeddings by default, not hash pseudo-vectors.
- **Smaller JS footprint.** `@xenova/transformers` (45 MB) → `fastembed` (109 KB). Net JS payload drops dramatically.
- **Maintained upstream.** `fastembed` is actively developed; `@xenova/transformers` is archived.
- **Hard-fail guarantees.** Missing model, broken network on first run, or a misconfigured provider produces a user-visible error instead of silent quality degradation.
- **Regression-proof.** Five guard layers (identifier-based ESLint + smoke check, plus behaviour-based structural ESLint rule, dist-walker, and DI-compliance test) together block any future PR that reintroduces hash-embedding code — whether under the original banned names, an anonymous inline producer matching the `Float32Array + charCodeAt` shape, or an ambient-provider entry point that bypasses dependency injection. See **Post-decision correction** for why all five are load-bearing.
- **Interchangeable vectors.** Same `all-MiniLM-L6-v2` architecture → existing DBs only need re-embedding when the model itself changes, not when swapping runtime libraries.

### Negative

- **Install size ballooned.** Pre-epic: 34 MB default install. Post-epic + prune: ~80 MB. Still ~14× smaller than Ruflo's ~1.1 GB default, but a real regression from the old hash-fallback default. This is a deliberate trade-off — real semantic search is worth the extra ~46 MB.
- **First-run download.** On a fresh machine without the cache, the user waits ~1–3 minutes for the model to download (one-time per machine, stored in `~/.cache/fastembed`).
- **Air-gapped installs need a preload.** Users on air-gapped networks must pre-populate `~/.cache/fastembed` before `flo init`.
- **Docker sandbox caching.** ~~The sandbox Dockerfile needs either a writable cache mount or the model baked into the image to avoid downloading on every container start.~~ **Resolved by issue #549** (2026-04-23): `docker/sandbox/Dockerfile` bakes the default `all-MiniLM-L6-v2` model into `/opt/fastembed-cache` at image build and exports `FASTEMBED_CACHE=/opt/fastembed-cache`; `FastembedEmbeddingService` reads the env var as a `cacheDir` fallback so sandboxed spell steps work under `--network none` with no per-container redownload.
- **Upgrade migration is the default experience.** The README never documented `@xenova/transformers`, so most live users are currently on hash vectors and will see the re-embed migration (1–3 min) on upgrade.

### Neutral

- **OpenAI embeddings stay opt-in.** `OpenAIEmbeddingService` is still exposed for callers who explicitly configure it; `fastembed` is the default.
- **Test fixture unchanged.** Unit tests that inject `DeterministicEmbeddingProvider` continue to work without modification.

## Alternatives Considered

### 1. Keep hash fallback, document it clearly

Rejected. Any fallback that produces semantically meaningless vectors is a correctness hazard — even a well-documented one. Users would still configure `memory_search` against a hash-backed corpus and get confusing results.

### 2. Fork and strip `@xenova/transformers`

Rejected. `fastembed` already is the minimal embeddings-only client we would have built. Ownership overhead too high for a one-developer upstream.

### 3. Auto-install on first use / doctor-check pattern

Rejected. This treats embeddings as a recovery path, not a core dependency. Users shouldn't have to run `flo doctor --fix` to get their memory system to produce meaningful vectors.

### 4. Ship a WASM-only embedding runtime (no `onnxruntime-node`)

Rejected. The WASM variant has meaningfully slower inference (5–10×) on typical embedding workloads. The platform-specific prune keeps `onnxruntime-node` at a reasonable size.

### 5. Background / async migration

Rejected. Correctness beats latency for a one-shot DB re-embed. Blocking migration with a clear progress indicator is simpler and less error-prone than a background job that could race with other memory operations.

## References

- Epic #527 — [EPIC] Hard-require neural embeddings; remove all hash fallbacks; swap @xenova → fastembed
- Story #528 — Add fastembed-backed `IEmbeddingService` (additive)
- Story #529 — `embeddings_version` markers + resumable migration driver
- Story #530 — Upgrade UX (messaging, progress, interrupt safety)
- Story #531 — Atomic removal of all hash fallbacks; promote fastembed to hard dep
- Story #532 — ESLint rule + smoke guard against hash-fallback regression
- Story #533 — Platform-specific ONNX runtime binary pruning
- Story #534 — CI model cache + ADR updates + README install-size note (this ADR)
- ADR-G002 — Constitution / shard split (updated to reference fastembed + epic #527)
- ADR-G026 — Review remediation (section 7 marked resolved)
- `src/modules/cli/src/embeddings/fastembed-embedding-service.ts` — production service
- `harness/consumer-smoke/lib/checks.mjs` — banned-identifier + required-dep guard + `verifyNoInlineHashEmbeddingsInSwarm` dist-walker
- `scripts/prune-native-binaries.mjs` — platform-specific ONNX prune

### Post-decision follow-ups (see **Post-decision correction** above)

- #542 / PR #543 — Remove inline hash embeddings in swarm coordinators; ship first structural `Float32Array + charCodeAt` ESLint rule + smoke dist-walker
- #545 — Strengthen regression guard (unscope structural rule across `src/`, extend banned-identifier list)
- #546 — Full `Float32Array` producer audit + DI-compliance test
- #555 — This amendment
- #558 — Purge remaining inline hash embeddings caught by the unscoped guard (hooks-tools, migration fixtures, mock service)
- #560 — Pretrain benchmark `ops/sec` reported on hash embeddings (discovered by the audit)
- `docs/audits/2026-04-23-float32array-producers.md` — full classification of every `Float32Array` producer under `src/`
- `src/modules/cli/__tests__/embeddings/provider-di-compliance.test.ts` — DI-compliance test pinning the provider-required contract
