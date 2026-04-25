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
| `@moflo/cli` | `modules/cli/` | CLI entry point (40+ commands); also hosts inlined `aidefence`, `embeddings`, `guidance`, `shared`, `spells` |
| `@moflo/hooks` | `modules/hooks/` | Hooks + workers |
| `@moflo/memory` | `modules/memory/` | sql.js + HNSW vector search (MofloDb) |
| `@moflo/neural` | `modules/neural/` | Neural patterns (SONA) |

## Code Quality

- Files under 500 lines
- No hardcoded secrets
- Input validation at system boundaries
- Typed interfaces for all public APIs
