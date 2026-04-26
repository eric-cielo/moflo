# `@moflo/*` Workspace Collapse — Dependency Graph

Epic [#586](https://github.com/eric-cielo/moflo/issues/586) is **complete**: every former workspace package has been inlined under `src/cli/` (or deleted as dead code), and as of story [#602](https://github.com/eric-cielo/moflo/issues/602) `cli` itself was lifted out of the `src/modules/<pkg>/` workspace layout into the root package's source tree.

The repo no longer exposes any `@moflo/*` bare specifiers in source. The static drift guard at `src/cli/__tests__/services/published-package-drift-guard.test.ts` enforces this — any reintroduction of a bare specifier fails the test.

This file is preserved (as opposed to deleted) so future link-backs from older epic discussions still resolve. The companion machine-readable form lives at `collapse-deps.json`.
