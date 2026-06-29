# Changelog

All notable changes to MoFlo are documented here. Pre-2026-03 entries below describe Claude Flow → Ruflo releases from before MoFlo forked off; they're preserved for historical context.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed — Daemon orphan-reap cross-kill across shared installs (#1249)

When a project root's `node_modules/moflo` was a symlink sharing another
root's physical install — a git-worktree / Conductor workspace linking
`node_modules` back to the main checkout, or `npm link moflo` across projects
— starting a daemon in one root reaped (killed) the other root's running
daemon as a bogus "same-project orphan". `acquireDaemonLock`'s pre-acquire
reap SIGTERM/SIGKILL'd it. Normal `npm install` consumers (separate physical
copies) were unaffected.

- `projectCliCandidates` (`src/cli/services/daemon-lock.ts`) realpathed the
  full cli.js candidate path, resolving the `node_modules/moflo` symlink and
  collapsing distinct roots onto one path. Fix: realpath the project-ROOT
  PREFIX only (keeps #1145's macOS `/var`→`/private/var` matching), then
  append the relative CLI path literally — a daemon's identity is its project
  root, not the shareable binary it executes.
- Same-root orphan reaping (#1150) preserved; regression tests added in
  `daemon-lock-orphan.test.ts`.

### Fixed — Session-start mutation pluralization

The launcher's `plural()` helper appended a bare `s`, rendering "durable
entrys" instead of "entries" in #1232 durable-sync session-start mutations.

### Fixed — Daemon port collision (#1145, CRITICAL)

Pre-#1145, moflo's daemon HTTP server defaulted to a fixed port (3117). The server retried 3117→3126 on `EADDRINUSE`; the client always POSTed to 3117. When two moflo-using projects ran daemons concurrently on the same machine, the second project's clients routed to the first project's daemon — silently. `flo memory stats`, `flo memory list`, `memory_search`, MCP `memory_store`, `flo memory store/delete`, swarm persistence, aidefence, and write-through-adapter all crossed projects.

#### What changed

- New shared port resolver `src/cli/services/daemon-port.ts` (JS twin at `bin/lib/daemon-port.mjs`). Both server bind site and client RPC route through `resolveProjectPort(projectRoot)` — deterministic `33000 + sha256(path) % 1000` so every project gets its own port.
- `.moflo/daemon.lock` gained a `port` field. Server stamps the actually-bound port after `listen()`; clients read it to discover the daemon without guessing.
- New `GET /api/health` endpoint on the daemon returns `{status, projectRoot, pid, version, uptimeMs}`. Clients probe it on every reachability check; a confirmed `projectRoot` mismatch downgrades the call to direct-SQL (the path that's been provably correct) and emits ONE stderr warn per mismatched port.
- Daemon now hard-fails if the dashboard can't bind any candidate port — pre-#1145 the daemon stayed alive doing internal-worker-only work while HTTP was dead.
- New healer subcheck: `flo healer --fix -c daemon-identity` (alias `identity`). Detects identity mismatches, kills the local daemon, clears the lock, respawns on the per-project port.
- Regression guard at `tests/system/no-fixed-3117-port.test.ts` rejects any new shipped code that references the legacy literal outside the central resolver.

#### Compatibility

- `MOFLO_DAEMON_PORT` env override still wins. Consumers pinning the env keep the pre-#1145 behavior.
- Clients running against pre-#1145 daemons (no `/api/health`, no lock-file `port`) fall through to `LEGACY_DEFAULT_PORT` (3117) — no breakage during the upgrade window.
- Daemons running against pre-#1145 clients keep working; the new port is just announced through the lock file the old client will ignore.

#### Data-integrity advisory

moflo versions ≤4.10.7 had a daemon-routing bug (#1145) where two moflo-using projects on the same machine could silently cross-write each other's databases during any overlap window. If you ran `flo memory store`, MCP `memory_store`, or `flo swarm` across multiple projects concurrently, audit `.moflo/moflo.db` in each project for foreign entries (especially in the `learnings`, `default`, `swarm-*`, and `tasklist` namespaces — indexer-populated namespaces like `guidance`, `code-map`, `tests`, `patterns` are safe because they bypass HTTP). See `docs/internal/1145-daemon-port-collision-analysis.md` §10.2 for the manual reconciliation procedure.

## [3.5.0] - 2026-02-27

### Ruflo v3.5 — First Major Stable Release

This release marks the official rebranding from **Claude Flow** to **Ruflo** and represents the first major stable release after 5,800+ commits, 55 alpha iterations, and 10 months of development.

### Highlights

- **Rebranding**: Claude Flow → Ruflo across all packages (`@moflo/cli`, `claude-flow`, `ruflo`)
- **agentic-flow v3.0.0-alpha.1 Integration**: Full deep integration with 10 subpath exports (ReasoningBank, Router, Orchestration, Agent Booster, SDK, Security, QUIC transport)
- **AgentDB v3.0.0-alpha.9**: 8 new controllers (HierarchicalMemory, MemoryConsolidation, SemanticRouter, GNNService, RVFOptimizer, MutationGuard, AttestationLog, GuardedVectorBackend) + 6 MCP tools
- **215 MCP Tools**: Full Model Context Protocol server with vector memory, neural training, swarm coordination
- **Security Hardening**: Command injection fix, TOCTOU race fix, eliminated hardcoded HMAC keys, timing attack fixes
- **Doctor Health Check**: New `agentic-flow` diagnostic (filesystem-based, ESM-compatible)
- **0 Production Vulnerabilities**: Clean `npm audit` across all packages

### Added

- `agentic-flow-bridge.ts` — Unified lazy-loading bridge for all agentic-flow v3 modules
- Tiered embedding resolution: ReasoningBank WASM (Tier 1) → @moflo/embeddings (Tier 2) → mock fallback (Tier 3)
- Agent Booster local import with npx fallback
- `checkAgenticFlow()` doctor health check
- 7 TypeScript module declarations for agentic-flow subpath exports
- ADR-056: agentic-flow v3 Integration Architecture

### Fixed

- Command injection vulnerability in enhanced-model-router.ts (SAFE_LANGUAGES whitelist)
- TOCTOU race condition in bridge singleton initialization (Promise-based caching)
- 22 agent/skill files updated from stale v1.5.11/v2.0.0-alpha to v3.0.0-alpha.1
- ESM compatibility for doctor checks (filesystem-based instead of `require.resolve`)
- (since removed) @ruvector/gnn pinned to 0.1.25 to fix fatal process crash (issue #216)

### Changed

- All 3 packages bumped from `3.1.0-alpha.55` to `3.5.0`
- Publish tags changed from `alpha`/`v3alpha` to `latest`
- agentic-flow minimum version: `0.1.0` → `3.0.0-alpha.1`
- agentdb minimum version: `2.0.0-alpha.3.4` → `3.0.0-alpha.10`

---

## [3.1.0-alpha.55] - 2026-02-27

### AgentDB 3.0.0-alpha.9 Integration (ADR-053/ADR-055)

- Activated 8 AgentDB v3 controllers with MutationGuard proof engine
- Added 6 new MCP tools: `agentdb_hierarchical_*`, `agentdb_consolidation_*`, `agentdb_semantic_*`
- Fixed controller registry activation bugs (ADR-055)
- Statusline fixes for real-time controller status
- (since removed) Pinned @ruvector/gnn@0.1.25 to fix fatal process crash

## [3.1.0-alpha.43] - 2026-02-15

### Ruflo Branding Fix

- Fixed CLI branding: show 'ruflo' instead of 'claude-flow' when run via `npx ruflo`
- Fixed Windows ESM import crash with `pathToFileURL`
- Fixed init hook prompt overflow and description field

## [3.1.0-alpha.36] - 2026-02-10

### Stability & Compatibility

- Fixed hooks backward compatibility: `--success` and `--file` made optional
- Fixed Windows npm install crash (404 optional dependencies)
- Bumped agentdb to 2.0.0-alpha.3.6
- Fixed V3 build errors (missing helmet, VERSION type, vitest spy)

## [3.1.0-alpha.29] - 2026-02-01

### Security & Agent Teams

- Security fixes, backward compatibility, and Agent Teams hooks
- Added `--settings` flag to upgrade command for Agent Teams
- Fixed npm 11 install crash by pinning agentdb

---

## v3.0.0-alpha Series (2025-10 to 2026-02)

### v3.0.0-alpha.184 — CLI Help & Categorization (2025-12)

- Fixed CLI help categorization across 26 commands
- Published install optimizations
- curl-style installer script
- SEO-optimized npm packages for discovery

### v3.0.0-alpha.170 — Plugins & Marketplace (2025-12)

- **Plugin Marketplace**: 8 official plugins + IPFS registry via Pinata
- **Gas Town Bridge Plugin**: WASM-accelerated orchestrator integration
- **10 RuVector WASM Plugins**: 50 MCP tools for neural computation
- **@moflo/teammate-plugin**: MCP tools for Agent Teams coordination

### v3.0.0-alpha.150 — SONA & SemanticRouter (2025-11)

- **SemanticRouter**: SONA WASM integration with verified benchmarks
- Fixed phantom Claude popups on Windows
- Fixed statusline safe multi-line output for Claude Desktop
- Fixed MCP tool naming (`/` → `_`) for Claude Desktop compatibility
- Memory namespace support in delete command

### v3.0.0-alpha.100 — @moflo/guidance (2025-11)

- **@moflo/guidance Control Plane**: Governance, compliance, and policy enforcement
- Wave 1: Proof, gateway, memory-gate, coherence, hooks, persistence primitives
- Wave 2: Conformance kit, capability algebra, evolution pipeline, artifact ledger
- Wave 3: Civilization-grade primitives (trust, truth, uncertainty, time, authority)
- **Rust WASM Policy Kernel**: SIMD128-accelerated policy evaluation
- **ContinueGate**: Safety gate for agent continuation decisions
- 22-benchmark suite with before/after performance reporting
- CLAUDE.md generators, analyzer, and auto-optimizer
- Content-aware executor with statistical validation (Spearman ρ, Cohen's d)

### v3.0.0-alpha.50 — Core V3 Implementation (2025-10)

- Complete V3 implementation across all ADRs
- ADR-003: Coordinator consolidation + security tests
- Complete hooks system with AgentDB, HNSW, tests
- ReasoningBank guidance system with CLI
- V2→V3 migration documentation
- MCP memory tools upgraded to sql.js + HNSW backend
- Claims-based authorization (ADR-016)
- Node.js worker daemon system
- Auto-update system for @claude-flow packages (ADR-025)
- Replaced all mock implementations with real functionality

### v3.0.0-alpha.1 — Foundation (2025-10)

- Complete V3 monorepo structure (`@moflo/cli`, `shared`, `memory`, `hooks`, `security`)
- 26 CLI commands with 140+ subcommands
- 215 MCP tools via FastMCP 3.x
- RuVector intelligence system (SONA, MoE, HNSW, EWC++, Flash Attention)
- Hive-Mind consensus (Byzantine, Raft, Gossip, CRDT, Quorum)
- 17 hooks + 12 background workers
- 60+ specialized agent types
- Cross-platform helper system

---

## v2.7.x Series (2025-08 to 2025-10)

### v2.7.34 — PostgreSQL & Neural Persistence

- PostgreSQL Bridge with attention, GNN, hyperbolic embeddings
- Neural pattern persistence to disk
- Hive-mind `--claude` flag for spawn command
- Real statusline data, hive-mind shutdown fixes, daemon persistence
- Multi-platform builds (Linux, macOS, Windows) in CI/CD

### v2.7.0 — agentic-flow Integration

- Deep integration with agentic-flow coordination engine
- SDK architecture analysis and hooks & learning integration
- Modular installation strategy
- Optimized v3 migration plan

---

## v2.0.0-alpha Series (2025-05 to 2025-08)

### v2.0.0-alpha.128 — Maturity

- Comprehensive hive-mind optimization
- Database schema robustness (missing columns, optimization errors)
- Auto-rebuild better-sqlite3 on NODE_MODULE_VERSION mismatch
- InMemoryStore interval cleanup for clean process exit

### v2.0.0-alpha.53 — Hook Safety

- Critical hook safety system
- Hive-mind optimization command
- Safety & security features documentation
- Neural Link System with safety protocols

### v2.0.0-alpha.33 — Windows & WSL

- Windows/WSL compatibility fixes
- Module import error resolution
- README restructure for v2.0.0 features
- Comprehensive test suite

---

## v1.x Series (2025-01 to 2025-05)

### v1.0.71 — Final v1 Release

- npm publishing compatibility
- Full CLI command functionality
- SPARC integration with full prompt loading
- Cross-platform support

### v1.0.50 — Swarm & SPARC

- Parallel execution for swarm tasks
- Background task management
- Swarm command with improved error handling
- Claude Code slash commands integration

### v1.0.28 — Project Management

- CLI project management commands
- System monitoring and SPARC commands
- Orchestration templates (monitoring, optimization, security review)

### v1.0.1 — Initial Release (2025-01-01)

- Complete Claude-Flow AI Agent Orchestration System
- Configuration guide and comprehensive tests
- Initial commit

---

## Milestone Summary

| Milestone | Version | Date | Key Feature |
|-----------|---------|------|-------------|
| Initial Release | v1.0.1 | 2025-01 | AI agent orchestration system |
| SPARC Integration | v1.0.50 | 2025-03 | Swarm + SPARC methodology |
| Alpha Foundation | v2.0.0-alpha.33 | 2025-05 | V2 alpha with hook safety |
| agentic-flow | v2.7.0 | 2025-08 | agentic-flow coordination engine |
| V3 Foundation | v3.0.0-alpha.1 | 2025-10 | V3 monorepo, 215 MCP tools |
| Plugin Marketplace | v3.0.0-alpha.170 | 2025-12 | 8 plugins + IPFS registry |
| Guidance Control Plane | v3.0.0-alpha.100 | 2026-01 | WASM policy kernel, ContinueGate |
| AgentDB v3 | v3.1.0-alpha.55 | 2026-02 | 8 controllers, MutationGuard |
| **Ruflo v3.5** | **v3.5.0** | **2026-02-27** | **First stable release, rebranding** |
