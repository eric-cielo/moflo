/**
 * Linux Bubblewrap (bwrap) Sandbox Wrapper
 *
 * Generates bwrap command-line arguments from step capabilities and wraps
 * bash commands for sandboxed execution inside a Linux namespace.
 *
 * Unlike macOS sandbox-exec (which needs a temp .sb profile file), bwrap
 * takes all its configuration as CLI arguments, so no temp files are needed.
 *
 * @see https://github.com/eric-cielo/moflo/issues/411
 */

import type { StepCapability } from '../types/step-command.types.js';
import { resolveScopePath, type SandboxWrapResult } from './sandbox-utils.js';

/**
 * Build bwrap CLI arguments from step capabilities.
 *
 * Default posture: deny-all via read-only root bind, unshared PID and network.
 * Capabilities grant specific permissions:
 *   - fs:read scoped  -> --ro-bind for each scope path
 *   - fs:read unscoped -> --ro-bind for projectRoot (already covered by / bind)
 *   - fs:write scoped  -> --bind (read-write) for each scope path
 *   - fs:write unscoped -> --bind (read-write) for projectRoot
 *   - net              -> omit --unshare-net
 */
export function buildBwrapArgs(
  command: string,
  capabilities: readonly StepCapability[],
  projectRoot: string,
): readonly string[] {
  const args: string[] = [];

  // ── Root filesystem (read-only by default) ──────────────────────────
  args.push('--ro-bind', '/', '/');

  // ── Device and proc filesystems ─────────────────────────────────────
  args.push('--dev', '/dev');
  args.push('--proc', '/proc');

  // ── Writable tmpfs at /tmp ──────────────────────────────────────────
  args.push('--tmpfs', '/tmp');

  // ── fs:write — grant read-write bind mounts ─────────────────────────
  const fsWrite = capabilities.find(c => c.type === 'fs:write');
  if (fsWrite) {
    if (fsWrite.scope && fsWrite.scope.length > 0) {
      for (const scopePath of fsWrite.scope) {
        const resolved = resolveScopePath(scopePath, projectRoot);
        args.push('--bind', resolved, resolved);
      }
    } else {
      // Unscoped fs:write -> writable project root
      args.push('--bind', projectRoot, projectRoot);
    }
  }

  // ── fs:read scoped — explicit read-only bind mounts ─────────────────
  // Unscoped fs:read is already covered by the --ro-bind / / at the top.
  const fsRead = capabilities.find(c => c.type === 'fs:read');
  if (fsRead && fsRead.scope && fsRead.scope.length > 0) {
    for (const scopePath of fsRead.scope) {
      const resolved = resolveScopePath(scopePath, projectRoot);
      // Only add if not already covered by an fs:write --bind for same path
      const alreadyWritable = fsWrite?.scope?.some(
        wp => resolveScopePath(wp, projectRoot) === resolved,
      );
      if (!alreadyWritable) {
        args.push('--ro-bind', resolved, resolved);
      }
    }
  }

  // ── Network isolation ───────────────────────────────────────────────
  const hasNet = capabilities.some(c => c.type === 'net');
  if (!hasNet) {
    args.push('--unshare-net');
  }

  // ── PID isolation (always) ──────────────────────────────────────────
  args.push('--unshare-pid');

  // ── Command ─────────────────────────────────────────────────────────
  args.push('bash', '-c', command);

  return args;
}

/**
 * Wrap a bash command for execution under Linux bubblewrap (bwrap).
 *
 * Returns a `SandboxWrapResult` compatible with the macOS sandbox-exec wrapper,
 * so `bash-command.ts` can use either interchangeably.
 *
 * Unlike sandbox-exec, bwrap uses CLI args only — no temp files are created,
 * so `cleanup()` is a no-op.
 */
export function wrapWithBwrap(
  command: string,
  capabilities: readonly StepCapability[],
  projectRoot: string,
): SandboxWrapResult {
  const args = buildBwrapArgs(command, capabilities, projectRoot);

  return {
    bin: 'bwrap',
    args,
    cleanup: () => {},
  };
}

