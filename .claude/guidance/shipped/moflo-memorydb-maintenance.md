# Memory Database Maintenance

**Purpose:** How to inspect, reindex, and recover the moflo memory database. Reference this when memory search returns empty results, embeddings look stale, or you need to purge a namespace before re-running an indexer.

---

## Database Location

- **Path:** `.moflo/moflo.db` — canonical location
- **Engine:** `node:sqlite` (built into Node 22+) running in WAL mode — multi-process safe via POSIX/Windows file locks. The sql.js (WASM) backend is no longer used and the npm dep is being removed.
- **Single table:** `memory_entries` — stores content, embeddings, and metadata in one table
- **WAL sidecars:** `.moflo/moflo.db-wal` + `.moflo/moflo.db-shm` appear next to `moflo.db` after the first write. Don't commit them; don't manually delete them while moflo is running.
- **Legacy path:** `.swarm/memory.db` — older consumers may still have this. The launcher migrates it to `.moflo/moflo.db` automatically on session start. After migration the legacy file is renamed `.swarm/memory.db.bak` and is safe to delete once you've verified the canonical DB is healthy (`flo doctor`).

## Network filesystem caveat

SQLite's multi-process safety relies on POSIX/Windows file locking and on shared-memory WAL sidecars. **Neither works reliably on network-mounted filesystems** — NFS, SMB/CIFS, sshfs, and some FUSE mounts silently break advisory locks and refuse to map the `.db-shm` shared-memory region. If `.moflo/moflo.db` lives on a network mount, two moflo processes can clobber each other's writes and you may see partial-row corruption.

On first open against a non-WAL-capable filesystem moflo emits a one-line stderr warning naming the path:

```
[moflo] WARNING: SQLite journal_mode=delete on /mnt/network/proj/.moflo/moflo.db (WAL not active).
If this directory is on NFS/SMB or another network filesystem, POSIX advisory locks are unreliable
and concurrent moflo processes can corrupt the database. Move the project to a local disk to
restore multi-process safety.
```

The warning is deduplicated per path per process. If you see it: move the project (or just the `.moflo/` directory) onto a local disk. There is no in-product workaround — single-machine SQLite cannot be made safe over a remote filesystem.

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

Use the backend factory so you get the same engine + WAL semantics every other writer uses:

```js
node --input-type=module -e "
import { openBackend } from 'moflo/bin/lib/get-backend.mjs';

const db = await openBackend(process.cwd(), { create: false });

const before = db.exec('SELECT namespace, COUNT(*) FROM memory_entries GROUP BY namespace');
console.log('BEFORE:', JSON.stringify(before[0]?.values));

db.run(\"DELETE FROM memory_entries WHERE namespace = 'code-map'\");

const after = db.exec('SELECT namespace, COUNT(*) FROM memory_entries GROUP BY namespace');
console.log('AFTER:', JSON.stringify(after[0]?.values));

db.save();
db.close();
"
```

Under node:sqlite the `db.save()` call is a no-op (WAL persists incrementally), but the factory keeps the API parity so the same snippet works against any backend the factory currently knows about. Concurrent writers serialize through WAL — running this while the daemon is up no longer clobbers anything — but if you want to be defensive, `flo daemon stop` before purging is still the cleanest sequence.

After purging, reindex the namespace and rebuild embeddings:
```bash
node bin/generate-code-map.mjs   # or whichever indexer owns the namespace
node bin/build-embeddings.mjs
```

## Auto-Reindex on Session Start

`hooks.mjs` spawns `index-all.mjs` on session start, which runs the full chain. The session-start launcher syncs the indexer scripts into `.claude/scripts/` on every version change so the chain always points at current code.

## Recovering From a Legacy DB

If you find an older `.swarm/memory.db` (or a post-upgrade `.swarm/memory.db.bak`) with learnings/knowledge entries that didn't migrate cleanly, cherry-pick them into the canonical DB:

```bash
flo memory restore-learnings --from .swarm/memory.db
flo memory restore-learnings --from .swarm/memory.db.bak
```

## Troubleshooting

- **Empty search results:** Run `mcp__moflo__memory_stats` to check entry counts. If a namespace is empty, run its indexer.
- **Stale embeddings:** Run `node bin/build-embeddings.mjs` — it skips entries that already have embeddings unless content changed.
- **Wrong DB path used by tools:** Run `flo doctor` — it reports both canonical and legacy paths and flags drift.
- **Full reset:** Stop the daemon, delete `.moflo/moflo.db`, then run `node bin/index-all.mjs && node bin/build-embeddings.mjs`.

---

## See Also

- `.claude/guidance/moflo-memory-strategy.md` — When to use which namespace; semantic search query patterns
- `.claude/guidance/moflo-core-guidance.md` — `flo memory` CLI subcommands and `flo doctor` output
- `.claude/guidance/moflo-subagents.md` — Memory-first protocol that depends on these indexes being healthy
