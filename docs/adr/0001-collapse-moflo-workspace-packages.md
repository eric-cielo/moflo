# ADR-0001 — Collapse `@moflo/*` Workspace Packages into a Single `moflo` Package

- **Status:** Implemented
- **Date:** 2026-04-24 (decided), 2026-04-25 (implemented)
- **Related:** Epic [#586](https://github.com/eric-cielo/moflo/issues/586), final story [#602](https://github.com/eric-cielo/moflo/issues/602), `feedback_no_fixed_depth_paths.md`, `feedback_no_stale_docs.md`, `feedback_optional_deps_gotcha.md`
- **Foundation artifacts:** [`collapse-deps.json`](./collapse-deps.json), [`collapse-deps.md`](./collapse-deps.md)
- **Outcome:** every former `@moflo/<pkg>` workspace package is now inlined under `src/cli/` (or deleted as dead code). The repo no longer has a `src/modules/` tree, no per-package `tsconfig.json`/`package.json`, and no bare `@moflo/*` specifiers in source.

## Context

`moflo` is shipped on npm as a single package, but the source is laid out as a **14-package workspace** under `src/modules/<pkg>/`. Each package has its own `package.json` declaring `"name": "@moflo/<pkg>"`, its own `tsconfig.json`, and its own `dist/` build output. The 14 packages are:

`aidefence`, `claims`, `cli`, `embeddings`, `guidance`, `hooks`, `memory`, `neural`, `plugins`, `security`, `shared`, `spells`, `swarm`, `testing`.

The published tarball (`npm pack`) bundles only **11** of these (cli, embeddings, guidance, hooks, memory, neural, plugins, security, shared, spells, swarm). The remaining three — `aidefence`, `claims`, `testing` — publish as their own separate npm packages and are pulled in via `optionalDependencies` from `@moflo/cli`.

### What goes wrong with this layout

1. **Bare `@moflo/X` specifiers don't resolve in consumer installs.** When a user runs `npx moflo` from their own project, Node resolves `import '@moflo/memory'` against the consumer's `node_modules/`, not moflo's. Consumer projects don't have `@moflo/memory` installed (it ships _inside_ `node_modules/moflo/src/modules/memory/dist/`), so resolution fails. We worked around this with `mofloImport()` and `locateMofloModuleDist()` (`src/cli/services/moflo-require.ts`) — a `createRequire`-anchored helper that walks up to find the right `dist/` folder. That helper now has 11 call sites and a 12-deep walk cap with caching. It exists purely because the workspace layout doesn't match the shipping reality.

2. **Cross-package relative paths leak build layout.** Where the import-string workaround is inconvenient, modules use literal `../../../shared/dist/utils/atomic-file-write.js` paths (e.g. `src/modules/embeddings/src/utils/atomic-file-write.ts`). Those break the moment source/dist depth changes, which is why `feedback_no_fixed_depth_paths.md` and PR #581 added a guard. The guard is symptom-treatment for layout that shouldn't exist.

3. **Build coordination tax.** Every module has its own `tsconfig.json`, `vitest.config.ts`, and build script. `tsc -b` orchestrates project references; one missing reference and a cross-package edit silently uses stale `dist/` output. New contributors hit this immediately.

4. **Versioning theatre.** Module package.json files declare `"@moflo/memory": "^3.0.0-alpha.2"` peer/optional deps even though the version is a fiction — only the root `moflo` package is published, and its single `version` field is what consumers see. Internal version drift can't actually mean anything because consumers always get the matching set in one tarball.

5. **No real spin-off path anyway.** The original justification for the workspace layout was theoretical: "we might publish individual packages later." The project owner has confirmed this is **not a goal** for moflo. We're paying the workspace tax for an option we don't intend to exercise.

### Dependency graph snapshot

From [`collapse-deps.md`](./collapse-deps.md):

- **Leaves (zero outbound `@moflo/*` imports):** `aidefence`, `claims`, `embeddings`, `guidance`, `hooks`, `plugins`, `security`, `shared`, `spells`, `swarm`, `memory`, `neural` (13/14 — `aidefence` inlined in #590, `claims` deleted in #591, `embeddings` inlined in #592, `plugins` deleted in #593, `guidance` inlined in #600, `spells` inlined in #596, `swarm` inlined in #597, `memory + neural` inlined together in #598, `hooks` inlined in #599)
- **Mid-tier:** `testing` → `cli` (walk-up)
- **Trunk:** `cli` (the inlined home for all collapsed packages)
- **Cycle:** ~~`memory ↔ neural`~~ (resolved by #598 — both packages share a compilation unit, dynamic imports replaced with sibling relative imports)

The graph is identical between TypeScript source and compiled `dist/` output. The published tarball preserves the same edges but is missing three packages (the optional add-ons).

## Decision

**Collapse all 14 `@moflo/*` workspace packages into the single root `moflo` package.**

Concretely:

1. Move every `src/modules/<pkg>/src/*` tree into a single source tree under the root `moflo` package — final layout TBD by the per-module stories, but the constraint is "no internal `@moflo/*` import strings remain."
2. Delete the per-module `package.json`, `tsconfig.json`, and `vitest.config.ts` files. One root build, one root test run.
3. Replace all `from '@moflo/X'` and `import('@moflo/X')` with relative imports that don't need the moflo-require walk-up.
4. Delete `src/cli/services/moflo-require.ts` and its 11 call sites. Replace `mofloImport`/`locateMofloModuleDist`/`requireMofloOrWarn` with direct relative imports.
5. Delete `feedback_no_fixed_depth_paths.md`'s ESLint guard (the rule is moot once there's only one package depth).
6. Inline the three "optional add-on" packages (`aidefence`, `claims`, `testing`) into the root tree on the same terms as every other package. They are `optionalDependencies: "file:../X"` workspace fictions left over from the ruvnet/ruflo fork — none is actually published to npm (verify with `npm view @moflo/X`), and there are no external consumers to protect. Drop the optional-dependency machinery entirely; do not preserve a "standalone install" affordance.

The collapse runs **leaves first** per the topological order in [`collapse-deps.md`](./collapse-deps.md), so each step's existing `@moflo/*` imports become trivially local by the time it's touched.

## Alternatives considered

### A. Keep the workspace + use `bundledDependencies`

Declare each `@moflo/X` as a real npm dependency and let `npm pack` bundle them via `bundledDependencies`. This would fix the consumer-resolution problem (the packages would actually be in `node_modules/moflo/node_modules/@moflo/X/`) without touching source.

**Rejected** because:

- It doubles the install footprint — every package gets its own `node_modules/` copy of any shared transitive deps.
- The version-drift theatre stays. Each `@moflo/X/package.json` still declares versions that don't matter.
- `npm pack` with bundled deps is fragile across npm/pnpm/yarn — we'd be debugging packager edge cases instead of writing code.
- The build coordination tax (per-module tsconfig, per-module vitest) is unchanged.

### B. Keep the layout, ban `@moflo/*` strings, allow only relative paths

Delete the moflo-require helper, mandate `../../<other-pkg>/src/...` everywhere, and rely on the existing ESLint rule from #581 to enforce no fixed-depth paths via a stable-marker walk-up.

**Rejected** because:

- It enshrines exactly the cross-package coupling we want to eliminate, just under different syntax.
- The 14 separate `tsconfig.json` files still need project references and stale-build coordination.
- Per-module test runners still split CI into 14 sub-jobs.
- We end up with one package's source code reaching across ten directory boundaries to import from another — strictly worse readability than a single tree.

### C. Status quo (do nothing)

**Rejected** because the cost is paid every release: see PR #582 (sandbox image-name drift), PR #575 / #581 (fixed-depth path audit), the ongoing `mofloImport` retrofit. Each is real work driven by the layout. Removing the layout removes the recurring tax.

## Consequences

### Positive

- One `package.json`, one `tsconfig.json`, one test runner, one build. CI gets simpler; new-contributor ramp shortens dramatically.
- The moflo-require helper, the fixed-depth-path ESLint rule, and the `clean-dist` orphan checker either disappear or shrink to thin shells.
- Internal refactors stop tripping over package boundaries. Renaming a function in `shared` doesn't require coordinating four `@moflo/X/package.json` version bumps.
- Consumer surface stays identical — `moflo` on npm continues to be the single shipping name.
- The 14-package illusion goes away. Anyone reading the source can trust that the layout matches reality.

### Negative / cost

- Lose the (theoretical, never-exercised) ability to publish individual `@moflo/X` packages on npm. The project owner has explicitly declared this a non-goal.
- One-shot churn: every internal import string gets rewritten. The collapse epic is sized accordingly.
- Test files currently scoped per-package run together once collapsed — global test setup needs review for shared state. (Mitigated by current `vitest.config.ts isolationTests` mechanism, which already handles this for the cross-package tests we have.)
- IDE workspace folders that pin to `src/modules/<pkg>/` will need re-pinning. One-time, low-effort.

### Risks and mitigations

- **Risk:** test runner picks up cross-test pollution that was previously hidden by per-package isolation. **Mitigation:** `vitest.config.ts` has the `isolationTests` list (`feedback_vitest_isolation_list.md`); audit during the collapse and extend as needed.
- **Risk:** something downstream depends on `@moflo/<pkg>` as an importable string (e.g., a plugin loaded via `import('@moflo/X')`). **Mitigation:** the dependency graph artifact catches every such reference; the collapse stories must address each. The plugin-store registry advertises `@moflo/security`, etc. — those entries will be revisited as part of the optional-add-on resolution.
- **Risk:** the three optional add-ons (`aidefence`, `claims`, `testing`) are out of the tarball today; collapsing them in changes that. **Mitigation:** the decision is per-package and tracked in the epic. Each can independently inline / stay-separate / drop.

## Migration plan

The per-module stories in the workspace-collapse epic each:

1. Pick the next package by topological order (leaves first; see [`collapse-deps.md`](./collapse-deps.md)).
2. Move that package's `src/` tree into the unified layout.
3. Rewrite all import strings that pointed at it to use the new relative path.
4. Delete the package's own `package.json`, `tsconfig.json`, `vitest.config.ts`.
5. Update any moflo-require call sites that referenced it.
6. Run the full test suite + smoke harness; fix anything broken.
7. Open a PR for that single package's collapse.

The epic completes when all 14 packages are merged, the moflo-require helper is deleted, and the `files` array in the root `package.json` no longer enumerates per-module dist paths.

## Verification

The dependency graph in [`collapse-deps.json`](./collapse-deps.json) is the source of truth for "is this collapse complete?" After each story merges:

```bash
node scripts/analyze-collapse-deps.mjs --src --json /tmp/post-merge.json
jq '.adjacency | to_entries | map(select(.value | length > 0))' /tmp/post-merge.json
```

When that command returns `[]` and `jq '.rootRefs | length' /tmp/post-merge.json` returns `0`, the workspace collapse is done.
