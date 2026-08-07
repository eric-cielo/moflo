/**
 * Cross-platform utilities for shell commands and path handling.
 */

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
 *
 * **This is the canonical implementation.** Every other copy in the tree
 * re-exports it (`spells/core/shell.ts`) or, where a plain `.mjs` cannot import
 * TS, mirrors it with a pointer back here (`harness/consumer-smoke/lib/proc.mjs`).
 *
 * On Windows the wrapping is `"…"` and backslashes matter: under MSVCRT argv
 * parsing a backslash is only special immediately before a `"`, where it escapes
 * it. Escaping quotes alone — the previous behaviour — left a trailing backslash
 * escaping the *closing* quote, so `C:\Users\eric\` became `"C:\Users\eric\"`,
 * the quoted region ran on, and it swallowed the next argument. Windows paths
 * produce that shape constantly (#1419). So: double every run of backslashes
 * that precedes a `"` or terminates the string, then escape the quotes.
 *
 * On Unix the `'\''` idiom is already total — single quotes suppress every other
 * metacharacter — and is unchanged.
 *
 * Scope: this makes the argument survive the C runtime's argv split. It does not
 * neutralise `cmd.exe`'s own `%VAR%` expansion, which happens before the runtime
 * ever sees the string; prefer passing an argv array with `shell: false` when the
 * call site allows it.
 */
export function escapeShellArg(arg: string): string {
  return IS_WINDOWS ? escapeShellArgWindows(arg) : escapeShellArgPosix(arg);
}

/**
 * The Windows branch of {@link escapeShellArg}, exported so it can be tested
 * from any host. Rule #1: a Windows-only code path guarded by `IS_WINDOWS` is a
 * path that a Linux CI run never executes, which is how the trailing-backslash
 * defect survived — including in the smoke harness built to catch exactly this.
 */
export function escapeShellArgWindows(arg: string): string {
  const escaped = arg
    .replace(/(\\*)"/g, '$1$1\\"')  // backslash run before a quote: double it, then escape the quote
    .replace(/(\\+)$/, '$1$1');     // backslash run before the closing quote: double it
  return `"${escaped}"`;
}

/** The POSIX branch of {@link escapeShellArg}, exported for the same reason. */
export function escapeShellArgPosix(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
