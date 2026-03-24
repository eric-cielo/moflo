# MoFlo Build, Test & Publish

Canonical build instructions. Follow these exactly — no improvisation.

## Prerequisites

- Node.js >= 20 (check: `node --version`)
- npm (comes with Node — no pnpm, no yarn, no bun)
- TypeScript installed at project root (`node_modules/typescript`)
- OTP authenticator for npm publish

## Directory

All commands run from the moflo project root: `/c/Users/eric/Projects/moflo`

**Never** `cd` into subdirectories to build. The root `package.json` drives everything.

## Step-by-Step: Build & Publish

### 1. Pull latest

```bash
git pull origin main
```

Always pull before starting work. Remote may have merged PRs since your last sync.

### 2. Build

```bash
npm run build
```

This runs `tsc -b` which builds all packages via TypeScript project references.

**Expected output:** no output (clean build). Any errors must be fixed before proceeding.

**Do NOT use:**
- `npm run build:ts` — broken, tries to find tsc in `src/node_modules/` which doesn't exist
- `cd src/@claude-flow/cli && npm run build` — same problem
- `npx tsc` from subdirectories — wrong resolution

### 3. Test

```bash
npm test
```

Runs `vitest run` with the root `vitest.config.ts`.

**Pass criteria:** 0 test failures. Worker OOM errors (3-4) are non-fatal background noise.
Current baseline: ~148 files passed, ~26 skipped, ~5500 tests.

### 4. Version bump

```bash
npm version patch --no-git-tag-version
```

This bumps `package.json` AND syncs `src/@claude-flow/cli/package.json` via the `version` lifecycle script.

For minor/major: replace `patch` with `minor` or `major`.

### 5. Rebuild after version bump

```bash
npm run build
```

The version change updates `package.json` files which may affect compiled output. Always rebuild.

### 6. Commit & PR

```bash
git checkout -b <branch-name>
git add <changed files> package.json package-lock.json src/@claude-flow/cli/package.json
git commit -m "description"
git push -u origin <branch-name>
gh pr create --title "..." --body "..."
gh pr merge <number> --squash --delete-branch --admin
```

### 7. Sync main & publish

```bash
git checkout main
git pull origin main
npm publish --otp=<code>
```

### 8. Verify

```bash
npm view moflo version          # Should match what you just published
```

## What NOT to Do

| Wrong | Why | Correct |
|-------|-----|---------|
| `cd src/@claude-flow/cli && npm run build` | tsc not in src/node_modules | `npm run build` from root |
| Publish without building | Ships stale .js artifacts | Always `npm run build` then verify exit 0 |
| Publish without testing | May ship broken code | Always `npm test` with 0 failures |
| Publish without pulling | Version conflicts, rebase hell | Always `git pull origin main` first |
| `npm run build:ts` | Uses broken workspace cd | `npm run build` (tsc -b) |
| Using pnpm/yarn/bun | Not configured, will create orphaned artifacts | npm only |

## Build Architecture

```
moflo/
├── package.json          ← Root: build scripts, version source of truth
├── tsconfig.json         ← Root: tsc -b entry point (project references)
├── vitest.config.ts      ← Root: test runner config
├── src/
│   ├── tsconfig.json     ← Workspace: references all @claude-flow/* packages
│   ├── tsconfig.base.json ← Shared compiler options (DO NOT DELETE)
│   └── @claude-flow/
│       ├── cli/          ← Main CLI package (@moflo/cli)
│       │   ├── tsconfig.json  ← References shared, swarm
│       │   └── dist/          ← Compiled output (committed)
│       ├── neural/       ← SONA, EWC++, LoRA, RL algorithms
│       ├── memory/       ← AgentDB, HNSW, persistent SONA
│       ├── shared/       ← Shared types, hooks, safety
│       └── ...           ← Other packages
└── bin/                  ← Indexer scripts (synced to consumer projects)
```

`tsc -b` follows the project reference chain from root → src → individual packages.
Compiled `.js` + `.d.ts` output goes to each package's `dist/` directory.
The `dist/` directories are committed and published — npm consumers get pre-compiled JS.
