/**
 * Daemon Version Skew doctor check (epic #1054.S5 / #1059).
 *
 * Surfaces the failure mode that silently masked the #1054 bug class for two
 * version bumps: a long-lived daemon that survived `npm install moflo@<new>`
 * keeps running pre-upgrade code while the on-disk package.json reads `<new>`.
 *
 * Distinct failure mode — NOT buried in "stale cache". Consumes the same
 * signal the launcher acts on (`bin/session-start-launcher.mjs` section 3a-pre)
 * via `getDaemonLockPayload` so the diagnosis and the auto-recycle path share
 * one source of truth.
 *
 * @module cli/commands/doctor-checks-version-skew
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getDaemonLockPayload, readOwnMofloVersion } from '../services/daemon-lock.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import type { HealthCheck } from './doctor-types.js';

/**
 * Resolve the installed package version from `node_modules/moflo/package.json`.
 * Falls back to the daemon's own version (same package on consumers; same
 * dogfood layout in this repo).
 */
function readInstalledVersion(cwd: string): string | null {
  const pkgPath = join(cwd, 'node_modules', 'moflo', 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.version === 'string') return pkg.version;
    } catch {
      // unreadable / malformed — fall through
    }
  }
  // Dogfood path (this repo): no `node_modules/moflo`; read the root package
  // via the same walker the daemon uses.
  return readOwnMofloVersion() ?? null;
}

/**
 * Distinct doctor entry — fails when the running daemon's `version` (recorded
 * in `.moflo/daemon.lock` by S2) does not match the installed package version.
 *
 * Pre-#1054 daemons have no `version` in their lock — treated as a mismatch
 * because by construction they were launched before version publishing
 * existed.
 *
 * No daemon running → pass with a neutral message (the daemon-status check
 * already owns the "not running" diagnosis).
 */
export async function checkDaemonVersionSkew(cwd: string = process.cwd()): Promise<HealthCheck> {
  const name = 'Daemon Version Skew';
  try {
    const installed = readInstalledVersion(cwd);
    if (!installed) {
      return {
        name,
        status: 'warn',
        message: 'Cannot resolve installed moflo version (no node_modules/moflo/package.json)',
      };
    }

    const payload = getDaemonLockPayload(cwd);
    if (!payload) {
      return {
        name,
        status: 'pass',
        message: `No daemon running — installed v${installed}`,
      };
    }

    const observed = payload.version ?? '<pre-1054 / unknown>';
    if (payload.version === installed) {
      return {
        name,
        status: 'pass',
        message: `Daemon v${observed} matches installed v${installed} (PID ${payload.pid})`,
      };
    }

    return {
      name,
      status: 'fail',
      message:
        `Daemon (PID ${payload.pid}) running v${observed} but installed package is v${installed}. ` +
        `Stale pre-upgrade daemon — every write it makes is against pre-upgrade code paths (#1054 bug class).`,
      fix: 'npx moflo daemon stop && npx moflo daemon start',
    };
  } catch (e) {
    return {
      name,
      status: 'warn',
      message: `Unable to check version skew: ${errorDetail(e, { firstLineOnly: true })}`,
    };
  }
}
