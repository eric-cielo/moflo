# src/ — MoFlo Monorepo Modules

Root CLAUDE.md rules apply here.

## Build & Test

```bash
# From src/modules/<package>
npm install && npm run build && npm test
```

## Packages

| Package | Path | Purpose |
|---------|------|---------|
| `@moflo/cli` | `modules/cli/` | CLI entry point (40+ commands); also hosts inlined `aidefence`, `embeddings`, `guidance`, `hooks`, `memory`, `neural`, `shared`, `spells`, `swarm` |

The repo no longer hosts `@moflo/testing` — the package was unreferenced by both production and test code (story #601, epic #586) and was removed entirely.

## Code Quality

- Files under 500 lines
- No hardcoded secrets
- Input validation at system boundaries
- Typed interfaces for all public APIs
