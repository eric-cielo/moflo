/**
 * Platform Sandbox Detection
 *
 * Detects available OS-level sandboxing on the current platform and exposes
 * the result to the spell engine so bash-command can use it.
 *
 * Detection targets:
 *   - macOS:   sandbox-exec (always present)
 *   - Linux:   bwrap (bubblewrap)
 *   - Windows: Docker Desktop (docker binary + daemon running)
 *
 * @see https://github.com/eric-cielo/moflo/issues/409
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { escapeShellArg } from './shell.js';

type YamlModule = { load: (s: string) => unknown; default?: { load: (s: string) => unknown } };

// ============================================================================
// Types
// ============================================================================

export type SandboxOverhead = 'low' | 'medium';

export interface SandboxCapability {
  /** Current OS platform. */
  readonly platform: NodeJS.Platform;
  /** Whether an OS-level sandbox is available. */
  readonly available: boolean;
  /** The sandbox tool name, or null if unavailable. */
  readonly tool: string | null;
  /** Estimated overhead: 'low' for sandbox-exec/bwrap, 'medium' for Docker. */
  readonly overhead: SandboxOverhead | null;
}

export type SandboxTier = 'auto' | 'denylist-only' | 'full';

export interface SandboxConfig {
  /** Master toggle — false disables OS sandbox but keeps the denylist. */
  readonly enabled: boolean;
  /**
   * Tier selection:
   *   - auto:          use best available, fall back gracefully (default)
   *   - denylist-only: skip OS sandbox, keep denylist
   *   - full:          require OS sandbox, fail if unavailable
   */
  readonly tier: SandboxTier;
  /**
   * Docker image for Windows sandboxing.
   *
   * Auto-defaults to {@link RECOMMENDED_DOCKER_IMAGE} and auto-pulls on
   * first use. Set explicitly to override the default image.
   */
  readonly dockerImage?: string;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: false,
  tier: 'auto',
};

/** Recommended image for first-time Windows Docker sandbox setup. */
export const RECOMMENDED_DOCKER_IMAGE = 'ghcr.io/eric-cielo/moflo-sandbox:latest';

// ============================================================================
// Detection (cached)
// ============================================================================

let _cached: SandboxCapability | undefined;

/**
 * Detect the available sandbox tool for the current platform.
 *
 * Results are cached for the process lifetime — filesystem/daemon checks
 * are expensive and the answer doesn't change mid-process.
 */
export function detectSandboxCapability(): SandboxCapability {
  if (_cached) return _cached;
  _cached = detectUncached();
  return _cached;
}

/** Reset the cached result (for testing). */
export function resetSandboxCache(): void {
  _cached = undefined;
  _imageExistsCache.clear();
}

function detectUncached(): SandboxCapability {
  const os = platform();

  if (os === 'darwin') {
    return detectMacOS();
  }
  if (os === 'linux') {
    return detectLinux();
  }
  if (os === 'win32') {
    return detectWindows();
  }

  // Unsupported platform
  return { platform: os, available: false, tool: null, overhead: null };
}

// ── macOS ──────────────────────────────────────────────────────────────

function detectMacOS(): SandboxCapability {
  const available = existsSync('/usr/bin/sandbox-exec');
  return {
    platform: 'darwin',
    available,
    tool: available ? 'sandbox-exec' : null,
    overhead: available ? 'low' : null,
  };
}

// ── Linux ──────────────────────────────────────────────────────────────

function detectLinux(): SandboxCapability {
  const available = binaryExists('bwrap');
  return {
    platform: 'linux',
    available,
    tool: available ? 'bwrap' : null,
    overhead: available ? 'low' : null,
  };
}

// ── Windows ────────────────────────────────────────────────────────────

function detectWindows(): SandboxCapability {
  if (!binaryExists('docker')) {
    return { platform: 'win32', available: false, tool: null, overhead: null };
  }

  if (!dockerDaemonRunning()) {
    return { platform: 'win32', available: false, tool: null, overhead: null };
  }

  return {
    platform: 'win32',
    available: true,
    tool: 'docker',
    overhead: 'medium',
  };
}

// ============================================================================
// Helpers
// ============================================================================

function binaryExists(name: string): boolean {
  try {
    const cmd = platform() === 'win32' ? `where ${name}` : `which ${name}`;
    execSync(cmd, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function dockerDaemonRunning(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Config Resolution
// ============================================================================

/**
 * Resolve sandbox config from moflo.yaml raw data.
 * Handles both snake_case and camelCase keys.
 */
export function resolveSandboxConfig(raw?: Record<string, unknown>): SandboxConfig {
  if (!raw) return DEFAULT_SANDBOX_CONFIG;

  const enabled = raw.enabled;
  const tier = raw.tier;
  const dockerImageRaw = raw.dockerImage ?? raw.docker_image;
  const dockerImage = typeof dockerImageRaw === 'string' && dockerImageRaw.trim().length > 0
    ? dockerImageRaw.trim()
    : undefined;

  return {
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_SANDBOX_CONFIG.enabled,
    tier: isValidTier(tier) ? tier : DEFAULT_SANDBOX_CONFIG.tier,
    ...(dockerImage ? { dockerImage } : {}),
  };
}

function isValidTier(value: unknown): value is SandboxTier {
  return value === 'auto' || value === 'denylist-only' || value === 'full';
}

/**
 * Load sandbox config from a project's moflo.yaml.
 * Returns DEFAULT_SANDBOX_CONFIG on any failure (missing file, parse error, etc.).
 *
 * Lets the spell engine auto-discover sandbox settings from the project root
 * without forcing every caller (MCP tools, CLI adapters) to load moflo.yaml.
 *
 * `MOFLO_SANDBOX_DISABLED=1` short-circuits to disabled config so tests can
 * exercise spell-engine paths without depending on host sandbox capability
 * (e.g. Windows-without-Docker). The override is intentionally undocumented
 * for end users — production callers should set sandbox.enabled in moflo.yaml.
 */
export async function loadSandboxConfigFromProject(projectRoot: string): Promise<SandboxConfig> {
  if (process.env.MOFLO_SANDBOX_DISABLED === '1') {
    return DEFAULT_SANDBOX_CONFIG;
  }
  try {
    const content = readFileSync(join(projectRoot, 'moflo.yaml'), 'utf-8');
    const mod = await import('js-yaml') as YamlModule;
    const yaml = mod.default ?? mod;
    const raw = yaml.load(content) as { sandbox?: Record<string, unknown> } | null;
    return resolveSandboxConfig(raw?.sandbox);
  } catch {
    return DEFAULT_SANDBOX_CONFIG;
  }
}

// ============================================================================
// Effective Sandbox State
// ============================================================================

export interface EffectiveSandbox {
  /** Whether OS-level sandbox should be used for this run. */
  readonly useOsSandbox: boolean;
  /** The detected capability (null if detection was skipped). */
  readonly capability: SandboxCapability;
  /** The resolved config. */
  readonly config: SandboxConfig;
  /** Human-readable status for logging. */
  readonly displayStatus: string;
}

/**
 * Combine detected capability with user config to determine effective sandbox behavior.
 *
 * @param config — resolved user config (enabled + tier)
 * @param capability — optional capability override (for tests; skips OS detection)
 * @returns EffectiveSandbox — includes display status for spell-start logging.
 * @throws Error if tier is 'full' but no OS sandbox is available.
 */
export function resolveEffectiveSandbox(
  config: SandboxConfig,
  capability: SandboxCapability = detectSandboxCapability(),
): EffectiveSandbox {
  let resolved = config;

  // Config disabled or tier is denylist-only => no OS sandbox
  if (!resolved.enabled || resolved.tier === 'denylist-only') {
    return {
      useOsSandbox: false,
      capability,
      config: resolved,
      displayStatus: `OS sandbox: disabled (denylist active)`,
    };
  }

  // Windows: Docker is required for OS sandboxing. If Docker is available,
  // auto-default the image and auto-pull it on first use so the user doesn't
  // have to do manual setup. Only throw if Docker itself isn't installed/running.
  if (capability.platform === 'win32') {
    if (!capability.available) {
      throw new Error(formatWindowsDockerNotReadyMessage());
    }
    const image = resolved.dockerImage || RECOMMENDED_DOCKER_IMAGE;
    if (!resolved.dockerImage) {
      resolved = { ...resolved, dockerImage: image };
    }
    if (!dockerImageExists(image)) {
      dockerPullImage(image);
    }
  }

  // tier: full — require OS sandbox on non-Windows platforms
  if (resolved.tier === 'full' && !capability.available) {
    throw new Error(
      `Sandbox tier "full" requires an OS sandbox but none was detected on ${capability.platform}. ` +
      `Install bubblewrap (Linux) or set sandbox.tier to "auto".`,
    );
  }

  if (!capability.available) {
    return {
      useOsSandbox: false,
      capability,
      config: resolved,
      displayStatus: `OS sandbox: not available (${capability.platform})`,
    };
  }

  return {
    useOsSandbox: true,
    capability,
    config: resolved,
    displayStatus: `OS sandbox: ${capability.tool} (${capability.platform})`,
  };
}

const _imageExistsCache = new Map<string, boolean>();

/**
 * Check whether a Docker image is available locally (already pulled).
 * Result is cached per image name for the process lifetime.
 */
function dockerImageExists(image: string): boolean {
  const cached = _imageExistsCache.get(image);
  if (cached !== undefined) return cached;
  try {
    execSync(`docker image inspect ${escapeShellArg(image)}`, { stdio: 'ignore', timeout: 5000 });
    _imageExistsCache.set(image, true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull a Docker image, printing a one-time setup banner so the user knows
 * what's happening and why. Throws if the pull fails.
 */
function dockerPullImage(image: string): void {
  console.log(
    `[spell] One-time setup: pulling Docker image ${image} for sandboxing...\n` +
    `        This only happens once — Docker caches the image afterwards.`,
  );
  try {
    execSync(`docker pull ${escapeShellArg(image)}`, { stdio: 'inherit', timeout: 300_000 });
    _imageExistsCache.set(image, true);
    console.log(`[spell] Docker image ${image} is ready.`);
  } catch {
    throw new Error(
      `Failed to pull Docker image "${image}".\n\n` +
      'Make sure Docker Desktop is running and you have internet access, then try again.',
    );
  }
}

// ── Beginner-friendly setup messages (Windows) ──────────────────────────

function formatWindowsDockerNotReadyMessage(): string {
  return [
    'Sandboxing is enabled, but Docker Desktop is not ready on this machine.',
    '',
    'Windows sandboxing runs your spell steps inside a Docker container so',
    'they cannot touch the rest of your system. This is a one-time setup:',
    '',
    '  1. Install Docker Desktop (free):',
    '       https://www.docker.com/products/docker-desktop/',
    '',
    '  2. After installing, start Docker Desktop from the Start menu.',
    '     Wait for the whale icon in your system tray to stop animating —',
    '     that means Docker is ready.',
    '',
    `MoFlo will auto-pull the sandbox image (${RECOMMENDED_DOCKER_IMAGE}) on`,
    'the first spell run.',
    '',
    'Not ready to set this up? Turn sandboxing off by setting',
    '`sandbox.enabled: false` in moflo.yaml.',
  ].join('\n');
}


/**
 * Format a one-line log message for spell startup.
 */
export function formatSandboxLog(effective: EffectiveSandbox): string {
  return `[spell] ${effective.displayStatus}`;
}
