/**
 * Version freshness check for `flo doctor`.
 *
 * Uses fetch() against the npm registry rather than `npm view` because the
 * latter shells out to npm-cli.js, which is briefly orphaned on Windows after
 * its parent chain reaps and gets flagged by findZombieProcesses' "moflo"
 * regex.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { errorDetail } from '../shared/utils/error-detail.js';
import type { HealthCheck } from './doctor-types.js';

// Cold-connect TLS+DNS can eat most of npm's old 5s budget when doctor's
// parallel checks saturate the event loop, hence 10s.
const REGISTRY_FETCH_TIMEOUT_MS = 10_000;

function readCurrentVersion(): string {
  // Walk up from the current file's directory until we find the moflo
  // package.json (or a tolerated legacy upstream name during migration).
  // Walk until dirname(dir) === dir (filesystem root on any platform).
  try {
    const thisFile = fileURLToPath(import.meta.url);
    let dir = dirname(thisFile);
    for (;;) {
      const candidate = join(dir, 'package.json');
      try {
        if (existsSync(candidate)) {
          const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
          if (
            pkg.version &&
            typeof pkg.name === 'string' &&
            (pkg.name === 'moflo' || pkg.name === 'claude-flow')
          ) {
            return pkg.version;
          }
        }
      } catch {
        // Unreadable/invalid JSON -- skip and keep walking up
      }
      const parent = dirname(dir);
      if (parent === dir) break; // reached root
      dir = parent;
    }
  } catch {
    // Fall back to a default
  }
  return '0.0.0';
}

interface ParsedVersion { major: number; minor: number; patch: number; prerelease: number }

function parseVersion(v: string): ParsedVersion {
  const match = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-[a-zA-Z]+\.(\d+))?/);
  if (!match) return { major: 0, minor: 0, patch: 0, prerelease: 0 };
  return {
    major: parseInt(match[1], 10) || 0,
    minor: parseInt(match[2], 10) || 0,
    patch: parseInt(match[3], 10) || 0,
    prerelease: parseInt(match[4], 10) || 0,
  };
}

function isOutdated(current: ParsedVersion, latest: ParsedVersion): boolean {
  return (
    latest.major > current.major ||
    (latest.major === current.major && latest.minor > current.minor) ||
    (latest.major === current.major && latest.minor === current.minor && latest.patch > current.patch) ||
    (latest.major === current.major && latest.minor === current.minor && latest.patch === current.patch && latest.prerelease > current.prerelease)
  );
}

// Manual AbortController (NOT AbortSignal.timeout): the latter leaves
// a libuv timer alive past process exit on Node 24 / Windows and trips
// an `!(handle->flags & UV_HANDLE_CLOSING)` assertion in src/win/async.c.
export async function fetchLatestNpmVersion(pkg: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REGISTRY_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, {
      headers: { Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
    const info = (await response.json()) as { version?: string };
    if (typeof info.version !== 'string' || !info.version) {
      throw new Error('registry response missing version');
    }
    return info.version;
  } finally {
    clearTimeout(timer);
  }
}

export { parseVersion, isOutdated };
async function fetchLatestVersion(): Promise<string> {
  return fetchLatestNpmVersion('moflo');
}

export async function checkVersionFreshness(): Promise<HealthCheck> {
  try {
    const currentVersion = readCurrentVersion();

    // Check if running via npx (look for _npx in process path or argv)
    const isNpx = process.argv[1]?.includes('_npx') ||
                  process.env.npm_execpath?.includes('npx') ||
                  process.cwd().includes('_npx');

    let latestVersion: string;
    try {
      latestVersion = await fetchLatestVersion();
    } catch (e) {
      return {
        name: 'Version Freshness',
        status: 'warn',
        message: `v${currentVersion} (cannot check registry: ${errorDetail(e, { firstLineOnly: true })})`,
      };
    }

    if (isOutdated(parseVersion(currentVersion), parseVersion(latestVersion))) {
      const fix = isNpx
        ? (process.platform === 'win32'
          ? 'npx -y moflo (or clear %LocalAppData%\\npm-cache\\_npx manually)'
          : 'rm -rf ~/.npm/_npx/* && npx -y moflo')
        : 'npm update moflo';

      return {
        name: 'Version Freshness',
        status: 'warn',
        message: `v${currentVersion} (latest: v${latestVersion})${isNpx ? ' [npx cache stale]' : ''}`,
        fix,
      };
    }

    return {
      name: 'Version Freshness',
      status: 'pass',
      message: `v${currentVersion} (up to date)`,
    };
  } catch (error) {
    return {
      name: 'Version Freshness',
      status: 'warn',
      message: `Unable to check version freshness: ${errorDetail(error)}`,
    };
  }
}
