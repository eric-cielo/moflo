/**
 * Configuration & service-discovery checks for `flo doctor`:
 * config files, statusLine, daemon, MCP servers, moflo.yaml compliance,
 * test directories.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { getDaemonLockHolder } from '../services/daemon-lock.js';
import {
  legacyMemoryDbPath,
  memoryDbCandidatePaths,
  memoryDbPath,
} from '../services/moflo-paths.js';
import { probeDbIntegrity } from '../services/memory-db-integrity-repair.js';
import { findProjectRoot } from '../services/project-root.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import type { HealthCheck } from './doctor-types.js';

export async function checkConfigFile(): Promise<HealthCheck> {
  // JSON configs (parse-validated). LEGACY-CONFIG: `.claude-flow.json` and
  // `claude-flow.config.json` filenames are still recognised so consumers
  // upgrading from pre-#699 moflo builds keep working
  // without manual rename. Drift guard exempts these via LEGACY-CONFIG marker.
  const jsonPaths = [
    '.moflo/config.json',
    'moflo.config.json',
    'claude-flow.config.json', // LEGACY-CONFIG: pre-#699 fallback
    '.claude-flow.json',       // LEGACY-CONFIG: pre-#699 fallback
  ];

  for (const configPath of jsonPaths) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, 'utf8');
        JSON.parse(content);
        return { name: 'Config File', status: 'pass', message: `Found: ${configPath}` };
      } catch {
        return { name: 'Config File', status: 'fail', message: `Invalid JSON: ${configPath}`, fix: 'Fix JSON syntax in config file' };
      }
    }
  }

  // YAML configs (existence-checked only — no heavy yaml parser dependency).
  const yamlPaths = [
    '.moflo/config.yaml',
    '.moflo/config.yml',
    'moflo.config.yaml',
    'claude-flow.config.yaml', // LEGACY-CONFIG: pre-#699 fallback
  ];

  for (const configPath of yamlPaths) {
    if (existsSync(configPath)) {
      return { name: 'Config File', status: 'pass', message: `Found: ${configPath}` };
    }
  }

  return { name: 'Config File', status: 'warn', message: 'No config file (using defaults)', fix: 'claude-flow config init' };
}

export async function checkStatusLine(): Promise<HealthCheck> {
  const settingsPath = join(process.cwd(), '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    return { name: 'Status Line', status: 'warn', message: 'No .claude/settings.json found', fix: 'npx moflo init' };
  }

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (settings.statusLine && settings.statusLine.command) {
      if (settings.statusLine.command.includes('statusline.cjs')) {
        return { name: 'Status Line', status: 'pass', message: 'Wired in settings.json' };
      }
      return { name: 'Status Line', status: 'pass', message: 'Custom statusLine configured' };
    }
    return { name: 'Status Line', status: 'fail', message: 'statusLine not configured in settings.json', fix: 'Add statusLine config to .claude/settings.json' };
  } catch {
    return { name: 'Status Line', status: 'fail', message: 'Failed to parse .claude/settings.json', fix: 'Fix JSON syntax in .claude/settings.json' };
  }
}

// Delegates to daemon-lock module for proper PID + command-line verification
// (avoids Windows PID-recycling false positives).
export async function checkDaemonStatus(): Promise<HealthCheck> {
  try {
    // Retry up to 5 times with 1s delay — the daemon starts in the background
    // during session-start and may not have acquired its lock file yet.
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 1000;
    let holderPid: number | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      holderPid = getDaemonLockHolder(process.cwd());
      if (holderPid) break;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }

    if (holderPid) {
      return { name: 'Daemon Status', status: 'pass', message: `Running (PID: ${holderPid})` };
    }

    // getDaemonLockHolder auto-cleans stale locks, but check for legacy PID file
    const lockFile = '.moflo/daemon.lock';
    if (existsSync(lockFile)) {
      return { name: 'Daemon Status', status: 'warn', message: 'Stale lock file', fix: 'rm .moflo/daemon.lock && claude-flow daemon start' };
    }
    const pidFile = '.moflo/daemon.pid';
    if (existsSync(pidFile)) {
      return { name: 'Daemon Status', status: 'warn', message: 'Legacy PID file found', fix: 'rm .moflo/daemon.pid && claude-flow daemon start' };
    }
    return { name: 'Daemon Status', status: 'warn', message: 'Not running', fix: 'claude-flow daemon start' };
  } catch (e) {
    return { name: 'Daemon Status', status: 'warn', message: `Unable to check: ${errorDetail(e)}`, fix: 'claude-flow daemon status' };
  }
}

export async function checkMemoryDatabase(): Promise<HealthCheck> {
  const root = process.cwd();
  const canonical = memoryDbPath(root);

  for (const dbPath of memoryDbCandidatePaths(root)) {
    let stats;
    try { stats = statSync(dbPath); } catch { continue; }
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    if (dbPath === canonical) {
      let message = `.moflo/moflo.db (${sizeMB} MB)`;
      // Unfinished migration tail: source still present means the launcher's
      // rename-to-.bak step failed (Windows lock most often). Flag so the user
      // knows to clear the stale source.
      if (existsSync(legacyMemoryDbPath(root))) {
        message += ' — legacy .swarm/memory.db still present (delete it after confirming canonical is healthy)';
      }
      return { name: 'Memory Database', status: 'pass', message };
    }

    return {
      name: 'Memory Database',
      status: 'warn',
      message: `${dbPath} (${sizeMB} MB) — legacy location, will migrate to .moflo/moflo.db on next session start`,
      fix: 'restart claude code session',
    };
  }

  return { name: 'Memory Database', status: 'warn', message: 'Not initialized', fix: 'claude-flow memory configure --backend hybrid' };
}

/**
 * Tier-1 corruption probe for `.moflo/moflo.db`. Runs `PRAGMA integrity_check`
 * via a raw node:sqlite readonly handle — bypasses `openBackend` because that
 * path sets WAL pragmas on open and those throw on deeply-corrupt files,
 * masking the real failure as a generic "Check" error (doctor.ts:214).
 *
 * Owns the corruption signal so downstream checks (Embeddings, Semantic
 * Quality, Memory Access Functional, etc.) don't end up doing it implicitly
 * via their own swallow-all error paths. The companion fix in
 * doctor-fixes.ts coordinates daemon stop + tiered repair via the JS-side
 * `repairMemoryDbIfCorrupt` (bin/lib/db-repair.mjs).
 *
 * Status semantics:
 *  - `pass` — DB absent OR `integrity_check` returns 'ok'.
 *  - `fail` — corruption detected. `fix` field points at the healer's
 *    auto-recovery path (which runs REINDEX → VACUUM INTO → row-level
 *    salvage in order of escalation).
 *  - `warn` — probe itself crashed (rare; surfaces the diagnostic rather
 *    than masking it).
 */
export async function checkMemoryDbIntegrity(cwd: string = process.cwd()): Promise<HealthCheck> {
  const dbPath = memoryDbPath(cwd);
  if (!existsSync(dbPath)) {
    return { name: 'Memory DB Integrity', status: 'pass', message: 'DB absent (no integrity probe needed)' };
  }
  // Delegate to the single readonly-no-PRAGMAs probe in
  // `bin/lib/db-repair.mjs` (via the TS service bridge). Avoids re-deriving
  // the same DatabaseSync({ readOnly: true }) + integrity_check sequence in
  // two places and keeps the "what counts as healthy" semantics in one file.
  try {
    const probe = await probeDbIntegrity(dbPath);
    if (probe.ok) {
      return { name: 'Memory DB Integrity', status: 'pass', message: 'PRAGMA integrity_check: ok' };
    }
    const message = probe.openFailed
      ? 'Unable to probe DB (readonly open failed — likely deep corruption)'
      : `${probe.errors} integrity violation(s) detected`;
    return {
      name: 'Memory DB Integrity',
      status: 'fail',
      message,
      fix: 'flo healer --fix -c memory-db-integrity',
    };
  } catch (e) {
    // The probe itself maps "readonly open failed" to `openFailed: true`
    // and we surface that as `fail` above. Reaching the catch means the
    // probe *module* couldn't be loaded — `findMofloPackageRoot()` returned
    // null (broken install / wrong cwd) or the dynamic import threw. Both
    // are first-class diagnostic failures — a broken install must not be
    // silently downgraded to `warn` and hidden from the healer summary.
    return {
      name: 'Memory DB Integrity',
      status: 'fail',
      message: `Integrity probe unavailable: ${errorDetail(e)}`,
      fix: 'flo healer --fix -c memory-db-integrity',
    };
  }
}

/**
 * Standard MCP-config search paths: home (Claude Desktop on macOS/Linux),
 * XDG config dir, project-local `.mcp.json`, and APPDATA on Windows.
 *
 * Shared by `checkMcpServers` (which inspects configs and reports on moflo
 * presence) and `checkDaemonWriteRouting` (which COUNTS servers across all
 * paths to detect the multi-process-clobber hazard).
 */
function mcpConfigSearchPaths(cwd: string): string[] {
  return [
    join(os.homedir(), '.claude/claude_desktop_config.json'),
    join(os.homedir(), '.config/claude/mcp.json'),
    join(cwd, '.mcp.json'),
    ...(process.platform === 'win32' && process.env.APPDATA
      ? [join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json')]
      : []),
  ];
}

/** Sum MCP servers across every reachable config. Malformed configs counted as 0. */
function countMcpServers(cwd: string): number {
  let total = 0;
  for (const configPath of mcpConfigSearchPaths(cwd)) {
    if (!existsSync(configPath)) continue;
    try {
      const content = JSON.parse(readFileSync(configPath, 'utf8'));
      const servers = content.mcpServers || content.servers || {};
      total += Object.keys(servers).length;
    } catch {
      // Skip unreadable / malformed config — checkMcpServers reports it.
    }
  }
  return total;
}

/**
 * Inspect the project's `.mcp.json` (the file `flo init` writes and Claude
 * Code reads at the project level) and report whether moflo is present,
 * absent, or the file is malformed.
 *
 * Scope: deliberately project-only. We previously also scanned
 * `~/.claude/claude_desktop_config.json` and `%APPDATA%/Claude/...` — Claude
 * **Desktop** paths — which is a separate Anthropic product that doesn't
 * host moflo's MCP server. The old wide scan caused #1126: a Claude
 * Desktop preferences-only APPDATA file outranked a malformed project
 * `.mcp.json`, surfacing "0 servers (flo not found)" while the actually
 * broken project file went unrepaired. Claude Code stores user-level MCP
 * registrations under `~/.claude.json` `projects[<path>].mcpServers`, but
 * that's Claude Code internal state we don't author or rewrite; the
 * project file is the canonical surface moflo owns end-to-end.
 *
 * Multi-writer / cross-ecosystem MCP-process counting still uses the wider
 * `mcpConfigSearchPaths` via `countMcpServers` in
 * `checkDaemonWriteRouting` — that check has a legitimate reason to see
 * Claude Desktop processes.
 *
 * Exported so the auto-fixer (doctor-fixes.ts) can detect a malformed
 * `.mcp.json` and regenerate it. Project root resolves via
 * `findProjectRoot()` so a consumer running `flo healer` from a
 * subdirectory still discovers the project file.
 */
export function inspectMcpConfigs(cwd: string = findProjectRoot()): {
  status: 'valid_with_moflo' | 'valid_no_moflo' | 'malformed' | 'not_found';
  path?: string;
  count?: number;
  parseError?: string;
} {
  const configPath = join(cwd, '.mcp.json');
  if (!existsSync(configPath)) {
    return { status: 'not_found' };
  }
  try {
    const content = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const serversValue = content.mcpServers ?? content.servers;
    const servers = (serversValue && typeof serversValue === 'object')
      ? (serversValue as Record<string, unknown>)
      : {};
    const count = Object.keys(servers).length;
    const hasMoflo = 'moflo' in servers || 'claude-flow' in servers || 'claude-flow_alpha' in servers;
    if (hasMoflo) {
      return { status: 'valid_with_moflo', path: configPath, count };
    }
    return { status: 'valid_no_moflo', path: configPath, count };
  } catch (e) {
    return { status: 'malformed', path: configPath, parseError: errorDetail(e) };
  }
}

export async function checkMcpServers(cwd: string = findProjectRoot()): Promise<HealthCheck> {
  const result = inspectMcpConfigs(cwd);

  switch (result.status) {
    case 'valid_with_moflo':
      return { name: 'MCP Servers', status: 'pass', message: `${result.count} servers (moflo configured)` };

    case 'valid_no_moflo':
      return {
        name: 'MCP Servers',
        status: 'warn',
        message: `${result.count} servers (moflo not registered)`,
        fix: 'claude mcp add moflo -- npx -y moflo mcp start',
      };

    case 'malformed':
      // #1126: distinguish "config malformed" from "moflo missing". Previously
      // the loop silently caught the JSON.parse error and fell through,
      // reporting "0 servers (flo not found)" — which led users to run
      // `claude mcp add` against a still-broken file that would never parse.
      // Now we surface the parse error and direct them at the auto-fixer
      // that regenerates the file from `generateMCPJson`.
      return {
        name: 'MCP Servers',
        status: 'warn',
        message: `malformed JSON at ${result.path}: ${result.parseError}`,
        fix: 'flo healer --fix -c mcp-servers',
      };

    case 'not_found':
    default:
      return {
        name: 'MCP Servers',
        status: 'warn',
        message: 'No MCP config found',
        fix: 'claude mcp add moflo -- npx -y moflo mcp start',
      };
  }
}

// Catches three failure modes (#895):
//   1. File missing — session-start should have created it; warn user that
//      defaults are invisible/untunable.
//   2. File empty / unreadable — corrupted by half-write or filesystem error.
//   3. Top-level sections missing — partial yaml from manual edit or stale
//      copy from a moflo version that didn't ship a section yet.
//
// Exported so tests can exercise it end-to-end against a temp project root
// without mutating process.cwd() (which fights vitest's parallel test runner).
export async function checkMofloYamlCompliance(cwd: string = process.cwd()): Promise<HealthCheck> {
  const yamlPath = join(cwd, 'moflo.yaml');

  // Lazy-import the validator so doctor doesn't pull in fs walks on the
  // happy path of unrelated checks.
  const { validateMofloYaml } = await import('../init/moflo-yaml-template.js');
  const result = validateMofloYaml(yamlPath);

  if (!result.exists) {
    return {
      name: 'moflo.yaml',
      status: 'warn',
      message: 'moflo.yaml not found — defaults are in effect but not visible/tunable',
      fix: 'Restart Claude Code (session-start auto-creates) or run `npx moflo init`',
    };
  }

  if (result.valid) {
    return { name: 'moflo.yaml', status: 'pass', message: `Compliant (${yamlPath})` };
  }

  const parseIssue = result.issues.find((i) => i.kind !== 'missing-section');
  if (parseIssue) {
    return {
      name: 'moflo.yaml',
      status: 'fail',
      message: `${parseIssue.kind}: ${parseIssue.detail}`,
      fix: 'Inspect/repair moflo.yaml, or `mv moflo.yaml moflo.yaml.bak && npx moflo init`',
    };
  }

  return {
    name: 'moflo.yaml',
    status: 'warn',
    message: `Missing sections: ${result.missingSections.join(', ')}`,
    fix: 'Restart Claude Code (yaml-upgrader auto-appends) or `npx moflo init --force`',
  };
}

/**
 * #981 / #987 — surfaces the single-writer-architecture safety net.
 *
 * When `daemon.auto_start: false` is set in moflo.yaml AND the consumer has
 * an MCP server configured, every MCP-process write hits sql.js directly
 * (no daemon-RPC routing). Pre-#981 multi-process clobber + reader-staleness
 * hazards reappear in that configuration. Warn — never fail — because
 * disabling the daemon is a legitimate consumer choice and the config
 * itself isn't broken.
 *
 * Pass: daemon enabled (default) → routing protection active.
 * Pass: daemon disabled but no MCP server detected → no multi-writer hazard.
 * Warn: daemon disabled AND MCP server detected → hazard window open.
 */
export async function checkDaemonWriteRouting(cwd: string = process.cwd()): Promise<HealthCheck> {
  const name = 'Daemon Write Routing';

  let daemonEnabled = true; // default-on — matches moflo.yaml default
  try {
    const { loadMofloConfig } = await import('../config/moflo-config.js');
    const config = loadMofloConfig(cwd);
    daemonEnabled = config?.daemon?.auto_start !== false;
  } catch {
    // Unreadable config — assume daemon-enabled and let other checks flag
    // the config error.
    daemonEnabled = true;
  }

  if (daemonEnabled) {
    return {
      name,
      status: 'pass',
      message: 'Daemon enabled — multi-process writes route through single writer (#981 protection active)',
    };
  }

  // Daemon disabled — count MCP servers across every reachable config.
  const mcpServerCount = countMcpServers(cwd);

  if (mcpServerCount === 0) {
    return {
      name,
      status: 'pass',
      message: 'Daemon disabled and no MCP server configured — no multi-writer hazard',
    };
  }

  return {
    name,
    status: 'warn',
    message:
      `Daemon disabled (moflo.yaml) and ${mcpServerCount} MCP server(s) configured — ` +
      `multi-process sql.js writes can clobber each other (#981). ` +
      `Set daemon.auto_start: true to restore single-writer protection.`,
    fix: 'Edit moflo.yaml: daemon.auto_start: true',
  };
}

export async function checkTestDirs(): Promise<HealthCheck> {
  const yamlPath = join(process.cwd(), 'moflo.yaml');

  if (!existsSync(yamlPath)) {
    return { name: 'Test Directories', status: 'warn', message: 'No moflo.yaml — test indexing unconfigured', fix: 'npx moflo init' };
  }

  try {
    const content = readFileSync(yamlPath, 'utf-8');

    const testsBlock = content.match(/tests:\s*\n\s+directories:\s*\n((?:\s+-\s+.+\n?)+)/);
    if (!testsBlock) {
      return { name: 'Test Directories', status: 'warn', message: 'No tests section in moflo.yaml', fix: 'npx moflo init --force' };
    }

    const items = testsBlock[1].match(/-\s+(.+)/g);
    if (!items || items.length === 0) {
      return { name: 'Test Directories', status: 'warn', message: 'Empty test directories list' };
    }

    const dirs = items.map(item => item.replace(/^-\s+/, '').trim());
    const existing = dirs.filter(d => existsSync(join(process.cwd(), d)));
    const missing = dirs.filter(d => !existsSync(join(process.cwd(), d)));

    const autoIndexMatch = content.match(/auto_index:\s*\n(?:.*\n)*?\s+tests:\s*(true|false)/);
    const autoIndexEnabled = !autoIndexMatch || autoIndexMatch[1] !== 'false';
    const indexLabel = autoIndexEnabled ? 'auto-index: on' : 'auto-index: off';

    if (missing.length > 0 && existing.length === 0) {
      return {
        name: 'Test Directories',
        status: 'warn',
        message: `No configured test dirs exist: ${missing.join(', ')} (${indexLabel})`,
      };
    }

    if (missing.length > 0) {
      return {
        name: 'Test Directories',
        status: 'warn',
        message: `${existing.length} OK, ${missing.length} missing: ${missing.join(', ')} (${indexLabel})`,
      };
    }

    return { name: 'Test Directories', status: 'pass', message: `${existing.length} directories: ${existing.join(', ')} (${indexLabel})` };
  } catch (e) {
    return { name: 'Test Directories', status: 'warn', message: `Unable to parse moflo.yaml: ${errorDetail(e)}` };
  }
}
