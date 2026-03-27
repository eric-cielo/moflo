# Rename `src/@claude-flow/` → `src/packages/`

**Date:** 2026-03-26
**Branch:** working directly on main (pre-PR)
**Status:** In progress — build + tests passing, remaining doc updates needed

## Context

The `src/@claude-flow/` directory is inherited from the upstream ruflo/claude-flow monorepo.
The `@claude-flow` scoped name is confusing — it's not our brand, implies npm packages that
don't publish, and creates unnecessarily deep paths. Renaming to `src/packages/` is a pure
directory rename; TypeScript import aliases (`@claude-flow/*`) stay unchanged for now (they're
resolved via tsconfig paths, not filesystem conventions).

## Completed

- [x] `git mv src/@claude-flow src/packages`
- [x] `src/tsconfig.json` — paths and references point to `./packages/*`
- [x] `package.json` — `files` array, all `scripts` entries updated
- [x] `vitest.config.ts` — include/exclude globs updated
- [x] `scripts/sync-version.mjs` — CLI path updated
- [x] `bin/cli.js` — entry point path fixed
- [x] `bin/hooks.mjs`, `bin/index-all.mjs`, `bin/session-start-launcher.mjs` — updated
- [x] `.claude/scripts/*.mjs` and `.claude/helpers/auto-memory-hook.mjs` — updated
- [x] `src/mcp/tools/*.ts` — relative imports fixed (agent-tools, federation-tools, hooks-tools, worker-tools)
- [x] `src/mcp/__tests__/hooks-tools.test.ts`, `worker-tools.test.ts` — mock paths fixed
- [x] `src/index.ts` — re-exports fixed
- [x] `src/__tests__/appliance/*.test.ts` — imports fixed
- [x] 9 test files in `tests/` — path assertions updated (guidance-build, doctor-command, doctor-test-dirs, init-test-dirs, issue-fixes, settings-statusline, bin/lib-sync, guidance/lint-*)
- [x] `CLAUDE.md` — key packages table updated
- [x] `src/CLAUDE.md` — packages table updated
- [x] `src/packages/cli/CLAUDE.md` — already uses relative paths, no change needed
- [x] Build: `tsc -b` clean (after clearing tsbuildinfo + dist)
- [x] Tests: 131 passed, 4935 tests, 3 pre-existing worker OOM errors (unchanged)
- [x] CLI: `flo --version` → 4.8.50, `flo doctor` → 17 passed + 1 warning (stale test-dir cache)

## Remaining TODO

### Code/Config (must do before publish)

- [ ] `src/mcp/tools/*.js` — these are standalone JS files (not tsc output), still have old
      `../../@claude-flow/` paths. The `.ts` sources are fixed but these `.js` siblings need
      manual update or deletion if they're generated artifacts.
- [ ] Verify `src/mcp/tools/sona-tools.js` and `sona-tools.d.ts` — may have old paths

### Docs (should do before publish)

- [ ] `docs/BUILD.md` — references `src/@claude-flow/` paths
- [ ] `.claude/guidance/moflo-core-guidance.md` — references old paths
- [ ] `.claude/guidance/shipped/moflo-core-guidance.md` — same
- [ ] `.claude/guidance/internal/dogfooding.md` — references old paths
- [ ] `.claude/guidance/internal/consumer-project-paths.md` — references old paths

### Post-publish

- [ ] Clear stale doctor test-dir cache — runs `flo-setup` or `flo-index` to rebuild
- [ ] Re-index code-map memory (`flo-codemap`) so semantic search has correct paths
- [ ] Update MEMORY.md entries if any reference old path

## Publish Checklist

```bash
npm version patch --no-git-tag-version   # 4.8.50 → 4.8.51
npm run build
npm test                                  # Must pass 131 files
npx flo doctor                            # Must pass
npm pack --dry-run                        # Verify ~601 files
npm publish --otp=<code>
npm view moflo version                    # Verify
```

Then: create branch, commit, push, PR, merge.

## What NOT to change (yet)

- Import aliases (`@claude-flow/*`) — these are tsconfig path mappings, not directory names.
  Renaming to `@moflo/*` is Tier 3 work and touches hundreds of source files.
- Individual subpackage `package.json` names — they still say `@claude-flow/memory` etc.
  These are internal and not published. Rename is Tier 3.

## Related: Distro Trim (completed, published as 4.8.50)

Merged as PR #96. Removed 49 unused files (630→601):
- Dead agents: sublinear/, dual-mode/codex, payments/, templates/
- Stale commands: agents/, analysis/, automation/, monitoring/, optimization/
- Duplicate scripts: `.claude/scripts/**` dropped from package.json files
