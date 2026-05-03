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

## See Also

- `.claude/guidance/internal/upgrade-contract.md` — The "user never re-runs init" invariant that dogfooding stress-tests on every dev session
- `.claude/guidance/shipped/moflo-guidance-rules.md` — Universal writing rules every guidance file follows
- `.claude/guidance/internal/guidance-rules.md` — Moflo-only extensions: `moflo-` prefix, shipped/internal partition, decision rules
- `.claude/guidance/internal/testing-performance.md` — The "no flaky tests" standing decision; dogfooding catches flakes before they reach consumers
- `.claude/guidance/internal/consumer-project-paths.md` — Why `bin/` scripts must use `findProjectRoot()` — dogfooding catches the path-resolution bugs first
- `.claude/guidance/shipped/moflo-session-start.md` — Consumer-facing view of what runs on every session start (dogfood = we are the consumer)
- `.claude/guidance/shipped/moflo-settings-injection.md` — The settings.json self-heal contract dogfooding exercises
- `.claude/guidance/internal/guidance-sync.md` — Three-layer pipeline (filesystem → DB → HNSW) for shipped guidance; dogfooding catches sync regressions on every reindex
