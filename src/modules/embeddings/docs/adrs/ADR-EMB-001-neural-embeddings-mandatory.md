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

`fastembed` lives in root `dependencies` and in `src/modules/embeddings/package.json` `dependencies`. No `peerDependencies`, no `peerDependenciesMeta.optional`, no install prompts, no doctor checks, no recovery path. The library depends on it, period.

### 4. Platform-specific ONNX runtime pruning

`onnxruntime-node` ships binaries for every supported platform (~230 MB across all binaries). A `postinstall` script (`scripts/prune-native-binaries.mjs`) deletes binaries for non-matching platforms on the current host, reducing install size to ~80 MB.

### 5. Permanent regression guard

Two layers prevent hash-fallback code from re-entering the tree:

- **ESLint rule** (`.eslintrc.cjs`) — flags any occurrence of the banned identifiers above in `src/` and `bin/`.
- **Consumer-smoke harness** (`harness/consumer-smoke/`) — a fresh `npm install moflo` in a scratch consumer project asserts `fastembed` is present and no banned identifiers leak into the published `dist/` tree.

### 6. CI model cache

`actions/cache@v4` caches `~/.cache/fastembed` across CI runs (this ADR, epic #527, story #534). First CI run warms the cache; subsequent runs on the same lockfile skip the ~90 MB model download.

## Consequences

### Positive

- **Semantic search actually works.** Every consumer install gets real 384-dim neural embeddings by default, not hash pseudo-vectors.
- **Smaller JS footprint.** `@xenova/transformers` (45 MB) → `fastembed` (109 KB). Net JS payload drops dramatically.
- **Maintained upstream.** `fastembed` is actively developed; `@xenova/transformers` is archived.
- **Hard-fail guarantees.** Missing model, broken network on first run, or a misconfigured provider produces a user-visible error instead of silent quality degradation.
- **Regression-proof.** ESLint + smoke harness together block any future PR that re-adds the banned identifiers.
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
- `src/modules/embeddings/src/fastembed-embedding-service.ts` — production service
- `harness/consumer-smoke/lib/checks.mjs` — banned-identifier + required-dep guard
- `scripts/prune-native-binaries.mjs` — platform-specific ONNX prune
