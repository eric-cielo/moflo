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
import { errorDetail } from '../shared/utils/error-detail.js';
import type { HealthCheck } from './doctor-types.js';

export async function checkConfigFile(): Promise<HealthCheck> {
  // JSON configs (parse-validated). LEGACY-CONFIG: `.claude-flow.json` and
  // `claude-flow.config.json` filenames are still recognised so consumers
  // upgrading from pre-#699 moflo builds (upstream Ruflo) keep working
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

export async function checkMcpServers(): Promise<HealthCheck> {
  const mcpConfigPaths = [
    join(os.homedir(), '.claude/claude_desktop_config.json'),
    join(os.homedir(), '.config/claude/mcp.json'),
    '.mcp.json',
    // Windows: Claude Desktop stores config under %APPDATA%\Claude\
    ...(process.platform === 'win32' && process.env.APPDATA
      ? [join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json')]
      : []),
  ];

  for (const configPath of mcpConfigPaths) {
    if (existsSync(configPath)) {
      try {
        const content = JSON.parse(readFileSync(configPath, 'utf8'));
        const servers = content.mcpServers || content.servers || {};
        const count = Object.keys(servers).length;
        const hasClaudeFlow = 'moflo' in servers || 'claude-flow' in servers || 'claude-flow_alpha' in servers || 'ruflo' in servers || 'ruflo_alpha' in servers;
        if (hasClaudeFlow) {
          return { name: 'MCP Servers', status: 'pass', message: `${count} servers (flo configured)` };
        }
        return { name: 'MCP Servers', status: 'warn', message: `${count} servers (flo not found)`, fix: 'claude mcp add ruflo -- npx -y ruflo@latest mcp start' };
      } catch {
        // continue to next path
      }
    }
  }

  return { name: 'MCP Servers', status: 'warn', message: 'No MCP config found', fix: 'claude mcp add moflo npx moflo mcp start' };
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
