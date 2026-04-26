# src/ — MoFlo Source

Root CLAUDE.md rules apply here.

## Build & Test

```bash
npm run build   # tsc -b from repo root
npm test        # parallel + isolation passes
```

## Layout

- `cli/` — the moflo source tree (commands, init, hooks, memory, neural, swarm, spells, embeddings, guidance, aidefence, shared, mcp-server, mcp-tools, services, …). After workspace-collapse epic #586 this is the entire shipped package — no more `src/modules/<pkg>/` subtrees.

The compiled output lives at `dist/src/cli/**` and is what gets shipped to npm consumers.

## Code Quality

- Files under 500 lines
- No hardcoded secrets
- Input validation at system boundaries
- Typed interfaces for all public APIs
