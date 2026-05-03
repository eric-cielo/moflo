/**
 * V3 CLI Doctor Command
 * System diagnostics, dependency checks, config validation
 *
 * Created with motailz.com
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { getDaemonLockHolder, releaseDaemonLock, isDaemonProcess } from '../services/daemon-lock.js';
import {
  checkSubagentHealth,
  checkSpellExecution,
  checkMcpToolInvocation,
  checkHookExecution,
  checkMcpSpellIntegration,
  checkGateHealth,
  checkHookBlockDrift,
  checkMofloDbBridge,
  getMofloRoot,
} from './doctor-checks-deep.js';
import { checkEmbeddingHygiene } from './doctor-embedding-hygiene.js';
import {
  checkSwarmFunctional,
  checkHiveMindFunctional,
} from './doctor-checks-swarm.js';
import { checkMemoryAccessFunctional } from './doctor-checks-memory-access.js';
import { repairHookWiring } from '../services/hook-wiring.js';
import {
  legacyMemoryDbPath,
  memoryDbCandidatePaths,
  memoryDbPath,
} from '../services/moflo-paths.js';
import { errorDetail } from '../shared/utils/error-detail.js';

// Promisified exec with proper shell and env inheritance for cross-platform support
const execAsync = promisify(exec);

/**
 * Execute command asynchronously with proper environment inheritance
 * Critical for Windows where PATH may not be inherited properly
 */
async function runCommand(command: string, timeoutMs: number = 5000): Promise<string> {
  const opts = {
    encoding: 'utf8' as BufferEncoding,
    timeout: timeoutMs,
    shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', // Use proper shell per platform
    env: { ...process.env }, // Explicitly inherit full environment
    windowsHide: true, // Hide window on Windows
  };
  const { stdout } = await execAsync(command, opts);
  const out = (stdout as string).trim();
  // Windows parallel exec occasionally returns empty stdout under shell contention — retry once serially
  if (!out && process.platform === 'win32') {
    const retry = await execAsync(command, opts);
    return (retry.stdout as string).trim();
  }
  return out;
}

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

// Check Node.js version
async function checkNodeVersion(): Promise<HealthCheck> {
  const requiredMajor = 20;
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);

  if (major >= requiredMajor) {
    return { name: 'Node.js Version', status: 'pass', message: `${version} (>= ${requiredMajor} required)` };
  } else if (major >= 18) {
    return { name: 'Node.js Version', status: 'warn', message: `${version} (>= ${requiredMajor} recommended)`, fix: 'nvm install 20 && nvm use 20' };
  } else {
    return { name: 'Node.js Version', status: 'fail', message: `${version} (>= ${requiredMajor} required)`, fix: 'nvm install 20 && nvm use 20' };
  }
}

// Check npm version (async with proper env inheritance)
async function checkNpmVersion(): Promise<HealthCheck> {
  try {
    const version = await runCommand('npm --version');
    const major = parseInt(version.split('.')[0], 10);
    if (major >= 9) {
      return { name: 'npm Version', status: 'pass', message: `v${version}` };
    } else {
      return { name: 'npm Version', status: 'warn', message: `v${version} (>= 9 recommended)`, fix: 'npm install -g npm@latest' };
    }
  } catch {
    return { name: 'npm Version', status: 'fail', message: 'npm not found', fix: 'Install Node.js from https://nodejs.org' };
  }
}

// Check config file
async function checkConfigFile(): Promise<HealthCheck> {
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
      } catch (e) {
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

// Check statusLine is wired in settings.json
async function checkStatusLine(): Promise<HealthCheck> {
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

// Check daemon status — delegates to daemon-lock module for proper
// PID + command-line verification (avoids Windows PID-recycling false positives).
async function checkDaemonStatus(): Promise<HealthCheck> {
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
      // Lock exists but holder is null — getDaemonLockHolder already cleaned it,
      // but if it persists it means cleanup failed (permissions, etc.)
      return { name: 'Daemon Status', status: 'warn', message: 'Stale lock file', fix: 'rm .moflo/daemon.lock && claude-flow daemon start' };
    }
    // Also check legacy PID file
    const pidFile = '.moflo/daemon.pid';
    if (existsSync(pidFile)) {
      return { name: 'Daemon Status', status: 'warn', message: 'Legacy PID file found', fix: 'rm .moflo/daemon.pid && claude-flow daemon start' };
    }
    return { name: 'Daemon Status', status: 'warn', message: 'Not running', fix: 'claude-flow daemon start' };
  } catch (e) {
    return { name: 'Daemon Status', status: 'warn', message: `Unable to check: ${errorDetail(e)}`, fix: 'claude-flow daemon status' };
  }
}

// Check memory database
async function checkMemoryDatabase(): Promise<HealthCheck> {
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

// Check git (async with proper env inheritance)
async function checkGit(): Promise<HealthCheck> {
  try {
    const version = await runCommand('git --version');
    return { name: 'Git', status: 'pass', message: version.replace('git version ', 'v') };
  } catch (e) {
    return { name: 'Git', status: 'warn', message: `Not installed (${errorDetail(e, { firstLineOnly: true })})`, fix: 'Install git from https://git-scm.com' };
  }
}

// Check if in git repo (async with proper env inheritance)
async function checkGitRepo(): Promise<HealthCheck> {
  try {
    await runCommand('git rev-parse --git-dir');
    return { name: 'Git Repository', status: 'pass', message: 'In a git repository' };
  } catch (e) {
    return { name: 'Git Repository', status: 'warn', message: `Not a git repository (${errorDetail(e, { firstLineOnly: true })})`, fix: 'git init' };
  }
}

// Check MCP servers
async function checkMcpServers(): Promise<HealthCheck> {
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
        } else {
          return { name: 'MCP Servers', status: 'warn', message: `${count} servers (flo not found)`, fix: 'claude mcp add ruflo -- npx -y ruflo@latest mcp start' };
        }
      } catch {
        // continue to next path
      }
    }
  }

  return { name: 'MCP Servers', status: 'warn', message: 'No MCP config found', fix: 'claude mcp add moflo npx moflo mcp start' };
}

// Check disk space (async with proper env inheritance)
async function checkDiskSpace(): Promise<HealthCheck> {
  try {
    if (process.platform === 'win32') {
      try {
        const driveLetter = process.cwd().match(/^([A-Z]):/i)?.[1]?.toUpperCase() || 'C';
        const psOutput = await runCommand(`powershell -NoProfile -Command "Get-PSDrive ${driveLetter} | Select-Object -ExpandProperty Free; Get-PSDrive ${driveLetter} | Select-Object -ExpandProperty Used"`);
        const vals = psOutput.split(/\r?\n/).filter(l => l.trim());
        const freeBytes = parseInt(vals[0] || '0', 10);
        const usedBytes = parseInt(vals[1] || '0', 10);
        const totalBytes = freeBytes + usedBytes || 1;
        const freeGB = (freeBytes / (1024 ** 3)).toFixed(1);
        const usePercent = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);
        if (usePercent > 90) {
          return { name: 'Disk Space', status: 'fail', message: `${freeGB}G available (${usePercent}% used)`, fix: 'Free up disk space' };
        } else if (usePercent > 80) {
          return { name: 'Disk Space', status: 'warn', message: `${freeGB}G available (${usePercent}% used)` };
        }
        return { name: 'Disk Space', status: 'pass', message: `${freeGB}G available` };
      } catch {
        return { name: 'Disk Space', status: 'pass', message: 'Check skipped (PowerShell unavailable)' };
      }
    }
    // Use df -Ph for POSIX mode (guarantees single-line output even with long device names)
    const output_str = await runCommand('df -Ph . | tail -1');
    const parts = output_str.split(/\s+/);
    // POSIX format: Filesystem Size Used Avail Capacity Mounted
    const available = parts[3];
    const usePercent = parseInt(parts[4]?.replace('%', '') || '0', 10);
    if (isNaN(usePercent)) {
      return { name: 'Disk Space', status: 'warn', message: `${available || 'unknown'} available (unable to parse usage)` };
    }

    if (usePercent > 90) {
      return { name: 'Disk Space', status: 'fail', message: `${available} available (${usePercent}% used)`, fix: 'Free up disk space' };
    } else if (usePercent > 80) {
      return { name: 'Disk Space', status: 'warn', message: `${available} available (${usePercent}% used)` };
    }
    return { name: 'Disk Space', status: 'pass', message: `${available} available` };
  } catch (e) {
    return { name: 'Disk Space', status: 'warn', message: `Unable to check: ${errorDetail(e, { firstLineOnly: true })}` };
  }
}

// Check TypeScript/build (async with proper env inheritance)
async function checkBuildTools(): Promise<HealthCheck> {
  try {
    const tscVersion = await runCommand('npx tsc --version', 10000); // tsc can be slow
    if (!tscVersion || tscVersion.includes('not found')) {
      return { name: 'TypeScript', status: 'warn', message: 'Not installed locally', fix: 'npm install -D typescript' };
    }
    return { name: 'TypeScript', status: 'pass', message: tscVersion.replace('Version ', 'v') };
  } catch (e) {
    return { name: 'TypeScript', status: 'warn', message: `Not installed locally (${errorDetail(e, { firstLineOnly: true })})`, fix: 'npm install -D typescript' };
  }
}

// Check for stale npx cache (version freshness)
async function checkVersionFreshness(): Promise<HealthCheck> {
  try {
    // Get current CLI version from package.json
    // Use import.meta.url to reliably locate our own package.json,
    // regardless of how deep the compiled file sits (e.g. dist/src/commands/).
    let currentVersion = '0.0.0';
    try {
      const thisFile = fileURLToPath(import.meta.url);
      let dir = dirname(thisFile);

      // Walk up from the current file's directory until we find the moflo
      // package.json (or a tolerated legacy upstream name during migration).
      // Walk until dirname(dir) === dir (filesystem root on any platform).
      for (;;) {
        const candidate = join(dir, 'package.json');
        try {
          if (existsSync(candidate)) {
            const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
            if (
              pkg.version &&
              typeof pkg.name === 'string' &&
              (pkg.name === 'moflo' || pkg.name === 'claude-flow' || pkg.name === 'ruflo')
            ) {
              currentVersion = pkg.version;
              break;
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
      currentVersion = '0.0.0';
    }

    // Check if running via npx (look for _npx in process path or argv)
    const isNpx = process.argv[1]?.includes('_npx') ||
                  process.env.npm_execpath?.includes('npx') ||
                  process.cwd().includes('_npx');

    // Query npm for latest version (using alpha tag since that's what we publish to)
    let latestVersion = currentVersion;
    try {
      const npmInfo = await runCommand('npm view moflo version', 5000);
      latestVersion = npmInfo.trim();
    } catch (e) {
      // Can't reach npm registry - skip check
      return {
        name: 'Version Freshness',
        status: 'warn',
        message: `v${currentVersion} (cannot check registry: ${errorDetail(e, { firstLineOnly: true })})`
      };
    }

    // Parse version numbers for comparison (handle prerelease like 3.0.0-alpha.84)
    const parseVersion = (v: string): { major: number; minor: number; patch: number; prerelease: number } => {
      const match = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-[a-zA-Z]+\.(\d+))?/);
      if (!match) return { major: 0, minor: 0, patch: 0, prerelease: 0 };
      return {
        major: parseInt(match[1], 10) || 0,
        minor: parseInt(match[2], 10) || 0,
        patch: parseInt(match[3], 10) || 0,
        prerelease: parseInt(match[4], 10) || 0
      };
    };

    const current = parseVersion(currentVersion);
    const latest = parseVersion(latestVersion);

    // Compare versions (including prerelease number)
    const isOutdated = (
      latest.major > current.major ||
      (latest.major === current.major && latest.minor > current.minor) ||
      (latest.major === current.major && latest.minor === current.minor && latest.patch > current.patch) ||
      (latest.major === current.major && latest.minor === current.minor && latest.patch === current.patch && latest.prerelease > current.prerelease)
    );

    if (isOutdated) {
      const fix = isNpx
        ? (process.platform === 'win32'
          ? 'npx -y moflo (or clear %LocalAppData%\\npm-cache\\_npx manually)'
          : 'rm -rf ~/.npm/_npx/* && npx -y moflo')
        : 'npm update moflo';

      return {
        name: 'Version Freshness',
        status: 'warn',
        message: `v${currentVersion} (latest: v${latestVersion})${isNpx ? ' [npx cache stale]' : ''}`,
        fix
      };
    }

    return {
      name: 'Version Freshness',
      status: 'pass',
      message: `v${currentVersion} (up to date)`
    };
  } catch (error) {
    return {
      name: 'Version Freshness',
      status: 'warn',
      message: `Unable to check version freshness: ${errorDetail(error)}`
    };
  }
}

// Check Claude Code CLI (async with proper env inheritance)
async function checkClaudeCode(): Promise<HealthCheck> {
  try {
    const version = await runCommand('claude --version');
    // Parse version from output like "claude 1.0.0" or "Claude Code v1.0.0"
    const versionMatch = version.match(/v?(\d+\.\d+\.\d+)/);
    const versionStr = versionMatch ? `v${versionMatch[1]}` : version;
    return { name: 'Claude Code CLI', status: 'pass', message: versionStr };
  } catch (e) {
    return {
      name: 'Claude Code CLI',
      status: 'warn',
      message: `Not installed (${errorDetail(e, { firstLineOnly: true })})`,
      fix: 'npm install -g @anthropic-ai/claude-code'
    };
  }
}

// Install Claude Code CLI
async function installClaudeCode(): Promise<boolean> {
  try {
    output.writeln();
    output.writeln(output.bold('Installing Claude Code CLI...'));
    execSync('npm install -g @anthropic-ai/claude-code', {
      encoding: 'utf8',
      stdio: 'inherit',
      windowsHide: true
    });
    output.writeln(output.success('Claude Code CLI installed successfully!'));
    return true;
  } catch (error) {
    output.writeln(output.error('Failed to install Claude Code CLI'));
    if (error instanceof Error) {
      output.writeln(output.dim(error.message));
    }
    return false;
  }
}

/**
 * Open `dbPath` via moflo's bundled sql.js and return the count of memory_entries
 * rows that have an embedding. Returns null if sql.js can't be loaded, the file
 * isn't a v3 schema, or the query fails — every error is treated as "unknown
 * truth", letting the caller fall back to the cached stats rather than masking
 * a healthy DB as broken.
 */
async function countEmbeddedRowsFromDb(dbPath: string): Promise<number | null> {
  try {
    const { mofloImport } = await import('../services/moflo-require.js');
    const initSqlJs = (await mofloImport('sql.js'))?.default;
    if (!initSqlJs) return null;
    const SQL = await initSqlJs();
    const buffer = readFileSync(dbPath);
    const db = new SQL.Database(buffer);
    try {
      const res = db.exec(
        "SELECT COUNT(*) FROM memory_entries WHERE embedding IS NOT NULL AND embedding != ''",
      );
      const cell = res?.[0]?.values?.[0]?.[0];
      return typeof cell === 'number' ? cell : Number(cell ?? 0);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Skew (cached / live count delta) above which the cache is treated as stale. */
const VECTOR_STATS_SKEW_WARN_THRESHOLD = 0.2;

// Check embeddings / vector index health.
// Exported so the #639 stale-cache regression test can invoke it directly.
export async function checkEmbeddings(): Promise<HealthCheck> {
  const liveDbPath = memoryDbCandidatePaths(process.cwd()).find((p) => existsSync(p));

  // 1. Fast path: read cached vector-stats.json if available
  const statsPath = join(process.cwd(), '.moflo', 'vector-stats.json');
  try {
    if (existsSync(statsPath)) {
      const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
      const count = stats.vectorCount ?? 0;
      const updatedAt = typeof stats.updatedAt === 'number' ? stats.updatedAt : 0;
      const hasHnsw = stats.hasHnsw ?? false;
      const dbSizeKB = stats.dbSizeKB ?? 0;

      // Skew check (#639): the cache can drift out of sync with the live DB
      // when a writer clobbers it with zeros (#639) or when an external tool
      // mutates memory.db without going through the bridge. Cross-check the
      // cached vectorCount against the actual DB; if they differ by more than
      // VECTOR_STATS_SKEW_WARN_THRESHOLD, surface a stale-cache warning rather
      // than displaying a wrong number on the statusline.
      //
      // Cheap signals first — opening memory.db via sql.js loads the whole
      // file. Skip the open when the cache was clearly written after the last
      // DB mutation (mtime check) AND the cached count is non-zero. The
      // count===0 case keeps the open because that's the observed #639 failure
      // mode (cache silently clobbered to zero).
      let dbMtimeMs = 0;
      if (liveDbPath) {
        try { dbMtimeMs = statSync(liveDbPath).mtimeMs; } catch { /* missing — handled below */ }
      }
      const cacheNewerThanDb = updatedAt > 0 && dbMtimeMs > 0 && updatedAt >= dbMtimeMs;
      if (liveDbPath && (count === 0 || !cacheNewerThanDb)) {
        const liveCount = await countEmbeddedRowsFromDb(liveDbPath);
        if (liveCount !== null) {
          const denom = Math.max(liveCount, 1);
          const skew = Math.abs(liveCount - count) / denom;
          if (skew > VECTOR_STATS_SKEW_WARN_THRESHOLD) {
            return {
              name: 'Embeddings',
              status: 'warn',
              message: `vector-stats cache is stale (cached ${count}, DB has ${liveCount} embedded rows — ${Math.round(skew * 100)}% skew)`,
              fix: 'node node_modules/moflo/bin/build-embeddings.mjs',
            };
          }
        }
      }

      if (count === 0) {
        return {
          name: 'Embeddings',
          status: 'warn',
          message: `Memory DB exists (${dbSizeKB} KB) but 0 vectors indexed — documents not embedded`,
          fix: 'npx moflo memory init --force && npx moflo embeddings init'
        };
      }

      const hnswLabel = hasHnsw ? ', HNSW' : '';
      return {
        name: 'Embeddings',
        status: 'pass',
        message: `${count} vectors indexed (${dbSizeKB} KB${hnswLabel})`
      };
    }
  } catch {
    // Stats file unreadable — fall through to DB check
  }

  // 2. Check if memory DB file exists at all (reuse liveDbPath from above)
  const foundDbPath = liveDbPath ?? null;

  if (!foundDbPath) {
    return {
      name: 'Embeddings',
      status: 'warn',
      message: 'No memory database — embeddings not initialized',
      fix: 'npx moflo memory init --force'
    };
  }

  // 3. DB exists but no stats cache — try querying the DB for entry count
  try {
    const { checkMemoryInitialization } = await import('../memory/memory-initializer.js');
    const info = await checkMemoryInitialization(foundDbPath);
    if (!info.initialized) {
      return {
        name: 'Embeddings',
        status: 'warn',
        message: 'Memory DB exists but not properly initialized',
        fix: 'npx moflo memory init --force'
      };
    }
    const hasVectors = info.features?.vectorEmbeddings ?? false;
    if (!hasVectors) {
      return {
        name: 'Embeddings',
        status: 'warn',
        message: `Memory DB initialized (v${info.version}) but no vector_indexes table`,
        fix: 'npx moflo memory init --force && npx moflo embeddings init'
      };
    }
    return {
      name: 'Embeddings',
      status: 'pass',
      message: `Memory DB initialized (v${info.version}, vectors enabled)`
    };
  } catch (sqlJsError) {
    // sql.js not available — fall back to file-size heuristic
    const sqlDetail = errorDetail(sqlJsError);
    try {
      const stats = statSync(foundDbPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      return {
        name: 'Embeddings',
        status: 'warn',
        message: `Memory DB exists (${sizeMB} MB) — cannot verify vectors (sql.js not available: ${sqlDetail})`,
        fix: 'npm install sql.js && npx moflo embeddings init'
      };
    } catch (statError) {
      return { name: 'Embeddings', status: 'warn', message: `Unable to check: sql.js failed (${sqlDetail}), stat failed (${errorDetail(statError)})` };
    }
  }
}

/**
 * Auto-fix: execute fix commands for a failed/warned health check.
 * Returns true if the fix succeeded (re-check should pass).
 */
async function autoFixCheck(check: HealthCheck): Promise<boolean> {
  if (!check.fix) return false;

  // Map checks to programmatic fixes (not just shell commands)
  const fixActions: Record<string, () => Promise<boolean>> = {
    'Memory Database': async () => {
      try {
        const swarmDir = join(process.cwd(), '.swarm');
        if (!existsSync(swarmDir)) mkdirSync(swarmDir, { recursive: true });
        const { initializeMemoryDatabase } = await import('../memory/memory-initializer.js');
        const result = await initializeMemoryDatabase({ force: true, verbose: false });
        return result.success;
      } catch {
        // Fall back to CLI
        return runFixCommand('npx moflo memory init --force');
      }
    },
    'Embeddings': async () => {
      try {
        // Step 1: ensure memory DB exists
        const swarmDir = join(process.cwd(), '.swarm');
        if (!existsSync(swarmDir)) mkdirSync(swarmDir, { recursive: true });
        const dbPath = join(swarmDir, 'memory.db');
        if (!existsSync(dbPath)) {
          const { initializeMemoryDatabase } = await import('../memory/memory-initializer.js');
          await initializeMemoryDatabase({ force: true, verbose: false });
        }
        // Step 2: attempt embeddings init via CLI
        return runFixCommand('npx moflo embeddings init --force');
      } catch {
        return runFixCommand('npx moflo memory init --force');
      }
    },
    'Config File': async () => {
      try {
        const cfDir = join(process.cwd(), '.moflo');
        if (!existsSync(cfDir)) mkdirSync(cfDir, { recursive: true });
        return runFixCommand('npx moflo config init');
      } catch {
        return false;
      }
    },
    'Daemon Status': async () => {
      // Clean stale locks, then try to start daemon
      const lockFile = join(process.cwd(), '.moflo', 'daemon.lock');
      const pidFile = join(process.cwd(), '.moflo', 'daemon.pid');
      try {
        if (existsSync(lockFile)) {
          const { unlinkSync } = await import('fs');
          unlinkSync(lockFile);
        }
        if (existsSync(pidFile)) {
          const { unlinkSync } = await import('fs');
          unlinkSync(pidFile);
        }
      } catch { /* best effort */ }
      return runFixCommand('npx moflo daemon start');
    },
    'MCP Servers': async () => {
      return runFixCommand('claude mcp add moflo -- npx -y moflo mcp start');
    },
    'Claude Code CLI': async () => {
      return installClaudeCode();
    },
    'Zombie Processes': async () => {
      const result = await findZombieProcesses(true);
      return result.killed > 0 || result.found === 0;
    },
    'Gate Health': async () => {
      return fixGateHealthHooks();
    },
    'Status Line': async () => {
      const settingsPath = join(process.cwd(), '.claude', 'settings.json');
      if (!existsSync(settingsPath)) return false;
      try {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        if (!settings.statusLine) {
          settings.statusLine = {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/statusline.cjs" --compact',
          };
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        }
        return true;
      } catch {
        return false;
      }
    },
  };

  const fixFn = fixActions[check.name];
  if (fixFn) {
    try {
      output.writeln(output.dim(`  Fixing: ${check.name}...`));
      const success = await fixFn();
      if (success) {
        output.writeln(output.success(`  Fixed: ${check.name}`));
      } else {
        output.writeln(output.warning(`  Fix attempted but may need manual action: ${check.fix}`));
      }
      return success;
    } catch (e) {
      output.writeln(output.warning(`  Fix failed: ${errorDetail(e)}`));
      return false;
    }
  }

  // Generic: try running the fix command directly if it looks like a shell command
  if (check.fix.startsWith('npx ') || check.fix.startsWith('npm ') || check.fix.startsWith('claude ')) {
    return runFixCommand(check.fix);
  }

  return false;
}

/**
 * Run a shell command as a fix action. Returns true on exit code 0.
 */
async function runFixCommand(cmd: string): Promise<boolean> {
  try {
    await execAsync(cmd, {
      encoding: 'utf8' as BufferEncoding,
      timeout: 30000,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      env: { ...process.env },
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fix missing hook wiring in settings.json by patching in entries for
 * any REQUIRED_HOOK_WIRING patterns that aren't present.
 * Delegates to shared repairHookWiring() to stay DRY with the upgrade path.
 */
async function fixGateHealthHooks(): Promise<boolean> {
  const settingsPath = join(process.cwd(), '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return false;

  try {
    const raw = readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(raw) as Record<string, unknown>;

    const { repaired } = repairHookWiring(settings);
    if (repaired.length === 0) return true; // nothing to fix

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// Check moflo.yaml exists and contains all required top-level sections (#895).
// Catches three failure modes:
//   1. File missing — session-start should have created it; warn user that
//      defaults are invisible/untunable.
//   2. File empty / unreadable — corrupted by half-write or filesystem error.
//   3. Top-level sections missing — partial yaml from manual edit or stale
//      copy from a moflo version that didn't ship a section yet. The
//      session-start yaml-upgrader would normally backfill these, but the
//      diagnostic surfaces it for users who never restarted.
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

  // Missing sections — recoverable on next session-start via yaml-upgrader.
  return {
    name: 'moflo.yaml',
    status: 'warn',
    message: `Missing sections: ${result.missingSections.join(', ')}`,
    fix: 'Restart Claude Code (yaml-upgrader auto-appends) or `npx moflo init --force`',
  };
}

// Check test directories configured in moflo.yaml
async function checkTestDirs(): Promise<HealthCheck> {
  const yamlPath = join(process.cwd(), 'moflo.yaml');

  if (!existsSync(yamlPath)) {
    return { name: 'Test Directories', status: 'warn', message: 'No moflo.yaml — test indexing unconfigured', fix: 'npx moflo init' };
  }

  try {
    const content = readFileSync(yamlPath, 'utf-8');

    // Check if tests section exists
    const testsBlock = content.match(/tests:\s*\n\s+directories:\s*\n((?:\s+-\s+.+\n?)+)/);
    if (!testsBlock) {
      return { name: 'Test Directories', status: 'warn', message: 'No tests section in moflo.yaml', fix: 'npx moflo init --force' };
    }

    // Extract configured directories
    const items = testsBlock[1].match(/-\s+(.+)/g);
    if (!items || items.length === 0) {
      return { name: 'Test Directories', status: 'warn', message: 'Empty test directories list' };
    }

    const dirs = items.map(item => item.replace(/^-\s+/, '').trim());
    const existing = dirs.filter(d => existsSync(join(process.cwd(), d)));
    const missing = dirs.filter(d => !existsSync(join(process.cwd(), d)));

    // Check auto_index.tests flag
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

// Check semantic search quality — verify no 0.500 keyword fallback scores
async function checkSemanticQuality(): Promise<HealthCheck> {
  try {
    const { searchEntries } = await import('../memory/memory-initializer.js');
    const result = await searchEntries({
      query: 'test infrastructure health check',
      namespace: 'patterns',
      limit: 5,
      threshold: 0.1
    });

    if (!result.success || result.results.length === 0) {
      return {
        name: 'Semantic Quality',
        status: 'warn',
        message: 'No search results (empty database or no patterns namespace)',
      };
    }

    const scores = result.results.map((r: { score: number }) => r.score);
    const allSame = scores.every((s: number) => s === scores[0]);
    const hasFallback = scores.some((s: number) => s === 0.5);

    if (hasFallback) {
      return {
        name: 'Semantic Quality',
        status: 'fail',
        message: `${scores.length} results, scores include 0.500 fallback (keyword-only, no embeddings)`,
        fix: 'Re-index with: npx moflo embeddings build --force'
      };
    }

    if (allSame && scores.length > 1) {
      return {
        name: 'Semantic Quality',
        status: 'warn',
        message: `${scores.length} results, all scores identical (${scores[0].toFixed(3)}) — degraded search`,
      };
    }

    const topScore = Math.max(...scores);
    return {
      name: 'Semantic Quality',
      status: topScore >= 0.3 ? 'pass' : 'warn',
      message: `${scores.length} results, top ${topScore.toFixed(3)}, varied (semantic search active)`,
    };
  } catch (e) {
    return {
      name: 'Semantic Quality',
      status: 'warn',
      message: `Check failed: ${e instanceof Error ? e.message.split(/\r?\n/)[0] : 'error'}`,
    };
  }
}

// Check memory-backed patterns (populated by pretrain) as a fallback for neural checks.
// Uses the same pattern-search handler that pretrain writes to.
async function checkMemoryPatterns(_namespace: string): Promise<number> {
  try {
    // Use the pattern-search handler (same store pretrain writes to)
    const hooksMod = await import('../mcp-tools/hooks-tools.js');
    if (hooksMod.hooksPatternSearch) {
      const result = await hooksMod.hooksPatternSearch.handler({
        query: 'pretrain',
        topK: 1,
        minConfidence: 0.1,
      });
      const matches = (result as Record<string, unknown>)?.results;
      if (Array.isArray(matches)) return matches.length;
    }
  } catch {
    // hooks module not available
  }
  // Secondary fallback: check the memory DB file exists
  try {
    const { existsSync } = await import('fs');
    const { join } = await import('path');
    const dbPath = join(process.cwd(), '.claude', 'memory.db');
    if (existsSync(dbPath)) return 1;
  } catch {
    // fs not available
  }
  return 0;
}

// Check intelligence layer: SONA, EWC++, LoRA, Flash Attention, ReasoningBank
// Exercises each component with a lightweight functional test rather than just checking "loaded".
async function checkIntelligence(): Promise<HealthCheck> {
  try {
    const neural = await import('../neural/index.js');
    const results: string[] = [];
    const failures: string[] = [];

    // 1. SONA — create manager, run trajectory lifecycle
    try {
      const sona = neural.createSONAManager('balanced');
      await sona.initialize();
      const tid = sona.beginTrajectory('doctor-check', 'general');
      const embedding = new Float32Array(64).fill(0.1);
      sona.recordStep(tid, 'test-action', 0.8, embedding);
      const traj = sona.completeTrajectory(tid, 0.9);
      if (traj && traj.steps.length > 0) {
        results.push('SONA');
      } else {
        failures.push('SONA (no trajectory output)');
      }
      await sona.cleanup();
    } catch (e) {
      failures.push(`SONA (${e instanceof Error ? e.message : 'error'})`);
    }

    // 2. ReasoningBank — verify instantiation and trajectory store/distill lifecycle
    try {
      const rb = neural.createReasoningBank();
      const stateAfter = new Float32Array(64).fill(0.2);
      const trajectory = {
        trajectoryId: 'doctor-test',
        context: 'health check',
        domain: 'general' as const,
        steps: [{ stepId: 's1', action: 'test', reward: 1, stateBefore: stateAfter, stateAfter, timestamp: Date.now() }],
        startTime: Date.now(),
        endTime: Date.now(),
        qualityScore: 0.9,
        isComplete: true,
        verdict: {
          success: true,
          confidence: 0.9,
          strengths: ['health check passed'],
          weaknesses: [],
          improvements: [],
          relevanceScore: 0.9,
        },
      };
      rb.storeTrajectory(trajectory);
      // distill() populates memories (storeTrajectory alone does not)
      const distilled = await rb.distill(trajectory);
      if (distilled || rb.getTrajectories().length > 0) {
        results.push('ReasoningBank');
      } else {
        // Fallback: check memory-backed patterns from pretrain
        const memoryPatterns = await checkMemoryPatterns('patterns');
        if (memoryPatterns > 0) {
          results.push('ReasoningBank(memory)');
        } else {
          failures.push('ReasoningBank (distill returned no data)');
        }
      }
    } catch (e) {
      failures.push(`ReasoningBank (${e instanceof Error ? e.message : 'error'})`);
    }

    // 3. PatternLearner — extract + match
    try {
      const pl = neural.createPatternLearner();
      const embedding = new Float32Array(64).fill(0.3);
      const now = Date.now();
      pl.extractPattern(
        {
          trajectoryId: 'doctor-pl', context: 'test', domain: 'general' as const,
          steps: [{ stepId: 's1', action: 'test', reward: 1, stateBefore: embedding, stateAfter: embedding, timestamp: now }],
          startTime: now, endTime: now, qualityScore: 1, isComplete: true,
        },
        { memoryId: 'doctor-pl-mem', trajectoryId: 'doctor-pl', strategy: 'health-check', keyLearnings: ['test'], embedding, quality: 1, usageCount: 0, lastUsed: now }
      );
      const matches = pl.findMatches(embedding, 1);
      if (matches.length > 0) {
        results.push('PatternLearner');
      } else {
        // Fallback: check memory-backed patterns from pretrain
        const memoryPatterns = await checkMemoryPatterns('patterns');
        if (memoryPatterns > 0) {
          results.push('PatternLearner(memory)');
        } else {
          failures.push('PatternLearner (no matches)');
        }
      }
    } catch (e) {
      failures.push(`PatternLearner (${e instanceof Error ? e.message : 'error'})`);
    }

    // 4. SONALearningEngine (MicroLoRA + EWC++)
    try {
      const engine = neural.createSONALearningEngine();
      const ctx = { domain: 'general' as const, queryEmbedding: new Float32Array(768).fill(0.1) };
      const adapted = await engine.adapt(ctx);
      const components: string[] = [];
      if (adapted && adapted.transformedQuery) components.push('LoRA');
      if (adapted && adapted.patterns !== undefined) components.push('EWC++');
      if (components.length > 0) {
        results.push(...components);
      } else {
        failures.push('LoRA/EWC++ (adapt returned no data)');
      }
    } catch (e) {
      // Gracefully handle cold/uninitialized state
      const msg = e instanceof Error ? e.message : 'error';
      if (msg.includes('undefined') || msg.includes('not initialized')) {
        results.push('LoRA/EWC++(cold)');
      } else {
        failures.push(`LoRA/EWC++ (${msg})`);
      }
    }

    // 5. RL Algorithms — quick instantiation check
    try {
      const algNames: string[] = [];
      const ppo = neural.createPPO();
      if (ppo) algNames.push('PPO');
      const dqn = neural.createDQN();
      if (dqn) algNames.push('DQN');
      const ql = neural.createQLearning();
      if (ql) algNames.push('Q-Learn');
      if (algNames.length > 0) {
        results.push(`RL(${algNames.join('+')})`);
      }
    } catch (e) {
      failures.push(`RL (${e instanceof Error ? e.message : 'error'})`);
    }

    if (failures.length > 0) {
      return {
        name: 'Intelligence',
        status: results.length > 0 ? 'warn' : 'fail',
        message: `${results.join(', ')} OK; FAILED: ${failures.join(', ')}`,
        fix: 'Check neural module imports and dependencies',
      };
    }

    return {
      name: 'Intelligence',
      status: 'pass',
      message: results.join(', '),
    };
  } catch (e) {
    return {
      name: 'Intelligence',
      status: 'warn',
      message: `Module unavailable: ${e instanceof Error ? e.message.split(/\r?\n/)[0] : 'import failed'}`,
      fix: 'Ensure moflo is built (npm run build)',
    };
  }
}

// Check whether a given PID is still running.
// Uses signal 0 which works cross-platform (Windows, Linux, macOS) without
// needing PowerShell or /proc — Node handles the platform abstraction.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Fast path: kill processes tracked in the shared ProcessManager registry.
// This avoids the expensive OS-level process scan for known background tasks.
function killTrackedProcesses(): number {
  const registryFile = join(process.cwd(), '.moflo', 'background-pids.json');
  const lockFile = join(process.cwd(), '.moflo', 'spawn.lock');
  let killed = 0;
  try {
    if (existsSync(registryFile)) {
      const entries = JSON.parse(readFileSync(registryFile, 'utf-8'));
      for (const entry of entries) {
        if (!isProcessAlive(entry.pid)) continue;
        try {
          if (process.platform === 'win32') {
            execSync(`taskkill /F /PID ${entry.pid}`, { timeout: 5000, windowsHide: true });
          } else {
            process.kill(entry.pid, 'SIGKILL');
          }
          killed++;
        } catch { /* already gone */ }
      }
      // Clear registry
      writeFileSync(registryFile, '[]');
    }
  } catch { /* non-fatal */ }
  // Remove spawn lock
  try {
    if (existsSync(lockFile)) unlinkSync(lockFile);
  } catch { /* ok */ }
  return killed;
}

// Read the set of moflo background PIDs registered with the shared
// ProcessManager (.moflo/background-pids.json). These are legitimate tracked
// background tasks (sequential indexer chain, daemon, MCP servers spawned by
// session-start) — they are detached:true by design so their parents have
// already exited, but they are NOT orphans. Without this allow-set,
// findZombieProcesses() flags every running indexer step as a zombie.
function readTrackedBackgroundPids(): Set<number> {
  const result = new Set<number>();
  const registryFile = join(process.cwd(), '.moflo', 'background-pids.json');
  try {
    if (!existsSync(registryFile)) return result;
    const entries = JSON.parse(readFileSync(registryFile, 'utf-8'));
    if (!Array.isArray(entries)) return result;
    for (const entry of entries) {
      if (entry && typeof entry.pid === 'number' && entry.pid > 0) {
        result.add(entry.pid);
      }
    }
  } catch { /* malformed or unreadable — treat as empty */ }
  return result;
}

// Find and optionally kill orphaned moflo/claude-flow node processes.
// A process is only "orphaned" if its parent is no longer alive — meaning
// nothing will clean it up. MCP servers spawned by a live Claude Code session
// have a live parent (claude.exe) and must not be flagged.
async function findZombieProcesses(kill = false): Promise<{ found: number; killed: number; pids: number[] }> {
  const legitimatePid = getDaemonLockHolder(process.cwd());
  const trackedPids = readTrackedBackgroundPids();
  const currentPid = process.pid;
  const parentPid = process.ppid;
  const found: number[] = [];
  let killed = 0;

  // Collect candidates as { pid, ppid } so we can check parent liveness
  const candidates: { pid: number; ppid: number }[] = [];

  try {
    if (process.platform === 'win32') {
      // Windows: include ParentProcessId so we can verify orphan status
      const result = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Select-Object ProcessId,ParentProcessId,CommandLine | Format-Table -AutoSize -Wrap"',
        { encoding: 'utf-8', timeout: 10000, windowsHide: true },
      );
      const lines = result.split(/\r?\n/);
      for (const line of lines) {
        if (/moflo|claude-flow|flo\s+(hooks|gate|mcp|daemon)/i.test(line)) {
          // Format-Table columns: ProcessId  ParentProcessId  CommandLine...
          const match = line.match(/^\s*(\d+)\s+(\d+)/);
          if (match) {
            candidates.push({ pid: parseInt(match[1], 10), ppid: parseInt(match[2], 10) });
          }
        }
      }
    } else {
      // Unix/macOS: use ps with explicit PID+PPID columns for reliable parsing
      const result = execSync(
        'ps -eo pid,ppid,command | grep -E "node.*(moflo|claude-flow)" | grep -v grep',
        { encoding: 'utf-8', timeout: 5000 },
      );
      const lines = result.trim().split(/\r?\n/);
      for (const line of lines) {
        const match = line.trim().match(/^(\d+)\s+(\d+)/);
        if (match) {
          candidates.push({ pid: parseInt(match[1], 10), ppid: parseInt(match[2], 10) });
        }
      }
    }
  } catch {
    // No matches found (grep exits non-zero) or command failed
  }

  // Filter: skip known-good PIDs and processes whose parent is still alive.
  // A live parent (e.g. claude.exe for MCP servers) means the process is managed, not orphaned.
  for (const { pid, ppid } of candidates) {
    if (pid === currentPid || pid === parentPid || pid === legitimatePid) continue;
    // Tracked background tasks (indexer chain, etc.) are detached:true so their
    // parent is dead by design. The ProcessManager registry tells us they are
    // legitimate, not orphaned.
    if (trackedPids.has(pid)) continue;
    if (isProcessAlive(ppid)) continue;
    // Defense-in-depth: detached daemons have dead parents by design.
    // Even if the lock file is missing/corrupted, don't kill a running daemon.
    if (isDaemonProcess(pid)) continue;
    found.push(pid);
  }

  if (kill && found.length > 0) {
    for (const pid of found) {
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /F /PID ${pid}`, { timeout: 5000, windowsHide: true });
        } else {
          process.kill(pid, 'SIGKILL');
        }
        killed++;
      } catch {
        // Process may have already exited
      }
    }

    // Clean up stale daemon lock if we killed the holder
    if (legitimatePid && found.includes(legitimatePid)) {
      releaseDaemonLock(process.cwd(), legitimatePid, true);
    }
  }

  return { found: found.length, killed, pids: found };
}

// Format health check result
function formatCheck(check: HealthCheck): string {
  const icon = check.status === 'pass' ? output.success('✓') :
               check.status === 'warn' ? output.warning('⚠') :
               output.error('✗');
  return `${icon} ${check.name}: ${check.message}`;
}

// Main doctor command
export const doctorCommand: Command = {
  name: 'doctor',
  aliases: ['healer'],
  description: 'System diagnostics and health checks',
  options: [
    {
      name: 'fix',
      short: 'f',
      description: 'Automatically fix issues where possible',
      type: 'boolean',
      default: false
    },
    {
      name: 'install',
      short: 'i',
      description: 'Auto-install missing dependencies (Claude Code CLI)',
      type: 'boolean',
      default: false
    },
    {
      name: 'component',
      short: 'c',
      description: 'Check specific component (version, node, npm, config, daemon, memory, embeddings, git, mcp, claude, disk, typescript, semantic, intelligence, swarm, hive-mind)',
      type: 'string'
    },
    {
      name: 'verbose',
      short: 'v',
      description: 'Verbose output',
      type: 'boolean',
      default: false
    },
    {
      name: 'kill-zombies',
      short: 'k',
      description: 'Find and kill orphaned moflo/claude-flow node processes',
      type: 'boolean',
      default: false
    },
    {
      // Issue #784: fail on warnings. Used by consumer-install-smoke so a
      // single regressed check (like the 4.9.0-rc.11 Sandbox-Tier silent
      // warn) blocks merge instead of slipping into a published tarball.
      name: 'strict',
      description: 'Treat warnings as failures (non-zero exit). Used by CI.',
      type: 'boolean',
      default: false
    },
    {
      // Companion to --strict. CI-legitimate warnings (e.g. "Sandbox Tier"
      // on a runner without Docker) are explicitly allowlisted by name so
      // the test owner's intent is on record. Comma-separated; matches the
      // `name` field of each check (case-sensitive substring).
      name: 'allow-warn',
      description: 'In --strict mode, comma-separated check names whose warnings are tolerated.',
      type: 'string'
    },
    {
      // Issue #818: machine-readable output. Suppresses banner/spinner/auto-fix
      // and emits a single JSON document so CI gates and smoke harnesses can
      // consume per-check details (including FunctionalCheckDetail entries).
      name: 'json',
      description: 'Emit a single JSON document with per-check + per-subcheck details. Suppresses formatted output.',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow doctor', description: 'Run full health check' },
    { command: 'claude-flow doctor --fix', description: 'Show fixes for issues' },
    { command: 'claude-flow doctor --install', description: 'Auto-install missing dependencies' },
    { command: 'claude-flow doctor --kill-zombies', description: 'Find and kill zombie processes' },
    { command: 'claude-flow doctor -c version', description: 'Check for stale npx cache' },
    { command: 'claude-flow doctor -c claude', description: 'Check Claude Code CLI only' },
    { command: 'claude-flow doctor --strict', description: 'Fail (exit 1) on any warning — used by CI' },
    { command: 'claude-flow doctor --json', description: 'Emit a single JSON doc with per-check + per-subcheck details (for CI/smoke gates)' },
    { command: 'claude-flow doctor -c swarm', description: 'Run only the swarm + agent + task coordinator-path tripwire (epic #798)' },
    { command: 'claude-flow doctor -c hive-mind', description: 'Run only the hive-mind MessageBus + shared-coordinator tripwire' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const showFix = ctx.flags.fix as boolean;
    const autoInstall = ctx.flags.install as boolean;
    const component = ctx.flags.component as string;
    const verbose = ctx.flags.verbose as boolean;
    const killZombies = ctx.flags.killZombies as boolean;
    const strict = ctx.flags.strict as boolean;
    // Parser normalises kebab-case flag names to camelCase: `--allow-warn`
    // arrives as `ctx.flags.allowWarn`. Reading the dashed form returns
    // undefined and silently disables the allowlist (was the bug that made
    // every smoke run fail until 4.9.0-rc.13).
    const allowWarnRaw = ctx.flags.allowWarn as string | undefined;
    const allowWarnList = allowWarnRaw
      ? allowWarnRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const jsonOutput = ctx.flags.json as boolean;

    if (!jsonOutput) {
      output.writeln();
      output.writeln(output.bold('MoFlo Doctor'));
      output.writeln(output.dim('System diagnostics and health check'));
      output.writeln(output.dim('─'.repeat(50)));
      output.writeln();
    }

    // --allow-warn is meaningless without --strict; surface the misuse
    // under the banner so it reads as doctor output, not orphaned text.
    if (allowWarnList.length > 0 && !strict && !jsonOutput) {
      output.writeln(output.warning(
        '--allow-warn requires --strict; ignoring (warnings are tolerated by default).',
      ));
      output.writeln();
    }

    // Handle --kill-zombies early
    if (killZombies) {
      output.writeln(output.bold('Zombie Process Scan'));
      output.writeln();

      // Fast path: kill tracked processes from the shared registry first
      const registryKilled = killTrackedProcesses();
      if (registryKilled > 0) {
        output.writeln(output.success(`  Killed ${registryKilled} tracked background process(es) from registry`));
      }

      // Slow path: OS-level scan for any remaining orphans
      const scan = await findZombieProcesses(false);

      if (scan.found === 0) {
        if (registryKilled === 0) {
          output.writeln(output.success('  No orphaned moflo processes found'));
        }
      } else {
        output.writeln(output.warning(`  Found ${scan.found} additional orphaned process(es): PIDs ${scan.pids.join(', ')}`));

        // Kill them
        const result = await findZombieProcesses(true);
        if (result.killed > 0) {
          output.writeln(output.success(`  Killed ${result.killed} zombie process(es)`));
        }
        if (result.killed < result.found) {
          output.writeln(output.warning(`  ${result.found - result.killed} process(es) could not be killed`));
        }
      }

      output.writeln();
      output.writeln(output.dim('─'.repeat(50)));
      output.writeln();
    }

    const checkZombieProcesses = async (): Promise<HealthCheck> => {
      try {
        const scan = await findZombieProcesses(false);
        if (scan.found === 0) {
          return { name: 'Zombie Processes', status: 'pass', message: 'No orphaned processes' };
        }
        return {
          name: 'Zombie Processes',
          status: 'warn',
          message: `${scan.found} orphaned process(es) (PIDs: ${scan.pids.join(', ')})`,
          fix: 'moflo doctor --kill-zombies'
        };
      } catch {
        return { name: 'Zombie Processes', status: 'pass', message: 'Check skipped' };
      }
    };

    // Check Spell Engine health — validates core modules, built output, and step commands
    async function checkSpellEngine(): Promise<HealthCheck> {
      try {
        // Resolve relative to the moflo package root (works in both dev and consumer)
        const mofloRoot = getMofloRoot();
        if (!mofloRoot) {
          return { name: 'Spell Engine', status: 'warn', message: 'Could not locate moflo package root', fix: 'npm run build' };
        }

        // Post-#586 workspace collapse: spell engine lives at src/cli/spells/
        // (source) and dist/src/cli/spells/ (compiled). The legacy
        // src/modules/spells/{src,dist}/ tree was deleted.
        const distDir = join(mofloRoot, 'dist', 'src', 'cli', 'spells');
        const srcDir = join(mofloRoot, 'src', 'cli', 'spells');
        const hasDistDir = existsSync(distDir);
        const hasSrcDir = existsSync(srcDir);

        if (!hasDistDir && !hasSrcDir) {
          return { name: 'Spell Engine', status: 'warn', message: 'Spell engine not found', fix: 'npm run build' };
        }

        // Core compiled modules that must exist
        const coreModules = [
          'core/runner',
          'core/step-executor',
          'core/step-command-registry',
          'core/interpolation',
          'core/credential-masker',
          'registry/spell-registry',
          'factory/runner-factory',
          'schema',
          'types',
          'credentials',
          'scheduler',
        ];

        const baseDir = hasDistDir ? distDir : srcDir;
        const ext = hasDistDir ? '.js' : '.ts';

        // Directories don't need an extension check
        const dirModules = ['schema', 'types', 'credentials', 'scheduler'];
        const missing = coreModules.filter(m =>
          dirModules.includes(m)
            ? !existsSync(join(baseDir, m))
            : !existsSync(join(baseDir, m + ext))
        );

        if (missing.length > 0) {
          return {
            name: 'Spell Engine',
            status: 'warn',
            message: `Missing modules: ${missing.join(', ')}`,
            fix: 'npm run build',
          };
        }

        // Check for step commands directory
        const commandsDir = join(baseDir, 'commands');
        const hasCommands = existsSync(commandsDir);

        // Check for spell definition loaders
        const loadersDir = join(baseDir, 'loaders');
        const hasLoaders = existsSync(loadersDir);

        // Check for index entry point
        const hasIndex = existsSync(join(baseDir, 'index' + ext));

        const parts: string[] = [];
        parts.push(`${coreModules.length} core modules`);
        if (hasCommands) parts.push('step commands');
        if (hasLoaders) parts.push('loaders');
        if (hasIndex) parts.push('index');

        return {
          name: 'Spell Engine',
          status: 'pass',
          message: parts.join(', '),
        };
      } catch (e) {
        return { name: 'Spell Engine', status: 'warn', message: `Unable to check spell engine: ${errorDetail(e)}` };
      }
    }

    // Check sandbox tier — reports OS sandbox capability AND, if the project
    // has `sandbox.enabled: true`, whether the effective sandbox would
    // actually start (e.g. Windows Docker image pulled and configured).
    async function checkSandboxTier(): Promise<HealthCheck> {
      try {
        const {
          detectSandboxCapability,
          loadSandboxConfigFromProject,
          resolveEffectiveSandbox,
        } = await import('../spells/index.js');

        const cap = await detectSandboxCapability();
        const config = await loadSandboxConfigFromProject(process.cwd());

        // If sandboxing isn't enabled in moflo.yaml, just report capability.
        if (!config.enabled) {
          if (cap.available) {
            return {
              name: 'Sandbox Tier',
              status: 'pass',
              message: `${cap.tool} available (${cap.platform}) — sandboxing off in moflo.yaml`,
            };
          }

          const offHint: Record<string, string> = {
            win32: 'Install Docker Desktop and set sandbox.dockerImage in moflo.yaml to enable sandboxing',
            linux: 'Install bubblewrap: sudo apt install bubblewrap',
            darwin: 'sandbox-exec should be available on macOS — check /usr/bin/sandbox-exec',
          };

          return {
            name: 'Sandbox Tier',
            status: 'pass',
            message: `sandboxing off (${cap.platform}, denylist active)`,
            fix: offHint[cap.platform],
          };
        }

        // Sandboxing is enabled — run the real resolver and surface any error.
        try {
          const effective = await resolveEffectiveSandbox(config);
          if (effective.useOsSandbox) {
            const imageHint = effective.config.dockerImage ? `, ${effective.config.dockerImage}` : '';
            return {
              name: 'Sandbox Tier',
              status: 'pass',
              message: `${cap.tool} ready (${cap.platform}${imageHint})`,
            };
          }
          return {
            name: 'Sandbox Tier',
            status: 'warn',
            message: `denylist only (${cap.platform})`,
          };
        } catch (err) {
          return {
            name: 'Sandbox Tier',
            status: 'warn',
            message: `sandboxing enabled but not ready (${cap.platform})`,
            fix: errorDetail(err),
          };
        }
      } catch (err) {
        return {
          name: 'Sandbox Tier',
          status: 'warn',
          message: `Unable to detect: ${err instanceof Error ? err.message : 'unknown error'}`,
        };
      }
    }

    const allChecks: (() => Promise<HealthCheck>)[] = [
      checkVersionFreshness,
      checkNodeVersion,
      checkNpmVersion,
      checkClaudeCode,
      checkGit,
      checkGitRepo,
      checkConfigFile,
      checkMofloYamlCompliance,
      checkStatusLine,
      checkDaemonStatus,
      checkMemoryDatabase,
      checkEmbeddings,
      checkEmbeddingHygiene,
      checkTestDirs,
      checkMcpServers,
      checkDiskSpace,
      checkBuildTools,
      checkSemanticQuality,
      checkIntelligence,
      checkSpellEngine,
      checkZombieProcesses,
      checkSubagentHealth,
      checkSpellExecution,
      checkMcpToolInvocation,
      checkMcpSpellIntegration,
      checkHookExecution,
      checkGateHealth,
      checkHookBlockDrift,
      checkMofloDbBridge,
      // Issue #818 / epic #798 — coordinator-path tripwires. They share the
      // singleton coordinator with checkSubagentHealth above and assert by
      // agent-id (not absolute counts) so they tolerate the parallel batch.
      checkSwarmFunctional,
      checkHiveMindFunctional,
      // Issue #844 — memory_store + memory_search round-trip across subagent,
      // swarm-agent, and hive-mind contexts. Catches the failure classes from
      // #837 (threshold:0 ignored), #838/#842 (per-actor gating), and embedder
      // wiring regressions (hash fallback) that the coordinator-only checks
      // above would miss.
      checkMemoryAccessFunctional,
      checkSandboxTier,
    ];

    const componentMap: Record<string, () => Promise<HealthCheck>> = {
      'version': checkVersionFreshness,
      'freshness': checkVersionFreshness,
      'node': checkNodeVersion,
      'npm': checkNpmVersion,
      'claude': checkClaudeCode,
      'config': checkConfigFile,
      'yaml': checkMofloYamlCompliance,
      'moflo-yaml': checkMofloYamlCompliance,
      'statusline': checkStatusLine,
      'status-line': checkStatusLine,
      'daemon': checkDaemonStatus,
      'memory': checkMemoryDatabase,
      'embeddings': checkEmbeddings,
      'embedding-hygiene': checkEmbeddingHygiene,
      'hygiene': checkEmbeddingHygiene,
      'git': checkGit,
      'mcp': checkMcpServers,
      'disk': checkDiskSpace,
      'typescript': checkBuildTools,
      'tests': checkTestDirs,
      'semantic': checkSemanticQuality,
      'quality': checkSemanticQuality,
      'intelligence': checkIntelligence,
      'workflows': checkSpellEngine,
      'workflow': checkSpellEngine,
      'subagent': checkSubagentHealth,
      'subagents': checkSubagentHealth,
      'agents': checkSubagentHealth,
      'spell-exec': checkSpellExecution,
      'mcp-tools': checkMcpToolInvocation,
      'mcp-spell': checkMcpSpellIntegration,
      'hooks': checkHookExecution,
      'gates': checkGateHealth,
      'gate': checkGateHealth,
      'hook-drift': checkHookBlockDrift,
      'drift': checkHookBlockDrift,
      'sandbox': checkSandboxTier,
      'sandbox-tier': checkSandboxTier,
      'moflodb': checkMofloDbBridge,
      'bridge': checkMofloDbBridge,
      'swarm': checkSwarmFunctional,
      'swarm-functional': checkSwarmFunctional,
      'hive': checkHiveMindFunctional,
      'hive-mind': checkHiveMindFunctional,
      'hive-mind-functional': checkHiveMindFunctional,
      'memory-access': checkMemoryAccessFunctional,
      'memory-functional': checkMemoryAccessFunctional,
    };

    let checksToRun = allChecks;
    if (component && componentMap[component]) {
      checksToRun = [componentMap[component]];
    }

    const results: HealthCheck[] = [];
    const fixes: string[] = [];

    // OPTIMIZATION: Run all checks in parallel for 3-5x faster execution
    const spinner = jsonOutput
      ? null
      : output.createSpinner({ text: 'Running health checks in parallel...', spinner: 'dots' });
    spinner?.start();

    // Issue #818: in --json mode, several deep checks (spell engine probe,
    // mcp-spell bridge, etc.) write `[spell] ...` log lines straight to
    // stdout — that breaks the single-JSON-document contract. Capture and
    // discard stdout writes while checks run; restore in `finally` so a
    // throw can't leave the process with a stubbed stdout.
    const realStdoutWrite = process.stdout.write.bind(process.stdout);
    const restoreStdout = () => {
      if (jsonOutput) {
        (process.stdout as unknown as { write: typeof realStdoutWrite }).write = realStdoutWrite;
      }
    };
    if (jsonOutput) {
      (process.stdout as unknown as { write: (...args: unknown[]) => boolean }).write =
        (..._args: unknown[]) => true;
    }

    try {
      // Execute all checks concurrently
      let checkResults: PromiseSettledResult<HealthCheck>[];
      try {
        checkResults = await Promise.allSettled(checksToRun.map(check => check()));
      } finally {
        spinner?.stop();
        restoreStdout();
      }

      // Process results in order
      for (const settledResult of checkResults) {
        if (settledResult.status === 'fulfilled') {
          const result = settledResult.value;
          results.push(result);
          if (!jsonOutput) output.writeln(formatCheck(result));

          if (result.fix && (result.status === 'fail' || result.status === 'warn')) {
            fixes.push(`${result.name}: ${result.fix}`);
          }
        } else {
          const errorResult: HealthCheck = {
            name: 'Check',
            status: 'fail',
            message: settledResult.reason?.message || 'Unknown error'
          };
          results.push(errorResult);
          if (!jsonOutput) output.writeln(formatCheck(errorResult));
        }
      }
    } catch (error) {
      spinner?.stop();
      restoreStdout();
      if (!jsonOutput) output.writeln(output.error('Failed to run health checks'));
    }

    // Issue #818: machine-readable output. Emits a single JSON document with
    // per-check fields (and any FunctionalCheckDetail entries from the swarm/
    // hive checks) and exits with the right code. Skips auto-fix entirely —
    // --json is read-only by intent so CI gates can consume it without
    // mutating the working tree.
    if (jsonOutput) {
      const passed = results.filter(r => r.status === 'pass').length;
      const warnings = results.filter(r => r.status === 'warn').length;
      const failed = results.filter(r => r.status === 'fail').length;

      const allowSet = new Set(allowWarnList);
      const strictWarningFailures = strict
        ? results.filter(r => r.status === 'warn' && !allowSet.has(r.name)).map(r => r.name)
        : [];

      const exitCode = failed > 0 || strictWarningFailures.length > 0 ? 1 : 0;

      process.stdout.write(JSON.stringify({
        summary: { passed, warnings, failed },
        strict: strict ? { strictMode: true, warningsTriggeringFail: strictWarningFailures } : { strictMode: false },
        results,
      }, null, 2) + '\n');

      return { success: exitCode === 0, exitCode, data: { passed, warnings, failed, results } };
    }

    // Auto-install missing dependencies if requested
    if (autoInstall) {
      const claudeCodeResult = results.find(r => r.name === 'Claude Code CLI');
      if (claudeCodeResult && claudeCodeResult.status !== 'pass') {
        const installed = await installClaudeCode();
        if (installed) {
          // Re-check Claude Code after installation
          const newCheck = await checkClaudeCode();
          const idx = results.findIndex(r => r.name === 'Claude Code CLI');
          if (idx !== -1) {
            results[idx] = newCheck;
            // Update fixes list
            const fixIdx = fixes.findIndex(f => f.startsWith('Claude Code CLI:'));
            if (fixIdx !== -1 && newCheck.status === 'pass') {
              fixes.splice(fixIdx, 1);
            }
          }
          output.writeln(formatCheck(newCheck));
        }
      }
    }

    // Summary
    const passed = results.filter(r => r.status === 'pass').length;
    const warnings = results.filter(r => r.status === 'warn').length;
    const failed = results.filter(r => r.status === 'fail').length;

    output.writeln();
    output.writeln(output.dim('─'.repeat(50)));
    output.writeln();

    const summaryParts = [
      output.success(`${passed} passed`),
      warnings > 0 ? output.warning(`${warnings} warnings`) : null,
      failed > 0 ? output.error(`${failed} failed`) : null
    ].filter(Boolean);

    output.writeln(`Summary: ${summaryParts.join(', ')}`);

    // Auto-fix or show fixes
    if (showFix && fixes.length > 0) {
      output.writeln();
      output.writeln(output.bold('Auto-fixing issues...'));
      output.writeln();

      const fixableResults = results.filter(r => r.fix && (r.status === 'fail' || r.status === 'warn'));
      let fixed = 0;
      const unfixed: string[] = [];

      for (const check of fixableResults) {
        const success = await autoFixCheck(check);
        if (success) {
          fixed++;
        } else {
          unfixed.push(`${check.name}: ${check.fix}`);
        }
      }

      if (fixed > 0) {
        output.writeln();
        output.writeln(output.success(`Auto-fixed ${fixed} issue${fixed > 1 ? 's' : ''}`));
      }
      if (unfixed.length > 0) {
        output.writeln();
        output.writeln(output.bold('Manual fixes needed:'));
        for (const fix of unfixed) {
          output.writeln(output.dim(`  ${fix}`));
        }
      }

      // Re-run checks to show updated status
      if (fixed > 0) {
        output.writeln();
        output.writeln(output.dim('Re-checking...'));
        output.writeln();
        const reResults = await Promise.allSettled(checksToRun.map(check => check()));
        let rePassed = 0, reWarnings = 0, reFailed = 0;
        for (const sr of reResults) {
          if (sr.status === 'fulfilled') {
            output.writeln(formatCheck(sr.value));
            if (sr.value.status === 'pass') rePassed++;
            else if (sr.value.status === 'warn') reWarnings++;
            else reFailed++;
          }
        }
        output.writeln();
        output.writeln(output.dim('─'.repeat(50)));
        const reSummary = [
          output.success(`${rePassed} passed`),
          reWarnings > 0 ? output.warning(`${reWarnings} warnings`) : null,
          reFailed > 0 ? output.error(`${reFailed} failed`) : null
        ].filter(Boolean);
        output.writeln(`After fix: ${reSummary.join(', ')}`);
      }
    } else if (fixes.length > 0 && !showFix) {
      output.writeln();
      output.writeln(output.dim(`Run with --fix to auto-fix ${fixes.length} issue${fixes.length > 1 ? 's' : ''}`));
    }

    // Overall result
    if (failed > 0) {
      output.writeln();
      output.writeln(output.error('Some checks failed. Please address the issues above.'));
      return { success: false, exitCode: 1, data: { passed, warnings, failed, results } };
    } else if (warnings > 0) {
      // Issue #784: in strict mode any non-allowlisted warning fails the run.
      // Equality (not substring) match — an allowlist entry tolerates exactly
      // that check, never accidentally suppresses neighboring checks like
      // "Git" allowlisting "Git Repository".
      if (strict) {
        const warnResults = results.filter((r) => r.status === 'warn');
        const allowSet = new Set(allowWarnList);
        const offending = warnResults.filter((r) => !r.name || !allowSet.has(r.name));
        if (offending.length > 0) {
          output.writeln();
          output.writeln(output.error(
            `--strict: ${offending.length} warning${offending.length > 1 ? 's' : ''} not allowlisted ` +
              `(use --allow-warn "<name>,<name>" to tolerate intentional warnings):`,
          ));
          for (const r of offending) {
            output.writeln(output.error(`  ✗ ${r.name}: ${r.message ?? ''}`));
          }
          return { success: false, exitCode: 1, data: { passed, warnings, failed, results } };
        }
        output.writeln();
        output.writeln(output.success(
          `--strict: ${warnResults.length} warning${warnResults.length > 1 ? 's' : ''} all allowlisted (--allow-warn).`,
        ));
        return { success: true, data: { passed, warnings, failed, results } };
      }
      output.writeln();
      output.writeln(output.warning('All checks passed with some warnings.'));
      return { success: true, data: { passed, warnings, failed, results } };
    } else {
      output.writeln();
      output.writeln(output.success('All checks passed! System is healthy.'));
      return { success: true, data: { passed, warnings, failed, results } };
    }
  }
};

export default doctorCommand;
