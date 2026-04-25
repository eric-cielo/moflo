# `@moflo/*` Workspace Collapse — Dependency Graph

Foundation artifact for the workspace-collapse epic. Companion to [`0001-collapse-moflo-workspace-packages.md`](./0001-collapse-moflo-workspace-packages.md) and machine-readable [`collapse-deps.json`](./collapse-deps.json).

> This file is **hand-curated narrative**. Numeric facts (adjacency, inbound/outbound counts, cycles) come from `scripts/analyze-collapse-deps.mjs`; reproduce them with the commands at the bottom and reconcile any divergence before merging.

The scanner walks three trees and produces the same edges in each:

| Tree | Notes |
|------|-------|
| `src/**/*.ts` (source) | Reference adjacency (canonical). File count: see `files` field in [`collapse-deps.json`](./collapse-deps.json). |
| `src/modules/*/dist/**/*.js` (compiled) | Identical adjacency to source — TypeScript build preserves edges. |
| `npm pack` tarball (consumer surface) | Same edges, but `testing` is excluded from the tarball (claims and aidefence were removed in #591/#590). |

The scanner strips `/* ... */` and `// ...` comments before matching `'@moflo/<pkg>'` so JSDoc mentions don't contaminate the graph. Both `from '@moflo/X'` and `import('@moflo/X')` are included, plus string-form references inside `mofloImport(...)` / `requireMofloOrWarn(...)` (the moflo-require helpers used to dodge consumer-project resolution).

## Adjacency list

Each row lists the `@moflo/*` packages a given module imports.

| Package | Outbound | Inbound | Imports |
|---------|----------|---------|---------|
| `cli` | 10 | 0 | `embeddings`, `guidance`, `hooks`, `memory`, `neural`, `plugins`, `security`, `shared`, `swarm`, `testing` |
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

Done so far: `aidefence` (inlined into cli/src in #590), `claims` (deleted as dead code in #591 — source had zero importers; cli has its own live `ClaimService` and `claims-tools.ts`), `embeddings` (inlined into cli/src in #592).

## Leaves (zero outbound `@moflo/*` imports — collapse first)

These have no relative paths to other moflo packages to rewrite, so they merge cleanly:

- `@moflo/aidefence` _(inlined in #590)_
- `@moflo/claims` _(deleted as dead code in #591 — package source had zero importers; cli has its own live impl)_
- `@moflo/embeddings` _(inlined into cli/src in #592)_
- `@moflo/plugins`
- `@moflo/security`
- `@moflo/shared`
- `@moflo/spells` _(also zero inbound — fully isolated)_
- `@moflo/swarm`

## Mid-tier (one level of fan-in or fan-out)

Collapse after leaves; each has a single dependency edge to rewrite:

- `@moflo/neural` → `memory`
- `@moflo/guidance` → `hooks`
- `@moflo/hooks` → `memory`, `security`
- `@moflo/testing` → `memory`, `shared`, `swarm` _(inline pending #601)_

## Trunk (highest fan-in / fan-out — collapse last)

- `@moflo/cli` — outbound 9, inbound 0. CLI is the ultimate consumer; flipping it changes every command surface. By the time everything else has collapsed, all of cli's `@moflo/*` imports become local.
- `@moflo/memory` — inbound 4 (cli, hooks, neural, testing). Touching memory's package boundary affects four call-site groups.

## Cycles

There is one cycle (also recorded under `cycles` in `collapse-deps.json`):

```
memory → neural (src/modules/memory/src/learning-bridge.ts:420)
neural → memory (src/modules/neural/src/reasoning-bank.ts:45)
```

Both edges are dynamic `await import(...)` guarded by try/catch — the runtime contract is "the other module is optional; degrade gracefully if absent." The cycle only exists at the package boundary; collapse removes it because both files end up in the same compilation unit.

## Topological collapse order (recommended)

After leaves and mid-tier are merged, the trunk falls in last. This ordering minimises work-in-progress: each step's `@moflo/*` imports are already local by the time we touch it.

1. `@moflo/aidefence` _(leaf, inlined in #590)_
2. `@moflo/claims` _(leaf, deleted as dead code in #591)_
3. `@moflo/embeddings` _(leaf, inlined into cli/src in #592)_
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

`npm pack` only ships **11** of the 12 remaining packages — `testing` is still excluded from `package.json#files`. It was declared `optionalDependencies: "file:../testing"` in `src/modules/cli/package.json` to look like a standalone package, but it is not actually published on npm (`npm view @moflo/testing` 404s). The standalone-publish framing is **leftover from the ruvnet/ruflo fork** — these packages have zero external consumers. (`aidefence` and `claims` shared this framing and were removed in #590 / #591.)

`@moflo/cli` (which DOES ship in the tarball) keeps live import strings to all three:

| Site | Form | Behaviour when missing |
|------|------|------------------------|
| `src/modules/cli/src/mcp-tools/auto-install.ts` | Registry entry (testing) | Surfaces in interactive install prompt |
| `src/modules/cli/src/update/checker.ts` | List of moflo packages | Skipped if not installed |
| `src/modules/cli/src/plugins/store/discovery.ts` | Featured/official catalogue | Listing-only, no runtime resolve |
| `src/modules/cli/package.json#optionalDependencies` | `"@moflo/<pkg>": "file:../<pkg>"` | Soft-fails npm-install; consumers can never `npm i @moflo/<pkg>` because it is not on npm |

(The aidefence and claims rows were removed as part of #590 / #591; #601 will remove `testing`.)

**Implication for the collapse epic:** the per-module stories for `aidefence`, `claims`, and `testing` collapse exactly like every other package — **inline**. Drop the `optionalDependencies` entries, the auto-install registry rows, the lazy-load retry paths in `security-tools.ts`, the phantom `optional-modules.d.ts` blocks, and the standalone-package marketing in `docs/modules/*.md`. There is no "keep separate" or "drop" branch to evaluate.

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
