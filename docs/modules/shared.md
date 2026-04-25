# cli/shared

> **Inlined into `@moflo/cli` by [#595](https://github.com/eric-cielo/moflo/issues/595)** (epic [#586](https://github.com/eric-cielo/moflo/issues/586) / [ADR-0001](../adr/0001-collapse-moflo-workspace-packages.md)). The `@moflo/shared` workspace package no longer exists — its contents live at `src/modules/cli/src/shared/` and ship inside the `moflo` tarball.

Shared types, events, hooks, plugin system, security, resilience, services, and core utilities used internally across the moflo codebase. Not exported as a separate npm package.

## Where things live

| Concern | Path |
|---------|------|
| Source | `src/modules/cli/src/shared/` |
| Public surface | `src/modules/cli/src/shared/index.ts` (named exports) |
| Tests | `src/modules/cli/__tests__/shared/` |
| Path-safety helpers | `src/modules/cli/src/services/moflo-require.ts` (the actual `mofloPath()` / `mofloUrl()` anchors live here, not in shared) |

## Cross-package access

The `testing` module dynamic-imports the inlined shared via a stable-marker walk-up at `src/modules/testing/src/locate-cli-shared.ts`. That helper disappears once the testing collapse story (#601) finishes.
