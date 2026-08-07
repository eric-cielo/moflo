/**
 * OS-Native Daemon Service Registration
 *
 * Registers/removes the moflo daemon as a user-level login service
 * so scheduled spells survive reboots without Docker.
 *
 * - macOS:   launchd plist in ~/Library/LaunchAgents/
 * - Linux:   systemd --user unit in ~/.config/systemd/user/
 * - Windows: Task Scheduler ONLOGON trigger via schtasks
 */

import * as fs from 'fs';
import { createHash } from 'crypto';
import { basename, dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { locateMofloCliBin } from './moflo-require.js';
import { errorDetail } from '../shared/utils/error-detail.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServiceInstallResult {
  success: boolean;
  servicePath: string | null;
  message: string;
}

export interface ServiceUninstallResult {
  success: boolean;
  message: string;
}

/** Options accepted by the injected command runner — a subset of `execSync`'s. */
export interface CommandRunnerOptions {
  timeout: number;
  stdio?: 'ignore';
  windowsHide?: boolean;
  cwd?: string;
}

/**
 * The process boundary this module shells out across. Throws on non-zero exit,
 * exactly like `execSync` — every call site here relies on that to decide
 * whether the service manager accepted the command.
 */
export type CommandRunner = (command: string, options: CommandRunnerOptions) => void;

export interface DaemonServiceOptions {
  /**
   * Replaces the real `execSync`. Unit tests pass a recording stub so they
   * assert the commands that *would* be issued instead of invoking the host's
   * service manager — see #1412 (real `systemctl --user` calls made the tests
   * both unsandboxed and unable to fit inside vitest's 5s timeout).
   */
  readonly runCommand?: CommandRunner;
  /** Target a platform branch other than the host's. Test injection. */
  readonly platform?: NodeJS.Platform;
  /**
   * Root the service file is written under. Test injection — keeps unit tests
   * out of the developer's real `~/Library/LaunchAgents` and
   * `~/.config/systemd/user`. When set, `XDG_CONFIG_HOME` is deliberately
   * ignored so an ambient value cannot leak the write back out of the sandbox.
   */
  readonly homeDir?: string;
}

/** Real process boundary. Kept thin so the stub and the default stay swappable. */
const execSyncRunner: CommandRunner = (command, options) => {
  execSync(command, options);
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLIST_LABEL = 'com.moflo.daemon';
const SYSTEMD_UNIT = 'moflo-daemon.service';
const SCHTASKS_NAME = 'MoFloDaemon';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if the daemon service is registered for the current platform.
 */
export function isDaemonInstalled(
  projectRoot: string,
  options: DaemonServiceOptions = {},
): boolean {
  const resolvedRoot = resolve(projectRoot);
  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? execSyncRunner;

  if (platform === 'darwin') {
    return isDaemonInstalledMacOS(resolvedRoot, options);
  } else if (platform === 'linux') {
    return isDaemonInstalledLinux(resolvedRoot, options);
  } else if (platform === 'win32') {
    return isDaemonInstalledWindows(resolvedRoot, run);
  }

  return false;
}

/**
 * Install the daemon as an OS-native login service.
 */
export function installDaemonService(
  projectRoot: string,
  options: DaemonServiceOptions = {},
): ServiceInstallResult {
  const resolvedRoot = resolve(projectRoot);
  validateProjectRoot(resolvedRoot);

  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? execSyncRunner;
  const nodePath = process.execPath;
  const cliPath = resolveCliPath();

  if (platform === 'darwin') {
    return installMacOS(resolvedRoot, nodePath, cliPath, options);
  } else if (platform === 'linux') {
    return installLinux(resolvedRoot, nodePath, cliPath, run, options);
  } else if (platform === 'win32') {
    return installWindows(resolvedRoot, nodePath, cliPath, run);
  }

  return {
    success: false,
    servicePath: null,
    message: `Unsupported platform: ${platform}`,
  };
}

/**
 * Uninstall the daemon OS-native login service.
 */
export function uninstallDaemonService(
  projectRoot: string,
  options: DaemonServiceOptions = {},
): ServiceUninstallResult {
  const resolvedRoot = resolve(projectRoot);
  validateProjectRoot(resolvedRoot);
  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? execSyncRunner;

  if (platform === 'darwin') {
    return uninstallMacOS(resolvedRoot, run, options);
  } else if (platform === 'linux') {
    return uninstallLinux(resolvedRoot, run, options);
  } else if (platform === 'win32') {
    return uninstallWindows(resolvedRoot, run);
  }

  return {
    success: false,
    message: `Unsupported platform: ${platform}`,
  };
}

// ---------------------------------------------------------------------------
// macOS — launchd
// ---------------------------------------------------------------------------

function plistPath(projectRoot: string, options: DaemonServiceOptions = {}): string {
  const slug = projectRootSlug(projectRoot);
  return join(options.homeDir ?? homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.${slug}.plist`);
}

function generatePlist(projectRoot: string, nodePath: string, cliPath: string): string {
  const slug = projectRootSlug(projectRoot);
  const label = `${PLIST_LABEL}.${slug}`;

  // XML plist — launchd specification
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>`,
    `  <string>${escapeXml(label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${escapeXml(nodePath)}</string>`,
    `    <string>${escapeXml(cliPath)}</string>`,
    `    <string>daemon</string>`,
    `    <string>start</string>`,
    `    <string>--foreground</string>`,
    `    <string>--quiet</string>`,
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXml(projectRoot)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <false/>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXml(join(projectRoot, '.moflo', 'daemon.log'))}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXml(join(projectRoot, '.moflo', 'daemon.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function installMacOS(
  projectRoot: string,
  nodePath: string,
  cliPath: string,
  options: DaemonServiceOptions,
): ServiceInstallResult {
  const dest = plistPath(projectRoot, options);
  const dir = dirname(dest);
  fs.mkdirSync(dir, { recursive: true });

  const content = generatePlist(projectRoot, nodePath, cliPath);
  fs.writeFileSync(dest, content, 'utf-8');

  return {
    success: true,
    servicePath: dest,
    message: `Daemon service installed at ${dest}. It will start automatically on login.`,
  };
}

function uninstallMacOS(
  projectRoot: string,
  run: CommandRunner,
  options: DaemonServiceOptions,
): ServiceUninstallResult {
  const dest = plistPath(projectRoot, options);

  if (!fs.existsSync(dest)) {
    return { success: true, message: 'Daemon service is not installed.' };
  }

  // Unload before removing (ignore errors — may not be loaded)
  try {
    run(`launchctl unload "${dest}"`, { timeout: 5000, stdio: 'ignore' });
  } catch { /* not loaded — fine */ }

  fs.unlinkSync(dest);
  return { success: true, message: `Daemon service removed from ${dest}.` };
}

function isDaemonInstalledMacOS(projectRoot: string, options: DaemonServiceOptions): boolean {
  return fs.existsSync(plistPath(projectRoot, options));
}

// ---------------------------------------------------------------------------
// Linux — systemd --user
// ---------------------------------------------------------------------------

function systemdUnitPath(projectRoot: string, options: DaemonServiceOptions = {}): string {
  const slug = projectRootSlug(projectRoot);
  // An injected homeDir is a sandbox boundary — XDG_CONFIG_HOME must not
  // override it, or an ambient value would redirect the write back to the
  // developer's real config tree.
  const configDir = options.homeDir
    ? join(options.homeDir, '.config')
    : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configDir, 'systemd', 'user', `${SYSTEMD_UNIT.replace('.service', '')}-${slug}.service`);
}

function generateSystemdUnit(projectRoot: string, nodePath: string, cliPath: string): string {
  return [
    '[Unit]',
    `Description=MoFlo Daemon (${projectRoot})`,
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart="${nodePath}" "${cliPath}" daemon start --foreground --quiet`,
    `WorkingDirectory=${projectRoot}`,
    'Restart=on-failure',
    'RestartSec=10',
    `Environment=MOFLO_DAEMON=1`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function installLinux(
  projectRoot: string,
  nodePath: string,
  cliPath: string,
  run: CommandRunner,
  options: DaemonServiceOptions,
): ServiceInstallResult {
  const dest = systemdUnitPath(projectRoot, options);
  const dir = dirname(dest);
  fs.mkdirSync(dir, { recursive: true });

  const content = generateSystemdUnit(projectRoot, nodePath, cliPath);
  fs.writeFileSync(dest, content, 'utf-8');

  // Reload systemd and enable
  try {
    run('systemctl --user daemon-reload', { timeout: 10000, stdio: 'ignore' });
    run(`systemctl --user enable ${basename(dest)}`, { timeout: 10000, stdio: 'ignore' });
  } catch {
    // systemctl may not be available in all environments
  }

  return {
    success: true,
    servicePath: dest,
    message: `Daemon service installed at ${dest}. It will start automatically on login.`,
  };
}

function uninstallLinux(
  projectRoot: string,
  run: CommandRunner,
  options: DaemonServiceOptions,
): ServiceUninstallResult {
  const dest = systemdUnitPath(projectRoot, options);

  if (!fs.existsSync(dest)) {
    return { success: true, message: 'Daemon service is not installed.' };
  }

  // Disable and stop before removing
  try {
    const unitName = basename(dest);
    run(`systemctl --user disable ${unitName}`, { timeout: 10000, stdio: 'ignore' });
    run(`systemctl --user stop ${unitName}`, { timeout: 10000, stdio: 'ignore' });
  } catch { /* may not be running */ }

  fs.unlinkSync(dest);

  // Reload systemd
  try {
    run('systemctl --user daemon-reload', { timeout: 10000, stdio: 'ignore' });
  } catch { /* ignore */ }

  return { success: true, message: `Daemon service removed from ${dest}.` };
}

function isDaemonInstalledLinux(projectRoot: string, options: DaemonServiceOptions): boolean {
  return fs.existsSync(systemdUnitPath(projectRoot, options));
}

// ---------------------------------------------------------------------------
// Windows — Task Scheduler
// ---------------------------------------------------------------------------

function schtasksName(projectRoot: string): string {
  const slug = projectRootSlug(projectRoot);
  return `${SCHTASKS_NAME}-${slug}`;
}

function installWindows(
  projectRoot: string,
  nodePath: string,
  cliPath: string,
  run: CommandRunner,
): ServiceInstallResult {
  const taskName = schtasksName(projectRoot);

  // Build schtasks command — ONLOGON trigger, user-level
  // Use /F to force overwrite if already exists (idempotent)
  try {
    run(
      `schtasks /Create /TN "${taskName}" /TR "\\"${nodePath}\\" \\"${cliPath}\\" daemon start --foreground --quiet" /SC ONLOGON /F`,
      { timeout: 15000, windowsHide: true, cwd: projectRoot, stdio: 'ignore' },
    );
  } catch (err) {
    return {
      success: false,
      servicePath: null,
      message: `Failed to create scheduled task: ${errorDetail(err)}`,
    };
  }

  return {
    success: true,
    servicePath: taskName,
    message: `Daemon task "${taskName}" registered in Task Scheduler. It will start automatically on login.`,
  };
}

function uninstallWindows(projectRoot: string, run: CommandRunner): ServiceUninstallResult {
  const taskName = schtasksName(projectRoot);

  try {
    run(
      `schtasks /Delete /TN "${taskName}" /F`,
      { timeout: 15000, windowsHide: true, stdio: 'ignore' },
    );
  } catch {
    // schtasks /Delete /F returns non-zero when task doesn't exist
    return { success: true, message: 'Daemon service is not installed.' };
  }

  return { success: true, message: `Daemon task "${taskName}" removed from Task Scheduler.` };
}

function isDaemonInstalledWindows(projectRoot: string, run: CommandRunner): boolean {
  const taskName = schtasksName(projectRoot);
  try {
    run(`schtasks /Query /TN "${taskName}"`, {
      timeout: 10000,
      windowsHide: true,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve CLI path from moflo's own package — anchors on moflo's package.json
 * so file moves (workspace collapse, etc.) cannot break it. Throws when the
 * binary is missing because every caller spawns it; failing here surfaces
 * the broken install louder than a downstream ENOENT.
 */
function resolveCliPath(): string {
  const cliPath = locateMofloCliBin();
  if (!cliPath) {
    throw new Error('moflo: bin/cli.js not found in installed package — broken install');
  }
  return cliPath;
}

/**
 * Create a filesystem-safe slug from a project root path.
 * Used to differentiate per-project services.
 */
function projectRootSlug(projectRoot: string): string {
  const resolved = resolve(projectRoot);
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  const tail = resolved
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(-40);
  return `${tail}-${hash}`;
}

/**
 * Validate project root for path safety.
 */
function validateProjectRoot(path: string): void {
  if (path.includes('\0')) {
    throw new Error('Project root contains null bytes');
  }
  if (/[;&|`$<>]/.test(path)) {
    throw new Error('Project root contains shell metacharacters');
  }
}

/**
 * Escape special characters for XML plist values.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Export for testing
export {
  generatePlist as _generatePlist,
  generateSystemdUnit as _generateSystemdUnit,
  plistPath as _plistPath,
  systemdUnitPath as _systemdUnitPath,
  schtasksName as _schtasksName,
  projectRootSlug as _projectRootSlug,
  resolveCliPath as _resolveCliPath,
};
