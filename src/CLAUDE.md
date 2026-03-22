# src/ — MoFlo Monorepo Packages

Root CLAUDE.md rules apply here.

## Build & Test

```bash
# From src/@claude-flow/<package>
npm install && npm run build && npm test
```

## Packages

| Package | Path | Purpose |
|---------|------|---------|
| `@moflo/cli` | `@claude-flow/cli/` | CLI entry point (40+ commands) |
| `@claude-flow/guidance` | `@claude-flow/guidance/` | Governance control plane |
| `@claude-flow/hooks` | `@claude-flow/hooks/` | Hooks + workers |
| `@claude-flow/memory` | `@claude-flow/memory/` | AgentDB + HNSW vector search |
| `@claude-flow/shared` | `@claude-flow/shared/` | Shared types and utilities |
| `@claude-flow/security` | `@claude-flow/security/` | Input validation, CVE remediation |
| `@claude-flow/embeddings` | `@claude-flow/embeddings/` | Vector embeddings (sql.js, HNSW) |
| `@claude-flow/neural` | `@claude-flow/neural/` | Neural patterns (SONA) |
| `@claude-flow/plugins` | `@claude-flow/plugins/` | Plugin system + RuVector integration |

## Code Quality

- Files under 500 lines
- No hardcoded secrets
- Input validation at system boundaries
- Typed interfaces for all public APIs
