/**
 * OS-Native Daemon Service Registration
 *
 * Registers/removes the moflo daemon as a user-level login service
 * so scheduled workflows survive reboots without Docker.
 *
 * - macOS:   launchd plist in ~/Library/LaunchAgents/
 * - Linux:   systemd --user unit in ~/.config/systemd/user/
 * - Windows: Task Scheduler ONLOGON trigger via schtasks
 */

import * as fs from 'fs';
import { createHash } from 'crypto';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

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
export function isDaemonInstalled(projectRoot: string): boolean {
  const resolvedRoot = resolve(projectRoot);
  const platform = process.platform;

  if (platform === 'darwin') {
    return isDaemonInstalledMacOS(resolvedRoot);
  } else if (platform === 'linux') {
    return isDaemonInstalledLinux(resolvedRoot);
  } else if (platform === 'win32') {
    return isDaemonInstalledWindows(resolvedRoot);
  }

  return false;
}

/**
 * Install the daemon as an OS-native login service.
 */
export function installDaemonService(projectRoot: string): ServiceInstallResult {
  const resolvedRoot = resolve(projectRoot);
  validateProjectRoot(resolvedRoot);

  const platform = process.platform;
  const nodePath = process.execPath;
  const cliPath = resolveCliPath();

  if (platform === 'darwin') {
    return installMacOS(resolvedRoot, nodePath, cliPath);
  } else if (platform === 'linux') {
    return installLinux(resolvedRoot, nodePath, cliPath);
  } else if (platform === 'win32') {
    return installWindows(resolvedRoot, nodePath, cliPath);
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
export function uninstallDaemonService(projectRoot: string): ServiceUninstallResult {
  const resolvedRoot = resolve(projectRoot);
  validateProjectRoot(resolvedRoot);
  const platform = process.platform;

  if (platform === 'darwin') {
    return uninstallMacOS(resolvedRoot);
  } else if (platform === 'linux') {
    return uninstallLinux(resolvedRoot);
  } else if (platform === 'win32') {
    return uninstallWindows(resolvedRoot);
  }

  return {
    success: false,
    message: `Unsupported platform: ${platform}`,
  };
}

// ---------------------------------------------------------------------------
// macOS — launchd
// ---------------------------------------------------------------------------

function plistPath(projectRoot: string): string {
  const slug = projectRootSlug(projectRoot);
  return join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.${slug}.plist`);
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
    `  <string>${escapeXml(join(projectRoot, '.claude-flow', 'daemon.log'))}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXml(join(projectRoot, '.claude-flow', 'daemon.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function installMacOS(projectRoot: string, nodePath: string, cliPath: string): ServiceInstallResult {
  const dest = plistPath(projectRoot);
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

function uninstallMacOS(projectRoot: string): ServiceUninstallResult {
  const dest = plistPath(projectRoot);

  if (!fs.existsSync(dest)) {
    return { success: true, message: 'Daemon service is not installed.' };
  }

  // Unload before removing (ignore errors — may not be loaded)
  try {
    execSync(`launchctl unload "${dest}"`, { timeout: 5000, stdio: 'ignore' });
  } catch { /* not loaded — fine */ }

  fs.unlinkSync(dest);
  return { success: true, message: `Daemon service removed from ${dest}.` };
}

function isDaemonInstalledMacOS(projectRoot: string): boolean {
  return fs.existsSync(plistPath(projectRoot));
}

// ---------------------------------------------------------------------------
// Linux — systemd --user
// ---------------------------------------------------------------------------

function systemdUnitPath(projectRoot: string): string {
  const slug = projectRootSlug(projectRoot);
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
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
    `Environment=CLAUDE_FLOW_DAEMON=1`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function installLinux(projectRoot: string, nodePath: string, cliPath: string): ServiceInstallResult {
  const dest = systemdUnitPath(projectRoot);
  const dir = dirname(dest);
  fs.mkdirSync(dir, { recursive: true });

  const content = generateSystemdUnit(projectRoot, nodePath, cliPath);
  fs.writeFileSync(dest, content, 'utf-8');

  // Reload systemd and enable
  try {
    execSync('systemctl --user daemon-reload', { timeout: 10000, stdio: 'ignore' });
    const unitName = dest.split('/').pop()!;
    execSync(`systemctl --user enable ${unitName}`, { timeout: 10000, stdio: 'ignore' });
  } catch {
    // systemctl may not be available in all environments
  }

  return {
    success: true,
    servicePath: dest,
    message: `Daemon service installed at ${dest}. It will start automatically on login.`,
  };
}

function uninstallLinux(projectRoot: string): ServiceUninstallResult {
  const dest = systemdUnitPath(projectRoot);

  if (!fs.existsSync(dest)) {
    return { success: true, message: 'Daemon service is not installed.' };
  }

  // Disable and stop before removing
  try {
    const unitName = dest.split('/').pop()!;
    execSync(`systemctl --user disable ${unitName}`, { timeout: 10000, stdio: 'ignore' });
    execSync(`systemctl --user stop ${unitName}`, { timeout: 10000, stdio: 'ignore' });
  } catch { /* may not be running */ }

  fs.unlinkSync(dest);

  // Reload systemd
  try {
    execSync('systemctl --user daemon-reload', { timeout: 10000, stdio: 'ignore' });
  } catch { /* ignore */ }

  return { success: true, message: `Daemon service removed from ${dest}.` };
}

function isDaemonInstalledLinux(projectRoot: string): boolean {
  return fs.existsSync(systemdUnitPath(projectRoot));
}

// ---------------------------------------------------------------------------
// Windows — Task Scheduler
// ---------------------------------------------------------------------------

function schtasksName(projectRoot: string): string {
  const slug = projectRootSlug(projectRoot);
  return `${SCHTASKS_NAME}-${slug}`;
}

function installWindows(projectRoot: string, nodePath: string, cliPath: string): ServiceInstallResult {
  const taskName = schtasksName(projectRoot);

  // Build schtasks command — ONLOGON trigger, user-level
  // Use /F to force overwrite if already exists (idempotent)
  try {
    execSync(
      `schtasks /Create /TN "${taskName}" /TR "\\"${nodePath}\\" \\"${cliPath}\\" daemon start --foreground --quiet" /SC ONLOGON /F`,
      { timeout: 15000, windowsHide: true, cwd: projectRoot, stdio: 'ignore' },
    );
  } catch (err) {
    return {
      success: false,
      servicePath: null,
      message: `Failed to create scheduled task: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    success: true,
    servicePath: taskName,
    message: `Daemon task "${taskName}" registered in Task Scheduler. It will start automatically on login.`,
  };
}

function uninstallWindows(projectRoot: string): ServiceUninstallResult {
  const taskName = schtasksName(projectRoot);

  try {
    execSync(
      `schtasks /Delete /TN "${taskName}" /F`,
      { timeout: 15000, windowsHide: true, stdio: 'ignore' },
    );
  } catch {
    // schtasks /Delete /F returns non-zero when task doesn't exist
    return { success: true, message: 'Daemon service is not installed.' };
  }

  return { success: true, message: `Daemon task "${taskName}" removed from Task Scheduler.` };
}

function isDaemonInstalledWindows(projectRoot: string): boolean {
  const taskName = schtasksName(projectRoot);
  try {
    execSync(`schtasks /Query /TN "${taskName}"`, {
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
 * Resolve CLI path from moflo's own package (using import.meta.url, not process.cwd()).
 */
function resolveCliPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // dist/src/services -> dist/src -> dist -> package root -> bin/cli.js
  return resolve(join(__dirname, '..', '..', '..', 'bin', 'cli.js'));
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
