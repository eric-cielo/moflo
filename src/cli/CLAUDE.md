# src/cli/ — moflo source

Root CLAUDE.md rules apply here. After epic #586 / story #602, this directory holds the entire moflo package source — there is no longer a separate `@moflo/cli` workspace package.

## Layout

- `commands/` — 40+ CLI commands
- `init/` — Project initialization (wizard, claudemd-generator, settings, mcp config)
- `mcp-tools/` — MCP tool definitions
- `mcp-server.ts`, `mcp-client.ts` — MCP entry points
- `plugins/` — Plugin system (store, discovery)
- `memory/` — MofloDb adapter, HNSW, controllers, RVF, learning bridge (ex-`@moflo/memory`, story #598) — see [docs/modules/memory.md](../../docs/modules/memory.md)
- `neural/` — SONA, ReasoningBank, RL algorithms, modes (ex-`@moflo/neural`) — see [docs/modules/neural.md](../../docs/modules/neural.md)
- `swarm/` — UnifiedSwarmCoordinator, MessageBus, consensus (ex-`@moflo/swarm`, story #597) — see [docs/modules/swarm.md](../../docs/modules/swarm.md)
- `hooks/` — HookRegistry, executor, daemons, ReasoningBank, statusline, workers (ex-`@moflo/hooks`) — see [docs/modules/hooks.md](../../docs/modules/hooks.md)
- `embeddings/`, `shared/`, `spells/`, `guidance/`, `aidefence/` — other inlined ex-packages from epic #586
- `__tests__/` — vitest test tree
- `agents/`, `data/`, `scripts/`, `epic/spells/` — non-TS assets shipped with the package

## Key Rules

- This source compiles to `dist/src/cli/` at the repo root.
- The CLI binary entry is `bin/cli.js` (proxies to compiled `dist/src/cli/index.js`).
- The `claudemd-generator.ts` must produce minimal output (~40 lines injected into user's CLAUDE.md). All detailed docs belong in `.claude/guidance/shipped/moflo-core-guidance.md`, not in CLAUDE.md injection.
