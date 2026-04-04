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
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { getDaemonLockHolder, releaseDaemonLock, isDaemonProcess } from '../services/daemon-lock.js';
import {
  checkSubagentHealth,
  checkWorkflowExecution,
  checkMcpToolInvocation,
  checkHookExecution,
  checkMcpWorkflowIntegration,
  checkGateHealth,
  getMofloRoot,
} from './doctor-checks-deep.js';

// Promisified exec with proper shell and env inheritance for cross-platform support
const execAsync = promisify(exec);

/**
 * Execute command asynchronously with proper environment inheritance
 * Critical for Windows where PATH may not be inherited properly
 */
async function runCommand(command: string, timeoutMs: number = 5000): Promise<string> {
  const { stdout } = await execAsync(command, {
    encoding: 'utf8' as BufferEncoding,
    timeout: timeoutMs,
    shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', // Use proper shell per platform
    env: { ...process.env }, // Explicitly inherit full environment
    windowsHide: true, // Hide window on Windows
  });
  return (stdout as string).trim();
}

interface HealthCheck {
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
  // JSON configs (parse-validated)
  const jsonPaths = [
    '.claude-flow/config.json',
    'claude-flow.config.json',
    '.claude-flow.json'
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

  // YAML configs (existence-checked only — no heavy yaml parser dependency)
  const yamlPaths = [
    '.claude-flow/config.yaml',
    '.claude-flow/config.yml',
    'claude-flow.config.yaml'
  ];

  for (const configPath of yamlPaths) {
    if (existsSync(configPath)) {
      return { name: 'Config File', status: 'pass', message: `Found: ${configPath}` };
    }
  }

  return { name: 'Config File', status: 'warn', message: 'No config file (using defaults)', fix: 'claude-flow config init' };
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
    const lockFile = '.claude-flow/daemon.lock';
    if (existsSync(lockFile)) {
      // Lock exists but holder is null — getDaemonLockHolder already cleaned it,
      // but if it persists it means cleanup failed (permissions, etc.)
      return { name: 'Daemon Status', status: 'warn', message: 'Stale lock file', fix: 'rm .claude-flow/daemon.lock && claude-flow daemon start' };
    }
    // Also check legacy PID file
    const pidFile = '.claude-flow/daemon.pid';
    if (existsSync(pidFile)) {
      return { name: 'Daemon Status', status: 'warn', message: 'Legacy PID file found', fix: 'rm .claude-flow/daemon.pid && claude-flow daemon start' };
    }
    return { name: 'Daemon Status', status: 'warn', message: 'Not running', fix: 'claude-flow daemon start' };
  } catch {
    return { name: 'Daemon Status', status: 'warn', message: 'Unable to check', fix: 'claude-flow daemon status' };
  }
}

// Check memory database
async function checkMemoryDatabase(): Promise<HealthCheck> {
  const dbPaths = [
    '.claude-flow/memory.db',
    '.swarm/memory.db',
    'data/memory.db'
  ];

  for (const dbPath of dbPaths) {
    if (existsSync(dbPath)) {
      try {
        const stats = statSync(dbPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        return { name: 'Memory Database', status: 'pass', message: `${dbPath} (${sizeMB} MB)` };
      } catch {
        return { name: 'Memory Database', status: 'warn', message: `${dbPath} (unable to stat)` };
      }
    }
  }

  return { name: 'Memory Database', status: 'warn', message: 'Not initialized', fix: 'claude-flow memory configure --backend hybrid' };
}

// Check git (async with proper env inheritance)
async function checkGit(): Promise<HealthCheck> {
  try {
    const version = await runCommand('git --version');
    return { name: 'Git', status: 'pass', message: version.replace('git version ', 'v') };
  } catch {
    return { name: 'Git', status: 'warn', message: 'Not installed', fix: 'Install git from https://git-scm.com' };
  }
}

// Check if in git repo (async with proper env inheritance)
async function checkGitRepo(): Promise<HealthCheck> {
  try {
    await runCommand('git rev-parse --git-dir');
    return { name: 'Git Repository', status: 'pass', message: 'In a git repository' };
  } catch {
    return { name: 'Git Repository', status: 'warn', message: 'Not a git repository', fix: 'git init' };
  }
}

// Check MCP servers
async function checkMcpServers(): Promise<HealthCheck> {
  const mcpConfigPaths = [
    join(os.homedir(), '.claude/claude_desktop_config.json'),
    join(os.homedir(), '.config/claude/mcp.json'),
    '.mcp.json'
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
        const psOutput = await runCommand('powershell -NoProfile -Command "Get-PSDrive C | Select-Object -ExpandProperty Free; Get-PSDrive C | Select-Object -ExpandProperty Used"');
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
  } catch {
    return { name: 'Disk Space', status: 'warn', message: 'Unable to check' };
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
  } catch {
    return { name: 'TypeScript', status: 'warn', message: 'Not installed locally', fix: 'npm install -D typescript' };
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

      // Walk up from the current file's directory until we find the
      // package.json that belongs to @claude-flow/cli (or claude-flow/cli).
      // Walk until dirname(dir) === dir (filesystem root on any platform).
      for (;;) {
        const candidate = join(dir, 'package.json');
        try {
          if (existsSync(candidate)) {
            const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
            if (
              pkg.version &&
              typeof pkg.name === 'string' &&
              (pkg.name === '@claude-flow/cli' || pkg.name === 'claude-flow' || pkg.name === 'ruflo' || pkg.name === 'moflo' || pkg.name === '@moflo/cli')
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
    } catch {
      // Can't reach npm registry - skip check
      return {
        name: 'Version Freshness',
        status: 'warn',
        message: `v${currentVersion} (cannot check registry)`
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
        ? 'rm -rf ~/.npm/_npx/* && npx -y moflo'
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
      message: 'Unable to check version freshness'
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
  } catch {
    return {
      name: 'Claude Code CLI',
      status: 'warn',
      message: 'Not installed',
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

// Check embeddings / vector index health
async function checkEmbeddings(): Promise<HealthCheck> {
  const dbPaths = [
    join(process.cwd(), '.swarm', 'memory.db'),
    join(process.cwd(), '.claude-flow', 'memory.db'),
    join(process.cwd(), 'data', 'memory.db'),
  ];

  // 1. Fast path: read cached vector-stats.json if available
  const statsPath = join(process.cwd(), '.claude-flow', 'vector-stats.json');
  try {
    if (existsSync(statsPath)) {
      const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
      const count = stats.vectorCount ?? 0;
      const hasHnsw = stats.hasHnsw ?? false;
      const dbSizeKB = stats.dbSizeKB ?? 0;

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

  // 2. Check if memory DB file exists at all
  let foundDbPath: string | null = null;
  for (const p of dbPaths) {
    if (existsSync(p)) { foundDbPath = p; break; }
  }

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
  } catch {
    // sql.js not available — fall back to file-size heuristic
    try {
      const stats = statSync(foundDbPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      return {
        name: 'Embeddings',
        status: 'warn',
        message: `Memory DB exists (${sizeMB} MB) — cannot verify vectors (sql.js not available)`,
        fix: 'npm install sql.js && npx moflo embeddings init'
      };
    } catch {
      return { name: 'Embeddings', status: 'warn', message: 'Unable to check' };
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
        const cfDir = join(process.cwd(), '.claude-flow');
        if (!existsSync(cfDir)) mkdirSync(cfDir, { recursive: true });
        return runFixCommand('npx moflo config init');
      } catch {
        return false;
      }
    },
    'Daemon Status': async () => {
      // Clean stale locks, then try to start daemon
      const lockFile = join(process.cwd(), '.claude-flow', 'daemon.lock');
      const pidFile = join(process.cwd(), '.claude-flow', 'daemon.pid');
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
      output.writeln(output.warning(`  Fix failed: ${e instanceof Error ? e.message : String(e)}`));
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
  } catch {
    return { name: 'Test Directories', status: 'warn', message: 'Unable to parse moflo.yaml' };
  }
}

// Check agentic-flow v3 integration (filesystem-based to avoid slow WASM/DB init)
async function checkAgenticFlow(): Promise<HealthCheck> {
  try {
    // Walk common node_modules paths to find agentic-flow/package.json
    const candidates = [
      join(process.cwd(), 'node_modules', 'agentic-flow', 'package.json'),
      join(process.cwd(), '..', 'node_modules', 'agentic-flow', 'package.json'),
    ];
    let pkgJsonPath: string | null = null;
    for (const p of candidates) {
      if (existsSync(p)) { pkgJsonPath = p; break; }
    }
    if (!pkgJsonPath) {
      return {
        name: 'agentic-flow',
        status: 'warn',
        message: 'Not installed (optional — embeddings/routing will use fallbacks)',
        fix: 'npm install agentic-flow@latest'
      };
    }
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    const version = pkg.version || 'unknown';
    const exports = pkg.exports || {};
    const features = [
      exports['./reasoningbank'] ? 'ReasoningBank' : null,
      exports['./router'] ? 'Router' : null,
      exports['./transport/quic'] ? 'QUIC' : null,
    ].filter(Boolean);
    return {
      name: 'agentic-flow',
      status: 'pass',
      message: `v${version} (${features.join(', ')})`
    };
  } catch {
    return { name: 'agentic-flow', status: 'warn', message: 'Check failed' };
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
    // @ts-ignore — neural is not in tsconfig project references but is available at runtime
    // Import neural module — path is relative to compiled output at dist/src/commands/
    const neural = await import('../../../../neural/dist/index.js');
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
      const trajectory = {
        trajectoryId: 'doctor-test',
        context: 'health check',
        domain: 'general',
        steps: [{ action: 'test', reward: 1, stateAfter: new Float32Array(64).fill(0.2), timestamp: Date.now() }],
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
          trajectoryId: 'doctor-pl', context: 'test', domain: 'general',
          steps: [{ stepId: 's1', action: 'test', reward: 1, stateBefore: embedding, stateAfter: embedding, timestamp: now }],
          startTime: now, endTime: now, qualityScore: 1, isComplete: true,
        },
        { trajectoryId: 'doctor-pl', keyInsights: ['test'], compressedEmbedding: embedding, timestamp: now }
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
      fix: 'Ensure @claude-flow/neural is built (npm run build)',
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
  const registryFile = join(process.cwd(), '.claude-flow', 'background-pids.json');
  const lockFile = join(process.cwd(), '.claude-flow', 'spawn.lock');
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

// Find and optionally kill orphaned moflo/claude-flow node processes.
// A process is only "orphaned" if its parent is no longer alive — meaning
// nothing will clean it up. MCP servers spawned by a live Claude Code session
// have a live parent (claude.exe) and must not be flagged.
async function findZombieProcesses(kill = false): Promise<{ found: number; killed: number; pids: number[] }> {
  const legitimatePid = getDaemonLockHolder(process.cwd());
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
      description: 'Check specific component (version, node, npm, config, daemon, memory, embeddings, git, mcp, claude, disk, typescript, semantic, intelligence)',
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
    }
  ],
  examples: [
    { command: 'claude-flow doctor', description: 'Run full health check' },
    { command: 'claude-flow doctor --fix', description: 'Show fixes for issues' },
    { command: 'claude-flow doctor --install', description: 'Auto-install missing dependencies' },
    { command: 'claude-flow doctor --kill-zombies', description: 'Find and kill zombie processes' },
    { command: 'claude-flow doctor -c version', description: 'Check for stale npx cache' },
    { command: 'claude-flow doctor -c claude', description: 'Check Claude Code CLI only' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const showFix = ctx.flags.fix as boolean;
    const autoInstall = ctx.flags.install as boolean;
    const component = ctx.flags.component as string;
    const verbose = ctx.flags.verbose as boolean;
    const killZombies = ctx.flags['kill-zombies'] as boolean;

    output.writeln();
    output.writeln(output.bold('MoFlo Doctor'));
    output.writeln(output.dim('System diagnostics and health check'));
    output.writeln(output.dim('─'.repeat(50)));
    output.writeln();

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

    // Check Workflow Engine health — validates core modules, built output, and step commands
    async function checkWorkflowEngine(): Promise<HealthCheck> {
      try {
        // Resolve relative to the moflo package root (works in both dev and consumer)
        const mofloRoot = getMofloRoot();
        if (!mofloRoot) {
          return { name: 'Workflow Engine', status: 'warn', message: 'Could not locate moflo package root', fix: 'npm run build' };
        }

        // Prefer compiled dist/, fall back to src/ in dev repo
        const distDir = join(mofloRoot, 'src', 'packages', 'workflows', 'dist');
        const srcDir = join(mofloRoot, 'src', 'packages', 'workflows', 'src');
        const hasDistDir = existsSync(distDir);
        const hasSrcDir = existsSync(srcDir);

        if (!hasDistDir && !hasSrcDir) {
          return { name: 'Workflow Engine', status: 'warn', message: 'Workflow engine not found', fix: 'npm run build' };
        }

        // Core compiled modules that must exist
        const coreModules = [
          'core/runner',
          'core/step-executor',
          'core/step-command-registry',
          'core/interpolation',
          'core/credential-masker',
          'registry/workflow-registry',
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
            name: 'Workflow Engine',
            status: 'warn',
            message: `Missing modules: ${missing.join(', ')}`,
            fix: 'npm run build',
          };
        }

        // Check for step commands directory
        const commandsDir = join(baseDir, 'commands');
        const hasCommands = existsSync(commandsDir);

        // Check for workflow definition loaders
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
          name: 'Workflow Engine',
          status: 'pass',
          message: parts.join(', '),
        };
      } catch {
        return { name: 'Workflow Engine', status: 'warn', message: 'Unable to check workflow engine' };
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
      checkDaemonStatus,
      checkMemoryDatabase,
      checkEmbeddings,
      checkTestDirs,
      checkMcpServers,
      checkDiskSpace,
      checkBuildTools,
      checkAgenticFlow,
      checkSemanticQuality,
      checkIntelligence,
      checkWorkflowEngine,
      checkZombieProcesses,
      checkSubagentHealth,
      checkWorkflowExecution,
      checkMcpToolInvocation,
      checkMcpWorkflowIntegration,
      checkHookExecution,
      checkGateHealth,
    ];

    const componentMap: Record<string, () => Promise<HealthCheck>> = {
      'version': checkVersionFreshness,
      'freshness': checkVersionFreshness,
      'node': checkNodeVersion,
      'npm': checkNpmVersion,
      'claude': checkClaudeCode,
      'config': checkConfigFile,
      'daemon': checkDaemonStatus,
      'memory': checkMemoryDatabase,
      'embeddings': checkEmbeddings,
      'git': checkGit,
      'mcp': checkMcpServers,
      'disk': checkDiskSpace,
      'typescript': checkBuildTools,
      'tests': checkTestDirs,
      'agentic-flow': checkAgenticFlow,
      'semantic': checkSemanticQuality,
      'quality': checkSemanticQuality,
      'intelligence': checkIntelligence,
      'workflows': checkWorkflowEngine,
      'workflow': checkWorkflowEngine,
      'subagent': checkSubagentHealth,
      'subagents': checkSubagentHealth,
      'agents': checkSubagentHealth,
      'workflow-exec': checkWorkflowExecution,
      'mcp-tools': checkMcpToolInvocation,
      'mcp-workflow': checkMcpWorkflowIntegration,
      'hooks': checkHookExecution,
      'gates': checkGateHealth,
      'gate': checkGateHealth,
    };

    let checksToRun = allChecks;
    if (component && componentMap[component]) {
      checksToRun = [componentMap[component]];
    }

    const results: HealthCheck[] = [];
    const fixes: string[] = [];

    // OPTIMIZATION: Run all checks in parallel for 3-5x faster execution
    const spinner = output.createSpinner({ text: 'Running health checks in parallel...', spinner: 'dots' });
    spinner.start();

    try {
      // Execute all checks concurrently
      const checkResults = await Promise.allSettled(checksToRun.map(check => check()));
      spinner.stop();

      // Process results in order
      for (const settledResult of checkResults) {
        if (settledResult.status === 'fulfilled') {
          const result = settledResult.value;
          results.push(result);
          output.writeln(formatCheck(result));

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
          output.writeln(formatCheck(errorResult));
        }
      }
    } catch (error) {
      spinner.stop();
      output.writeln(output.error('Failed to run health checks'));
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
