/**
 * Cross-platform utilities for shell commands and path handling.
 */

/** Date of the cross-platform audit */
export const PLATFORM_AUDIT_DATE = '2026-04-01';

/** True when running on Windows */
export const IS_WINDOWS = process.platform === 'win32';

/** Platform-appropriate null device for stderr/stdout redirection */
export const NULL_DEVICE = IS_WINDOWS ? 'NUL' : '/dev/null';

/**
 * Append stderr-to-null redirection to a shell command.
 * On Windows: `2>NUL`, on Unix: `2>/dev/null`
 */
export function silenceStderr(cmd: string): string {
  return `${cmd} 2>${NULL_DEVICE}`;
}

/**
 * Get the platform-appropriate shell for child_process spawn/exec.
 * On Windows, uses ComSpec (defaults to cmd.exe).
 * On Unix, uses SHELL (defaults to /bin/sh).
 */
export function getShell(): string {
  return IS_WINDOWS
    ? (process.env.ComSpec || 'cmd.exe')
    : (process.env.SHELL || '/bin/sh');
}

/**
 * Escape a shell argument in a platform-appropriate way.
 * On Windows: double-quote wrapping with escaped inner quotes.
 * On Unix: single-quote wrapping with escaped inner quotes.
 */
export function escapeShellArg(arg: string): string {
  if (IS_WINDOWS) {
    return '"' + arg.replace(/"/g, '\\"') + '"';
  }
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
