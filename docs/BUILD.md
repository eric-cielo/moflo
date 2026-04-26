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

This runs `tsc` against the single root `tsconfig.json`. After workspace-collapse epic #586 there are no project references, no per-module tsconfigs, and no per-module `dist/` directories.

**Expected output:** no output (clean build). Any errors must be fixed before proceeding.

### 3. Test

```bash
npm test
```

Runs `scripts/test-runner.mjs` — a parallel pass via vitest plus a sequential isolation pass for the files listed in `vitest.config.ts:isolationTests`.

**Pass criteria:** 0 test failures.

### 4. Version bump

```bash
npm version patch --no-git-tag-version
```

This bumps `package.json` and the `version` lifecycle script syncs `src/cli/version.ts`.

For minor/major: replace `patch` with `minor` or `major`.

### 5. Rebuild after version bump

```bash
npm run build
```

The version change updates `src/cli/version.ts` which gets compiled into `dist/`. Always rebuild.

### 6. Commit & PR

```bash
git checkout -b <branch-name>
git add <changed files> package.json package-lock.json
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
| Publish without building | Ships stale `.js` artifacts — `prepublishOnly` runs `npm run build` which will fail-fast on errors | Always `npm run build` then verify exit 0 |
| Publish without testing | May ship broken code | Always `npm test` with 0 failures |
| Publish without pulling | Version conflicts, rebase hell | Always `git pull origin main` first |
| Using pnpm/yarn/bun | Not configured, will create orphaned artifacts | npm only |
| Adding `composite: true` or project references | Single-package layout — adds coordination cost with no benefit | Plain `tsc` from one root config |

## Adding New Scripts to `bin/`

When you add a new `.mjs` script to `bin/`, you **must** also add it to the `scriptFiles` array in `bin/session-start-launcher.mjs` (~line 112). This array controls which scripts get synced from `node_modules/moflo/bin/` to `.claude/scripts/` in consumer projects on version change. If a script is missing from this list, it will never be copied and any hook that references it will silently fail.

**Checklist for new scripts:**

1. Add the script to `bin/`
2. Add its filename to `scriptFiles` in `bin/session-start-launcher.mjs`
3. Mirror the same change in `.claude/scripts/session-start-launcher.mjs` (the dev copy)
4. Update the test list in `src/cli/__tests__/services/auto-update.test.ts`

## Build Architecture

```
moflo/
├── package.json          ← Root: build scripts, version source of truth
├── tsconfig.json         ← Root: single tsc entry point (no project references)
├── vitest.config.ts      ← Root: test runner config
├── src/
│   ├── cli/              ← Entire shipped source tree (commands, hooks, memory,
│   │                        neural, swarm, spells, embeddings, guidance,
│   │                        aidefence, services, mcp-server, mcp-tools, …)
│   └── __tests__/        ← Top-level integration tests (extend root tsconfig)
├── dist/                 ← Build output: `dist/src/cli/**` ships to npm
└── bin/                  ← CLI entry points (synced to consumer projects)
```

`tsc` reads `tsconfig.json` and emits compiled `.js` + `.d.ts` to `dist/src/cli/**`. The `dist/` directory is not committed; it is rebuilt via `prepublishOnly` before each publish.

## Package Contents (`files` field)

The `files` array in root `package.json` controls what ships to npm. This is carefully curated — do not add broad globs like `.claude/**` or `**/*.d.ts`.

### What's included and why

| Pattern | Purpose |
|---------|---------|
| `bin/**` | CLI entry points (`flo`, `flo-search`, etc.) |
| `dist/src/cli/**/*.js` | Compiled runtime code |
| `dist/src/cli/**/*.d.ts` | Type declarations |
| `dist/src/cli/**/*.yaml` | Bundled YAML resources (spells, agents) |
| `src/cli/agents/**` | Source-form agent definitions used at runtime |
| `src/cli/data/**` | Static data files (model registry, etc.) |
| `.claude/commands/**/*.md` | Slash commands — copied to user projects by `flo init` |
| `.claude/agents/**/*.md` | Agent definitions — copied to user projects by `flo init` |
| `.claude/helpers/**` | Hook scripts (statusline, gate, auto-memory) — copied by `flo init` |
| `.claude/guidance/shipped/**` | Shipped guidance docs — synced by `flo init` |
| `.claude/skills/**/*.md` | Skill definitions — copied by `flo init` |
| `spells/shipped/**` | Shipped spell definitions |
| `scripts/prune-native-binaries.mjs` | Postinstall script |
| `README.md`, `LICENSE` | Standard package metadata |

### What's excluded and why

| Excluded | Why |
|----------|-----|
| `**/*.map` | Source maps are dev-only |
| `**/__tests__/**`, `**/*.test.js`, `**/*.spec.js` | Tests don't ship |
| `.claude/**/*.db` | Database files are dev-only |

### Pre-publish verification

Always verify package contents before publishing:

```bash
# 1. Check file count and size
npm pack --dry-run 2>&1 | tail -10

# 2. Build tarball and test-install
npm pack
mkdir -p /tmp/moflo-test && cd /tmp/moflo-test && npm init -y && npm install /path/to/moflo-x.y.z.tgz

# 3. Verify CLI works
flo --version
flo doctor

# 4. Verify init assets shipped
ls node_modules/moflo/.claude/guidance/shipped/
ls node_modules/moflo/.claude/commands/
ls node_modules/moflo/.claude/agents/

# 5. Clean up
cd - && rm -rf /tmp/moflo-test && rm moflo-*.tgz
```

The CI consumer-install smoke test (`harness/consumer-smoke/run.mjs`) automates the same checks on every PR.
