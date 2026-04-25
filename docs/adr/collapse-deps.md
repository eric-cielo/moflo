# `@moflo/*` Workspace Collapse — Dependency Graph

Foundation artifact for the workspace-collapse epic. Companion to [`0001-collapse-moflo-workspace-packages.md`](./0001-collapse-moflo-workspace-packages.md) and machine-readable [`collapse-deps.json`](./collapse-deps.json).

> This file is **hand-curated narrative**. Numeric facts (adjacency, inbound/outbound counts, cycles) come from `scripts/analyze-collapse-deps.mjs`; reproduce them with the commands at the bottom and reconcile any divergence before merging.

The scanner walks three trees and produces the same edges in each:

| Tree | Files | Notes |
|------|-------|-------|
| `src/**/*.ts` (source) | 1016 | Reference adjacency (canonical) |
| `src/modules/*/dist/**/*.js` (compiled) | 651 | Identical adjacency to source — TypeScript build preserves edges |
| `npm pack` tarball (consumer surface) | 602 | Same edges, but only 11 of 14 packages ship inside the tarball |

The scanner strips `/* ... */` and `// ...` comments before matching `'@moflo/<pkg>'` so JSDoc mentions don't contaminate the graph. Both `from '@moflo/X'` and `import('@moflo/X')` are included, plus string-form references inside `mofloImport(...)` / `requireMofloOrWarn(...)` (the moflo-require helpers used to dodge consumer-project resolution).

## Adjacency list

Each row lists the `@moflo/*` packages a given module imports.

| Package | Outbound | Inbound | Imports |
|---------|----------|---------|---------|
| `aidefence` | 0 | 1 | _leaf_ |
| `claims` | 0 | 1 | _leaf_ |
| `cli` | 9 | 0 | `aidefence`, `claims`, `embeddings`, `memory`, `neural`, `plugins`, `security`, `shared`, `testing` |
| `embeddings` | 0 | 4 | _leaf_ |
| `guidance` | 2 | 0 | `embeddings`, `hooks` |
| `hooks` | 3 | 1 | `embeddings`, `memory`, `security` |
| `memory` | 2 | 4 | `embeddings`, `neural` |
| `neural` | 1 | 2 | `memory` |
| `plugins` | 0 | 1 | _leaf_ |
| `security` | 0 | 2 | _leaf_ |
| `shared` | 0 | 2 | _leaf_ |
| `spells` | 0 | 0 | _leaf, isolated_ |
| `swarm` | 0 | 1 | _leaf_ |
| `testing` | 3 | 1 | `memory`, `shared`, `swarm` |

## Leaves (zero outbound `@moflo/*` imports — collapse first)

These have no relative paths to other moflo packages to rewrite, so they merge cleanly:

- `@moflo/aidefence` _(separately published, not in moflo tarball)_
- `@moflo/claims` _(separately published, not in moflo tarball)_
- `@moflo/embeddings`
- `@moflo/plugins`
- `@moflo/security`
- `@moflo/shared`
- `@moflo/spells` _(also zero inbound — fully isolated)_
- `@moflo/swarm`

`@moflo/embeddings` is technically a leaf in the package-import graph, but it _does_ reach into `@moflo/shared` via a runtime filesystem walk-up to `../../../shared/dist/utils/atomic-file-write.js` (`src/modules/embeddings/src/utils/atomic-file-write.ts`). After collapse, that walk-up becomes a normal local import — strictly an improvement.

## Mid-tier (one level of fan-in or fan-out)

Collapse after leaves; each has a single dependency edge to rewrite:

- `@moflo/neural` → `memory`
- `@moflo/guidance` → `embeddings`, `hooks`
- `@moflo/hooks` → `embeddings`, `memory`, `security`
- `@moflo/testing` → `memory`, `shared`, `swarm` _(separately published)_

## Trunk (highest fan-in / fan-out — collapse last)

- `@moflo/cli` — outbound 9, inbound 0. CLI is the ultimate consumer; flipping it changes every command surface. By the time everything else has collapsed, all of cli's `@moflo/*` imports become local.
- `@moflo/memory` — inbound 4 (cli, hooks, neural, testing). Touching memory's package boundary affects four call-site groups.
- `@moflo/embeddings` — inbound 4 (cli, guidance, hooks, memory). Already a leaf; the inbound count just means the rewrite is broad but mechanical.

## Cycles

There is one cycle (also recorded under `cycles` in `collapse-deps.json`):

```
memory → neural (src/modules/memory/src/learning-bridge.ts:420)
neural → memory (src/modules/neural/src/reasoning-bank.ts:45)
```

Both edges are dynamic `await import(...)` guarded by try/catch — the runtime contract is "the other module is optional; degrade gracefully if absent." The cycle only exists at the package boundary; collapse removes it because both files end up in the same compilation unit.

## Topological collapse order (recommended)

After leaves and mid-tier are merged, the trunk falls in last. This ordering minimises work-in-progress: each step's `@moflo/*` imports are already local by the time we touch it.

1. `@moflo/aidefence` _(leaf, optional add-on)_
2. `@moflo/claims` _(leaf, optional add-on)_
3. `@moflo/embeddings` _(leaf)_
4. `@moflo/plugins` _(leaf)_
5. `@moflo/security` _(leaf)_
6. `@moflo/shared` _(leaf)_
7. `@moflo/spells` _(leaf, isolated)_
8. `@moflo/swarm` _(leaf)_
9. `@moflo/neural` _(after memory or in same step due to cycle)_
10. `@moflo/memory` _(after neural)_
11. `@moflo/hooks`
12. `@moflo/guidance`
13. `@moflo/testing`
14. `@moflo/cli` _(trunk — last)_

Steps 9–10 must move together because of the dynamic-import cycle.

## Consumer-surface caveat (the published tarball)

`npm pack` only ships **11** of the 14 packages — `aidefence`, `claims`, and `testing` are deliberately excluded from `package.json#files`. They publish as their own npm packages.

`@moflo/cli` (which DOES ship in the tarball) keeps live import strings to all three:

| Site | Form | Behaviour when missing |
|------|------|------------------------|
| `src/modules/cli/src/mcp-tools/security-tools.ts` | `await import('@moflo/aidefence')` | Throws `AIDefence package not available. Install with: npm install @moflo/aidefence` |
| `src/modules/cli/src/commands/security.js` | `await import('@moflo/aidefence')` | Same error path |
| `src/modules/cli/src/mcp-tools/auto-install.ts` | Registry entry | Surfaces in interactive install prompt |
| `src/modules/cli/src/update/checker.ts` | List of moflo packages | Skipped if not installed |
| `src/modules/cli/src/plugins/store/discovery.ts` | Featured/official catalogue | Listing-only, no runtime resolve |
| `src/modules/cli/package.json#optionalDependencies` | `"@moflo/aidefence": "file:../aidefence"` | Soft-fails npm-install; consumers must `npm i @moflo/aidefence` separately |

**Implication for the collapse epic:** these "optional add-on" references must be converted to one of three end states by the per-module stories:

1. **Inline** — pull aidefence/claims/testing into the root `moflo` package and remove the optional-dependency machinery (loses the "install only what you need" affordance).
2. **Keep separate** — leave aidefence/claims/testing as standalone npm packages but rewrite cli's references to use the established lazy-load pattern (today's behaviour, just made explicit).
3. **Drop** — remove the optional features entirely if they're underused.

The choice is per-package and out of scope for this artifact; the dependency graph just records that the references exist and ship live in the cli.

## Reproducing this artifact

```bash
# Source tree (canonical) — regenerates collapse-deps.json
node scripts/analyze-collapse-deps.mjs --src --json docs/adr/collapse-deps.json

# Compiled dist (parity check)
npm run build
node scripts/analyze-collapse-deps.mjs --dist --json /tmp/dist.json
diff <(jq .adjacency docs/adr/collapse-deps.json) <(jq .adjacency /tmp/dist.json)

# Published tarball (consumer surface)
npm pack --pack-destination /tmp
mkdir -p /tmp/moflo-pack && tar -xzf /tmp/moflo-*.tgz -C /tmp/moflo-pack
node scripts/analyze-collapse-deps.mjs --tarball /tmp/moflo-pack/package --json /tmp/tarball.json
```

If the regenerated `collapse-deps.json` adjacency differs from this file's tables, treat the JSON as truth and update the tables here.
