/**
 * Shared Sandbox Utilities
 *
 * Common types and helpers used by both macOS sandbox-exec and Linux bwrap wrappers.
 *
 * @see https://github.com/eric-cielo/moflo/issues/410
 * @see https://github.com/eric-cielo/moflo/issues/411
 */

import { posix, isAbsolute } from 'node:path';

/**
 * Result of wrapping a bash command for OS-level sandbox execution.
 * Used by both sandbox-exec (macOS) and bwrap (Linux).
 */
export interface SandboxWrapResult {
  /** Binary to spawn (e.g. '/usr/bin/sandbox-exec' or 'bwrap'). */
  readonly bin: string;
  /** Args array for the spawn call. */
  readonly args: readonly string[];
  /** Call after process exits to clean up temp files (no-op for bwrap). */
  readonly cleanup: () => void;
}

/**
 * Resolve a scope path relative to project root.
 * Absolute paths pass through; relative paths are joined with projectRoot.
 * Uses POSIX paths since sandboxing only runs on macOS and Linux.
 */
export function resolveScopePath(scopePath: string, projectRoot: string): string {
  if (isAbsolute(scopePath)) return scopePath;
  const cleaned = scopePath.replace(/^\.\//, '');
  return posix.join(projectRoot, cleaned);
}
