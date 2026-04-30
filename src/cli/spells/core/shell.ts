/**
 * Shell Utilities
 *
 * Shared helpers for executing shell commands and escaping arguments.
 * Used by github-cli tool, github step command, and any future tools
 * that need CLI execution.
 */

import { exec, execFile } from 'node:child_process';

// ============================================================================
// Types
// ============================================================================

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ============================================================================
// Shell execution
// ============================================================================

/**
 * Execute a shell command and return structured output.
 * Never throws — exit code and stderr capture failures.
 */
export function execAsync(command: string, timeout = 30000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32'
      ? (process.env.ComSpec || 'cmd.exe')
      : (process.env.SHELL || 'bash');
    const child = exec(command, { timeout, shell }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: child.exitCode ?? (error ? 1 : 0),
      });
    });
  });
}

/**
 * Spawn a binary with an argv array — no shell, no escaping required.
 * Use this whenever an argument may contain newlines, quotes, or other
 * shell metacharacters. cmd.exe treats embedded `\n` in shell-mode
 * strings as a command separator regardless of quoting, so any gh/git
 * command that carries a multi-line body must go through this path.
 */
export function execFileAsync(
  file: string,
  args: readonly string[],
  timeout = 30000,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { timeout, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: child.exitCode ?? (error ? 1 : 0),
        });
      },
    );
  });
}

/**
 * Escape a string for safe use as a single-quoted shell argument.
 * Wraps in single quotes and escapes embedded single quotes.
 */
export function escapeShellArg(arg: string): string {
  if (process.platform === 'win32') {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
