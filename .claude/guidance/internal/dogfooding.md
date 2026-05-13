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

## Upstream Sync

MoFlo is a diverged fork of Ruflo/Claude Flow. See `UPSTREAM_SYNC.md` for the cherry-pick log. Never push to or create PRs against `ruvnet/ruflo`.

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

## Smoke Harness Reality

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
