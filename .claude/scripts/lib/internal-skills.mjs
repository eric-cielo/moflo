/**
 * Skills that ship in the npm tarball (under `node_modules/moflo/.claude/skills/`)
 * but must NEVER be installed into consumer projects — strictly moflo-internal
 * dev tooling. `/publish` bumps moflo's own version and publishes to npm;
 * `/reset-epic` torches epic test data. Both are meaningless or harmful in a
 * consumer repo.
 *
 * The session-start launcher's recursive skills sync (`syncDirRecursive` in
 * `file-sync.mjs`) copies every shipped skill into the consumer on each run, so
 * it MUST skip these. The canonical TypeScript copy is `INTERNAL_SKILLS` in
 * `src/cli/init/executor.ts` (used by `flo init`). The launcher is a plain
 * `.mjs` and can't import that TS const across the dist/source depth boundary,
 * so this leaf mirrors it. `tests/bin/internal-skills-parity.test.ts` asserts
 * the two lists never drift.
 */
export const INTERNAL_SKILLS = ['publish', 'reset-epic'];
