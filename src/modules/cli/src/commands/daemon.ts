/**
 * V3 CLI Daemon Command
 * Manages background worker daemon (Node.js-based, similar to shell helpers)
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { WorkerDaemon, getDaemon, startDaemon, stopDaemon, type WorkerType, type DaemonConfig } from '../services/worker-daemon.js';
import { acquireDaemonLock, releaseDaemonLock, getDaemonLockHolder, transferDaemonLock, lockPath } from '../services/daemon-lock.js';
import { installDaemonService, uninstallDaemonService, isDaemonInstalled } from '../services/daemon-service.js';
import { startDashboard, createDashboardMemoryAccessor, DEFAULT_DASHBOARD_PORT, type DashboardHandle } from '../services/daemon-dashboard.js';
import { bootstrapDaemonScheduler } from '../services/daemon-scheduler-bootstrap.js';
import { loadMofloConfig } from '../config/moflo-config.js';
import type { MemoryAccessor } from '../spells/types/step-command.types.js';
import type { SchedulerEvent } from '../spells/scheduler/scheduler.js';
import { spawn, execFile, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, isAbsolute } from 'path';
import * as fs from 'fs';

// Start daemon subcommand
const startCommand: Command = {
  name: 'start',
  description: 'Start the worker daemon with all enabled background workers',
  options: [
    { name: 'workers', short: 'w', type: 'string', description: 'Comma-separated list of workers to enable (default: map,audit,optimize,consolidate,testgaps)' },
    { name: 'quiet', short: 'Q', type: 'boolean', description: 'Suppress output' },
    { name: 'background', short: 'b', type: 'boolean', description: 'Run daemon in background (detached process)', default: true },
    { name: 'foreground', short: 'f', type: 'boolean', description: 'Run daemon in foreground (blocks terminal)' },
    { name: 'headless', type: 'boolean', description: 'Enable headless worker execution (E2B sandbox)' },
    { name: 'sandbox', type: 'string', description: 'Default sandbox mode for headless workers', choices: ['strict', 'permissive', 'disabled'] },
    { name: 'max-cpu-load', type: 'string', description: 'Override maxCpuLoad resource threshold (e.g. 4.0)' },
    { name: 'min-free-memory', type: 'string', description: 'Override minFreeMemoryPercent resource threshold (e.g. 15)' },
    { name: 'dashboard-port', type: 'string', description: `Dashboard HTTP port (default: ${DEFAULT_DASHBOARD_PORT})` },
    { name: 'no-dashboard', type: 'boolean', description: 'Disable the dashboard HTTP server' },
  ],
  examples: [
    { command: 'claude-flow daemon start', description: 'Start daemon in background (default)' },
    { command: 'claude-flow daemon start --foreground', description: 'Start in foreground (blocks terminal)' },
    { command: 'claude-flow daemon start -w map,audit,optimize', description: 'Start with specific workers' },
    { command: 'claude-flow daemon start --headless --sandbox strict', description: 'Start with headless workers in strict sandbox' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const quiet = ctx.flags.quiet as boolean;
    const foreground = ctx.flags.foreground as boolean;
    const noDashboard = ctx.flags['no-dashboard'] as boolean;
    const rawDashboardPort = ctx.flags['dashboard-port'] as string | undefined;
    const projectRoot = process.cwd();
    const isDaemonProcess = process.env.CLAUDE_FLOW_DAEMON === '1';

    // Parse dashboard port
    let dashboardPort = DEFAULT_DASHBOARD_PORT;
    if (rawDashboardPort) {
      const parsed = parseInt(rawDashboardPort, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
        output.printError(`Invalid dashboard port: ${rawDashboardPort} (must be 1-65535)`);
        return { success: false, exitCode: 1 };
      }
      dashboardPort = parsed;
    }

    // Parse resource threshold overrides from CLI flags
    const config: Partial<DaemonConfig> = {};
    const rawMaxCpu = ctx.flags['max-cpu-load'] as string | undefined;
    const rawMinMem = ctx.flags['min-free-memory'] as string | undefined;

    // Strict numeric pattern to prevent command injection when forwarding to subprocess (S1)
    const NUMERIC_RE = /^\d+(\.\d+)?$/;
    const sanitize = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '');

    if (rawMaxCpu || rawMinMem) {
      const thresholds: { maxCpuLoad?: number; minFreeMemoryPercent?: number } = {};
      if (rawMaxCpu) {
        const val = parseFloat(rawMaxCpu);
        if (NUMERIC_RE.test(rawMaxCpu) && isFinite(val) && val > 0 && val <= 1000) {
          thresholds.maxCpuLoad = val;
        } else if (!quiet) {
          output.printWarning(`Ignoring invalid --max-cpu-load value: ${sanitize(rawMaxCpu)}`);
        }
      }
      if (rawMinMem) {
        const val = parseFloat(rawMinMem);
        if (NUMERIC_RE.test(rawMinMem) && isFinite(val) && val >= 0 && val <= 100) {
          thresholds.minFreeMemoryPercent = val;
        } else if (!quiet) {
          output.printWarning(`Ignoring invalid --min-free-memory value: ${sanitize(rawMinMem)}`);
        }
      }
      if (thresholds.maxCpuLoad !== undefined || thresholds.minFreeMemoryPercent !== undefined) {
        config.resourceThresholds = thresholds as any;
      }
    }

    // Background mode (default): fork a detached process
    if (!foreground) {
      return startBackgroundDaemon(projectRoot, quiet, rawMaxCpu, rawMinMem, dashboardPort, noDashboard);
    }

    // Foreground mode: run in current process (blocks terminal)
    try {
      // Acquire atomic daemon lock (prevents duplicate daemons).
      // Always acquire here — even when spawned as a child (CLAUDE_FLOW_DAEMON=1)
      // because on Windows the parent's child.pid is the shell PID (cmd.exe),
      // not the actual node process. The child must write its own real PID.
      const lockResult = acquireDaemonLock(projectRoot);
      if (!lockResult.acquired) {
        if (!quiet) {
          output.printWarning(`Daemon already running (PID: ${lockResult.holder})`);
        }
        return { success: true };
      }

      // Clean up lock file on exit
      const cleanup = () => {
        releaseDaemonLock(projectRoot, process.pid, true);
      };
      process.on('exit', cleanup);
      process.on('SIGINT', () => { cleanup(); process.exit(0); });
      process.on('SIGTERM', () => { cleanup(); process.exit(0); });
      // Ignore SIGHUP on macOS/Linux — prevents daemon death when terminal closes (#1283)
      if (process.platform !== 'win32') {
        process.on('SIGHUP', () => { /* ignore — keep running */ });
      }

      if (!quiet) {
        const spinner = output.createSpinner({ text: 'Starting worker daemon...', spinner: 'dots' });
        spinner.start();

        const daemon = await startDaemon(projectRoot, config);
        const status = daemon.getStatus();

        spinner.succeed('Worker daemon started (foreground mode)');

        const { dashboard } = await attachDaemonServices(daemon, {
          projectRoot, noDashboard, dashboardPort, verbose: true,
        });

        output.writeln();
        output.printBox(
          [
            `PID: ${status.pid}`,
            `Started: ${status.startedAt?.toISOString()}`,
            `Workers: ${status.config.workers.filter(w => w.enabled).length} enabled`,
            `Max Concurrent: ${status.config.maxConcurrent}`,
            `Max CPU Load: ${status.config.resourceThresholds.maxCpuLoad}`,
            `Min Free Memory: ${status.config.resourceThresholds.minFreeMemoryPercent}%`,
            ...(dashboard ? [`Dashboard: http://localhost:${dashboard.port}`] : []),
          ].join('\n'),
          'Daemon Status'
        );

        output.writeln();
        output.writeln(output.bold('Scheduled Workers'));
        output.printTable({
          columns: [
            { key: 'type', header: 'Worker', width: 15 },
            { key: 'interval', header: 'Interval', width: 12 },
            { key: 'priority', header: 'Priority', width: 10 },
            { key: 'description', header: 'Description', width: 30 },
          ],
          data: status.config.workers
            .filter(w => w.enabled)
            .map(w => ({
              type: output.highlight(w.type),
              interval: `${Math.round(w.intervalMs / 60000)}min`,
              priority: w.priority === 'critical' ? output.error(w.priority) :
                       w.priority === 'high' ? output.warning(w.priority) :
                       output.dim(w.priority),
              description: w.description,
            })),
        });

        output.writeln();
        output.writeln(output.dim('Press Ctrl+C to stop daemon'));

        // Listen for worker events
        daemon.on('worker:start', ({ type }: { type: string }) => {
          output.writeln(output.dim(`[daemon] Worker starting: ${type}`));
        });

        daemon.on('worker:complete', ({ type, durationMs }: { type: string; durationMs: number }) => {
          output.writeln(output.success(`[daemon] Worker completed: ${type} (${durationMs}ms)`));
        });

        daemon.on('worker:error', ({ type, error }: { type: string; error: string }) => {
          output.writeln(output.error(`[daemon] Worker failed: ${type} - ${error}`));
        });

        daemon.on('scheduler:event', (ev: SchedulerEvent) => {
          const line = `[scheduler] ${ev.type} ${ev.spellName}: ${ev.message}`;
          if (ev.type === 'schedule:failed') output.writeln(output.error(line));
          else output.writeln(output.dim(line));
        });

        // Keep process alive
        await new Promise(() => {}); // Never resolves - daemon runs until killed
      } else {
        const daemon = await startDaemon(projectRoot, config);
        await attachDaemonServices(daemon, { projectRoot, noDashboard, dashboardPort, verbose: false });
        await new Promise(() => {}); // Keep alive
      }

      return { success: true };
    } catch (error) {
      output.printError(`Failed to start daemon: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

/**
 * Create a shared memory accessor, start the dashboard (unless disabled),
 * and bootstrap the spell scheduler. `verbose: true` prints progress to
 * the user; `verbose: false` logs warnings via the daemon log file only.
 *
 * Each step is best-effort — the daemon's own worker tick loop keeps
 * running even if dashboard or scheduler wiring fails.
 */
async function attachDaemonServices(
  daemon: WorkerDaemon,
  opts: { projectRoot: string; noDashboard?: boolean; dashboardPort: number; verbose: boolean },
): Promise<{ dashboard: DashboardHandle | null; memory: MemoryAccessor | null }> {
  const logWarn = (msg: string) => opts.verbose
    ? output.printWarning(msg)
    : daemon.emit('log', { level: 'warn', message: msg, timestamp: new Date().toISOString() });

  let memory: MemoryAccessor | null = null;
  try {
    memory = await createDashboardMemoryAccessor();
  } catch (err) {
    logWarn(`Memory accessor unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return { dashboard: null, memory: null };
  }

  const schedulerConfig = loadMofloConfig(opts.projectRoot).scheduler;

  let dashboard: DashboardHandle | null = null;
  if (!opts.noDashboard) {
    try {
      dashboard = await startDashboard(daemon, {
        port: opts.dashboardPort,
        memory,
        schedulerEnabledInConfig: schedulerConfig.enabled,
      });
      if (opts.verbose) output.printSuccess(`Dashboard: http://localhost:${dashboard.port}`);
    } catch (err) {
      logWarn(`Dashboard failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!schedulerConfig.enabled) {
    if (opts.verbose) output.printInfo('Spell scheduler disabled via moflo.yaml (scheduler.enabled: false)');
    return { dashboard, memory };
  }

  try {
    // enabled is pre-gated above (early return); skip the redundant arg —
    // bootstrap's default is true.
    await bootstrapDaemonScheduler(daemon, {
      projectRoot: opts.projectRoot,
      memory,
      schedulerOptions: {
        pollIntervalMs: schedulerConfig.pollIntervalMs,
        maxConcurrent: schedulerConfig.maxConcurrent,
        catchUpWindowMs: schedulerConfig.catchUpWindowMs,
      },
    });
    if (opts.verbose) output.printSuccess('Spell scheduler attached');
  } catch (err) {
    logWarn(`Spell scheduler not started: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { dashboard, memory };
}

/**
 * Validate path for security - prevents path traversal and injection
 */
function validatePath(path: string, label: string): void {
  // Must be absolute after resolution
  const resolved = resolve(path);

  // Check for null bytes (injection attack)
  if (path.includes('\0')) {
    throw new Error(`${label} contains null bytes`);
  }

  // Check for shell metacharacters in path components
  if (/[;&|`$<>]/.test(path)) {
    throw new Error(`${label} contains shell metacharacters`);
  }

  // Prevent path traversal outside expected directories
  if (!resolved.includes('.claude-flow') && !resolved.includes('bin')) {
    // Allow only paths within project structure
    const cwd = process.cwd();
    if (!resolved.startsWith(cwd)) {
      throw new Error(`${label} escapes project directory`);
    }
  }
}

/**
 * Start daemon as a detached background process
 */
async function startBackgroundDaemon(projectRoot: string, quiet: boolean, maxCpuLoad?: string, minFreeMemory?: string, dashboardPort?: number, noDashboard?: boolean): Promise<CommandResult> {
  // Validate and resolve project root
  const resolvedRoot = resolve(projectRoot);
  validatePath(resolvedRoot, 'Project root');

  const stateDir = join(resolvedRoot, '.claude-flow');
  const logFile = join(stateDir, 'daemon.log');

  // Validate all paths
  validatePath(stateDir, 'State directory');
  validatePath(logFile, 'Log file');

  // Acquire atomic lock BEFORE spawning to prevent races
  const lockResult = acquireDaemonLock(resolvedRoot);
  if (!lockResult.acquired) {
    if (!quiet) {
      output.printWarning(`Daemon already running in background (PID: ${lockResult.holder})`);
    }
    return { success: true };
  }

  // Ensure state directory exists
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  // Get path to CLI (from dist/src/commands/daemon.js -> bin/cli.js)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // dist/src/commands -> dist/src -> dist -> package root -> bin/cli.js
  const cliPath = resolve(join(__dirname, '..', '..', '..', 'bin', 'cli.js'));
  validatePath(cliPath, 'CLI path');

  // Verify CLI path exists
  if (!fs.existsSync(cliPath)) {
    output.printError(`CLI not found at: ${cliPath}`);
    return { success: false, exitCode: 1 };
  }

  // Platform-aware spawn flags
  const isWin = process.platform === 'win32';
  // Use spawn with explicit arguments instead of shell string interpolation
  // This prevents command injection via paths
  const spawnArgs = [
    cliPath,
    'daemon', 'start', '--foreground', '--quiet',
  ];
  // Forward resource threshold flags to the foreground child process
  // Validate with strict numeric pattern to prevent shell injection on Windows (S1)
  const SPAWN_NUMERIC_RE = /^\d+(\.\d+)?$/;
  if (maxCpuLoad && SPAWN_NUMERIC_RE.test(maxCpuLoad)) {
    spawnArgs.push('--max-cpu-load', maxCpuLoad);
  }
  if (minFreeMemory && SPAWN_NUMERIC_RE.test(minFreeMemory)) {
    spawnArgs.push('--min-free-memory', minFreeMemory);
  }
  // Forward dashboard flags
  if (noDashboard) {
    spawnArgs.push('--no-dashboard');
  } else if (dashboardPort && dashboardPort !== DEFAULT_DASHBOARD_PORT) {
    spawnArgs.push('--dashboard-port', String(dashboardPort));
  }

  const daemonEnv = {
    ...process.env,
    CLAUDE_FLOW_DAEMON: '1',
    // Prevent macOS SIGHUP kill when terminal closes
    ...(process.platform === 'darwin' ? { NOHUP: '1' } : {}),
  };
  const stdoutFd = fs.openSync(logFile, 'a');
  const stderrFd = fs.openSync(logFile, 'a');

  // On Windows, join command + args into a single shell string to avoid
  // Node 24 DEP0190 ("args with shell:true" deprecation warning).
  const child = isWin
    ? spawn(`"${process.execPath}" ${spawnArgs.map(a => `"${a}"`).join(' ')}`, [], {
        cwd: resolvedRoot,
        stdio: ['ignore', stdoutFd, stderrFd],
        env: daemonEnv,
        shell: true, windowsHide: true,
      })
    : spawn(process.execPath, spawnArgs, {
        cwd: resolvedRoot,
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        env: daemonEnv,
      });

  // Get PID from spawned process directly (no shell echo needed)
  const pid = child.pid;

  if (!pid || pid <= 0) {
    // Release lock — spawn failed, no daemon running
    releaseDaemonLock(resolvedRoot, process.pid, true);
    output.printError('Failed to get daemon PID');
    return { success: false, exitCode: 1 };
  }

  // Unref BEFORE updating lock — prevents race where parent exits
  // but child hasn't fully detached yet (fixes macOS daemon death #1283)
  child.unref();

  // Small delay to let the child process fully detach on macOS
  await new Promise(resolve => setTimeout(resolve, 100));

  // On Windows with shell: true, child.pid is the cmd.exe shell PID, not the
  // actual node daemon. The child will acquire the lock itself with its real PID
  // (see foreground start path). Release the parent's lock so the child can take it.
  //
  // On POSIX (no shell), child.pid IS the real daemon PID, so we can transfer
  // atomically to avoid any gap where the lock is absent.
  if (isWin) {
    releaseDaemonLock(resolvedRoot, process.pid, true);
  } else {
    if (!transferDaemonLock(resolvedRoot, pid)) {
      releaseDaemonLock(resolvedRoot, process.pid, true);
      acquireDaemonLock(resolvedRoot, pid);
    }
  }

  if (!quiet) {
    output.printSuccess(`Daemon started in background (PID: ${pid})`);
    if (!noDashboard) {
      output.printInfo(`Dashboard: http://localhost:${dashboardPort ?? DEFAULT_DASHBOARD_PORT}`);
    }
    output.printInfo(`Logs: ${logFile}`);
    output.printInfo(`Stop with: claude-flow daemon stop`);
  }

  return { success: true };
}

// Stop daemon subcommand
const stopCommand: Command = {
  name: 'stop',
  description: 'Stop the worker daemon and all background workers',
  options: [
    { name: 'quiet', short: 'Q', type: 'boolean', description: 'Suppress output' },
  ],
  examples: [
    { command: 'claude-flow daemon stop', description: 'Stop the daemon' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const quiet = ctx.flags.quiet as boolean;
    const projectRoot = process.cwd();

    try {
      if (!quiet) {
        const spinner = output.createSpinner({ text: 'Stopping worker daemon...', spinner: 'dots' });
        spinner.start();

        // Try to stop in-process daemon first
        await stopDaemon();

        // Also kill any background daemon by PID
        const killed = await killBackgroundDaemon(projectRoot);

        spinner.succeed(killed ? 'Worker daemon stopped' : 'Worker daemon was not running');
      } else {
        await stopDaemon();
        await killBackgroundDaemon(projectRoot);
      }

      return { success: true };
    } catch (error) {
      output.printError(`Failed to stop daemon: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

/**
 * Kill background daemon process using lock file
 */
async function killBackgroundDaemon(projectRoot: string): Promise<boolean> {
  const holderPid = getDaemonLockHolder(projectRoot);

  if (!holderPid) {
    // No live daemon — clean up any stale lock
    releaseDaemonLock(projectRoot, 0, true);
    return false;
  }

  try {
    // Graceful kill — platform-aware
    if (process.platform === 'win32') {
      // SIGTERM silently force-kills on Windows; use taskkill for clean shutdown
      try {
        execFileSync('taskkill', ['/PID', String(holderPid)], { windowsHide: true });
      } catch {
        // taskkill may fail if process already exiting
      }
    } else {
      process.kill(holderPid, 'SIGTERM');
    }

    // Wait a moment then force kill if needed
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
      process.kill(holderPid, 0);
      // Still alive, force kill
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/F', '/PID', String(holderPid)], { windowsHide: true });
      } else {
        process.kill(holderPid, 'SIGKILL');
      }
    } catch {
      // Process terminated
    }

    // Release lock
    releaseDaemonLock(projectRoot, holderPid, true);
    return true;
  } catch (error) {
    // Clean up lock on any error
    releaseDaemonLock(projectRoot, 0, true);
    return false;
  }
}

// Legacy aliases — delegate to daemon-lock module
function getBackgroundDaemonPid(projectRoot: string): number | null {
  return getDaemonLockHolder(projectRoot);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Status subcommand
const statusCommand: Command = {
  name: 'status',
  description: 'Show daemon and worker status',
  options: [
    { name: 'verbose', short: 'v', type: 'boolean', description: 'Show detailed worker statistics' },
    { name: 'show-modes', type: 'boolean', description: 'Show worker execution modes (local/headless) and sandbox settings' },
  ],
  examples: [
    { command: 'claude-flow daemon status', description: 'Show daemon status' },
    { command: 'claude-flow daemon status -v', description: 'Show detailed status' },
    { command: 'claude-flow daemon status --show-modes', description: 'Show worker execution modes' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const verbose = ctx.flags.verbose as boolean;
    const showModes = ctx.flags['show-modes'] as boolean;
    const projectRoot = process.cwd();

    try {
      const daemon = getDaemon(projectRoot);
      const status = daemon.getStatus();

      // Also check for background daemon
      const bgPid = getBackgroundDaemonPid(projectRoot);
      const bgRunning = bgPid ? isProcessRunning(bgPid) : false;

      const isRunning = status.running || bgRunning;
      const displayPid = bgPid || status.pid;

      // Surface OS-level autostart + scheduler config so users can tell at
      // a glance whether scheduled spells will actually fire across reboots.
      const autostartInstalled = isDaemonInstalled(projectRoot);
      const schedulerConfig = loadMofloConfig(projectRoot).scheduler;

      output.writeln();

      // Daemon status box
      const statusIcon = isRunning ? output.success('●') : output.error('○');
      const statusText = isRunning ? output.success('RUNNING') : output.error('STOPPED');
      const mode = bgRunning ? output.dim(' (background)') : status.running ? output.dim(' (foreground)') : '';

      const autostartIcon = autostartInstalled ? output.success('✓') : output.dim('○');
      const autostartText = autostartInstalled ? 'registered' : 'not registered';
      const schedIcon = schedulerConfig.enabled ? output.success('✓') : output.dim('○');
      const schedText = schedulerConfig.enabled ? 'enabled' : 'disabled';

      output.printBox(
        [
          `Status: ${statusIcon} ${statusText}${mode}`,
          `PID: ${displayPid}`,
          status.startedAt ? `Started: ${status.startedAt.toISOString()}` : '',
          `Autostart: ${autostartIcon} ${autostartText}`,
          `Scheduler: ${schedIcon} ${schedText}`,
          `Workers Enabled: ${status.config.workers.filter(w => w.enabled).length}`,
          `Max Concurrent: ${status.config.maxConcurrent}`,
          `Max CPU Load: ${status.config.resourceThresholds.maxCpuLoad}`,
          `Min Free Memory: ${status.config.resourceThresholds.minFreeMemoryPercent}%`,
        ].filter(Boolean).join('\n'),
        'MoFlo Daemon'
      );

      output.writeln();
      output.writeln(output.bold('Worker Status'));

      const workerData = status.config.workers.map(w => {
        const state = status.workers.get(w.type);
        // Check for headless mode from worker config or state
        const isHeadless = (w as any).headless || (state as any)?.headless || false;
        const sandboxMode = (w as any).sandbox || (state as any)?.sandbox || null;
        return {
          type: w.enabled ? output.highlight(w.type) : output.dim(w.type),
          enabled: w.enabled ? output.success('✓') : output.dim('○'),
          status: state?.isRunning ? output.warning('running') :
                  w.enabled ? output.success('idle') : output.dim('disabled'),
          runs: state?.runCount ?? 0,
          success: state ? `${Math.round((state.successCount / Math.max(state.runCount, 1)) * 100)}%` : '-',
          lastRun: state?.lastRun ? formatTimeAgo(state.lastRun) : output.dim('never'),
          nextRun: state?.nextRun && w.enabled ? formatTimeUntil(state.nextRun) : output.dim('-'),
          mode: isHeadless ? output.highlight('headless') : output.dim('local'),
          sandbox: isHeadless ? (sandboxMode || 'strict') : output.dim('-'),
        };
      });

      // Build columns based on --show-modes flag
      const baseColumns = [
        { key: 'type', header: 'Worker', width: 12 },
        { key: 'enabled', header: 'On', width: 4 },
        { key: 'status', header: 'Status', width: 10 },
        { key: 'runs', header: 'Runs', width: 6 },
        { key: 'success', header: 'Success', width: 8 },
        { key: 'lastRun', header: 'Last Run', width: 12 },
        { key: 'nextRun', header: 'Next Run', width: 12 },
      ];

      const modeColumns = showModes ? [
        { key: 'mode', header: 'Mode', width: 10 },
        { key: 'sandbox', header: 'Sandbox', width: 12 },
      ] : [];

      output.printTable({
        columns: [...baseColumns, ...modeColumns],
        data: workerData,
      });

      if (verbose) {
        output.writeln();
        output.writeln(output.bold('Worker Configuration'));
        output.printTable({
          columns: [
            { key: 'type', header: 'Worker', width: 12 },
            { key: 'interval', header: 'Interval', width: 10 },
            { key: 'priority', header: 'Priority', width: 10 },
            { key: 'avgDuration', header: 'Avg Duration', width: 12 },
            { key: 'description', header: 'Description', width: 30 },
          ],
          data: status.config.workers.map(w => {
            const state = status.workers.get(w.type);
            return {
              type: w.type,
              interval: `${Math.round(w.intervalMs / 60000)}min`,
              priority: w.priority,
              avgDuration: state?.averageDurationMs ? `${Math.round(state.averageDurationMs)}ms` : '-',
              description: w.description,
            };
          }),
        });
      }

      return { success: true, data: status };
    } catch (error) {
      // Daemon not initialized — still surface autostart + scheduler state so
      // the user can see where the gap is (install + config are readable
      // even when the daemon process hasn't been instantiated).
      const autostartInstalled = isDaemonInstalled(projectRoot);
      const schedulerConfig = loadMofloConfig(projectRoot).scheduler;
      const autostartIcon = autostartInstalled ? output.success('✓') : output.dim('○');
      const schedIcon = schedulerConfig.enabled ? output.success('✓') : output.dim('○');

      output.writeln();
      output.printBox(
        [
          `Status: ${output.error('○')} ${output.error('NOT INITIALIZED')}`,
          `Autostart: ${autostartIcon} ${autostartInstalled ? 'registered' : 'not registered'}`,
          `Scheduler: ${schedIcon} ${schedulerConfig.enabled ? 'enabled' : 'disabled'} (config)`,
          '',
          'Run "claude-flow daemon start" to start the daemon',
        ].join('\n'),
        'MoFlo Daemon'
      );

      return { success: true };
    }
  },
};

// Trigger subcommand - manually run a worker
const triggerCommand: Command = {
  name: 'trigger',
  description: 'Manually trigger a specific worker',
  options: [
    { name: 'worker', short: 'w', type: 'string', description: 'Worker type to trigger', required: true },
    { name: 'headless', type: 'boolean', description: 'Run triggered worker in headless mode (E2B sandbox)' },
  ],
  examples: [
    { command: 'claude-flow daemon trigger -w map', description: 'Trigger the map worker' },
    { command: 'claude-flow daemon trigger -w audit', description: 'Trigger security audit' },
    { command: 'claude-flow daemon trigger -w audit --headless', description: 'Trigger audit in headless sandbox' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const workerType = ctx.flags.worker as WorkerType;

    if (!workerType) {
      output.printError('Worker type is required. Use --worker or -w flag.');
      output.writeln();
      output.writeln('Available workers: map, audit, optimize, consolidate, testgaps, predict, document, ultralearn, refactor, benchmark, deepdive, preload');
      return { success: false, exitCode: 1 };
    }

    try {
      const daemon = getDaemon(process.cwd());

      const spinner = output.createSpinner({ text: `Running ${workerType} worker...`, spinner: 'dots' });
      spinner.start();

      const result = await daemon.triggerWorker(workerType);

      if (result.success) {
        spinner.succeed(`Worker ${workerType} completed in ${result.durationMs}ms`);

        if (result.output) {
          output.writeln();
          output.writeln(output.bold('Output'));
          output.printJson(result.output);
        }
      } else {
        spinner.fail(`Worker ${workerType} failed: ${result.error}`);
      }

      return { success: result.success, data: result };
    } catch (error) {
      output.printError(`Failed to trigger worker: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

// Enable/disable worker subcommand
const enableCommand: Command = {
  name: 'enable',
  description: 'Enable or disable a specific worker',
  options: [
    { name: 'worker', short: 'w', type: 'string', description: 'Worker type', required: true },
    { name: 'disable', short: 'd', type: 'boolean', description: 'Disable instead of enable' },
  ],
  examples: [
    { command: 'claude-flow daemon enable -w predict', description: 'Enable predict worker' },
    { command: 'claude-flow daemon enable -w document --disable', description: 'Disable document worker' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const workerType = ctx.flags.worker as WorkerType;
    const disable = ctx.flags.disable as boolean;

    if (!workerType) {
      output.printError('Worker type is required. Use --worker or -w flag.');
      return { success: false, exitCode: 1 };
    }

    try {
      const daemon = getDaemon(process.cwd());
      daemon.setWorkerEnabled(workerType, !disable);

      output.printSuccess(`Worker ${workerType} ${disable ? 'disabled' : 'enabled'}`);

      return { success: true };
    } catch (error) {
      output.printError(`Failed to ${disable ? 'disable' : 'enable'} worker: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

// Install subcommand - register as OS-native login service
const installCommand: Command = {
  name: 'install',
  description: 'Register the daemon as an OS-native login service (survives reboots)',
  options: [
    { name: 'quiet', short: 'Q', type: 'boolean', description: 'Suppress output' },
  ],
  examples: [
    { command: 'claude-flow daemon install', description: 'Register daemon as login service' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const quiet = ctx.flags.quiet as boolean;
    const projectRoot = process.cwd();

    try {
      const result = installDaemonService(projectRoot);

      if (!quiet) {
        if (result.success) {
          output.printSuccess(result.message);
          output.printInfo('Remove anytime with: moflo daemon uninstall');
        } else {
          output.printError(result.message);
        }
      }

      return { success: result.success, exitCode: result.success ? 0 : 1 };
    } catch (error) {
      if (!quiet) {
        output.printError(`Failed to install daemon service: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};

// Uninstall subcommand - remove OS-native login service
const uninstallCommand: Command = {
  name: 'uninstall',
  description: 'Remove the daemon OS-native login service',
  options: [
    { name: 'quiet', short: 'Q', type: 'boolean', description: 'Suppress output' },
  ],
  examples: [
    { command: 'claude-flow daemon uninstall', description: 'Remove daemon login service' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const quiet = ctx.flags.quiet as boolean;
    const projectRoot = process.cwd();

    try {
      const result = uninstallDaemonService(projectRoot);

      if (!quiet) {
        if (result.success) {
          output.printSuccess(result.message);
        } else {
          output.printError(result.message);
        }
      }

      return { success: result.success, exitCode: result.success ? 0 : 1 };
    } catch (error) {
      if (!quiet) {
        output.printError(`Failed to uninstall daemon service: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  },
};

// Helper functions for time formatting
function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatTimeUntil(date: Date): string {
  const seconds = Math.floor((date.getTime() - Date.now()) / 1000);

  if (seconds < 0) return 'now';
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `in ${Math.floor(seconds / 3600)}h`;
  return `in ${Math.floor(seconds / 86400)}d`;
}

// Main daemon command
export const daemonCommand: Command = {
  name: 'daemon',
  description: 'Manage background worker daemon (Node.js-based, auto-runs like shell helpers)',
  subcommands: [
    startCommand,
    stopCommand,
    statusCommand,
    triggerCommand,
    enableCommand,
    installCommand,
    uninstallCommand,
  ],
  options: [],
  examples: [
    { command: 'claude-flow daemon start', description: 'Start the daemon' },
    { command: 'claude-flow daemon start --headless', description: 'Start with headless workers (E2B sandbox)' },
    { command: 'claude-flow daemon status', description: 'Check daemon status' },
    { command: 'claude-flow daemon stop', description: 'Stop the daemon' },
    { command: 'claude-flow daemon trigger -w audit', description: 'Run security audit' },
    { command: 'claude-flow daemon install', description: 'Register as OS login service' },
    { command: 'claude-flow daemon uninstall', description: 'Remove OS login service' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('MoFlo Daemon - Background Task Management'));
    output.writeln();
    output.writeln('Node.js-based background worker system that auto-runs like shell daemons.');
    output.writeln('Manages 12 specialized workers for continuous optimization and monitoring.');
    output.writeln();
    output.writeln(output.bold('Headless Mode'));
    output.writeln('Workers can run in headless mode using E2B sandboxes for isolated execution.');
    output.writeln('Use --headless flag with start/trigger commands. Sandbox modes: strict, permissive, disabled.');
    output.writeln();

    output.writeln(output.bold('Available Workers'));
    output.printList([
      `${output.highlight('map')}         - Codebase mapping (5 min interval)`,
      `${output.highlight('audit')}       - Security analysis (10 min interval)`,
      `${output.highlight('optimize')}    - Performance optimization (15 min interval)`,
      `${output.highlight('consolidate')} - Memory consolidation (30 min interval)`,
      `${output.highlight('testgaps')}    - Test coverage analysis (20 min interval)`,
      `${output.highlight('predict')}     - Predictive preloading (2 min, disabled by default)`,
      `${output.highlight('document')}    - Auto-documentation (60 min, disabled by default)`,
      `${output.highlight('ultralearn')}  - Deep knowledge acquisition (manual trigger)`,
      `${output.highlight('refactor')}    - Code refactoring suggestions (manual trigger)`,
      `${output.highlight('benchmark')}   - Performance benchmarking (manual trigger)`,
      `${output.highlight('deepdive')}    - Deep code analysis (manual trigger)`,
      `${output.highlight('preload')}     - Resource preloading (manual trigger)`,
    ]);

    output.writeln();
    output.writeln(output.bold('Subcommands'));
    output.printList([
      `${output.highlight('start')}     - Start the daemon`,
      `${output.highlight('stop')}      - Stop the daemon`,
      `${output.highlight('status')}    - Show daemon status`,
      `${output.highlight('trigger')}   - Manually run a worker`,
      `${output.highlight('enable')}    - Enable/disable a worker`,
      `${output.highlight('install')}   - Register as OS login service`,
      `${output.highlight('uninstall')} - Remove OS login service`,
    ]);

    output.writeln();
    output.writeln('Run "claude-flow daemon <subcommand> --help" for details');

    return { success: true };
  },
};

export default daemonCommand;
