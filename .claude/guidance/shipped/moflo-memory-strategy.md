# Memory & Semantic Search Strategy

**Purpose:** How memory, embeddings, and semantic search work in moflo. Reference when debugging search quality, configuring memory for a project, or extending the indexing pipeline. Authoring rules for guidance docs themselves live in `.claude/guidance/moflo-guidance-rules.md` — read those first.

---

## Architecture Overview

Source files (`.claude/guidance/*.md`, `docs/**/*.md`, code, tests) flow through four stages:

1. **Index** — `bin/index-*.mjs` chunks markdown on `##` headers and walks code/tests for structural facts
2. **Store** — entries land in `.moflo/moflo.db` (SQLite via Node 22's built-in `node:sqlite`) with metadata + RAG links
3. **Embed** — `bin/build-embeddings.mjs` generates 384-dim vectors via `fastembed` (mandatory, see ADR-EMB-001)
4. **Search** — `mcp__moflo__memory_search` (preferred), `npx flo memory search` (fallback), or `npx flo-search` (verbose) hit an HNSW index for nearest-neighbor lookup

| File | Purpose |
|------|---------|
| `.moflo/moflo.db` | SQLite DB — entries, embeddings, metadata |
| `.moflo/neural/patterns.json` | ReasoningBank learned patterns |
| `bin/index-guidance.mjs` | Indexes guidance with RAG linking |
| `bin/generate-code-map.mjs` | Structural code map (projects, dirs, types) |
| `bin/index-patterns.mjs` | Per-file code patterns |
| `bin/index-tests.mjs` | Test structure |
| `bin/index-all.mjs` | Runs the full chain sequentially |
| `bin/build-embeddings.mjs` | Generates 384-dim vectors |

---

## Namespaces

| Namespace | Content | Indexed By |
|-----------|---------|------------|
| `guidance` | Markdown guidance and docs | `index-guidance.mjs` |
| `code-map` | Structural codebase index (projects, dirs, types, interfaces) | `generate-code-map.mjs` |
| `patterns` | Per-file code patterns (services, routes, exports) | `index-patterns.mjs` |
| `tests` | Test structure and patterns | `index-tests.mjs` |
| `learnings` | User-stored patterns from work sessions | `mcp__moflo__memory_store` |

Namespaces are independent indexes. Search defaults to `all`; pass `namespace: "guidance"` to target one.

---

## Embedding Strategy

**Model:** `fast-all-MiniLM-L6-v2` via `fastembed` (Qdrant's ONNX client). 384-dim, L2-normalized vectors. ~3 s for 1000 entries.

**Mandatory.** Hash-based fallback was removed (ADR-EMB-001) — if `fastembed` cannot load, memory operations fail loudly rather than silently degrading. Model auto-downloads to `~/.cache/fastembed` on first use; for offline / sandboxed runs pre-populate the cache or set `FASTEMBED_CACHE`.

**Legacy aliases.** Entries embedded by earlier moflo versions may be tagged `Xenova/all-MiniLM-L6-v2` or `onnx`. They share the same vector space and are treated as compatible at search time (`semantic-search.mjs` `COMPATIBLE_MODELS`).

**Embedding alignment is critical.** Query embeddings MUST match stored embeddings — cosine similarity across model families produces meaningless scores. Both the search scripts and the MCP memory tools use `fastembed` for queries and filter stored entries by `embedding_model`.

---

## RAG Indexing Pipeline

`index-guidance.mjs`:

1. Scan configured directories for `.md` files
2. Hash check — skip files whose content hash hasn't changed (`--force` overrides)
3. Store the full document as `doc-{prefix}-{name}` for complete retrieval
4. Chunk on `##` headers — each H2 becomes a separate entry
5. H3 subsections become child chunks with the parent H2 as context prefix
6. Force-split sections over 4000 chars on paragraph boundaries
7. Build RAG metadata (`parentDoc`, `prevChunk`, `nextChunk`, `siblings`, `hierarchicalParent/Children`, `contextBefore/After`)
8. Prepend 20% overlapping context from neighbors
9. Stale-cleanup pass — drop entries for files no longer on disk
10. Spawn `build-embeddings.mjs` to vectorize new entries

**Configuration in `moflo.yaml`:**

```yaml
guidance:
  directories:
    - .claude/guidance
    - docs/guides
```

Default (when no config): `.claude/guidance`, `docs/guides`. Moflo also auto-indexes its own bundled guidance from `node_modules/moflo/.claude/guidance/` when installed as a dependency.

---

## Search Commands

All entry points auto-detect the stored model and generate matching query vectors.

**MCP (preferred):** `mcp__moflo__memory_search` — `query`, `namespace`, `limit`, `threshold`.

**CLI (fallback):**
```bash
npx flo memory search --query "your query" --namespace guidance --limit 5 --threshold 0.3
```

**Code map search.** When you need to find where a type, service, entity, or component lives, search `code-map` BEFORE Glob/Grep:

| Chunk prefix | Answers |
|--------------|---------|
| `project:` | "What's in the api project?" |
| `dir:` | "What types are in entities/?" |
| `iface-map:` | "What implements IPaymentService?" |
| `type-index:` | "Where is Service defined?" |

Use `mcp__moflo__memory_search` with `namespace: "code-map"`.

---

## Session Start Indexing

On every session start, `hooks.mjs` spawns `index-all.mjs`, which runs the full chain incrementally — files whose hash hasn't changed are skipped. Use `--force` to reindex everything.

| Indexer | Namespace |
|---------|-----------|
| `index-guidance.mjs` | `guidance` |
| `generate-code-map.mjs` | `code-map` |
| `index-tests.mjs` | `tests` |
| `index-patterns.mjs` | `patterns` |
| `build-embeddings.mjs` | (generates vectors for any unembedded entries) |

---

## Writing Guidance That Indexes Well

Authoring rules — Purpose line, imperative voice, 5–30-line H2 sections, decision tables, no decorative headings, See Also block — live in `.claude/guidance/moflo-guidance-rules.md`. Follow that file when writing or editing any guidance.

The retrieval-specific rules below only apply to docs you want surfaced via `memory_search`:

| Signal | Why it matters |
|--------|----------------|
| `**Purpose:**` line after H1 | First chunk of every doc; primary relevance signal |
| Domain-specific H2 headings (`## JWT Authentication Pattern`, not `## Pattern`) | Heading text is the chunk's embedding anchor |
| 1000–4000 char H2 sections | Below 50 chars chunks are dropped; above 6000 chars get force-split mid-thought |
| Self-contained H2 sections | Each chunk must answer a question without the surrounding doc |
| Tables over prose for decisions | Structured data parses more reliably than paragraphs |
| Cross-references in See Also | Builds the navigation graph (`prevChunk`/`nextChunk`/`siblings`) |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Search returns irrelevant results | Query/stored embedding model mismatch (legacy entry) | Auto-detected; verify with `npx flo-search --verbose` |
| Low similarity scores | Query missing domain terms | Include domain keywords in the query |
| `"Vector: No"` in `memory_list` | Entry lacks embedding | Run `node bin/build-embeddings.mjs` |
| Entries not found after editing a file | Indexer hasn't run yet | Restart session or `node bin/index-all.mjs` |
| Bundled moflo guidance not indexed | Running inside the moflo repo (same dir) | Bundled guidance only indexes when installed as a dependency |
| Empty namespace | Indexer never ran or DB was purged | See `.claude/guidance/moflo-memorydb-maintenance.md` |
| Embeddings fail offline | `fastembed` model cache missing | Pre-populate `~/.cache/fastembed` or set `FASTEMBED_CACHE` (see `docs/modules/embeddings.md`) |

---

## See Also

- `.claude/guidance/moflo-memorydb-maintenance.md` — Database location, schema, purge/reindex procedures
- `.claude/guidance/moflo-guidance-rules.md` — Universal authoring rules every guidance doc must follow
- `.claude/guidance/moflo-subagents.md` — Memory-first subagent protocol that uses these search paths
- `.claude/guidance/moflo-claude-swarm-cohesion.md` — Task & swarm coordination layered on top of memory
- `.claude/guidance/moflo-core-guidance.md` — Full CLI/MCP reference and Auto-Learning protocol
