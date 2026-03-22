# Memory & Semantic Search Strategy

**Purpose:** How memory, embeddings, and semantic search work in moflo. Reference when debugging memory issues, understanding the search pipeline, or configuring memory for a consumer project.

---

## Architecture Overview

```
Source Files (.claude/guidance/, docs/)
         |
         v
index-guidance.mjs (chunking, RAG linking)
         |
         v
.swarm/memory.db (SQLite - entries + metadata)
         |
         v
build-embeddings.mjs (384-dim neural or hash vectors)
         |
         v
Search layer (cosine similarity - MCP, CLI, or script)
```

---

## Key Files

| File | Purpose |
|------|---------|
| `.swarm/memory.db` | SQLite database with all entries, embeddings, metadata |
| `.swarm/code-map-hash.txt` | SHA-256 hash for incremental code map skip |
| `.claude-flow/neural/patterns.json` | ReasoningBank learned patterns |
| `bin/build-embeddings.mjs` | Generates 384-dim embeddings |
| `bin/index-guidance.mjs` | Indexes guidance files with RAG linking |
| `bin/generate-code-map.mjs` | Generates structural code map (projects, dirs, types, interfaces) |

---

## Embedding Strategy

**Primary model:** `Xenova/all-MiniLM-L6-v2` (384-dim, neural — used by `build-embeddings.mjs`)
**Fallback model:** `domain-aware-hash-v1` (384-dim, hash — used when Transformers.js unavailable)

**Critical rule:** Query embeddings MUST match stored embeddings. Both the search scripts and MCP tools auto-detect the stored model and generate matching query vectors. Cross-model cosine similarity is meaningless.

**Neural embeddings (primary):**
- Uses `@xenova/transformers` with ONNX WASM runtime
- True semantic understanding — "soft delete" matches "mark as deleted" without keyword overlap
- ~3s for 1000 entries, loaded lazily and cached

**Domain-aware hash (fallback):**
- 12 domain clusters with project-specific terms
- SimHash-style word encoding + bigram/trigram features
- Good keyword-level matching, misses semantic paraphrases
- No external dependencies — always available, <1s for 1000 entries

See `guidance-memory-strategy.md` for full embedding pipeline details.

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

**Regenerate:**
```bash
npx flo-codemap          # Incremental (skips if unchanged)
npx flo-codemap --force  # Full rebuild
```

---

## Database Schema

```sql
memory_entries (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,           -- e.g., "chunk-guidance-core-0"
  namespace TEXT,              -- "guidance", "patterns", "default"
  content TEXT,                -- Full text content
  embedding TEXT,              -- JSON array of 384 floats
  embedding_model TEXT,        -- "Xenova/all-MiniLM-L6-v2" or "domain-aware-hash-v1"
  embedding_dimensions INTEGER,-- 384
  metadata TEXT,               -- JSON: parentDoc, chunkTitle, prevChunk, nextChunk, siblings
  tags TEXT,                   -- JSON array
  status TEXT,                 -- "active"
  created_at INTEGER,
  updated_at INTEGER
)
```

---

## RAG Linking (metadata fields)

Each chunk includes navigation metadata:

| Field | Purpose |
|-------|---------|
| `parentDoc` | Key of full document (e.g., `doc-guidance-core`) |
| `prevChunk` | Previous chunk key for sequential reading |
| `nextChunk` | Next chunk key |
| `siblings` | All chunk keys from same document |
| `hierarchicalParent` | H2 parent for H3 chunks |
| `hierarchicalChildren` | H3 children for H2 chunks |
| `contextBefore` | Overlapping text from previous chunk (20%) |
| `contextAfter` | Overlapping text from next chunk (20%) |

---

## Namespaces

| Namespace | Content | Notes |
|-----------|---------|-------|
| `guidance` | Indexed guidance and docs | Largest — includes bundled moflo guidance |
| `code-map` | Structural codebase index (projects, directories, types, interfaces) | Search BEFORE Glob/Grep for navigation |
| `patterns` | Learned patterns from sessions | Grows over time |
| `default` | Misc stored data | Small |

---

## Session Start Indexing

On every session start, moflo automatically runs three background indexers:

| Indexer | Command | Namespace | What it does |
|---------|---------|-----------|--------------|
| Guidance | `npx flo-index` | `guidance` | Chunks markdown, builds RAG links, generates embeddings |
| Code Map | `npx flo-codemap` | `code-map` | Scans source for types, interfaces, directories |
| Learning | `npx flo-learn` | `patterns` | Pattern research on codebase |

These are configured in the `SessionStart` hook in `.claude/settings.json` (set up by `npx flo init`).

Indexing is incremental by default — files whose content hash hasn't changed are skipped. Use `--force` to reindex everything.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Search returns irrelevant results | Query/stored embedding model mismatch | Auto-detected now; verify with `--verbose` flag |
| Low similarity scores | Query doesn't match domain terms | Include domain keywords in query |
| "Vector: No" in list | Entry lacks embedding | Run `npx flo-index --force` |
| Entries not found after adding file | Indexer hasn't run yet | Run `npx flo-index` or restart session |
| Bundled moflo guidance not indexed | Not installed as dependency | Only indexes when `node_modules/moflo/.claude/guidance/` exists |

---

## Verification Commands

```bash
# Test semantic search
npx flo memory search --query "database entity pattern" --namespace guidance

# Force reindex all guidance
npx flo-index --force

# Force rebuild embeddings
npx flo-index --force

# Check entry count (requires better-sqlite3 or sql.js)
npx flo memory list --namespace guidance --limit 0
```

---

## See Also

- `.claude/guidance/guidance-memory-strategy.md` - RAG system tuning guide
- `.claude/guidance/agent-bootstrap.md` - Subagent bootstrap guide
- `.claude/guidance/moflo.md` - Full CLI/MCP reference
