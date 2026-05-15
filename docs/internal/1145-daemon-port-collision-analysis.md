# Daemon Port Collision — Cross-Project Routing Analysis

**Issue:** [#1145](https://github.com/eric-cielo/moflo/issues/1145) — `critical: fixed daemon port (3117) causes silent cross-project DB routing`

**Status:** Audit complete. Fix strategy committed. Recovery path documented. Ready for implementation scoping.

---

## 1. TL;DR

moflo's daemon HTTP server defaults to a fixed port (3117). The **server side** retries 3117→3118→…→3126 on `EADDRINUSE` (`src/cli/services/daemon-dashboard.ts:655-666`). The **client side** does NOT — `src/cli/memory/daemon-write-client.ts:47` hard-defaults to 3117 with no fallback. This asymmetry is the root mechanic: when project A binds 3117 first, project B's daemon binds 3118 successfully but project B's clients still POST to 3117 and silently hit project A.

Consequences proven on the audit machine:

- **Reads are wrong**: project B's `flo memory stats` / `memory list` / `memory retrieve` return project A's data.
- **Writes are wrong** (chokepoint surface): project B's MCP `memory_store` / `memory_delete`, `flo memory store/delete` CLI, swarm persistence, aidefence, and write-through-adapter land in project A's `.moflo/moflo.db` — **lost from B, foreign in A**. Indexers and migrations are safe (they bypass HTTP — see §6).
- **Orphan daemons accumulate**: same-project daemon proliferation. waxstack has TWO live daemons (3118, 3119) because stale-daemon detection failed.
- **No surface signal**: nothing logs, no health probe disagrees, daemon.lock contains no port — discovery is impossible without `netstat`.

The original consumer-reported symptom (`memory_stats reports totalEntries:0`) is one downstream effect among seven stacked bugs (§4).

---

## 2. Live Reproducer State

Three moflo daemons running on the audit machine at the time of investigation:

| PID | Port | Project | Version | Identity |
|-----|------|---------|---------|----------|
| 19580 | 3117 | `C:/Users/eric/Projects/moflo` (moflo-dev) | 4.10.6 | First to bind; owns the default port |
| 23040 | 3118 | `C:/Users/eric/Projects/motailz/code` (waxstack) | 4.10.7 | **Orphan** — not in any daemon.lock |
| 30344 | 3119 | `C:/Users/eric/Projects/motailz/code` (waxstack) | 4.10.7 | Current — owns waxstack's `.moflo/daemon.lock` |

`waxstack/.moflo/daemon.lock`:
```json
{"pid":30344,"startedAt":1778845531679,"label":"moflo-daemon","version":"4.10.7"}
```

**No `port` field.** Clients cannot discover the actual bound port.

### Direct reproducer

```bash
# From waxstack, with daemon routing enabled (default):
$ flo memory stats
  Total Entries:        0       # LIE. DB has 5,909.

$ flo memory list
  [INFO] Showing 5 of 4364 entries   # LIE. Those are moflo-dev's rows.

# Bypass daemon, hit SQL directly:
$ MOFLO_DISABLE_DAEMON_ROUTING=1 flo memory stats
  Total Entries:        5,909   # CORRECT.
```

Verified via direct `node:sqlite` open of both DB files:
- waxstack DB: 5,909 rows; namespaces `guidance` (2,620), `code-map` (1,414), `patterns` (1,297), `tests` (489)
- moflo-dev DB: 4,364 rows; namespaces `code-map` (1,385), `guidance` (1,018), `patterns` (971), `tests` (852)
- Different content, totally distinct projects.

### HTTP-level reproducer

```bash
# All three daemons share /api/memory/list shape but serve their own DB:
$ curl 127.0.0.1:3117/api/memory/list -d '{"limit":5}'
  → moflo-dev rows (4,364 total)

$ curl 127.0.0.1:3118/api/memory/list -d '{"limit":5}'
  → waxstack rows (5,909 total) — first row: chunk-guidance-analysis-output-location-4

$ curl 127.0.0.1:3119/api/memory/list -d '{"limit":5}'
  → identical to 3118 (same DB file)

# /api/health does not exist on any of them:
$ curl 127.0.0.1:3117/api/health
  → {"error":"Not found"}
```

---

## 3. Root Cause — The Asymmetric Port Fallback

Two source-of-truth constants for the same singleton (DRY violation surfaced in the audit):

```ts
// src/cli/services/daemon-dashboard.ts:59
export const DEFAULT_DASHBOARD_PORT = 3117;

// src/cli/memory/daemon-write-client.ts:47
const DEFAULT_DAEMON_PORT = 3117;
```

The server's port-fallback loop (`daemon-dashboard.ts:655-666`):

```ts
for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
  const port = basePort + attempt;
  try {
    const handle = await tryListenOnPort(daemon, opts, port);
    return handle;
  } catch (err) {
    if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS - 1) continue;
    throw err;
  }
}
```

`MAX_PORT_ATTEMPTS = 10` — tries 3117, 3118, …, 3126.

The client's port resolution (`daemon-write-client.ts:165`):

```ts
function getDaemonPort(): number {
  const fromEnv = process.env.MOFLO_DAEMON_PORT;
  if (fromEnv) { return parseInt(fromEnv, 10); }
  return DEFAULT_DAEMON_PORT;  // always 3117
}
```

**Server moves; client doesn't follow.** Every successful "I'm-listening" on a port > 3117 produces a silent collision waiting to happen.

---

## 4. Stacked Bugs Map

| # | Bug | Layer | Status |
|---|-----|-------|--------|
| 1 | Client port hard-defaults to 3117 (no fallback, no discovery) | `daemon-write-client.ts:47,165` | **Main #1145** |
| 2 | Two source-of-truths for `3117` | `daemon-dashboard.ts:59` + `daemon-write-client.ts:47` | **Part of #1145 fix** (collapse to one) |
| 3 | `.moflo/daemon.lock` has no `port` field | lock writer in launcher / `worker-daemon.ts` | **Part of #1145 fix** |
| 4 | Daemon has no `/api/health` (404 for identity probe) | `daemon-dashboard.ts` / `daemon-memory-rpc.ts` | **Part of #1145 fix** (add it) |
| 5 | Daemon `/api/memory/list` caps `limit ≤ 10000` | `daemon-memory-rpc.ts` request validator | **Sibling — separate issue** |
| 6 | MCP `memory_stats` requests `limit:100000` | `src/cli/mcp-tools/memory-tools.ts:732` | **Sibling — separate issue** |
| 7 | `tryDaemonList` transformer defaults `total: 0` on malformed shapes | `daemon-write-client.ts:354-357` | **Sibling — separate issue** |
| 8 | MCP `memory_stats` handler ignores `success: false` | `memory-tools.ts:732` (same file as #6) | **Sibling — separate issue** |
| 9 | Orphan daemon proliferation (multiple daemons per project) | daemon spawn / cleanup | **Sibling — separate issue** |
| 10 | MCP server PID file in `os.tmpdir()` (cross-project collision) | `src/cli/mcp-server.ts:70-71` | **Sibling — separate issue** |
| 11 | `~/.moflo/neural/` cross-project pattern bleed | `src/cli/memory/intelligence.ts:31` | **Sibling — separate issue** |

#1145's fix scope covers bugs **1–4**. Bugs 5–11 are filed separately so each is owned, tested, and reviewed independently.

---

## 5. Daemon HTTP Endpoint Inventory

From `src/cli/services/daemon-memory-rpc.ts:626-639`:

| Path | Method | Purpose | Cross-project-vulnerable? |
|------|--------|---------|---------------------------|
| `/api/memory/store` | POST | Single-entry write (chokepoint) | **YES** |
| `/api/memory/delete` | POST | Single-entry delete | **YES** |
| `/api/memory/batch` | POST | Bulk write/delete | **YES** |
| `/api/memory/get` | POST | Single-key retrieve | **YES** |
| `/api/memory/search` | POST | Semantic search | **YES** |
| `/api/memory/list` | POST | Paginated list | **YES** |
| `/api/health` | GET | (does not exist) | **N/A — needs to be added** |

Dashboard routes (`/`, `/api/events`, etc.) are read-only and present a different surface; not enumerated here.

---

## 6. Write-Path Pollution Analysis

Detailed audit results (parallel to `docs/internal/1054-writer-audit.md` and `981-writer-audit.md` — same shape):

### Write routing matrix

| Writer | Route | HTTP path | Direct fallback | Verdict |
|--------|-------|-----------|-----------------|---------|
| MCP `memory_store` / `memory_delete` | `storeEntry`/`deleteEntry` → `tryDaemonStore`/`tryDaemonDelete` first | `/api/memory/{store,delete}` | `openDaemonDatabase(memoryDbPath(cwd))` on `routed:false` | **wrong-daemon-vulnerable** |
| MCP aidefence (`aidefence-moflodb-store.ts:48,92`) | `storeEntry`/`deleteEntry` chokepoint | same | same fallback | **wrong-daemon-vulnerable** |
| CLI `flo memory store/delete` | `storeEntry`/`deleteEntry` chokepoint | same | same fallback | **wrong-daemon-vulnerable** |
| Swarm persistence + write-through-adapter | DI'd `storeEntry`/`deleteEntry` | same | same fallback | **wrong-daemon-vulnerable** |
| `bin/index-{guidance,tests,patterns}.mjs` | Direct `openBackend(projectRoot)` | none | local node:sqlite WAL | **direct-only-safe** |
| `bin/generate-code-map.mjs`, `bin/build-embeddings.mjs` | Direct `openBackend` | none | same | **direct-only-safe** |
| `bin/migrations/*.mjs` | Direct `openBackend` | none | same | **direct-only-safe** |
| `bin/lib/db-repair.mjs` | Direct `openBackend` | none | same | **direct-only-safe** |
| `services/learning-service.ts:387,639` (called from `commands/hooks.ts`) | Direct `openDaemonDatabase` (NOT routed) | none | direct | **direct-only-safe** |
| Doctor seed (`doctor-checks-memory-access.ts:335`) | Raw `db.export()` | none | direct | **direct-only-safe** |

### Bottom line on data damage

During the daemon-overlap window:

- **Foreign rows landed in moflo-dev's DB** from every chokepoint write originating in waxstack: MCP `memory_store` (Claude session "remember this", agent memory, hive-mind state), `flo memory store/delete` CLI, swarm coordination, aidefence learnings.
- **Lost rows from waxstack's DB**: the same writes never reached waxstack's local file. No shadow copy. Data is gone unless the user reconstructs from the foreign DB.
- **Intact in waxstack**: indexer-populated namespaces (`guidance`, `code-map`, `tests`, `patterns`) and learning-service `learned_patterns` (in-session writes). These bypass HTTP and write direct.
- **Intact in moflo-dev (its own namespaces)**: indexers ran direct against moflo-dev's DB too, so its `guidance`/`code-map`/`tests`/`patterns` are correct. The pollution shows up in `learnings`/`tasklist`/`swarm-*`/`default` namespaces (the MCP-store-targeted set).

Spot-check on the audit machine: moflo-dev's `learnings` namespace had 27 entries. Surface inspection of recent rows showed moflo-internal content (e.g., `1140-dead-mjs-collapse-residue`) — no obvious waxstack pollution in the visible sample. A full audit requires diffing every MCP-store-routable namespace against waxstack's expected content. Out of scope for the fix PR; tracked as recovery surface (§10).

---

## 7. Sidecar / HNSW Pollution Status

| File | moflo-dev | waxstack | Polluted? |
|------|-----------|----------|-----------|
| `.moflo/moflo.db` | 49 MB, 4,364 rows | 60 MB, 5,909 rows | **Yes** (foreign chokepoint rows in moflo-dev; missing chokepoint rows in waxstack) |
| `.moflo/hnsw.index` | 7.2 MB | 9.9 MB | **Indirect** — HNSW is rebuilt server-side by the daemon owning the project. waxstack's HNSW reflects waxstack's local DB (correct shape). moflo-dev's HNSW reflects moflo-dev's DB (including foreign rows it absorbed). |
| `.moflo/embeddings.json` | 317 B | 317 B | LOW — small bookkeeping; not a primary risk |
| `.moflo/daemon.lock` | per-project, valid PID | per-project, valid PID | **Schema gap** — no port field; clients can't discover bound port |
| `.moflo/daemon-state.json` | per-project | per-project | OK — describes the daemon's own workers, project-local |
| `.moflo/daemon-spawn.stamp` | per-project | per-project | OK |

HNSW pollution implications:

- waxstack's `.moflo/hnsw.index` is **complete for direct-write content** (indexers wrote rows + embeddings local; HNSW rebuild covered them). It's **missing vectors** for chokepoint writes that went elsewhere — so semantic-search in waxstack will fail to surface anything the user stored via MCP during the overlap window.
- moflo-dev's `.moflo/hnsw.index` includes **foreign vectors** for waxstack's chokepoint writes (HNSW rebuild covered the rows physically present in moflo-dev's DB regardless of origin). A search in moflo-dev surfaces waxstack content as plausible hits.

Recovery requires HNSW rebuild after row migration (§10).

---

## 8. Sibling Shared-Resource Collisions

Audit found other singleton-shared-resource assumptions that are bug-class siblings of #1145 — they would produce silent cross-project collisions on any developer's machine. Listed in severity order.

### HIGH severity (silent wrong-answers / data bleed)

| Resource | Location | Failure mode |
|----------|----------|--------------|
| Asymmetric server-vs-client port fallback | `daemon-dashboard.ts:655-666` vs `daemon-write-client.ts:47` | **Root mechanic of #1145.** Fix here. |
| MCP server PID file | `os.tmpdir()/claude-flow-mcp.pid` (`mcp-server.ts:70`) | Two projects' MCP servers overwrite each other's PID; "stop MCP" kills wrong process |
| MCP server log file | `os.tmpdir()/claude-flow-mcp.log` (`mcp-server.ts:71`) | Interleaved log lines, lost diagnostics |
| Neural intelligence patterns | `~/.moflo/neural/` (`memory/intelligence.ts:31`) | Cross-project pattern bleed; project A's neural learnings overwrite project B's |
| Spell credentials keyring | `~/.moflo/credentials.json`, `~/.moflo/credentials.key` (`spells/credentials/default-store.ts:29-30`) | Single keyring for the whole machine; two projects share creds |

### MEDIUM severity (noisy crashes / shared state)

| Resource | Location | Failure mode |
|----------|----------|--------------|
| Browser profile (Outlook) | `~/.moflo/browser-profiles/outlook` | Session-cookie collisions across projects |
| Claims store | `~/.config/claude-flow/claims.json` | Global claims; not project-scoped |
| Smoke-harness hardcoded `3217` | `harness/consumer-smoke/run.mjs:79` | Two parallel smokes collide noisily |

### LOW severity (cosmetic / read-mostly)

| Resource | Location | Notes |
|----------|----------|-------|
| Update-state JSON | `~/.moflo/update-state.json` | Rate-limit only |
| Update-history JSON | `~/.moflo/update-history.json` | Append-mostly |
| fastembed model cache | `~/.cache/fastembed/` | Content-addressed, read-mostly |
| Sandbox tmpfiles | `os.tmpdir()/moflo-sandbox-*.sb` | Per-invocation random suffix |

### Project-scoped (correctly isolated — for reference)

All locks under `.moflo/` follow the right pattern: `daemon.lock`, `recycle.lock`, `spawn.lock`, `indexer.lock`, `daemon-spawn.stamp`, `background-pids.json`. These are NOT siblings of #1145.

### Historical incidents (auto-memory)

- `1061-indexer-daemon-race-lock-pattern` — same shape; solved with project-scoped `.moflo/indexer.lock`.
- `feedback_moflo_dogfood_dual_context.md` — already documents the port-3117 dev-daemon-vs-smoke collision *within moflo's repo*; smoke uses 3217 as a workaround, not a fix.
- `launcher-stopdaemon-windows-escalation` — same lifecycle class as collision recovery.

---

## 9. Fix Strategy (Revised)

Three sub-fixes land in the same PR. Defense-in-depth — any one alone is insufficient.

### 9.1 Per-project deterministic port allocation

Single source-of-truth (kills #2 in §4 simultaneously). Both `daemon-dashboard.ts` and `daemon-write-client.ts` import from a shared `src/cli/services/daemon-port.ts`:

```ts
// src/cli/services/daemon-port.ts
import { createHash } from 'node:crypto';

const PORT_RANGE_BASE = 33000;
const PORT_RANGE_SIZE = 1000;
const LEGACY_DEFAULT_PORT = 3117;   // honored on read-only, not written

export function resolveProjectPort(projectRoot: string): number {
  if (process.env.MOFLO_DAEMON_PORT) {
    return parseInt(process.env.MOFLO_DAEMON_PORT, 10);
  }
  const hash = createHash('sha256').update(projectRoot).digest();
  return PORT_RANGE_BASE + (hash.readUInt16BE(0) % PORT_RANGE_SIZE);
}
```

- Same project path → same port across daemon restarts (no stale-lock confusion).
- Different paths → ~1/1000 collision probability; identity check (§9.3) catches it.
- Range 33000-34000 avoids common dev ports (3000, 3001, 5000, 5173, 8000, 8080).
- Env override preserves; legacy 3117 is no longer the unconditional fallback.

### 9.2 Port in `.moflo/daemon.lock`

Extend lock schema:

```json
{
  "pid": 30344,
  "startedAt": 1778845531679,
  "label": "moflo-daemon",
  "version": "4.10.7",
  "port": 33421
}
```

Clients **prefer** the lock-file port over `resolveProjectPort` so even if the server bound a non-default port (collision in the deterministic range), the client follows. Backward compat: when `lock.port` is missing, fall back to `resolveProjectPort(projectRoot)`, then env, then legacy 3117 with a deprecation warn.

### 9.3 Daemon identity endpoint + client identity check

Add `GET /api/health` to the daemon (currently 404):

```json
{
  "status": "ok",
  "projectRoot": "C:\\Users\\eric\\Projects\\motailz\\code",
  "pid": 30344,
  "version": "4.10.7",
  "uptimeMs": 36043927
}
```

Every client call probes `/api/health` (cached for 5 seconds, invalidated on routed-failure). Compare returned `projectRoot` to the client's `findProjectRoot()` result (unified resolver from #1057). On mismatch:

- Set `routed: false`; fall through to direct-SQL path (proven correct via `MOFLO_DISABLE_DAEMON_ROUTING=1`).
- Emit ONE stderr line per process per mismatched daemon: `[moflo] daemon at port X claims project '/foo' but cwd is '/bar' — using direct DB. Run flo healer --fix to repair.`
- Invalidate health cache.

### 9.4 Hard-fail on bind failure with non-default port

When `tryListenOnPort` exhausts the deterministic-range candidates and falls into the legacy retry, the daemon **must exit non-zero** rather than stay alive doing internal-worker-only work. Today's silent half-alive state (waxstack PID 30344) is the trap.

Spawn launcher detects the non-zero exit, retries up to N times with exponential backoff, then surfaces to healer.

### 9.5 Healer subcheck — `daemon-identity-match`

New doctor/healer subcheck:

1. Read `.moflo/daemon.lock` → extract claimed `port` + `pid`.
2. `GET 127.0.0.1:<port>/api/health` → extract reported `projectRoot`.
3. Assert `projectRoot === findProjectRoot(cwd)`.
4. On fail: `flo healer --fix daemon-identity` kills the wrong-project daemon process (only if its `commandLine` clearly belongs to a moflo install — see §10 recovery), restarts the local daemon.

---

## 10. Recovery Path for Affected Consumers

### 10.1 Detect

Healer's new `daemon-identity-match` subcheck (§9.5) surfaces the collision. Until that lands, consumers can manually run:

```bash
node --no-warnings -e "
const http = require('node:http');
const { readFileSync } = require('node:fs');
const lock = JSON.parse(readFileSync('.moflo/daemon.lock', 'utf-8'));
const port = lock.port ?? 3117;
http.get('http://127.0.0.1:' + port + '/api/health', res => {
  let body = ''; res.on('data', c => body += c);
  res.on('end', () => console.log('Port', port, 'identity:', body));
}).on('error', e => console.error('No daemon at', port, e.message));
"
```

If `/api/health` 404s (current state), check identity via `netstat -ano | grep :3117` + `tasklist /PID <pid>` (Windows) or `lsof -i :3117` (macOS/Linux).

### 10.2 Reconciliation (manual, pre-fix)

For consumers whose data went to a foreign DB during the overlap window:

1. **Stop all moflo daemons on the machine.** Find them: `ps aux | grep moflo` or `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -Match 'moflo.*daemon'`. Kill each.
2. **Identify victim and donor DBs.** Victim = project whose `.moflo/moflo.db` is missing chokepoint writes. Donor = project whose daemon was bound on 3117 first.
3. **Audit donor for foreign rows.** Per namespace audit. The `learnings`, `default`, `swarm-*`, `tasklist`, and any custom-MCP-store namespaces are the polluted set. Indexer-populated namespaces (`guidance`, `code-map`, `tests`, `patterns`) are safe.
4. **Manual extract + reinsert** of identified foreign rows. There is no auto-attribution — content origin must be inferred from `key` patterns, `metadata` JSON, or content text. A scripted helper for this could ship with the #1145 fix PR.
5. **Rebuild HNSW** in victim project: `flo memory rebuild-index` (or `flo embeddings init`).
6. **Restart daemons** post-fix in any order — the fix prevents recurrence.

### 10.3 Disclosure to consumers

The fix PR's CHANGELOG entry must clearly state:

> **Data-integrity advisory:** moflo versions ≤4.10.7 had a daemon-routing bug (#1145) where two moflo-using projects on the same machine could silently cross-write each other's databases. If you ran `flo memory store`, `mcp__moflo__memory_store`, or `flo swarm` across multiple projects concurrently, audit `.moflo/moflo.db` in each project for foreign entries before considering the fix complete. See `docs/internal/1145-daemon-port-collision-analysis.md` §10.2 for the manual reconciliation procedure.

---

## 11. Test Surface

### 11.1 New tests (must fail on `main`, pass after fix)

| Test | Location | What it asserts |
|------|----------|-----------------|
| Cross-project port allocation | `tests/system/daemon-port-isolation.test.ts` | Two daemons rooted at different paths each bind successfully; deterministic ports differ |
| Identity-check rejection | `tests/system/daemon-identity-mismatch.test.ts` | Client calling a daemon whose `/api/health` reports a different `projectRoot` falls through to direct SQL with one stderr warn |
| Lock-file port discovery | `tests/bin/daemon-lock-port-discovery.test.ts` | Client reads `port` field from `.moflo/daemon.lock` and uses it over `resolveProjectPort` |
| Hard-fail on bind exhaustion | `tests/bin/daemon-bind-exhaustion.test.ts` | When all candidate ports are taken, daemon exits non-zero; spawn launcher retries N times |
| Smoke harness extension | `harness/consumer-smoke/run-dual-consumer.mjs` (new) | Spawns two consumer-smokes back-to-back in different temp dirs; asserts each `flo memory stats` returns own row count |

### 11.2 Existing test surface to update

- `src/cli/__tests__/memory/daemon-write-client.test.ts` — fixture updates for port resolution
- `src/cli/__tests__/services/daemon-memory-rpc.test.ts` — `/api/health` route assertions
- `src/cli/__tests__/services/dashboard-claude-stats-route.test.ts` — already on `isolationTests`; verify still green post-fix
- All `tryDaemon*` tests in `daemon-write-client.test.ts` — gain identity-mismatch case

### 11.3 Regression guard

Add `tests/system/no-fixed-3117.test.ts` — static grep that any future commit reintroducing a literal `3117` outside `daemon-port.ts` fails the test. Same posture as `tests/bin/get-backend.test.ts` for the sql.js retirement.

---

## 12. Migration / Rollout Plan

### Phase 1 — Land #1145 (this issue)

PR includes:
- §9.1–9.5 implemented
- §11 tests green on Linux + macOS + Windows
- CHANGELOG advisory (§10.3)

### Phase 2 — File and resolve siblings (post-#1145)

Each sibling bug from §4 gets its own issue + PR:
- **memory_stats overhaul** — collapses bugs 5+6+7+8: dedicated `/api/memory/stats` endpoint with server-side aggregations, no client-side iteration; client surfaces 4xx errors instead of defaulting to 0.
- **orphan daemon cleanup** (bug 9) — startup probe: any moflo daemon process with same projectRoot but PID ≠ lock.pid gets killed before this daemon binds.
- **MCP PID/log relocation** (bug 10) — move `claude-flow-mcp.pid|log` from `os.tmpdir()` to `<projectRoot>/.moflo/mcp-server.{pid,log}`.
- **neural-pattern namespacing** (bug 11) — `~/.moflo/neural/` partitioned by project-hash subdirectory.

### Phase 3 — Tighten audit posture

Add a CI guard that fails on any new code path that:
- Reads/writes a fixed port outside `daemon-port.ts`
- Writes a PID/lock/state file outside `<projectRoot>/.moflo/` (with explicit allowlist for the four sibling-cleanup files in Phase 2)
- References `127.0.0.1:` literals outside the central daemon-port resolver

---

## 13. See Also

- `docs/internal/1054-writer-audit.md` — sibling writer audit (sql.js multi-process clobber); same audit shape, same posture
- `docs/internal/981-writer-audit.md` — earlier sibling audit (sql.js single-writer)
- `.claude/guidance/internal/dogfooding.md` — explains why `bin/**` requires publish-reinstall verification
- `feedback_consumer_blast_radius.md` — mandatory pre-change articulation rule (consumer surface / failure mode / round-trip cost) that this audit follows
- `feedback_moflo_dogfood_dual_context.md` — documents the local-only port-3117 collision class this issue escalates to the consumer-fleet scale
- `feedback_unified_project_root_resolver.md` — every `findProjectRoot()` caller pattern; §9.3 identity check relies on this
