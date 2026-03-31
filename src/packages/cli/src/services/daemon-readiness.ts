/**
 * Daemon Readiness Check for Scheduled Workflows
 *
 * Lazy three-state flow: only triggered when creating schedules.
 * 1. Is daemon running? If not, prompt to start it.
 * 2. Is daemon installed as OS service? If not, prompt to install.
 * Always creates the schedule regardless — the daemon picks it up on next start.
 */

import { resolve, dirname, join } from 'path';
import { existsSync, mkdirSync, openSync, closeSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { getDaemonLockHolder } from './daemon-lock.js';
import { isDaemonInstalled, installDaemonService } from './daemon-service.js';

export interface DaemonReadinessResult {
  /** Whether the daemon is currently running. */
  daemonRunning: boolean;
  /** Whether the daemon is installed as an OS-native login service. */
  daemonInstalled: boolean;
  /** Non-fatal warnings about daemon state. */
  warnings: string[];
}

export interface DaemonReadinessOptions {
  /** Project root directory. */
  projectRoot: string;
  /** Whether the CLI is running interactively (can prompt). */
  interactive: boolean;
  /** Prompt the user for confirmation. Injected for testability. */
  promptConfirm?: (message: string) => Promise<boolean>;
  /** Start the daemon in the background. Injected for testability. */
  startDaemon?: (projectRoot: string) => Promise<boolean>;
}

/**
 * Ensure the daemon is ready for scheduled workflow execution.
 *
 * Checks daemon state and prompts the user to start/install as needed.
 * Always returns — never throws. The caller should create the schedule
 * regardless of the result, since the daemon can pick it up later.
 */
export async function ensureDaemonForScheduling(
  options: DaemonReadinessOptions,
): Promise<DaemonReadinessResult> {
  const resolvedRoot = resolve(options.projectRoot);
  const promptFn = options.promptConfirm ?? defaultPromptConfirm;
  const startFn = options.startDaemon ?? defaultStartDaemon;

  const result: DaemonReadinessResult = {
    daemonRunning: false,
    daemonInstalled: false,
    warnings: [],
  };

  // Step 1: Check if daemon is running
  const holderPid = getDaemonLockHolder(resolvedRoot);
  result.daemonRunning = holderPid !== null;

  if (!result.daemonRunning) {
    if (options.interactive) {
      const shouldStart = await promptFn(
        'Scheduled workflows need the daemon. Start it now?',
      );
      if (shouldStart) {
        const started = await startFn(resolvedRoot);
        result.daemonRunning = started;
        if (!started) {
          result.warnings.push('Failed to start daemon. Schedule will run when daemon starts manually.');
        }
      } else {
        result.warnings.push('Daemon not started. Schedule is saved but will not run until the daemon starts.');
      }
    } else {
      result.warnings.push('Daemon is not running. Start it with: moflo daemon start');
    }
  }

  // Step 2: Check if daemon is installed as OS service
  if (result.daemonRunning) {
    result.daemonInstalled = isDaemonInstalled(resolvedRoot);
  }

  if (result.daemonRunning && !result.daemonInstalled) {
    if (options.interactive) {
      const shouldInstall = await promptFn(
        'Register the daemon as a login service so schedules survive reboots?',
      );
      if (shouldInstall) {
        const installResult = installDaemonService(resolvedRoot);
        result.daemonInstalled = installResult.success;
        if (!installResult.success) {
          result.warnings.push(`Failed to install daemon service: ${installResult.message}`);
        }
      } else {
        result.warnings.push('Daemon is running but not installed as a login service. Schedules will stop after reboot.');
      }
    } else {
      result.warnings.push('Daemon is not registered as a login service. Install with: moflo daemon install');
    }
  }

  return result;
}

async function defaultPromptConfirm(message: string): Promise<boolean> {
  // Dynamic import to avoid pulling in readline at module load
  const { confirm } = await import('../prompt.js');
  return confirm({ message, default: true });
}

async function defaultStartDaemon(projectRoot: string): Promise<boolean> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // dist/src/services -> dist/src -> dist -> package root -> bin/cli.js
  const cliPath = resolve(join(__dirname, '..', '..', '..', 'bin', 'cli.js'));

  if (!existsSync(cliPath)) return false;

  const stateDir = join(projectRoot, '.claude-flow');
  mkdirSync(stateDir, { recursive: true });

  const logFile = join(stateDir, 'daemon.log');
  const isWin = process.platform === 'win32';

  // Open file descriptors before spawn so we can close them on error
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  try {
    stdoutFd = openSync(logFile, 'a');
    stderrFd = openSync(logFile, 'a');

    const child = spawn(process.execPath, [cliPath, 'daemon', 'start', '--foreground', '--quiet'], {
      cwd: projectRoot,
      detached: !isWin,
      stdio: ['ignore', stdoutFd, stderrFd],
      env: {
        ...process.env,
        CLAUDE_FLOW_DAEMON: '1',
        ...(process.platform === 'darwin' ? { NOHUP: '1' } : {}),
      },
      ...(isWin ? { shell: true, windowsHide: true } : {}),
    });

    child.unref();

    // Poll for daemon lock acquisition (up to 2s, checking every 200ms)
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (getDaemonLockHolder(projectRoot) !== null) return true;
    }
    return false;
  } catch {
    // Close file descriptors on spawn failure to prevent leaks
    if (stdoutFd !== undefined) try { closeSync(stdoutFd); } catch { /* ignore */ }
    if (stderrFd !== undefined) try { closeSync(stderrFd); } catch { /* ignore */ }
    return false;
  }
}
