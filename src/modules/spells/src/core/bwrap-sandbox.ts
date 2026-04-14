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

import { homedir } from 'node:os';
import { posix } from 'node:path';
import type { StepCapability } from '../types/step-command.types.js';
import type { PermissionLevel } from './permission-resolver.js';
import { resolveScopePath, type SandboxWrapResult } from './sandbox-utils.js';

/**
 * Options that influence bwrap argument generation beyond raw capabilities.
 */
export interface BwrapOptions {
  /** Step's declared permission level — controls whether tool home paths are bound writable. */
  readonly permissionLevel?: PermissionLevel;
  /** Override home directory (for testing). Defaults to os.homedir(). */
  readonly homeDir?: string;
}

/**
 * Home-directory paths that common CLI tools need writable to persist state.
 * These are bound via `--bind-try` so missing entries are silently skipped.
 *
 * Rationale: `elevated`/`autonomous` steps routinely spawn tools like `claude`,
 * `gh`, `git`, and `npm` that write config/credentials/cache under $HOME. A
 * pure `--ro-bind / /` makes those tools fail with EROFS. We narrow the bind
 * set to well-known config paths so the sandbox still protects system dirs
 * (/etc, /usr, /var) and the rest of $HOME.
 */
const TOOL_HOME_PATHS: readonly string[] = [
  // Claude Code
  '.claude',
  '.claude.json',
  // GitHub CLI
  '.config/gh',
  // git
  '.gitconfig',
  '.git-credentials',
  // npm
  '.npmrc',
  '.npm',
  // Shared XDG locations
  '.config',
  '.cache',
  '.local/share',
  '.local/state',
];

/**
 * Permission levels that spawn arbitrary CLI tools and therefore need tool
 * home paths bound writable.
 */
function needsToolHomeAccess(level?: PermissionLevel): boolean {
  return level === 'elevated' || level === 'autonomous';
}

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
 *
 * When `options.permissionLevel` is `elevated` or `autonomous`, also:
 *   - Bind a narrow allowlist of CLI-tool home paths writable via `--bind-try`
 *     so spawned subcommands (claude, gh, git, npm) can persist state.
 *   - Share the host network (omit `--unshare-net`) so those tools can reach
 *     their APIs (api.anthropic.com, api.github.com, etc.). Without this,
 *     `claude -p` and similar commands fail with DNS/connection errors.
 */
export function buildBwrapArgs(
  command: string,
  capabilities: readonly StepCapability[],
  projectRoot: string,
  options: BwrapOptions = {},
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
  const writableScopes = new Set<string>();
  if (fsWrite) {
    if (fsWrite.scope && fsWrite.scope.length > 0) {
      for (const scopePath of fsWrite.scope) {
        const resolved = resolveScopePath(scopePath, projectRoot);
        args.push('--bind', resolved, resolved);
        writableScopes.add(resolved);
      }
    } else {
      // Unscoped fs:write -> writable project root
      args.push('--bind', projectRoot, projectRoot);
      writableScopes.add(projectRoot);
    }
  }

  // ── Tool home paths (elevated/autonomous only) ──────────────────────
  // Bind well-known CLI-tool config/cache paths writable so spawned
  // subcommands (claude, gh, git, npm) can persist their state. Uses
  // --bind-try so missing paths are ignored instead of erroring.
  if (needsToolHomeAccess(options.permissionLevel)) {
    const home = options.homeDir ?? homedir();
    if (home) {
      for (const rel of TOOL_HOME_PATHS) {
        const resolved = posix.join(home, rel);
        if (writableScopes.has(resolved)) continue;
        args.push('--bind-try', resolved, resolved);
        writableScopes.add(resolved);
      }
    }
  }

  // ── fs:read scoped — explicit read-only bind mounts ─────────────────
  // Unscoped fs:read is already covered by the --ro-bind / / at the top.
  const fsRead = capabilities.find(c => c.type === 'fs:read');
  if (fsRead && fsRead.scope && fsRead.scope.length > 0) {
    for (const scopePath of fsRead.scope) {
      const resolved = resolveScopePath(scopePath, projectRoot);
      // Only add if not already covered by a writable bind for same path
      if (!writableScopes.has(resolved)) {
        args.push('--ro-bind', resolved, resolved);
      }
    }
  }

  // ── Network isolation ───────────────────────────────────────────────
  // Elevated/autonomous steps spawn CLI tools (claude, gh, git, npm) that
  // need network to reach their APIs. Keep the host network for those,
  // mirroring the tool-home-paths policy.
  const hasNet = capabilities.some(c => c.type === 'net');
  if (!hasNet && !needsToolHomeAccess(options.permissionLevel)) {
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
  options: BwrapOptions = {},
): SandboxWrapResult {
  const args = buildBwrapArgs(command, capabilities, projectRoot, options);

  return {
    bin: 'bwrap',
    args,
    cleanup: () => {},
  };
}
