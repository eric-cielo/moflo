/**
 * Backward-compatible environment-variable reader for the claude-flow → moflo
 * rebrand (issue #1209).
 *
 * Reads the canonical `MOFLO_<suffix>` variable first, falling back to the
 * pre-rebrand `CLAUDE_FLOW_<suffix>` name. Every writer across the codebase
 * emits ONLY `MOFLO_*`; this fallback exists so consumers whose shell env or
 * already-persisted files (e.g. an installed systemd unit written by an older
 * moflo) still set the old names keep working without a manual migration.
 *
 * Deprecation window: keep the `CLAUDE_FLOW_*` fallback for at least one
 * release cycle after the rebrand ships, then drop both this fallback and the
 * writer-side exemption in `published-package-drift-guard.test.ts`.
 *
 * Zero imports on purpose — safe to import from any layer (including
 * `shared/core/config`) without risking a cycle.
 */

const MOFLO_PREFIX = 'MOFLO_';
const LEGACY_PREFIX = 'CLAUDE_FLOW_';

/**
 * Read an env var by its `MOFLO_<suffix>` name, falling back to the legacy
 * `CLAUDE_FLOW_<suffix>` name. Returns `undefined` when neither is set.
 *
 * @param suffix the shared variable suffix, e.g. `'MAX_AGENTS'`, `'DAEMON'`.
 */
export function readMofloEnv(suffix: string): string | undefined {
  return process.env[MOFLO_PREFIX + suffix] ?? process.env[LEGACY_PREFIX + suffix];
}
