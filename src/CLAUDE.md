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
| `@moflo/cli` | `modules/cli/` | CLI entry point (40+ commands) |
| `@moflo/guidance` | `modules/guidance/` | Governance control plane |
| `@moflo/hooks` | `modules/hooks/` | Hooks + workers |
| `@moflo/memory` | `modules/memory/` | sql.js + HNSW vector search (MofloDb) |
| `@moflo/shared` | `modules/shared/` | Shared types and utilities |
| `@moflo/security` | `modules/security/` | Input validation, CVE remediation |
| `@moflo/embeddings` | `modules/embeddings/` | Vector embeddings (sql.js, HNSW) |
| `@moflo/neural` | `modules/neural/` | Neural patterns (SONA) |
| `@moflo/plugins` | `modules/plugins/` | Plugin system |
| `@moflo/spells` | `modules/spells/` | Spell engine |

## Code Quality

- Files under 500 lines
- No hardcoded secrets
- Input validation at system boundaries
- Typed interfaces for all public APIs
