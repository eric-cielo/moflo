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

## See Also

- `.claude/guidance/internal/upgrade-contract.md` — The "user never re-runs init" invariant that dogfooding stress-tests on every dev session
- `.claude/guidance/shipped/moflo-guidance-rules.md` — Universal writing rules every guidance file follows
- `.claude/guidance/internal/guidance-rules.md` — Moflo-only extensions: `moflo-` prefix, shipped/internal partition, decision rules
- `.claude/guidance/internal/testing-performance.md` — The "no flaky tests" standing decision; dogfooding catches flakes before they reach consumers
- `.claude/guidance/internal/consumer-project-paths.md` — Why `bin/` scripts must use `findProjectRoot()` — dogfooding catches the path-resolution bugs first
- `.claude/guidance/internal/session-start.md` — Detailed view of what runs on every session start (dogfood = we are the consumer)
- `.claude/guidance/shipped/moflo-settings-injection.md` — The settings.json self-heal contract dogfooding exercises
- `.claude/guidance/internal/guidance-sync.md` — Three-layer pipeline (filesystem → DB → HNSW) for shipped guidance; dogfooding catches sync regressions on every reindex
