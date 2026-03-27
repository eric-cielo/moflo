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
| `@claude-flow/guidance` | `packages/guidance/` | Governance control plane |
| `@claude-flow/hooks` | `packages/hooks/` | Hooks + workers |
| `@claude-flow/memory` | `packages/memory/` | AgentDB + HNSW vector search |
| `@claude-flow/shared` | `packages/shared/` | Shared types and utilities |
| `@claude-flow/security` | `packages/security/` | Input validation, CVE remediation |
| `@claude-flow/embeddings` | `packages/embeddings/` | Vector embeddings (sql.js, HNSW) |
| `@claude-flow/neural` | `packages/neural/` | Neural patterns (SONA) |
| `@claude-flow/plugins` | `packages/plugins/` | Plugin system + RuVector integration |

## Code Quality

- Files under 500 lines
- No hardcoded secrets
- Input validation at system boundaries
- Typed interfaces for all public APIs
