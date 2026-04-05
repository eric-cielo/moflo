# src/ — MoFlo Monorepo Packages

Root CLAUDE.md rules apply here.

## Build & Test

```bash
# From src/packages/<package>
npm install && npm run build && npm test
```

## Packages

| Package | Path | Purpose |
|---------|------|---------|
| `@moflo/cli` | `packages/cli/` | CLI entry point (40+ commands) |
| `@moflo/guidance` | `packages/guidance/` | Governance control plane |
| `@moflo/hooks` | `packages/hooks/` | Hooks + workers |
| `@moflo/memory` | `packages/memory/` | AgentDB + HNSW vector search |
| `@moflo/shared` | `packages/shared/` | Shared types and utilities |
| `@moflo/security` | `packages/security/` | Input validation, CVE remediation |
| `@moflo/embeddings` | `packages/embeddings/` | Vector embeddings (sql.js, HNSW) |
| `@moflo/neural` | `packages/neural/` | Neural patterns (SONA) |
| `@moflo/plugins` | `packages/plugins/` | Plugin system |

## Code Quality

- Files under 500 lines
- No hardcoded secrets
- Input validation at system boundaries
- Typed interfaces for all public APIs
