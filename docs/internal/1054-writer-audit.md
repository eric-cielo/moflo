# #1054 Writer Audit — single-writer invariant (extends #981)

**Story:** #1055 (epic #1054 — sql.js multi-process clobber across upgrade boundary)
**Extends:** [docs/internal/981-writer-audit.md](./981-writer-audit.md)

## What changed since #981

#981's audit scoped to `src/cli/` and concluded that `bin/` migrations + indexers run "BEFORE long-lived sql.js consumers spawn" so were safe (Layer 4 — "no action needed"). That conclusion ships broken when **a stale daemon survives `npm install moflo@<new>`**: the pre-upgrade daemon keeps holding its own in-RAM sql.js snapshot, and any post-install `bin/` writer's flush is then clobbered by the daemon's stale snapshot on its next tick. Re-classify Layer 4 as **needs daemon-offline pattern** in S3 (#1057) — it is no longer safe-by-construction.

## Complete writer inventory

Three terminal dispositions — no fourth bucket. Each row must match an entry in `tests/system/fixtures/writer-audit-whitelist.json`.

### In-daemon (canonical sole writer when daemon is up)

Writes from inside the daemon process. The `MOFLO_IS_DAEMON=1` env var short-circuits the routing preamble so these don't recurse through HTTP.

| File:Line | Function | Notes |
|-----------|----------|-------|
| `src/cli/memory/memory-initializer.ts:1041,1259,1482,1879,2101,2540,2697` | Inner sql.js flush paths | Underlying writes used by chokepoint when running in-daemon |
| `src/cli/memory/sqlite-backend.ts:293,360,584` | node:sqlite backend write/persist | Underlying impl (replaced sqljs-backend in #1084; node:sqlite writes through the OS file handle so `persist()` is a no-op) |
| `src/cli/memory/bridge-core.ts:237` | Bridge atomic write | Bridge-internal, single-process |

### Daemon-RPC (cross-process writers route via `daemon-write-client`)

The chokepoint pattern from #985. When daemon is up, these route through HTTP to the daemon's single sql.js writer.

| File:Line | Caller | Why daemon-RPC | Existing wiring |
|-----------|--------|----------------|-----------------|
| `src/cli/memory/memory-initializer.ts:1890` | `storeEntry()` | Top-level writer | #985 preamble |
| `src/cli/memory/memory-initializer.ts:2066` | `storeEntries()` | Bulk variant | #985 preamble |
| `src/cli/memory/memory-initializer.ts:2491` | `deleteEntry()` | Top-level deleter | #985 preamble |
| `src/cli/mcp-tools/aidefence-moflodb-store.ts:48,92` | aidefence MCP store/delete | MCP-server process | #986 swap to chokepoint |
| `src/cli/mcp-tools/memory-tools.ts:175,232,425` | MCP `memory_*` handlers | MCP-server process | Funnels via chokepoint |
| `src/cli/swarm/swarm-persistence.ts:116,189` | Swarm coordinator | Cross-process | DI'd via chokepoint |
| `src/cli/swarm/message-bus/write-through-adapter.ts:147,162,209` | WriteThroughAdapter | Cross-process | DI'd via chokepoint |
| `src/cli/commands/memory.ts:1526,2233` | `flo memory store/delete` CLI | Subprocess | Funnels via chokepoint |
| **`src/cli/commands/doctor-checks-memory-access.ts:335`** | **Doctor neighbors-probe seed** | **In-session healer writes raw `db.export()`** | **MUST CHANGE — currently bypasses chokepoint; this is the #1053 / #1054 trigger surface** |

### Daemon-offline (launcher stops daemon → writer runs → launcher starts daemon)

Subprocess writers that operate on the on-disk DB. Per #1054, these MUST run with the daemon explicitly stopped — the "runs before daemon spawn" assumption breaks on upgrade when a stale daemon already exists.

| File:Line | Trigger | Current state |
|-----------|---------|---------------|
| `bin/migrations/strip-context-preambles.mjs:94` | Launcher pre-boot (§3e-1057) | ✓ Daemon-offline by ordering — runs before §4 daemon spawn (#1057) |
| `bin/migrations/purge-doc-entries.mjs:50` | Launcher pre-boot (§3e-1057) | ✓ Daemon-offline by ordering (#1057) |
| `bin/migrations/knowledge-purge.mjs:104` | Launcher pre-boot (§3e-1057) | ✓ Daemon-offline by ordering (#1057) |
| `bin/migrations/knowledge-to-learnings.mjs:122` | Launcher pre-boot (§3e-1057) | ✓ Daemon-offline by ordering (#1057) |
| `bin/build-embeddings.mjs:109,136` | Daemon worker spawn (`index-all`) | Mostly safe: indexer chain is sequential (#78 internal); cross-process race with daemon remains for follow-up |
| `bin/index-guidance.mjs:224` | Daemon worker spawn | ✓ Content-diff via `applyIncrementalChunks` (#1057, embedding-preserving) |
| `bin/index-tests.mjs:127` | Daemon worker spawn | ✓ Content-diff via `applyIncrementalChunks` |
| `bin/index-patterns.mjs:117` | Daemon worker spawn | ✓ Content-diff via `applyIncrementalChunks` |
| `bin/generate-code-map.mjs:150` | Daemon worker spawn | ✓ Content-diff via `applyIncrementalChunks` |
| `bin/lib/db-repair.mjs:92` | Launcher repair path | Needs daemon-stop verification |
| `src/cli/services/embeddings-migration.ts:152` | Launcher pre-boot (`runEmbeddingsMigrationIfNeeded`) | OK if pre-boot — needs S3 to verify daemon-offline guarantee post-upgrade |
| `src/cli/services/ephemeral-namespace-purge.ts:139` | Launcher pre-boot (#727 / #968) | OK if pre-boot — needs S3 verify |
| `src/cli/services/soft-delete-purge.ts:81` | Launcher pre-boot | OK if pre-boot — needs S3 verify |
| `src/cli/services/cherry-pick-learnings.ts:183` | Launcher pre-boot | OK if pre-boot — needs S3 verify |
| `src/cli/services/learning-service.ts:631` | Hooks (`commands/hooks.ts`) — in-session library | Cross-process — needs route via chokepoint or daemon-offline classification confirmed in S3 |

### Separate DB (not `.moflo/moflo.db`)

| File:Line | DB |
|-----------|-----|
| `src/cli/embeddings/persistent-cache.ts:182` | `.cache/embeddings.db` — unaffected |
| `src/cli/shared/events/event-store.ts:506` | Event store — separate file |
| `src/cli/movector/q-learning-router.ts:290` | Q-learning router export — in-memory serialization, not DB |
| `src/cli/memory/hnsw-persistence.ts` | `.moflo/hnsw.index` (separate file) |
| `harness/consumer-smoke/lib/*.mjs` | Test-fixture only — populated.mjs / checks.mjs build seed DBs in a tmpdir |
| `src/cli/__tests__/**` | All test fixtures use isolated tmpdir DBs |

## Action items derived from this audit (consumed by S2–S6)

1. **S3 (#1057)** ports `bin/migrations/**`, `bin/build-embeddings.mjs`, `bin/index-*.mjs`, `bin/generate-code-map.mjs`, `bin/lib/db-repair.mjs` to **explicit daemon-offline pattern** — launcher stops the daemon before invoking, restarts after.
2. **S3 (#1057)** changes `src/cli/commands/doctor-checks-memory-access.ts:335` to route the probe seed through `daemon-write-client` (eliminate the raw `db.export()` bypass that triggered #1053 / #1054).
3. **S3 (#1057)** adds content-diff to `bin/index-*.mjs` writers per `feedback_indexer_preserve_embeddings` so unchanged rows don't clobber embeddings on `INSERT OR REPLACE`.
4. **S3 (#1057)** verifies `learning-service.ts:631` — classify as cross-process (route via chokepoint) or as launcher-only (daemon-offline by construction).
5. **S2 (#1056)** guarantees the daemon-offline pattern is valid even after a version upgrade by detecting + killing a stale daemon before the launcher's pre-boot writer phase runs.
6. **S5 (#1059)** consumes this audit in the doctor `Writers Audit` runtime check.
7. **S6 (#1060)** uses this audit as the static-baseline for its cross-process smoke fixture.

## Lint enforcement

`tests/system/moflo-db-writer-audit.test.ts` greps the same patterns audited above and fails the suite when a hit doesn't match a whitelist entry. The whitelist (`tests/system/fixtures/writer-audit-whitelist.json`) is the canonical source — every new writer added to the repo must be added to the whitelist with a classification, or the build fails.

## See Also

- [docs/internal/981-writer-audit.md](./981-writer-audit.md) — Predecessor audit (chokepoint architecture)
- `feedback_indexer_preserve_embeddings.md` (auto-memory) — Content-diff before `INSERT OR REPLACE`
- `feedback_sqljs_writeback_clobber.md` (auto-memory) — The bug class this epic kills
- `.claude/guidance/shipped/moflo-root-cause-discipline.md` — Why the audit must kill the class, not patch instances
