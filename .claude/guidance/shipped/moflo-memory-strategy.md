# Memory & Semantic Search Strategy

**Purpose:** How memory, embeddings, and semantic search work in moflo. Reference when writing guidance documents, debugging search quality, configuring memory for a consumer project, or extending the system.

---

## Problem Statement

Claude Code agents need project-specific knowledge — coding rules, architecture patterns, entity templates, testing conventions — delivered at the right moment. Without a retrieval system, agents either miss critical rules or require massive CLAUDE.md files that waste context window tokens.

**Goals:**
- Agents find relevant guidance automatically via semantic search
- Subagents spawned by the coordinator inherit memory access
- Search quality is high enough that agents don't need to read whole files
- The system survives `npm install` (indexing runs on session start)

---

## Architecture Overview

```
Source Files (.claude/guidance/*.md, docs/*.md)
         |
         v
index-guidance.mjs --- Chunk on ## headers, build RAG links
         |                (prev/next, siblings, parent/child, context overlap)
         v
.swarm/memory.db ----- SQLite (entries + metadata + embedding vectors)
         |
         v
build-embeddings.mjs - Generate 384-dim vectors per entry
         |                (Xenova/all-MiniLM-L6-v2 neural, or domain-aware hash fallback)
         v
HNSW index ----------- Approximate nearest-neighbor search
         v
Search layer ---------- Three access paths:
                          1. MCP tools (mcp__moflo__memory_search) -- preferred
                          2. CLI (npx flo memory search) -- fallback
                          3. Script (semantic-search.mjs) -- detailed output
```

**Key files:**

| File | Purpose |
|------|---------|
| `.swarm/memory.db` | SQLite database with all entries, embeddings, metadata |
| `.swarm/code-map-hash.txt` | SHA-256 hash for incremental code map skip |
| `.claude-flow/neural/patterns.json` | ReasoningBank learned patterns |
| `bin/build-embeddings.mjs` | Generates 384-dim embeddings |
| `bin/index-guidance.mjs` | Indexes guidance files with RAG linking |
| `bin/generate-code-map.mjs` | Generates structural code map (projects, dirs, types, interfaces) |
| `bin/index-patterns.mjs` | Extracts per-file code patterns |
| `bin/index-tests.mjs` | Indexes test structure and patterns |
| `bin/index-all.mjs` | Runs the full indexing chain sequentially |

---

## Namespaces

| Namespace | Content | Indexed By |
|-----------|---------|------------|
| `guidance` | Indexed guidance and docs | `index-guidance.mjs` |
| `code-map` | Structural codebase index (projects, directories, types, interfaces) | `generate-code-map.mjs` |
| `patterns` | Per-file code patterns (services, routes, error handling, exports) | `index-patterns.mjs` |
| `tests` | Test structure and patterns | `index-tests.mjs` |

---

## Guidance Document Optimization Rules

These rules determine how well your guidance documents retrieve via semantic search:

### 1. Every file needs a Purpose line

Add `**Purpose:**` as the first meaningful line after the title. Claude checks this first for relevance scoring. Without it, the chunk has no summary signal.

### 2. H2 headings are the primary retrieval signal

The indexer splits on `##`. Each heading becomes the chunk title, prepended to searchable content. Domain-specific keywords in headings dramatically improve recall.

**Bad:** `## Overview`, `## Rules`, `## Pattern`
**Good:** `## Soft Delete Rules`, `## JWT Authentication Pattern`, `## Database Entity Migration`

### 3. Ideal chunk size: 1000-4000 characters

Below 50 chars the chunk is dropped. Above 6000 the indexer force-splits on paragraphs, which breaks mid-thought. The sweet spot produces focused embeddings.

### 4. Self-contained chunks

Each H2 section must answer a question without needing the rest of the document. Include: the rule, a code example, and a cross-reference.

### 5. Tables over prose

Claude parses structured data more accurately than paragraphs. DO/DON'T tables, field reference tables, and command tables all retrieve better.

### 6. Cross-references create a navigation graph

The RAG indexer stores `prevChunk`/`nextChunk`/`siblings` metadata. Cross-references between documents let Claude follow chains: `core.md -> coding-rules.md -> database.md`.

### 7. No decorative formatting

ASCII boxes, excessive emoji, rhetorical questions, and motivational text all waste tokens without improving retrieval or comprehension.

---

## Embedding Strategy

### Embedding Models

| Model | Quality | Speed | When Used |
|-------|---------|-------|-----------|
| `Xenova/all-MiniLM-L6-v2` | High (true semantic) | ~3s for 1000 entries | Primary — `build-embeddings.mjs` uses this |
| `domain-aware-hash-v1` | Good (domain clustering) | <1s for 1000 entries | Fallback when Transformers.js unavailable |

**Neural embeddings (Xenova/all-MiniLM-L6-v2):**
- Uses `@xenova/transformers` with ONNX WASM runtime
- 384-dimensional vectors, L2-normalized
- True semantic understanding — "soft delete" matches "mark as deleted" without keyword overlap
- Loaded lazily on first use, cached for subsequent queries

**Domain-aware hash embeddings (fallback):**
- Custom SimHash-style algorithm with 12 domain clusters
- Multi-position hashing with bigram/trigram features
- Good at keyword-level matching but misses semantic paraphrases
- No external dependencies — always available

### The Embedding Alignment Problem

**Critical rule:** Query embeddings MUST match stored embeddings. Computing cosine similarity between vectors from different models produces meaningless scores.

Both the search scripts and the MCP memory tools auto-detect the stored embedding model and generate matching query vectors. Search also filters out entries with mismatched `embedding_model`.

### Domain Cluster Tuning

The hash fallback's domain clusters can be extended with project-specific terms:

| Cluster | Example Terms |
|---------|--------------|
| `database` | your ORM, database engine, schema terms |
| `frontend` | UI framework, component library terms |
| `backend` | DI container, API framework terms |
| `testing` | test framework, assertion library terms |
| `security` | auth system, permission model terms |

---

## RAG Indexing Pipeline

### How `index-guidance.mjs` Works

1. **Scan** configured directories for `.md` files
2. **Hash check** — Skip files whose content hash hasn't changed (unless `--force`)
3. **Store full document** as `doc-{prefix}-{name}` (for complete retrieval)
4. **Chunk on `##` headers** — Each H2 section becomes a separate entry
5. **H3 subsections** become child chunks with parent H2 as context prefix
6. **Force-split** sections over 4000 chars on paragraph boundaries
7. **Build RAG metadata** for every chunk:

| Metadata Field | Purpose |
|---------------|---------|
| `parentDoc` | Link back to full document |
| `prevChunk` / `nextChunk` | Sequential navigation |
| `siblings` | All chunk keys from same document |
| `hierarchicalParent` / `hierarchicalChildren` | H2->H3 relationships |
| `contextBefore` / `contextAfter` | 20% overlapping text from adjacent chunks |

8. **Prepend context** — Each chunk's searchable content includes overlap from neighbors
9. **Stale cleanup** — After indexing, remove entries for files that no longer exist on disk
10. **Background embedding** — Spawn `build-embeddings.mjs` to generate vectors

### Configuring Indexed Directories

In `moflo.yaml`:

```yaml
guidance:
  directories:
    - .claude/guidance
    - docs/guides
```

Default directories (when no config): `.claude/guidance`, `docs/guides`

Moflo also automatically indexes its own bundled guidance from `node_modules/moflo/.claude/guidance/` when installed as a dependency.

---

## Search Commands

All methods auto-detect the stored embedding model and generate matching query vectors:

**MCP (Preferred):** `mcp__moflo__memory_search` — `query: "your query", namespace: "guidance"`

**CLI (Fallback):**
```bash
npx flo memory search --query "your query" --namespace guidance
```

**Search options:**

| Flag | Default | Purpose |
|------|---------|---------|
| `--namespace` | all | Filter to specific namespace |
| `--limit` | 5 | Number of results |
| `--threshold` | 0.3 | Minimum similarity score |
| `--json` | false | Output as JSON |

### Code Map Search (for codebase navigation)

When you need to find where a type, service, entity, or component lives — search `code-map` BEFORE using Glob/Grep:

**MCP:** `mcp__moflo__memory_search` — `query: "payment service", namespace: "code-map"`

**What code-map contains:**

| Chunk prefix | What it answers |
|--------------|-----------------|
| `project:` | "What's in the api project?" |
| `dir:` | "What types are in the entities directory?" |
| `iface-map:` | "What implements IPaymentService?" |
| `type-index:` | "Where is Service defined?" |

---

## Session Start Indexing

On every session start, `hooks.mjs` spawns `index-all.mjs` which runs the full chain:

| Indexer | Namespace | What it does |
|---------|-----------|--------------|
| `index-guidance.mjs` | `guidance` | Chunks markdown, builds RAG links |
| `generate-code-map.mjs` | `code-map` | Scans source for types, interfaces, directories |
| `index-tests.mjs` | `tests` | Indexes test structure |
| `index-patterns.mjs` | `patterns` | Extracts per-file code patterns |
| `build-embeddings.mjs` | all | Generates vectors for any unembedded entries |

Indexing is incremental by default — files whose content hash hasn't changed are skipped. Use `--force` to reindex everything.

---

## Replication Guide

To set up this system in a new project:

```bash
npm install moflo
npx flo init
```

Create `.claude/guidance/` with markdown files following the optimization rules above, then:

```bash
npx flo-index --force                                              # Index documents
npx flo memory search --query "your domain query" --namespace guidance  # Verify
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Search returns irrelevant results | Query/stored embedding model mismatch | Auto-detected now; verify with `--verbose` flag |
| Low similarity scores | Query doesn't match domain terms | Include domain keywords in query |
| "Vector: No" in list | Entry lacks embedding | Run `node bin/build-embeddings.mjs` |
| Entries not found after adding file | Indexer hasn't run yet | Run `node bin/index-all.mjs` or restart session |
| Bundled moflo guidance not indexed | Not installed as dependency | Only indexes when `node_modules/moflo/.claude/guidance/` exists |
| Empty namespace | Indexer never ran or DB was purged | See `moflo-memorydb-maintenance.md` for reindex/purge procedures |

---

## See Also

- `moflo-memorydb-maintenance.md` — Database location, schema, purge/reindex procedures
- `moflo-subagents.md` — Subagents guide
- `moflo-claude-swarm-cohesion.md` — Task & swarm coordination
- `moflo-core-guidance.md` — Full CLI/MCP reference
