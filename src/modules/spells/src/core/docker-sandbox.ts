/**
 * Windows Docker Sandbox Wrapper
 *
 * Wraps a bash command with `docker run` for execution inside a Linux
 * container. Mirrors the bwrap/sandbox-exec interface so `bash-command.ts`
 * can dispatch to any platform's sandbox identically.
 *
 * Design notes vs bwrap:
 *   - Paths must be translated: Windows `C:\path` won't exist in the
 *     container. projectRoot mounts at `/workspace` (the container's CWD);
 *     scopes inside projectRoot translate to `/workspace/<rel>`; absolute
 *     scopes outside the project are skipped with a log line.
 *   - Tool home paths mount under `/home/node/<rel>` so that claude/gh/git
 *     inside the container read and write the same config files the user
 *     edits on Windows. The container runs as the `node` user (uid 1000)
 *     because Claude Code CLI refuses to run as root with
 *     `--dangerously-skip-permissions`.
 *   - `--network none` is the default; `net` cap or elevated/autonomous omit
 *     it (default bridge) — mirrors the bwrap policy.
 *   - `--rm` handles cleanup automatically.
 *
 * @see https://github.com/eric-cielo/moflo/issues/412
 */

import { homedir } from 'node:os';
import { posix, isAbsolute, relative } from 'node:path';
import type { StepCapability } from '../types/step-command.types.js';
import type { PermissionLevel } from './permission-resolver.js';
import type { SandboxWrapResult } from './sandbox-utils.js';

/** Container path where projectRoot is mounted. */
const CONTAINER_WORKSPACE = '/workspace';

/**
 * Container path where the user's home is projected (for tool home mounts).
 * The sandbox image switches to the `node` user, so tool configs must land
 * in that user's home — not `/root`.
 */
const CONTAINER_HOME = '/home/node';

/**
 * Tool home paths mounted rw for elevated/autonomous steps so claude, gh,
 * git, npm can persist their config/credentials/cache. Mirrors the bwrap
 * allowlist; Windows-specific Application Support paths aren't included
 * because the Linux tools inside the container look at POSIX paths.
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

export interface DockerOptions {
  /** Docker image to run the container from (required). */
  readonly image: string;
  /** Step's declared permission level. */
  readonly permissionLevel?: PermissionLevel;
  /** Override home directory (for testing). Defaults to `os.homedir()`. */
  readonly homeDir?: string;
  /** Override docker binary (for testing). Defaults to `docker`. */
  readonly dockerBin?: string;
}

function needsToolHomeAccess(level?: PermissionLevel): boolean {
  return level === 'elevated' || level === 'autonomous';
}

/**
 * Normalise a host path into the form Docker Desktop accepts on `-v` mounts.
 * Docker for Windows accepts either native Windows paths or the `/c/...`
 * form — we pass the native path through untouched since `execFile`-style
 * spawning avoids shell-quoting issues.
 */
function normaliseHostPath(p: string): string {
  return p;
}

/**
 * Translate a host scope path into a container path.
 *
 * - If inside `projectRoot` → mount at `/workspace/<relative>` (no extra bind)
 * - If outside → return null (caller will add a dedicated bind at the same
 *   POSIX-form path and log that the path is being projected)
 */
function translateScopePath(
  scopePath: string,
  projectRoot: string,
): { containerPath: string; needsBind: boolean } {
  if (!isAbsolute(scopePath)) {
    const cleaned = scopePath.replace(/^\.\/+/, '');
    return {
      containerPath: posix.join(CONTAINER_WORKSPACE, cleaned),
      needsBind: false,
    };
  }

  const rel = relative(projectRoot, scopePath);
  const isInside = !rel.startsWith('..') && !isAbsolute(rel);
  if (isInside) {
    return {
      containerPath: posix.join(CONTAINER_WORKSPACE, rel.replace(/\\/g, '/')),
      needsBind: false,
    };
  }

  // Outside project — give it a dedicated mount at a synthetic container path.
  // We use a hash-free, deterministic name based on the leaf so repeated
  // scopes produce stable paths.
  return {
    containerPath: `/mnt/sandbox/${toSafeSegment(scopePath)}`,
    needsBind: true,
  };
}

function toSafeSegment(hostPath: string): string {
  return hostPath
    .replace(/[\\:]+/g, '_')
    .replace(/\//g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Build `docker run` arguments from step capabilities.
 *
 * Default posture: project mounted read-only at `/workspace`, no network,
 * no tool home access. Capabilities grant additional permissions:
 *   - fs:read scoped   → `-v <host>:<container>:ro` for each outside-project
 *                        path; inside-project paths are already covered by
 *                        the workspace bind
 *   - fs:read unscoped → no-op (workspace is already read-only)
 *   - fs:write scoped  → promotes scoped paths to rw
 *   - fs:write unscoped → promotes `/workspace` to rw
 *   - net              → omit `--network none`
 *
 * When `permissionLevel` is `elevated` or `autonomous`:
 *   - Mount tool home paths rw at `/home/node/<rel>`
 *   - Share the host network (omit `--network none`)
 */
export function buildDockerArgs(
  command: string,
  capabilities: readonly StepCapability[],
  projectRoot: string,
  options: DockerOptions,
): readonly string[] {
  const args: string[] = ['run', '--rm', '-i'];

  // ── Workspace mount (read-only by default) ──────────────────────────
  const fsWrite = capabilities.find(c => c.type === 'fs:write');
  const projectRw = Boolean(fsWrite && (!fsWrite.scope || fsWrite.scope.length === 0));

  args.push('-v', `${normaliseHostPath(projectRoot)}:${CONTAINER_WORKSPACE}${projectRw ? '' : ':ro'}`);
  args.push('-w', CONTAINER_WORKSPACE);

  // Track container paths we've already bound so we don't double-mount.
  const mountedContainerPaths = new Set<string>([CONTAINER_WORKSPACE]);

  // ── fs:write scoped — rw binds for each path ────────────────────────
  // Inside-project scopes use overlay binds: Docker Desktop honours a second
  // `-v` whose container target is a subpath of the first, and the second
  // mount's mode wins for its subtree. That gives us per-scope rw without
  // opening the whole workspace — the same posture bwrap provides via
  // `--ro-bind /` + `--bind <scope>`.
  if (fsWrite && fsWrite.scope && fsWrite.scope.length > 0) {
    for (const scopePath of fsWrite.scope) {
      const resolved = isAbsolute(scopePath) ? scopePath : posix.join(projectRoot, scopePath.replace(/^\.\/+/, ''));
      const { containerPath } = translateScopePath(resolved, projectRoot);
      if (mountedContainerPaths.has(containerPath)) continue;
      args.push('-v', `${normaliseHostPath(resolved)}:${containerPath}`);
      mountedContainerPaths.add(containerPath);
    }
  }

  // ── fs:read scoped — ro binds for outside-project paths ─────────────
  const fsRead = capabilities.find(c => c.type === 'fs:read');
  if (fsRead && fsRead.scope && fsRead.scope.length > 0) {
    for (const scopePath of fsRead.scope) {
      const resolved = isAbsolute(scopePath) ? scopePath : posix.join(projectRoot, scopePath.replace(/^\.\/+/, ''));
      const { containerPath, needsBind } = translateScopePath(resolved, projectRoot);
      if (!needsBind) continue;
      if (mountedContainerPaths.has(containerPath)) continue;
      args.push('-v', `${normaliseHostPath(resolved)}:${containerPath}:ro`);
      mountedContainerPaths.add(containerPath);
    }
  }

  // ── Tool home paths (elevated/autonomous only) ──────────────────────
  if (needsToolHomeAccess(options.permissionLevel)) {
    const home = options.homeDir ?? homedir();
    if (home) {
      for (const rel of TOOL_HOME_PATHS) {
        const hostPath = posix.join(home.replace(/\\/g, '/'), rel);
        const containerPath = posix.join(CONTAINER_HOME, rel);
        if (mountedContainerPaths.has(containerPath)) continue;
        args.push('-v', `${normaliseHostPath(hostPath)}:${containerPath}`);
        mountedContainerPaths.add(containerPath);
      }
    }

    // Override git credential.helper to the gh CLI helper. The host's
    // bind-mounted .gitconfig declares a helper that can't run in the
    // Linux container (Windows: `manager` .exe; macOS: `osxkeychain`;
    // Linux: libsecret/etc — all host-OS-specific). gh is installed in
    // the sandbox image and `.config/gh` is bind-mounted, so
    // `gh auth git-credential` supplies the token for HTTPS git ops.
    // First entry (empty value) resets the inherited helper list; the
    // second entry installs the gh helper as the only one. Applied via
    // GIT_CONFIG_* env vars so no config file is modified.
    args.push('-e', 'GIT_CONFIG_COUNT=2');
    args.push('-e', 'GIT_CONFIG_KEY_0=credential.helper');
    args.push('-e', 'GIT_CONFIG_VALUE_0=');
    args.push('-e', 'GIT_CONFIG_KEY_1=credential.helper');
    args.push('-e', 'GIT_CONFIG_VALUE_1=!gh auth git-credential');
  }

  // ── Network isolation ───────────────────────────────────────────────
  const hasNet = capabilities.some(c => c.type === 'net');
  if (!hasNet && !needsToolHomeAccess(options.permissionLevel)) {
    args.push('--network', 'none');
  }

  // ── Image + command ─────────────────────────────────────────────────
  args.push(options.image);
  args.push('bash', '-c', command);

  return args;
}

/**
 * Wrap a bash command for execution inside a Docker container.
 *
 * Returns a `SandboxWrapResult` identical in shape to the bwrap/sandbox-exec
 * wrappers. `--rm` handles container cleanup, so `cleanup()` is a no-op.
 */
export function wrapWithDocker(
  command: string,
  capabilities: readonly StepCapability[],
  projectRoot: string,
  options: DockerOptions,
): SandboxWrapResult {
  const args = buildDockerArgs(command, capabilities, projectRoot, options);
  return {
    bin: options.dockerBin ?? 'docker',
    args,
    cleanup: () => {},
  };
}
