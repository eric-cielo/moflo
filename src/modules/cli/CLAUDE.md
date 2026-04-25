# @moflo/cli — CLI Package

Root CLAUDE.md rules apply here. This is the CLI entry point for moflo.

## Build

```bash
npm run build   # Compiles TypeScript to dist/
```

## Structure

- `src/commands/` — 40+ CLI commands
- `src/init/` — Project initialization (wizard, claudemd-generator, settings, mcp config)
- `src/mcp-tools/` — MCP tool definitions
- `src/plugins/` — Plugin system (store, discovery)
- `src/memory/` — Inlined ex-`@moflo/memory` (MofloDb adapter, HNSW, controllers, RVF, learning bridge) — see [docs/modules/memory.md](../../../docs/modules/memory.md)
- `src/neural/` — Inlined ex-`@moflo/neural` (SONA, ReasoningBank, RL algorithms, modes) — see [docs/modules/neural.md](../../../docs/modules/neural.md)
- `src/swarm/` — Inlined ex-`@moflo/swarm` (UnifiedSwarmCoordinator, MessageBus, consensus) — see [docs/modules/swarm.md](../../../docs/modules/swarm.md)
- `src/embeddings/`, `src/shared/`, `src/spells/`, `src/guidance/`, `src/aidefence/` — other inlined ex-packages from epic #586
- `bin/` — CLI entry point (`cli.js`)

## Key Rules

- This package is bundled into `moflo` on npm — it is NOT published separately
- The `claudemd-generator.ts` must produce minimal output (~40 lines injected into user's CLAUDE.md)
- All detailed docs belong in `.claude/guidance/shipped/moflo-core-guidance.md`, not in CLAUDE.md injection
