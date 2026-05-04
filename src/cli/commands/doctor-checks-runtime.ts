/**
 * Quick runtime environment checks for `flo doctor`:
 * Node.js, npm, Claude Code CLI, git, disk space, TypeScript build tool.
 *
 * These checks call external binaries via the shared `runCommand` helper that
 * inherits the full process env (critical on Windows where PATH may not be
 * inherited properly across child shells).
 */

import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import { errorDetail } from '../shared/utils/error-detail.js';
import { output } from '../output.js';
import type { HealthCheck } from './doctor-types.js';

const execAsync = promisify(exec);

/**
 * Execute command asynchronously with proper environment inheritance.
 * Critical for Windows where PATH may not be inherited properly.
 */
export async function runCommand(command: string, timeoutMs: number = 5000): Promise<string> {
  const opts = {
    encoding: 'utf8' as BufferEncoding,
    timeout: timeoutMs,
    shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    env: { ...process.env },
    windowsHide: true,
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

export async function checkNodeVersion(): Promise<HealthCheck> {
  const requiredMajor = 20;
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);

  if (major >= requiredMajor) {
    return { name: 'Node.js Version', status: 'pass', message: `${version} (>= ${requiredMajor} required)` };
  } else if (major >= 18) {
    return { name: 'Node.js Version', status: 'warn', message: `${version} (>= ${requiredMajor} recommended)`, fix: 'nvm install 20 && nvm use 20' };
  }
  return { name: 'Node.js Version', status: 'fail', message: `${version} (>= ${requiredMajor} required)`, fix: 'nvm install 20 && nvm use 20' };
}

export async function checkNpmVersion(): Promise<HealthCheck> {
  try {
    const version = await runCommand('npm --version');
    const major = parseInt(version.split('.')[0], 10);
    if (major >= 9) {
      return { name: 'npm Version', status: 'pass', message: `v${version}` };
    }
    return { name: 'npm Version', status: 'warn', message: `v${version} (>= 9 recommended)`, fix: 'npm install -g npm@latest' };
  } catch {
    return { name: 'npm Version', status: 'fail', message: 'npm not found', fix: 'Install Node.js from https://nodejs.org' };
  }
}

export async function checkGit(): Promise<HealthCheck> {
  try {
    const version = await runCommand('git --version');
    return { name: 'Git', status: 'pass', message: version.replace('git version ', 'v') };
  } catch (e) {
    return { name: 'Git', status: 'warn', message: `Not installed (${errorDetail(e, { firstLineOnly: true })})`, fix: 'Install git from https://git-scm.com' };
  }
}

export async function checkGitRepo(): Promise<HealthCheck> {
  try {
    await runCommand('git rev-parse --git-dir');
    return { name: 'Git Repository', status: 'pass', message: 'In a git repository' };
  } catch (e) {
    return { name: 'Git Repository', status: 'warn', message: `Not a git repository (${errorDetail(e, { firstLineOnly: true })})`, fix: 'git init' };
  }
}

export async function checkDiskSpace(): Promise<HealthCheck> {
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
        }
        if (usePercent > 80) {
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
    const available = parts[3];
    const usePercent = parseInt(parts[4]?.replace('%', '') || '0', 10);
    if (isNaN(usePercent)) {
      return { name: 'Disk Space', status: 'warn', message: `${available || 'unknown'} available (unable to parse usage)` };
    }

    if (usePercent > 90) {
      return { name: 'Disk Space', status: 'fail', message: `${available} available (${usePercent}% used)`, fix: 'Free up disk space' };
    }
    if (usePercent > 80) {
      return { name: 'Disk Space', status: 'warn', message: `${available} available (${usePercent}% used)` };
    }
    return { name: 'Disk Space', status: 'pass', message: `${available} available` };
  } catch (e) {
    return { name: 'Disk Space', status: 'warn', message: `Unable to check: ${errorDetail(e, { firstLineOnly: true })}` };
  }
}

export async function checkBuildTools(): Promise<HealthCheck> {
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

export async function checkClaudeCode(): Promise<HealthCheck> {
  try {
    const version = await runCommand('claude --version');
    const versionMatch = version.match(/v?(\d+\.\d+\.\d+)/);
    const versionStr = versionMatch ? `v${versionMatch[1]}` : version;
    return { name: 'Claude Code CLI', status: 'pass', message: versionStr };
  } catch (e) {
    return {
      name: 'Claude Code CLI',
      status: 'warn',
      message: `Not installed (${errorDetail(e, { firstLineOnly: true })})`,
      fix: 'npm install -g @anthropic-ai/claude-code',
    };
  }
}

export async function installClaudeCode(): Promise<boolean> {
  try {
    output.writeln();
    output.writeln(output.bold('Installing Claude Code CLI...'));
    execSync('npm install -g @anthropic-ai/claude-code', {
      encoding: 'utf8',
      stdio: 'inherit',
      windowsHide: true,
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
