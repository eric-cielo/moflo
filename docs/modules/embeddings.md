# cli/embeddings

> **Inlined into `@moflo/cli` by [#592](https://github.com/eric-cielo/moflo/issues/592)** (epic [#586](https://github.com/eric-cielo/moflo/issues/586) / [ADR-0001](../adr/0001-collapse-moflo-workspace-packages.md)). The `@moflo/embeddings` workspace package no longer exists — its contents live at `src/cli/embeddings/` and ship inside the `moflo` tarball.

`fastembed`-backed neural embeddings with persistent caching, document chunking, normalization, and hyperbolic embeddings. Used internally by cli, hooks, and memory; not exported as a separate npm package.

## Where things live

| Concern | Path |
|---------|------|
| Source | `src/cli/embeddings/` |
| Public surface | `src/cli/embeddings/index.ts` (named exports) |
| Tests | `src/cli/__tests__/embeddings/` |
| ADR (neural mandatory) | [ADR-EMB-001](../adr/ADR-EMB-001-neural-embeddings-mandatory.md) |
| Float32Array audit | [docs/audits/2026-04-23-float32array-producers.md](../audits/2026-04-23-float32array-producers.md) |

## Core capabilities

- `fastembed` default — ONNX-based neural embeddings (Qdrant's `fastembed`, native Rust tokenizer, 384-dim `all-MiniLM-L6-v2`). Neural-only — no hash fallback (epic #527 / ADR-EMB-001).
- OpenAI opt-in via `provider: 'openai'` for cloud embeddings.
- LRU + SQLite persistent cache with TTL.
- Batch embedding with partial cache hits.
- Cosine / Euclidean / dot-product similarity helpers.
- Document chunking (character, sentence, paragraph, token strategies with overlap).
- Normalization (L2 / L1 / min-max / z-score).
- Hyperbolic embeddings (Poincaré ball) for hierarchical representations.
- Resumable embeddings-version migration driver (`src/cli/embeddings/migration/`).

## Internal usage

```ts
// From any cli source file:
import {
  createEmbeddingService,
  cosineSimilarity,
  chunkText,
} from '../embeddings/index.js';

const service = createEmbeddingService({ provider: 'fastembed' });
const { embedding } = await service.embed('Hello world');
```

After the workspace-collapse epic (#586) memory and hooks now live inside cli, so they import embeddings via direct relative paths — the previous walk-up helpers (`locate-cli-embeddings.ts`) are gone.

## Why the rewrite

Pre-#592 framing claimed `@moflo/embeddings` was a separately publishable npm package. It wasn't — `npm view @moflo/embeddings` 404s, the workspace boundary was leftover Ruvnet/ruflo-fork text. ADR-0001 captures the full reasoning; #592 collapses embeddings as the third leaf in the topo order (after `aidefence` and `claims`).
