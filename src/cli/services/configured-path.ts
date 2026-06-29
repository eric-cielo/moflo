/**
 * Shared resolution for opt-in "configured path" features (env override > a
 * `moflo.yaml` value), plus a symlink-stable absolute form for path-identity
 * comparison. Extracted from `durable-sync.ts` (#1232) when `snapshot-restore.ts`
 * (#1244) grew the same env>config>resolve + self-reference-guard shape — a
 * single source of truth so the two stay byte-identical (Rule #1 / #1145).
 *
 * @module cli/services/configured-path
 */

import * as fs from 'fs';
import * as path from 'path';
import { normalizeProjectRoot } from './daemon-port.js';

/**
 * Resolve a path that may not exist yet to a stable absolute form for identity
 * comparison. Reuses {@link normalizeProjectRoot} (the #1145 reference impl) so
 * both sides of any comparison fold identically: it realpath's symlinks (macOS
 * `/var/folders` → `/private/var/folders`) and lowercases on Windows (NTFS is
 * case-insensitive). When the target doesn't exist yet — the common first-flush
 * case — we realpath the nearest existing parent and rejoin the tail so a
 * symlinked parent dir still normalises identically.
 */
export function stableAbsolute(p: string): string {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) return normalizeProjectRoot(abs);
  return normalizeProjectRoot(
    path.join(normalizeProjectRoot(path.dirname(abs)), path.basename(abs)),
  );
}

/**
 * Pick a configured path: a non-empty env override wins over the config value;
 * the chosen value is resolved absolute (relative values against `projectRoot`).
 * Returns `null` when neither is set — the "feature off" signal. Resolution is
 * pure string/path work (no IO), so it's safe on the cold-start hot path.
 */
export function pickConfiguredPath(
  envValue: string | undefined,
  cfgValue: string | undefined,
  projectRoot: string,
): string | null {
  const env = envValue?.trim();
  const cfg = cfgValue?.trim();
  const raw = env && env.length > 0 ? env : cfg;
  if (!raw) return null;
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectRoot, raw);
}
