# Memory Database Maintenance

## Database Location

- **Path:** `.swarm/memory.db`
- **Engine:** sql.js (WASM-based SQLite — no native binaries needed)
- **Single table:** `memory_entries` — stores content, embeddings, and metadata in one table

## Schema

```sql
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  namespace TEXT DEFAULT 'default',
  content TEXT NOT NULL,
  type TEXT DEFAULT 'semantic',
  embedding TEXT,           -- inline vector (no separate embeddings table)
  embedding_model TEXT DEFAULT 'local',
  embedding_dimensions INTEGER,
  tags TEXT,
  metadata TEXT,
  owner_id TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  expires_at INTEGER,
  last_accessed_at INTEGER,
  access_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  UNIQUE(namespace, key)
);
```

## Namespaces

| Namespace | Indexed By | Key Patterns | Purpose |
|-----------|-----------|--------------|---------|
| `code-map` | `generate-code-map.mjs` | `file:{path}`, `dir:{path}`, `type-index:{n}` | Codebase navigation |
| `guidance` | `index-guidance.mjs` | `chunk-guidance-*` | Governance docs, shipped guidance |
| `patterns` | `index-patterns.mjs` | `pattern:file:{path}`, `pattern:service:{name}`, `pattern:route:{path}`, `pattern:error:{path}` | Per-file code patterns |
| `tests` | `index-tests.mjs` | test-related keys | Test structure and patterns |

## MCP Tools

| Tool | Use |
|------|-----|
| `mcp__moflo__memory_search` | Semantic search (HNSW-accelerated) |
| `mcp__moflo__memory_store` | Store/upsert entries |
| `mcp__moflo__memory_delete` | Delete single entry by key |
| `mcp__moflo__memory_stats` | Namespace counts and HNSW index status |
| `mcp__moflo__memory_list` | List keys in a namespace |

## Reindex Commands

```bash
# Full reindex (guidance → code-map → tests → patterns → pretrain → HNSW rebuild)
node bin/index-all.mjs

# Individual indexers
node bin/index-guidance.mjs
node bin/generate-code-map.mjs
node bin/index-tests.mjs
node bin/index-patterns.mjs          # --force for full reindex, --stats for counts

# Rebuild embeddings (vectorize all entries)
node bin/build-embeddings.mjs
```

## Purging a Namespace

Use sql.js directly (no sqlite3 binary on this machine):

```js
node --input-type=module -e "
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync } from 'fs';

const SQL = await initSqlJs();
const buf = readFileSync('.swarm/memory.db');
const db = new SQL.Database(buf);

// Check counts before
const before = db.exec('SELECT namespace, COUNT(*) FROM memory_entries GROUP BY namespace');
console.log('BEFORE:', JSON.stringify(before[0]?.values));

// Purge a namespace (embeddings are inline — no separate table to clean)
db.run(\"DELETE FROM memory_entries WHERE namespace = 'code-map'\");

const after = db.exec('SELECT namespace, COUNT(*) FROM memory_entries GROUP BY namespace');
console.log('AFTER:', JSON.stringify(after[0]?.values));

writeFileSync('.swarm/memory.db', Buffer.from(db.export()));
db.close();
"
```

After purging, reindex the namespace and rebuild embeddings:
```bash
node bin/generate-code-map.mjs   # or whichever indexer owns the namespace
node bin/build-embeddings.mjs
```

## Auto-Reindex on Session Start

`hooks.mjs` spawns `index-all.mjs` on session start, which runs the full chain. This only works if `index-all.mjs` is in the `scriptFiles` array in `session-start-launcher.mjs` (see docs/BUILD.md § "Adding New Scripts").

## Troubleshooting

- **Empty search results:** Run `mcp__moflo__memory_stats` to check entry counts. If a namespace is empty, run its indexer.
- **Stale embeddings:** Run `node bin/build-embeddings.mjs` — it skips entries that already have embeddings unless content changed.
- **Full reset:** Delete `.swarm/memory.db` and run `node bin/index-all.mjs && node bin/build-embeddings.mjs`.
