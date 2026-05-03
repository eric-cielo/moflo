# Guidance File Sync — Source to Consumer Search

**Purpose:** How shipped guidance flows from `node_modules/moflo/.claude/guidance/shipped/` into a consumer project's filesystem, into `.moflo/moflo.db`, and into HNSW search results — and how stale content is purged at every layer. Reference this whenever you add, remove, rename, or split a shipped guidance file, or whenever a consumer reports "old guidance is still showing up in search."

---

## The Three Sync Layers

The sync is a pipeline. A change to `shipped/` propagates through three layers; **a regression at any layer leaves consumers with stale or missing content.**

| Layer | What it owns | Updated by | Source file |
|-------|--------------|------------|-------------|
| Filesystem (consumer) | `.claude/guidance/shipped/*.md` and top-level `.claude/guidance/*.md` mirrors | `session-start-launcher.mjs` sections 3 + 3b | `bin/session-start-launcher.mjs` |
| Database | `memory_entries` rows in the `guidance` namespace (`doc-*` and `chunk-*` keys) | `bin/index-guidance.mjs` | `bin/index-guidance.mjs` |
| Vector index | `.moflo/moflo.hnsw` sidecar referenced by `mcp__moflo__memory_search` | `bin/build-embeddings.mjs` | `bin/build-embeddings.mjs` |

Every sync round runs all three on session start (when `auto_index.guidance: true`, the default).

---

## Layer 1 — Filesystem (launcher)

Two stages run, both inside `bin/session-start-launcher.mjs`:

**Section 3 (full sync, runs only on version change or manifest drift)** — copies every `*.md` in `node_modules/moflo/.claude/guidance/shipped/` into the consumer's `.claude/guidance/` (top-level mirror) and records each path in `currentManifest`. Then it diffs `previousManifest` (from `.moflo/installed-files.json`) against `currentManifest` and `unlinkSync`s anything that was installed last time but is no longer shipped. This is the authoritative removal path.

**Section 3b (restore + prune, runs every session)** — restores any missing top-level mirror that should exist (e.g., a user accidentally deleted one) and prunes any top-level `*.md` whose source no longer exists in `shipped/` AND whose first line begins with the `<!-- MOFLO:SESSION-START-MIRROR ` marker. The marker check protects user-authored files and the `moflo-bootstrap.md` (which uses a distinct `moflo init` marker).

| Change to `shipped/` | Section 3 effect | Section 3b effect |
|---------------------|------------------|-------------------|
| File added | New mirror written + path added to manifest | No-op (file exists) |
| File renamed | Old path unlinked via manifest diff; new path written | Catches the orphan if section 3 didn't run yet (no version bump) |
| File deleted | Manifest diff unlinks it | Marker-based prune catches pre-manifest installs |
| File content changed | Mirror rewritten with new content | No-op (file exists) |

**Pre-#843 consumers** (which never had `installed-files.json`) rely entirely on Section 3b's marker prune for cleanup; that's why the marker is non-negotiable. See `learning-launcher-guidance-mirror-pruning` in auto-memory for the historical fix.

---

## Layer 2 — Database (indexer)

`bin/index-guidance.mjs` walks every directory configured in `moflo.yaml`'s `guidance.directories` (default: `.claude/guidance`, `docs/guides`) and for each `*.md` file runs `indexFile()`.

**Per-file path (`indexFile`)** —

1. Hash the file content.
2. If the existing `doc-<keyPrefix>-<filename>` entry has the same hash and `--force` was not passed → SKIP (status: `unchanged`).
3. Otherwise: `deleteByPrefix(db, chunkPrefix)` — wipe **all** old chunks for this file.
4. Write the new doc entry + new chunks (chunked by H2 boundaries with overlap).
5. Record the doc key in `currentDocKeys` (the in-run set).

**End-of-run path (`cleanStaleEntries`)** — only when reindexing the full directory, not `--file <path>`:

1. Scan every `doc-*` key in the `guidance` namespace.
2. For any key not in `currentDocKeys` (i.e., the file no longer exists on disk) → DELETE that doc + every matching `chunk-*` row.
3. Sweep orphan keys not matching `doc-*` or `chunk-*` patterns.

| Change to a guidance file | `indexFile` does | `cleanStaleEntries` does |
|--------------------------|------------------|--------------------------|
| New file | Inserts doc + chunks | No-op |
| Same file, content changed | `deleteByPrefix(chunkPrefix)`, re-inserts new chunks (any size — handles SHRINK and GROW) | No-op |
| Same file, identical hash | Skip (unchanged) | No-op |
| File renamed | Old name doesn't exist → handled by `cleanStaleEntries`; new name → handled by `indexFile` | Deletes old doc + chunks |
| File deleted | Old name doesn't exist → not touched | Deletes old doc + chunks |

**The split-this-PR case** (`moflo-core-guidance.md` shrunk from 53 chunks to 26, two new files added 30 chunks) is the SHRINK + NEW-FILE path. Verified live: `chunk-guidance-moflo-core-guidance-*` count dropped from 53 → 26 in the same run that added 30 new chunks for the sibling docs.

---

## Layer 3 — HNSW sidecar (build-embeddings)

`bin/build-embeddings.mjs` runs after the indexer and:

1. Embeds every row with `embedding IS NULL OR embedding = ''`.
2. Calls `ensureHnswSidecar()` — rebuilds the `.moflo/moflo.hnsw` file when:
   - new embeddings were just written (`alwaysRebuild: true`), OR
   - the sidecar is missing, OR
   - `--force` was passed.

**Critical asymmetry:** a pure-deletion round (e.g., a guidance file was deleted, no new content embedded) does NOT trigger a sidecar rebuild. The sidecar keeps the deleted vector IDs.

**Why it's still safe at search time** — the search path in `src/cli/memory/moflo-db-adapter.ts:414` does:

```typescript
for (const { id, distance } of indexResults) {
  const entry = this.entries.get(id);
  if (!entry) continue;   // phantom skip — silently drops deleted IDs
  ...
}
```

The same guard exists in `src/cli/memory/infrastructure/repositories/hybrid-memory-repository.ts:303`. Search results stay correct; the cost is sidecar size drift over time. `flo doctor` flags `vectorCount` vs `withEmbeddings` divergence.

---

## End-to-End Consumer Flow

When a consumer runs `npm install moflo@<latest>` and starts a new Claude Code session:

1. **Launcher section 3** (version-bump branch) — refresh `.claude/guidance/` from new `shipped/`, prune retired files via manifest diff.
2. **Launcher section 3b** — restore any accidentally-deleted mirrors, marker-prune any pre-manifest orphans.
3. **Indexer (`auto_index.guidance: true`)** — for each remaining `*.md`, hash-check and re-chunk if changed; sweep stale `doc-*` entries from the DB.
4. **build-embeddings** — embed any new chunks, rebuild HNSW sidecar.
5. **MCP search** — phantom-skip filters guard against any straggling sidecar references.

The consumer experiences this as: open a session → wait for the indexers → search returns the new content, old content is gone.

---

## Verification Recipe

When you change `shipped/` (rename, split, delete, large rewrite), verify the cleanup ran by snapshotting the chunk counts before and after a reindex:

```bash
# BEFORE: snapshot chunk counts for the affected files
node --input-type=module -e "
import initSqlJs from 'sql.js';
import { readFileSync } from 'fs';
const SQL = await initSqlJs();
const db = new SQL.Database(readFileSync('.moflo/moflo.db'));
const r = db.exec(\"SELECT COUNT(*) FROM memory_entries WHERE namespace='guidance' AND key LIKE 'chunk-guidance-<file-stem>%'\");
console.log('chunks:', r[0]?.values[0][0]);
"

# Run the indexer
node bin/index-guidance.mjs

# AFTER: same query — confirm the count matches the new shape
```

If chunks remain after deletion, `cleanStaleEntries` did not run (likely `--file` mode) or the doc key is still appearing in `currentDocKeys` (the file is still on disk). If chunks dropped but search still returns the old content, the HNSW sidecar didn't rebuild — re-run with `node bin/build-embeddings.mjs --force`.

---

## Known Gaps

| Gap | Symptom | Mitigation |
|-----|---------|------------|
| HNSW sidecar growth on pure-delete rounds | `vectorCount > withEmbeddings`, sidecar size drifts up | Phantom-skip at search makes this latency-only; force-rebuild on next embedding round |
| `auto_index.guidance: false` | DB cleanup never runs in opt-out consumers | Documented in `moflo-yaml-reference.md`; consumers who flip this knob own the cleanup |
| `--file <path>` skips `cleanStaleEntries` | Single-file partial reindex won't sweep deletions | Intentional — partial-file mode shouldn't have authority to delete others; full session-start reindex is the cleanup vehicle |
| Pre-manifest installs | No `installed-files.json`, manifest diff can't reach old files | Section 3b marker prune handles this — the `<!-- MOFLO:SESSION-START-MIRROR ` marker is the stable identifier |

---

## See Also

- `.claude/guidance/internal/upgrade-contract.md` — the larger upgrade contract this sync sits inside; "user must never re-run init" depends on these three layers cooperating
- `.claude/guidance/internal/dogfooding.md` — why a sync regression bites moflo developers first (we are our own first consumer)
- `.claude/guidance/internal/guidance-rules.md` — how to write guidance docs that index well; chunk shape decisions feed Layer 2's chunking heuristics
- `.claude/guidance/shipped/moflo-memorydb-maintenance.md` — consumer-facing recovery commands (purge namespace, force reindex, restore from `.bak`)
- `.claude/guidance/shipped/moflo-memory-strategy.md` — namespace conventions and search query patterns the synced data feeds
- `.claude/guidance/shipped/moflo-session-start.md` — every launcher stage in execution order, including stages 3 and 3b documented above
- `.claude/guidance/shipped/moflo-settings-injection.md` — sibling self-heal contract for `.claude/settings.json` (analogous mechanism, different surface)
- `bin/session-start-launcher.mjs` — sections 3 and 3b implementation
- `bin/index-guidance.mjs` — `indexFile`, `cleanStaleEntries`, `deleteByPrefix`
- `bin/build-embeddings.mjs` — `ensureHnswSidecar` rebuild conditions
