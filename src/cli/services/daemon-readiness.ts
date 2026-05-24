/**
 * Daemon Readiness Check for Scheduled Spells
 *
 * Confirms the daemon is currently running so a freshly-created schedule
 * actually fires. Prompts the user to start it interactively, or warns
 * non-interactively. Always returns regardless of state — the caller still
 * writes the schedule, and the daemon picks it up on next start.
 *
 * OS-autostart install/uninstall is no longer handled here — see
 * `daemon-autostart-lifecycle.ts`. That side effect is now driven by the
 * count of enabled schedules, not a per-create prompt.
 */

import { join, resolve } from 'path';
import { mkdirSync, openSync, closeSync } from 'fs';
import { spawn } from 'child_process';
import { getDaemonLockHolder } from './daemon-lock.js';
import { isDaemonInstalled } from './daemon-service.js';
import { locateMofloCliBin } from './moflo-require.js';
import { registerBackgroundPid } from './process-registry.js';

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
  /** Inspect OS install state. Injected for testability. */
  isDaemonInstalledFn?: (projectRoot: string) => boolean;
}

/**
 * Ensure the daemon is ready for scheduled spell execution.
 *
 * Checks daemon state and prompts the user to start it as needed. Always
 * returns — never throws. The caller should create the schedule regardless
 * of the result, since the daemon can pick it up later. OS-autostart is
 * reconciled separately by the create/cancel paths via
 * `reconcileDaemonAutostart`.
 */
export async function ensureDaemonForScheduling(
  options: DaemonReadinessOptions,
): Promise<DaemonReadinessResult> {
  const resolvedRoot = resolve(options.projectRoot);
  const promptFn = options.promptConfirm ?? defaultPromptConfirm;
  const startFn = options.startDaemon ?? defaultStartDaemon;
  const installedFn = options.isDaemonInstalledFn ?? isDaemonInstalled;

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
        'Scheduled spells need the daemon. Start it now?',
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

  // Surface OS install state purely informationally — no prompts. The
  // create/cancel commands reconcile install/uninstall via
  // reconcileDaemonAutostart, driven by the enabled-schedule count.
  result.daemonInstalled = installedFn(resolvedRoot);

  return result;
}

async function defaultPromptConfirm(message: string): Promise<boolean> {
  // Dynamic import to avoid pulling in readline at module load
  const { confirm } = await import('../prompt.js');
  return confirm({ message, default: true });
}

async function defaultStartDaemon(projectRoot: string): Promise<boolean> {
  const cliPath = locateMofloCliBin();

  if (!cliPath) return false;

  const stateDir = join(projectRoot, '.moflo');
  mkdirSync(stateDir, { recursive: true });

  const logFile = join(stateDir, 'daemon.log');
  const isWin = process.platform === 'win32';

  // Open file descriptors before spawn so we can close them on error
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  try {
    stdoutFd = openSync(logFile, 'a');
    stderrFd = openSync(logFile, 'a');

    const spawnArgs = [cliPath, 'daemon', 'start', '--foreground', '--quiet'];
    const daemonEnv = {
      ...process.env,
      MOFLO_DAEMON: '1',
      ...(process.platform === 'darwin' ? { NOHUP: '1' } : {}),
    };

    // On Windows, join command + args into a single shell string to avoid
    // Node 24 DEP0190 ("args with shell:true" deprecation warning).
    const child = isWin
      ? spawn(`"${process.execPath}" ${spawnArgs.map(a => `"${a}"`).join(' ')}`, [], {
          cwd: projectRoot,
          stdio: ['ignore', stdoutFd, stderrFd],
          env: daemonEnv,
          shell: true, windowsHide: true,
        })
      : spawn(process.execPath, spawnArgs, {
          cwd: projectRoot,
          detached: true,
          stdio: ['ignore', stdoutFd, stderrFd],
          env: daemonEnv,
        });

    child.unref();

    // Register the spawned daemon PID with the shared ProcessManager (parity
    // with src/cli/index.ts maybeAutoStartDaemon). Without this, doctor's
    // zombie scan flags this detached process as orphaned because its parent
    // (this CLI invocation) exits as soon as ensureDaemonForScheduling
    // resolves.
    if (child.pid) {
      try {
        registerBackgroundPid(projectRoot, child.pid, 'daemon', spawnArgs.slice(1).join(' '));
      } catch { /* registration is non-essential */ }
    }

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
