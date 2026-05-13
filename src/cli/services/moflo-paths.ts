/**
 * MoFlo runtime state directory constants.
 *
 * MoFlo owns its state under `.moflo/` at the project root. Pre-#699 builds
 * used `.claude-flow/`; both legacy locations are still recognized as
 * read-only sources for the version-bump-gated cherry-pick (#851) but are
 * never relocated or renamed automatically — leaving them in place gives
 * consumers a recovery source and avoids the failure modes that motivated
 * the issue (silent migrations, daemon-held stale paths, .gitignore deletion).
 *
 * Anything that touches a runtime state path under the project root must
 * compose it from `MOFLO_DIR`. Plain string literals like `'.moflo'` are
 * tolerated where a constant import is awkward (shell templates, tests) but
 * production code is checked by `published-package-drift-guard.test.ts`.
 *
 * The pure-JS twin at `bin/lib/moflo-paths.mjs` mirrors these constants so
 * `bin/session-start-launcher.mjs` can resolve paths before any TS is
 * compiled. The cherry-pick logic itself lives in
 * `cli/services/cherry-pick-learnings.ts` and is dynamically imported from
 * the compiled `dist/` by the launcher.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MOFLO_DIR = '.moflo';
/** Canonical memory DB filename (post-#727). Lives at `<root>/.moflo/moflo.db`. */
export const MEMORY_DB_FILE = 'moflo.db';
/** HNSW persisted index sidecar. Lives next to the DB at `<root>/.moflo/hnsw.index`. */
export const HNSW_INDEX_FILE = 'hnsw.index';

/**
 * Legacy `.claude-flow/` runtime directory used by pre-#699 moflo builds.
 * Only referenced from migration code paths — production code should use
 * {@link MOFLO_DIR}.
 */
export const LEGACY_CLAUDE_FLOW_DIR = '.claude-flow';
/** Legacy `.swarm/` directory used by pre-#727 moflo builds for the memory DB. */
export const LEGACY_SWARM_DIR = '.swarm';
/** Legacy memory DB filename — only ever inside `.swarm/`. Pre-#727. */
export const LEGACY_MEMORY_DB_FILE = 'memory.db';
/** Suffix appended to `.swarm/memory.db` once migrated, retained one upgrade cycle. */
export const LEGACY_MEMORY_DB_BAK_SUFFIX = '.bak';

export function mofloDir(projectRoot: string): string {
  return join(projectRoot, MOFLO_DIR);
}

/** User-scope MoFlo state dir: `~/.moflo`. Holds credentials and other per-machine state. */
export function mofloHomeDir(): string {
  return join(homedir(), MOFLO_DIR);
}

export function legacyClaudeFlowDir(projectRoot: string): string {
  return join(projectRoot, LEGACY_CLAUDE_FLOW_DIR);
}

/** Canonical memory DB path: `<root>/.moflo/moflo.db`. */
export function memoryDbPath(projectRoot: string): string {
  return join(projectRoot, MOFLO_DIR, MEMORY_DB_FILE);
}

/** Canonical HNSW index sidecar path: `<root>/.moflo/hnsw.index`. */
export function hnswIndexPath(projectRoot: string): string {
  return join(projectRoot, MOFLO_DIR, HNSW_INDEX_FILE);
}

/** Legacy memory DB path: `<root>/.swarm/memory.db`. Migration source only. */
export function legacyMemoryDbPath(projectRoot: string): string {
  return join(projectRoot, LEGACY_SWARM_DIR, LEGACY_MEMORY_DB_FILE);
}

/** Legacy HNSW index path: `<root>/.swarm/hnsw.index`. Migration source only. */
export function legacyHnswIndexPath(projectRoot: string): string {
  return join(projectRoot, LEGACY_SWARM_DIR, HNSW_INDEX_FILE);
}

/** Backup sentinel kept for one upgrade cycle: `<root>/.swarm/memory.db.bak`. */
export function legacyMemoryDbBakPath(projectRoot: string): string {
  return join(projectRoot, LEGACY_SWARM_DIR, `${LEGACY_MEMORY_DB_FILE}${LEGACY_MEMORY_DB_BAK_SUFFIX}`);
}

/**
 * Memory-DB probe order used by every reader that does best-effort detection
 * (statusline, doctor, swarm status, hooks aggregator). Canonical first so
 * the early-break stops at the post-#727 location; legacy paths kept so a
 * partially-migrated consumer still surfaces a result.
 *
 * Keep in sync with the pure-JS twin in `bin/lib/moflo-paths.mjs`.
 */
export function memoryDbCandidatePaths(projectRoot: string): string[] {
  return [
    memoryDbPath(projectRoot),
    legacyMemoryDbPath(projectRoot),
    join(projectRoot, 'data', LEGACY_MEMORY_DB_FILE),
    join(projectRoot, '.claude', LEGACY_MEMORY_DB_FILE),
  ];
}

