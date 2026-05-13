# Dogfooding Protocol

**Purpose:** How moflo uses itself during development. We are both the owner and the consumer — moflo is installed as a devDependency to develop on moflo.

---

## Why Dogfood

MoFlo installs itself (`npm install moflo`) so that:
- Session-start hooks, guidance indexing, and MCP tools run against *our own* codebase
- We catch consumer-facing bugs before users do
- Shipped guidance is tested under real conditions
- The dev experience mirrors the consumer experience

---

## Shipped vs Internal Guidance

| Directory | Ships in npm | Indexed when... |
|-----------|-------------|-----------------|
| `.claude/guidance/shipped/` | Yes | Installed as dependency (bundled guidance) |
| `.claude/guidance/internal/` | No | Only in the moflo repo (dev-only) |

**Rule:** Consumer-facing docs (CLI reference, swarm patterns, memory architecture, bootstrap guide) go in `shipped/`. Dev-only docs (this file, publishing steps, upstream sync, test conventions) go in `internal/`.

Both directories are indexed locally during moflo development because the indexer recurses into subdirectories. Only `shipped/` reaches consumers via npm.

---

## Publishing Checklist

1. Bump version in both `package.json` (root) and `src/cli/package.json`
2. Build: `npm run build`
3. Verify shipped guidance will be included: `npm pack --dry-run | grep guidance`
4. Publish: `npm publish`
5. Verify: `npm view moflo dist-tags --json`

---

## Upstream Boundary

MoFlo started as a fork of Ruflo/Claude Flow but is now an independent project — no active sync, no cherry-picks, no upstream remote. Never push to or create PRs against `ruvnet/ruflo`. If you find yourself reading code there, you've gone the wrong direction — the source of truth lives in this repo.

---

## Test Conventions

- Tests live in `tests/` (root-level) or colocated `__tests__/` directories
- Vitest with forks pool (avoids sql.js WASM segfaults)
- Exclude `flakey` and `local-only` tagged tests from CI
- Run `npx vitest run` before publishing
- Pre-existing flaky tests: `agentic-flow-agent.test.ts` (timing), `worker-daemon-resource-thresholds.test.ts` (heap OOM on Windows)

---

## Runtime Symptom Diagnosis

**MoFlo IS the project AND the installed devDependency that drives the editor.** Two layers exist and they routinely diverge:

| Layer | Location | Role |
|-------|----------|------|
| **Source** | `src/cli/...`, `bin/...` (working tree) | What's being edited |
| **Installed** | `node_modules/moflo/...` | What's actually running — Claude Code's SessionStart hooks, daemon, statusline, indexers, embeddings migration all execute from here |

When diagnosing any "X is broken" symptom (statusline numbers, daemon spam, missing upgrade UI, indexer behavior, hook output, anything observable in the editor) the symptom is produced by the **installed** bits — NOT by the source. The instinct of "open the source file and read the code" is wrong here unless the install was just refreshed.

### Verify install state before opening an issue

```bash
node -p "require('./node_modules/moflo/package.json').version"  # what's running
node -p "require('./package.json').version"                     # source version
git log --oneline -5                                            # what's in source not yet shipped
```

If installed lags source, **publish + reinstall first** (use `/publish`), then re-test. Most "the code is buggy" symptoms turn out to be stale-install artifacts in this repo specifically because of the dogfood loop.

### Anti-pattern: source-first diagnosis

❌ **Wrong:** symptom appears → open `src/cli/<file>.ts` → read code → file an issue claiming the code is broken.
✅ **Right:** symptom appears → check installed-vs-source version → if lagging, publish/reinstall → if symptom persists from `node_modules/moflo/...`, *then* open the issue with both versions logged.

### Corollary: code must run from `node_modules/moflo/...` paths

Features must work from the installed location (consumer perspective), not from source paths anchored on `process.cwd()`. Hand-rolled `__dirname` or `process.cwd()` resolution that "works in dev" silently breaks for every consumer because their `node_modules/moflo/` lives at a different relative depth. See `feedback_consumer_path_resolution.md` (auto-memory) and `consumer-project-paths.md`.

---

## Delivering Changes That Work Both Local AND Installed

Every non-trivial change has to clear three resolution problems that recur in this codebase because of the dogfood loop. Each has a canonical pattern; getting the pattern wrong produces "works locally, broken in `node_modules/moflo/`" bugs or vice versa.

### 1. Three distinct "roots" — pick the right one, use the right resolver

| What you want | Resolver | Use when |
|---|---|---|
| Consumer's project root (where the user's `.moflo/`, `package.json`, source tree live) | `findProjectRoot()` — JS: `bin/lib/moflo-paths.mjs`; TS: `services/project-root.ts` | bin/*.mjs scripts or TS code that needs to write to the *consumer's* state |
| MoFlo *package* root (where moflo's own `bin/`, `dist/`, `package.json` live — in dogfood that's the repo; in a consumer install that's `node_modules/moflo/`) | `findMofloPackageRoot()` from `src/cli/services/moflo-require.ts` | TS code that needs to load a moflo-shipped file (e.g. importing a `bin/lib/*.mjs` module from a TS module under `dist/src/cli/...`) |
| Sibling script in the same `bin/` directory | Candidate list across `__dirname`, `<projectRoot>/node_modules/moflo/bin/`, `<projectRoot>/.claude/scripts/` — see `consumer-project-paths.md` | bin/*.mjs scripts that spawn other bin/*.mjs scripts |

The three are distinct because they answer different questions: "where is the user's work?" vs "where is MY code installed?" vs "where is my sibling on disk?" Conflating them is the source of most install-vs-local breakage.

### 2. Anti-pattern: hardcoded `../../../../` paths in TS that crosses into `bin/`

```ts
// ❌ WRONG — depth differs between TS source and compiled dist
const repairUrl = new URL('../../../../bin/lib/db-repair.mjs', import.meta.url);

// ✅ CORRECT — works in all three contexts (dogfood TS / dist / consumer install)
const root = findMofloPackageRoot();
if (!root) throw new Error('moflo package root not found');
const repairUrl = pathToFileURL(join(root, 'bin', 'lib', 'db-repair.mjs')).href;
```

The depths don't match between source and dist:

| Context | `import.meta.url` for `services/foo.ts` | Up 4 levels |
|---|---|---|
| Dogfood TS source (vitest) | `<repo>/src/cli/services/foo.ts` | `<repo>/..` ← **wrong**, overshoots |
| Compiled dist (CLI runtime) | `<repo>/dist/src/cli/services/foo.js` | `<repo>` ← correct |
| Consumer install | `node_modules/moflo/dist/src/cli/services/foo.js` | `node_modules/moflo` ← correct |

The TS source tree is one level shallower than dist (`src/cli/services/` vs `dist/src/cli/services/`), so any fixed-depth `../` walk that's tuned for dist hits a different parent in vitest. Test suites that don't actually invoke the loader (e.g. tests that just check return shape, accepting both success and failure outcomes) silently pass over this bug — it surfaces only when a new test checks the *outcome* of the actual load. This bit us in #1126 — caught by the doctor-integrity test that explicitly required a healthy DB to report `pass`.

**Always use `findMofloPackageRoot()`** when a `.ts` module needs to locate any `.mjs` / `.js` file outside the same compile unit.

### 3. Three sync layers — match the new file's layer, no manual list

When adding a new file, check which layer it falls into:

| File location | Ships via | Sync requirement |
|---|---|---|
| `src/cli/**/*.ts` | `dist/src/cli/**/*.js` (auto, after `tsc`) | None — `package.json` `files` glob covers it |
| `bin/*.mjs` (top level) | `bin/**` glob | **YES — add to `scriptFiles[]` in three places** (`bin/session-start-launcher.mjs` + `.claude/scripts/session-start-launcher.mjs` + `auto-update.test.ts`) — see `feedback_scriptfiles_sync.md` |
| `bin/lib/*.mjs` | `bin/**` glob | None — launcher's §3 sync recursively `readdirSync(libSrcDir)` picks it up automatically |
| `bin/migrations/**` | `bin/**` glob | None — recursive sync |
| `.claude/skills/**/*.md` | `.claude/skills/**/*.md` glob | None |
| `.claude/guidance/shipped/**` | `.claude/guidance/shipped/**` glob | None (internal/ does NOT ship) |
| `.claude/helpers/**` | `.claude/helpers/**` glob | None |

The `scriptFiles[]` array hazard is the most common foot-gun because it's the only layer with a hand-maintained list. Everything else uses globs or `readdirSync`.

### 4. Round-trip cost — does the change need publish+reinstall to take effect locally?

| Change touches | Visible to dogfood after |
|---|---|
| Tests, internal helpers (anything not in the listed surfaces) | `npm test` / file save |
| Build tooling (`tsc` config, `package.json` scripts) | `npm run build` |
| `dist/src/cli/**` consumed by `flo` CLI subprocess (`npx moflo ...`) | `npm run build` — the subprocess loads fresh dist |
| `bin/*.mjs` consumed by `flo` CLI subprocess | Source edit — subprocess re-resolves from disk |
| `bin/session-start-launcher.mjs` / hook handlers / MCP server / daemon | **publish + `npm install`** — Claude Code only re-loads these at session start, and our dev daemon was spawned at *previous* session start from `node_modules/moflo/` |
| `.claude/skills/**/*.md` (the skill itself) | Reload the skill / next `Skill` tool invocation |

Two consequences:

- **Mid-session you and the daemon disagree on the code.** A `flo healer --fix` you just edited will use the new source via the subprocess CLI — but the MCP server the same session is talking to was loaded from `node_modules/moflo/` and still has the old code. If a fix depends on both, you have to publish + reinstall + restart Claude Code before you can test the integrated behavior. (See `feedback_dogfood_install_vs_source.md` and `feedback_moflo_dogfood_dual_context.md` in auto-memory.)
- **"Works on my machine after edit" doesn't prove consumer-safety.** Until you `npm pack` + install into a temp consumer dir (or just `/publish` to npm and reinstall), you've only verified that source-tree-resolution worked. The consumer-install resolution is a separate test the smoke harness performs.

### 5. Test isolation: writes through cached project root

The bridge module caches the project root at first import. If a vitest test exercises `memory_store` while `CLAUDE_PROJECT_DIR` still points at the real moflo repo, the test's writes to its temp DB land correctly *but* the cache-sidecar writers (`writeVectorStatsCache` in `memory-initializer.ts:2093`, `refreshVectorStatsCache` in `bridge-core.ts`) write to the *real* `.moflo/vector-stats.json` with the test's row count (often 1).

Symptom: statusline briefly flashes a tiny embedding count (e.g. `Vectors ●1` instead of `●3576`) during a test run, then self-heals as the daemon's next `memory_store` rewrites the cache to truth.

Consumer impact: zero — consumers don't run our vitest suite. But locally it's confusing and can make a stable statusline look broken. The fix isn't in code; it's in test isolation:

- Tests that touch `memory_store` MUST redirect `CLAUDE_PROJECT_DIR` to a temp dir AND reset the bridge module's cached root (see `doctor-checks-memory-access.test.ts:42-53` `resetDistBridgeState()` pattern).
- The anti-clobber guard in `bridge-core.ts:703` only short-circuits *all-zero* writes. Single-row test writes sail through. Tightening that guard is a real follow-up but out of scope for individual feature PRs.

### 6. Cross-platform primitives — established conventions

Match existing patterns rather than reinventing:

- **Cross-process daemon stop**: `process.kill(pid, 'SIGTERM')`. Node maps `SIGTERM` to `TerminateProcess` on Windows; same effective behavior as POSIX. Used by `Daemon Version Skew` fix and `memory-db-integrity-repair.ts`.
- **Atomic file swap**: `renameSync(src, dst)`. POSIX-atomic; on Windows it maps to `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`. Used by `atomic-file-write.ts` and `db-repair.mjs:atomicSwap()`.
- **Filesystem-safe timestamps**: `new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')` — strips `:` (illegal on Windows) and trailing `Z`.
- **No POSIX-only shell-outs**: no `lsof`, `kill`, `chmod` — everything routes through `node:fs`, `node:sqlite`, `process.kill`.

Before merging, audit any new code that opens files, spawns processes, or stops daemons against these primitives.

---



`harness/consumer-smoke/` packs the working tree, installs it into a temp consumer dir, and exercises the Claude-Code-facing surface. The harness is the single source of truth for whether a change is consumer-safe — but the dogfood loop makes it diverge from CI in two specific ways unless we pin them.

### Two contexts running at once (local dev only)

When the smoke runs inside a Claude Code session on the moflo repo, two moflo contexts coexist:

| Context | Origin | What it owns |
|---------|--------|--------------|
| **Dev daemon** | `SessionStart` hook auto-started moflo for the dev session | Port 3117, the moflo repo's `.moflo/moflo.db`, the dev session's `CLAUDE_PROJECT_DIR=<moflo-repo>` |
| **Consumer install** | `npm install` from packed tarball into `os.tmpdir()/moflo-consumer-smoke/consumer-N/` | Its own `.moflo/moflo.db`, its own daemon (would-be port 3117) |

CI runs the consumer install only — there's no dev daemon, no Claude Code session, no `CLAUDE_PROJECT_DIR` in env. Same code, different environment. Without pinning, two divergences leak through:

1. **Project-root resolution** — `findProjectRoot()` honors `CLAUDE_PROJECT_DIR` ahead of the marker walk. The dev session's value points at the moflo repo, so every consumer subprocess that inherits env resolves project-root to the source tree and writes to the *dev* DB instead of the consumer DB.
2. **Daemon port collision** — the dev daemon already binds 3117. The consumer's `flo daemon start` walks the fallback range (3118, 3119, …) but client subprocesses (writers via `daemon-write-client.ts`) still default to 3117, so they POST to the dev daemon.

### How the harness pins both (#1067)

`harness/consumer-smoke/run.mjs` mutates `process.env` before any subprocess spawns. The existing env merge in `lib/proc.mjs` (`{ ...process.env, ...(runOpts.env || {}) }`) propagates the pinned values to every `flo()` / `runNode()` call and to the daemons they fork:

```js
process.env.MOFLO_DAEMON_PORT = process.env.MOFLO_DAEMON_PORT || '3217';
// …after installConsumer():
process.env.CLAUDE_PROJECT_DIR = consumerDir;
```

`src/cli/commands/daemon.ts#resolveDashboardPort` honors `MOFLO_DAEMON_PORT` env (post-#1067) so the consumer daemon binds the pinned port, matching the client. Port 3217 is outside the dev daemon's fallback range, so a parallel local smoke can't collide.

### Symptoms of unpinned context

If you ever see a smoke check report `found=false` for a key that was just written, OR a probe writing to a `.moflo/moflo.db` that isn't under `consumerDir`, OR the harness times out waiting for the daemon while `flo daemon start` reported success — check that both env pins are still in place at the top of `run.mjs` / `run-populated.mjs`. The `verifyConsumerIsProjectRoot` gate runs `findProjectRoot({ honorEnv: false })`, so it passes even when downstream probes silently divergence-fail.

### Acceptance: local smoke matches CI

The contract: running `npm run test:smoke` while the moflo dev daemon is up on 3117 must produce identical pass/fail status to a fresh CI checkout. Any divergence between local and CI smoke is a bug in the harness's context pinning, not in the code under test.

---

## See Also

- `.claude/guidance/internal/upgrade-contract.md` — The "user never re-runs init" invariant that dogfooding stress-tests on every dev session
- `.claude/guidance/shipped/moflo-guidance-rules.md` — Universal writing rules every guidance file follows
- `.claude/guidance/internal/guidance-rules.md` — Moflo-only extensions: `moflo-` prefix, shipped/internal partition, decision rules
- `.claude/guidance/internal/testing-performance.md` — The "no flaky tests" standing decision; dogfooding catches flakes before they reach consumers
- `.claude/guidance/internal/consumer-project-paths.md` — Why `bin/` scripts must use `findProjectRoot()` — dogfooding catches the path-resolution bugs first
- `.claude/guidance/internal/session-start.md` — Detailed view of what runs on every session start (dogfood = we are the consumer)
- `.claude/guidance/shipped/moflo-settings-injection.md` — The settings.json self-heal contract dogfooding exercises
- `.claude/guidance/internal/guidance-sync.md` — Three-layer pipeline (filesystem → DB → HNSW) for shipped guidance; dogfooding catches sync regressions on every reindex
