# cli

> **Single-package home — there is no `@moflo/cli` workspace package.**
> After [ADR-0001](../adr/0001-collapse-moflo-workspace-packages.md) (epic [#586](https://github.com/eric-cielo/moflo/issues/586), final story [#602](https://github.com/eric-cielo/moflo/issues/602)), `src/cli/` is the entire `moflo` source tree. This file is the index for the sibling per-subsystem docs in this directory.

For the authoritative layout of `src/cli/`, see [src/cli/CLAUDE.md](../../src/cli/CLAUDE.md).

## Collapsed ex-`@moflo/*` subsystems

Each of these used to be a workspace package; all are now inlined under `src/cli/<area>/` and ship inside the single `moflo` tarball.

- [aidefence.md](aidefence.md) — AI manipulation defense (`src/cli/aidefence/`)
- [embeddings.md](embeddings.md) — fastembed neural embeddings (`src/cli/embeddings/`)
- [guidance.md](guidance.md) — long-horizon governance (`src/cli/guidance/`)
- [hooks.md](hooks.md) — hook registry, daemons, statusline, workers (`src/cli/hooks/`)
- [memory.md](memory.md) — MofloDb adapter, HNSW, learning bridge (`src/cli/memory/`)
- [neural.md](neural.md) — SONA, ReasoningBank, RL algorithms (`src/cli/neural/`)
- [security.md](security.md) — deleted as dead code in [#594](https://github.com/eric-cielo/moflo/issues/594)
- [shared.md](shared.md) — shared types / utilities (`src/cli/shared/`)
- [spells.md](spells.md) — spell engine (`src/cli/spells/`)
- [swarm.md](swarm.md) — coordination engine (`src/cli/swarm/`)

## Subtrees that were never workspace packages

These have always lived at the root of the cli source tree and have no per-subsystem doc — see `src/cli/CLAUDE.md` for the layout summary, or read the sources directly.

- `commands/` — 40+ CLI commands (`flo doctor`, `flo memory`, `flo spell`, `flo hooks`, …)
- `init/` — `flo init` wizard, `claudemd-generator`, settings, MCP config
- `mcp-server.ts`, `mcp-client.ts`, `mcp-tools/` — MCP entry points and tool definitions
- `plugins/` — plugin discovery and store
- `services/` — `engine-loader`, `grimoire-builder`, `findProjectRoot`, path anchors

## Binary entry

`bin/cli.js` proxies to compiled `dist/src/cli/index.js`. The `flo`, `moflo`, and `claude-flow` aliases all point at the same entry.
