/**
 * macOS Sandbox Profile Generator
 *
 * Generates sandbox-exec `.sb` profiles dynamically from step capabilities
 * and wraps bash commands for sandboxed execution.
 *
 * @see https://github.com/eric-cielo/moflo/issues/410
 */

import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { StepCapability } from '../types/step-command.types.js';
import { resolveScopePath, type SandboxWrapResult } from './sandbox-utils.js';

export type { SandboxWrapResult } from './sandbox-utils.js';

// ============================================================================
// Profile Generation
// ============================================================================

/**
 * Generate a macOS sandbox-exec profile (.sb) from step capabilities.
 *
 * Rules:
 *   - Deny all by default
 *   - Always allow process execution and signal handling
 *   - Always allow read access to /usr, /bin, /Library, /System (system libs)
 *   - fs:read scoped → allow file-read* to scoped paths
 *   - fs:read unscoped → allow file-read* to projectRoot
 *   - fs:write scoped → allow file-write* to scoped paths
 *   - fs:write unscoped → allow file-write* to projectRoot
 *   - net capability → allow network*
 *   - No net capability → network denied (default deny covers it)
 */
export function generateSandboxProfile(
  capabilities: readonly StepCapability[],
  projectRoot: string,
): string {
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '',
    '; Process execution (required for bash)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal)',
    '(allow sysctl-read)',
    '',
    '; System libraries and binaries (always needed)',
    '(allow file-read* (subpath "/usr"))',
    '(allow file-read* (subpath "/bin"))',
    '(allow file-read* (subpath "/Library"))',
    '(allow file-read* (subpath "/System"))',
    '(allow file-read* (subpath "/private/var"))',
    '(allow file-read* (subpath "/private/etc"))',
    '(allow file-read* (subpath "/dev"))',
    '(allow file-read-metadata)',
    '',
    '; Temp directory access (for profile itself and command temp files)',
    '(allow file-read* (subpath "/private/tmp"))',
    '(allow file-write* (subpath "/private/tmp"))',
    `(allow file-read* (subpath "${escapeSbPath(tmpdir())}"))`,
    `(allow file-write* (subpath "${escapeSbPath(tmpdir())}"))`,
  ];

  // ── fs:read ──────────────────────────────────────────────────────────
  const fsRead = capabilities.find(c => c.type === 'fs:read');
  if (fsRead) {
    lines.push('');
    lines.push('; Filesystem read access');
    if (fsRead.scope && fsRead.scope.length > 0) {
      for (const scopePath of fsRead.scope) {
        const resolved = resolveScopePath(scopePath, projectRoot);
        lines.push(`(allow file-read* (subpath "${escapeSbPath(resolved)}"))`);
      }
    } else {
      lines.push(`(allow file-read* (subpath "${escapeSbPath(projectRoot)}"))`);
    }
  }

  // ── fs:write ─────────────────────────────────────────────────────────
  const fsWrite = capabilities.find(c => c.type === 'fs:write');
  if (fsWrite) {
    lines.push('');
    lines.push('; Filesystem write access');
    if (fsWrite.scope && fsWrite.scope.length > 0) {
      for (const scopePath of fsWrite.scope) {
        const resolved = resolveScopePath(scopePath, projectRoot);
        lines.push(`(allow file-write* (subpath "${escapeSbPath(resolved)}"))`);
      }
    } else {
      lines.push(`(allow file-write* (subpath "${escapeSbPath(projectRoot)}"))`);
    }
  }

  // ── net ──────────────────────────────────────────────────────────────
  const hasNet = capabilities.some(c => c.type === 'net');
  if (hasNet) {
    lines.push('');
    lines.push('; Network access');
    lines.push('(allow network*)');
  }

  lines.push('');
  return lines.join('\n');
}

// ============================================================================
// Command Wrapping
// ============================================================================

/**
 * Wrap a bash command for execution under macOS sandbox-exec.
 *
 * Writes a temporary `.sb` profile and returns the sandbox-exec invocation.
 * The caller MUST call `cleanup()` after the process exits.
 */
export function wrapWithSandboxExec(
  command: string,
  capabilities: readonly StepCapability[],
  projectRoot: string,
): SandboxWrapResult {
  const profile = generateSandboxProfile(capabilities, projectRoot);
  const profilePath = join(tmpdir(), `moflo-sandbox-${randomBytes(8).toString('hex')}.sb`);

  writeFileSync(profilePath, profile, 'utf8');

  return {
    bin: '/usr/bin/sandbox-exec',
    args: ['-f', profilePath, 'bash', '-c', command],
    cleanup: () => {
      try {
        unlinkSync(profilePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.log(`[sandbox] failed to clean up profile ${profilePath}: ${(err as Error).message}`);
        }
      }
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Escape a path for use inside a sandbox profile string literal.
 * Backslashes and double quotes need escaping in Scheme strings.
 */
function escapeSbPath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
