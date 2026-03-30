/**
 * Shell Utilities
 *
 * Shared helpers for executing shell commands and escaping arguments.
 * Used by github-cli tool, github step command, and any future tools
 * that need CLI execution.
 */

import { exec } from 'node:child_process';

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
    const child = exec(command, { timeout, shell: 'bash' }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: child.exitCode ?? (error ? 1 : 0),
      });
    });
  });
}

/**
 * Escape a string for safe use as a single-quoted shell argument.
 * Wraps in single quotes and escapes embedded single quotes.
 */
export function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
