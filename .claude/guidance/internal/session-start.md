# MoFlo Session-Start Lifecycle

**Purpose:** Document everything that runs when Claude Code fires the `SessionStart` hook in a moflo-enabled project. The launcher does substantially more than "start the daemon" — it heals stale state, migrates DBs, syncs scripts, and reconciles hook wiring. Knowing what runs (and in what order) makes diagnosis fast.

**Audience:** Agents and developers diagnosing slow session starts, unexpected mutations to `.claude/`, embedded migrations, daemon recycling, and post-upgrade behaviour.

---

## Quick reference

The launcher (`bin/session-start-launcher.mjs`, synced to `.claude/scripts/session-start-launcher.mjs`) is the single SessionStart hook moflo registers. Everything below runs in one process, in the listed order, before Claude Code begins the session. Total cost on a healthy install with no version change is typically < 200 ms; an upgrade or DB heal can extend it to several seconds.

When anything runs, the launcher prints `moflo: <action> (<details>)` to stdout. Claude Code captures stdout as session-start `additionalContext`, so the agent sees every mutation. Failures land on stderr and similarly surface.

---

## Stages, in execution order

### 0. Headless skip

If `CLAUDE_CODE_HEADLESS=true` is set in the environment, the launcher exits immediately. The moflo daemon spawns headless Claude processes (for indexing, pretraining, etc.); without this guard each spawned Claude would re-enter the launcher and fork the indexer chain on every daemon worker tick. ([#860](https://github.com/eric-cielo/moflo/issues/860).)

### 0-pre. Drop stale upgrade-notice files

`.moflo/upgrade-notice.json` is a transient handshake between launcher and statusline. Pre-#738 launchers wrote a 1-hour-TTL "complete" notice that could survive past the launcher run that wrote it. The launcher unconditionally removes any leftover before its own run begins.

### 0c. Memory DB index repair

Probes `.moflo/moflo.db` for `sqlite_autoindex_memory_entries_1` corruption and runs `REINDEX` in place if found. Must run before any sql.js consumer (embeddings migration, ephemeral-namespace purge, MCP server, daemon) — those swallow corruption errors and silently drop work otherwise. Cost on the happy path: one PRAGMA check (~10 ms). ([#743](https://github.com/eric-cielo/moflo/issues/743).)

### 0d. Clear post-install restart notice

If `.moflo/restart-pending.json` was written by `scripts/post-install-notice.mjs` after the last `npm install moflo` and the running version now matches the pending version, the file is removed. The user has restarted; the notice has done its job. ([#867](https://github.com/eric-cielo/moflo/issues/867).)

### 2. Reset workflow state

Writes a fresh `.claude/workflow-state.json` for the new session: `tasksCreated: false`, `memorySearched: false`, `sessionStart: <ISO timestamp>`. The gate scripts read this on every tool call.

### 3. Auto-sync on version change (or drift)

This is the biggest stage. It fires when **either** condition is true:

- The installed version (`node_modules/moflo/package.json`) differs from the cached version stamp (`.moflo/moflo-version`), OR
- Any file in `.moflo/installed-files.json` (the manifest from the previous successful sync) is missing or has drifted in size since we last wrote it.

When triggered, the launcher walks the following sub-steps in order:

| Sub-step | What runs | Why |
|---------|-----------|-----|
| Stop daemon | Kills the daemon recorded in `.moflo/daemon.lock` | The daemon was started under the previous moflo image; old module-cache + path resolution would clobber the upgrade. ([#851](https://github.com/eric-cielo/moflo/issues/851).) |
| Cherry-pick learnings | `cherry-pick-learnings.js` reads legacy `.swarm/memory.db` and `INSERT OR IGNORE`s into `.moflo/moflo.db` | Carries user-authored knowledge forward across the v3 DB rename. Idempotent. |
| Sync scripts | Copy `bin/*.mjs` and `bin/lib/**` and `bin/migrations/**` into `.claude/scripts/` | Hooks always run the latest version |
| Sync helpers | Copy `bin/{gate.cjs,gate-hook.mjs,prompt-hook.mjs,hook-handler.cjs}` plus `.claude/helpers/{auto-memory-hook.mjs,statusline.cjs,...}` into `.claude/helpers/` | Same |
| Sync shipped guidance | Copy every `node_modules/moflo/.claude/guidance/shipped/moflo-*.md` into `.claude/guidance/`, prefixing each with the auto-generated mirror header | These are the files indexed by the consumer's memory namespace |
| Cleanup retired files | Anything in the OLD manifest but NOT in the new manifest is unlinked | Auto-removes files moflo no longer ships |
| Per-file retry/circuit | Each copy retries `[50, 200, 800] ms` on `EBUSY`/`EPERM`/`EACCES` (Windows file lock, AV scan); after 5 distinct failures the circuit opens and the rest of the sync runs without retries | Prevents a sick host from compounding wall-clock cost; persistent failures land on stderr |
| Manifest write | New `{path, size}` manifest committed to `.moflo/installed-files.json` | Drift detection on next launcher run |
| Defer version stamp | Pending write of `.moflo/moflo-version` queued for stage 3g | Stamp is "launcher fully completed" — writing it mid-flight strands consumers on a half-applied upgrade ([#730](https://github.com/eric-cielo/moflo/issues/730)) |

### 3a-pre. Recycle stale daemons

Even when the version hasn't changed, the daemon-lock's `startedAt` is compared against `node_modules/moflo`'s install mtime. If the daemon predates the current install (with a 5 s skew margin), it's recycled. This catches the "user upgraded ages ago, ran one session that bumped the stamp + recycled the daemon, but the daemon they started long-ago is still alive holding stale module cache" failure mode.

### 3a. Settings.json migration and self-heal

See `shipped/moflo-settings-injection.md` for the full mechanism. The launcher applies, in order:

1. **Drop stale `PATH` override** — pre-4.x settings injected `${PATH}` which Claude Code didn't expand, breaking node resolution.
2. **Replace `npx flo` hook commands with direct `node "$CLAUDE_PROJECT_DIR/..."` invocations** — saves 2–5 s of `npx` cold-start per hook.
3. **Ensure `statusLine` is wired** — the helper script is synced by stage 3 but the config block may be absent.
4. **Repair + rewrite hook wirings** — `repairHookWiring()` adds missing required hooks; `rewriteIncorrectHookWiring()` rewrites known-stale hook commands (e.g. [#879](https://github.com/eric-cielo/moflo/issues/879) `gate.cjs record-memory-searched` → `gate-hook.mjs record-memory-searched`).

### 3b. Restore + prune shipped guidance mirrors

Even when stage 3 didn't fire (no version change, no drift), the launcher checks that every `moflo-*.md` from `node_modules/moflo/.claude/guidance/shipped/` exists at `.claude/guidance/<file>` with the auto-generated mirror header. Missing files are restored; mirror files whose source has been removed (and which still carry the `<!-- AUTO-GENERATED by moflo session-start.` marker) are pruned. ([#839](https://github.com/eric-cielo/moflo/issues/839).)

### 3b-714, 3c. Legacy cleanup

- `.swarm/vector-stats.json` (replaced by `.moflo/vector-stats.json` post-#699) is unlinked.
- Pre-4.8.45 double-prefixed guidance files (`moflo-moflo-*.md`) are unlinked.

### 3d-yaml. Append missing top-level sections to `moflo.yaml`

`bin/lib/yaml-upgrader.mjs` walks the user's `moflo.yaml` and idempotently appends any registered top-level section that's absent (e.g., `sandbox:`, `auto_update:`, `daemon:`). Never modifies user-set values; never reorders or reformats. Surfaces appended section names so the user can find what changed. (Pattern documented in `internal/upgrade-contract.md` "Yaml upgrade pattern".)

### 3d. Install global `flo` shim

Best-effort install of a shim into npm's global bin so bare `flo` resolves to the local project's `node_modules/.bin/flo`. Idempotent — skips when already present. Non-fatal on failure: `flo` still works via `npx`.

### 3e. Foreground embeddings migration

`runEmbeddingsMigrationIfNeeded` checks `.moflo/moflo.db` for embeddings-version drift and, if needed, re-embeds rows in chunks. Runs synchronously with piped stdio so the renderer's progress bar reaches the user. Returns fast (~ms) when no migration is needed.

### 3e-728, 3e-729, 3e-968. Hard-purge legacy + trim flo-run history

- Soft-deleted tombstones (status='deleted' rows from pre-#728 builds) are hard-deleted and the DB is VACUUMed.
- Ephemeral-namespace rows in `hive-mind`, `epic-state`, and `test-bridge-fix` are hard-deleted on every session start. Writes to all four embedding-skipped namespaces (those three plus `tasklist`) bypass embedding generation entirely.
- `tasklist` is **not** purged — those rows back the dashboard's "Flo Runs" tab and need to outlive the session. The launcher trims tasklist to the most recent `TASKLIST_RETENTION_CAP` rows (default: 200), so the table stays bounded without losing recent history ([#968](https://github.com/eric-cielo/moflo/issues/968)).

Both run **before** the daemon is restarted in stage 4 so a concurrent sql.js flush can't clobber the foreground purge.

### 3f. Flip upgrade notice to "completed"

If stage 3 wrote an "in-progress" upgrade notice for the statusline, it's flipped to "completed" with a 2-minute TTL. The next session-start's stage 0-pre wipes any leftover.

### 3g. Commit deferred version stamp

`.moflo/moflo-version` is finally written with the installed version. Any abort above leaves the stamp unchanged so the next launcher re-detects the upgrade and re-runs stage 3. ([#730](https://github.com/eric-cielo/moflo/issues/730).)

### 4. Spawn background tasks

- `node bin/hooks.mjs session-start` is spawned detached + unref'd. That script starts the daemon, the indexer, the pretrain pass, the HNSW build, and the neural-pattern training. None of it blocks the session.
- Migrations (`run-migrations.mjs`) consult `.moflo/migrations.json` and run any unmigrated steps synchronously, then announce completed migrations via `moflo:` mutation lines.

### 5. Exit

`process.exit(0)`. Claude Code now begins the session with the launcher's stdout captured as additionalContext.

---

## Diagnosing slow session starts

Bottlenecks, in rough order of likelihood:

| Symptom | Likely stage | Mitigation |
|---------|-------------|------------|
| Several-second delay on first start after `npm install` | Stage 3 (script + helper + guidance sync) | Expected — one-shot cost. Subsequent starts are ms. |
| 30–60 s delay on first start after a major upgrade | Stage 3e (embeddings migration) | Surfaces a progress bar via stderr; cannot be skipped. |
| Repeated multi-second delay on every start | Stage 3 firing every time = manifest drift loop | Check `moflo: repaired stale install` lines on stdout — usually means a file copy keeps failing (Windows AV, file lock). Run `flo doctor --fix`. |
| Daemon appears to restart on every start | Stage 3a-pre — daemon predates install | Expected if you just upgraded; should stop after one session. |

If a stage hangs, the launcher's per-step timeouts (5–30 s depending on the operation) protect against deadlock. A blocked stage that times out lands an error on stderr; the next launcher run retries.

---

## Adding a new stage (developer note)

Before adding work to the launcher, ask:

1. Is this **per-session** work (hook reset, mirror restore) or **per-version** work (script sync, manifest)? Per-version belongs in stage 3 under the version-change gate; per-session goes in stage 2 or as its own gated stage.
2. Does it touch `sql.js`? It must run **before** stage 4's daemon spawn — concurrent flushes from a long-lived sql.js consumer will clobber a foreground write.
3. Does it mutate consumer state? It must `emitMutation()` so the user sees what changed via additionalContext. Silent mutations are a regression of the upgrade contract.
4. Does it depend on a fresh-state invariant (e.g., daemon stopped, manifest written, version stamp committed)? Order matters — see the existing 3 → 3a → 3a-pre → ... → 3g → 4 sequence and slot in accordingly.

Full ordering rules and historical violations live in `internal/upgrade-contract.md`.

---

## Adding a new helper script (static-files rule)

Helper scripts (`bin/*.mjs`, `bin/*.cjs`, hook handlers, statusline, auto-memory) ship as **pre-built static files**, not generated at runtime. The launcher copies them verbatim into the consumer's `.claude/scripts/` and `.claude/helpers/` during stage 3.

| Rule | Why |
|------|-----|
| If the script has no per-project interpolation, save it as a static file under `bin/` | Dynamic generation at runtime adds fragile moving parts (background `init --upgrade`, race conditions with session-start exit) and produces stale scripts when the sync list is incomplete |
| Add the script to the appropriate sync list in `bin/session-start-launcher.mjs` AND `src/cli/init/moflo-init.ts` | Otherwise the file ships to `node_modules/` but never reaches the consumer's `.claude/`. See feedback memory `feedback_scriptfiles_sync` |
| Per-source destination is fixed by the launcher's section 3 sub-step ("Sync scripts" vs "Sync helpers") | Consumers expect specific files at specific paths; moving destinations between releases breaks downstream tooling |

---

## See Also

- `shipped/moflo-settings-injection.md` — the contract for what moflo writes into `.claude/settings.json` and how the surgical self-heal works.
- `shipped/moflo-core-guidance.md` § Session-Start Cost Expectations — consumer-facing summary of session-start timing.
- `shipped/moflo-memorydb-maintenance.md` — what runs against `.moflo/moflo.db` (embeddings, soft-delete, ephemeral purge).
- `internal/upgrade-contract.md` — the "user must never re-run init" invariant the launcher enforces, with historical violations to learn from.
- `internal/guidance-sync.md` — Stages 3 and 3b documented end-to-end as part of the three-layer guidance sync (filesystem → DB → HNSW).
