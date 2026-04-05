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
- `cd src/modules/cli && npm run build` — same problem
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

This bumps `package.json` AND syncs `src/modules/cli/package.json` via the `version` lifecycle script.

For minor/major: replace `patch` with `minor` or `major`.

### 5. Rebuild after version bump

```bash
npm run build
```

The version change updates `package.json` files which may affect compiled output. Always rebuild.

### 6. Commit & PR

```bash
git checkout -b <branch-name>
git add <changed files> package.json package-lock.json src/modules/cli/package.json
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
| `cd src/modules/cli && npm run build` | tsc not in src/node_modules | `npm run build` from root |
| Publish without building | Ships stale .js artifacts — `prepublishOnly` now runs `npm run build` which will fail-fast on errors | Always `npm run build` then verify exit 0 |
| Publish without testing | May ship broken code | Always `npm test` with 0 failures |
| Publish without pulling | Version conflicts, rebase hell | Always `git pull origin main` first |
| `npm run build:ts` | Uses broken workspace cd | `npm run build` (tsc -b) |
| Using pnpm/yarn/bun | Not configured, will create orphaned artifacts | npm only |

## Adding New Scripts to `bin/`

When you add a new `.mjs` script to `bin/`, you **must** also add it to the `scriptFiles` array in `bin/session-start-launcher.mjs` (~line 112). This array controls which scripts get synced from `node_modules/moflo/bin/` to `.claude/scripts/` in consumer projects on version change. If a script is missing from this list, it will never be copied and any hook that references it will silently fail.

**Checklist for new scripts:**

1. Add the script to `bin/`
2. Add its filename to `scriptFiles` in `bin/session-start-launcher.mjs`
3. Mirror the same change in `.claude/scripts/session-start-launcher.mjs` (the dev copy)
4. Update the test list in `src/modules/cli/__tests__/services/auto-update.test.ts`

## Build Architecture

```
moflo/
├── package.json          ← Root: build scripts, version source of truth
├── tsconfig.json         ← Root: tsc -b entry point (project references)
├── vitest.config.ts      ← Root: test runner config
├── src/
│   ├── tsconfig.json     ← Workspace: references all @moflo/* packages
│   ├── tsconfig.base.json ← Shared compiler options (DO NOT DELETE)
│   └── @moflo/
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

## Package Contents (`files` field)

The `files` array in root `package.json` controls what ships to npm. This is carefully curated — do not add broad globs like `.claude/**` or `**/*.d.ts`.

### What's included and why

| Pattern | Purpose |
|---------|---------|
| `bin/**` | CLI entry points (`flo`, `flo-search`, etc.) |
| `src/modules/*/dist/**/*.js` | Compiled runtime code |
| `src/modules/*/package.json` | Workspace resolution for internal imports |
| `.claude/commands/**/*.md` | Slash commands — copied to user projects by `flo init` |
| `.claude/agents/**/*.md` | Agent definitions — copied to user projects by `flo init` |
| `.claude/helpers/**` | Hook scripts (statusline, gate, auto-memory) — copied by `flo init` |
| `.claude/scripts/**` | Utility scripts (session-start, etc.) — synced by `flo init` |
| `.claude/guidance/shipped/**` | Shipped guidance docs — synced by `flo init` |
| `README.md`, `LICENSE` | Standard package metadata |

### What's excluded and why

| Excluded | Why |
|----------|-----|
| `**/*.d.ts` | moflo is a CLI tool, not a library — no one imports its types |
| `**/*.map` | Source maps are dev-only |
| `.claude/checkpoints/` | Dev-only state |
| `.claude/config/` | Dev-only configuration |
| `.claude/mcp.json` | Dev-only MCP server config |
| `.claude/guidance/internal/` | Internal guidance not shipped to users |
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

**Baseline (v4.8.33):** ~653 files, ~1.7 MB packed, ~7.6 MB unpacked (includes neural dist).
