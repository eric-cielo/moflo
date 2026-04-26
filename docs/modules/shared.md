# cli/shared

> **Inlined into `@moflo/cli` by [#595](https://github.com/eric-cielo/moflo/issues/595)** (epic [#586](https://github.com/eric-cielo/moflo/issues/586) / [ADR-0001](../adr/0001-collapse-moflo-workspace-packages.md)). The `@moflo/shared` workspace package no longer exists — its contents live at `src/cli/shared/` and ship inside the `moflo` tarball.

Shared types, events, hooks, plugin system, security, resilience, services, and core utilities used internally across the moflo codebase. Not exported as a separate npm package.

## Where things live

| Concern | Path |
|---------|------|
| Source | `src/cli/shared/` |
| Public surface | `src/cli/shared/index.ts` (named exports) |
| Tests | `src/cli/__tests__/shared/` |
| Path-safety helpers | `src/cli/services/moflo-require.ts` (the actual `mofloPath()` / `mofloUrl()` anchors live here, not in shared) |

