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
   * Docker image for Windows sandboxing (required when `tool === 'docker'`).
   *
   * No default on purpose — the user picks an image so the pull is explicit.
   * Recommended: `node:20-bookworm-slim` (ships node + npm; claude, gh, git
   * install cleanly on top).
   *
   * See the setup instructions emitted when this is missing.
   */
  readonly dockerImage?: string;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: false,
  tier: 'auto',
};

/** Recommended image for first-time Windows Docker sandbox setup. */
export const RECOMMENDED_DOCKER_IMAGE = 'node:20-bookworm-slim';

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
 */
export async function loadSandboxConfigFromProject(projectRoot: string): Promise<SandboxConfig> {
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

  // Config disabled or tier is denylist-only => no OS sandbox
  if (!config.enabled || config.tier === 'denylist-only') {
    return {
      useOsSandbox: false,
      capability,
      config,
      displayStatus: `OS sandbox: disabled (denylist active)`,
    };
  }

  // Windows: give beginner-friendly setup instructions when sandboxing is
  // enabled but Docker isn't ready. Runs before the generic "not available"
  // branch so Windows users see actionable guidance instead of a terse
  // "not available (win32)" message.
  if (capability.platform === 'win32') {
    if (!capability.available) {
      throw new Error(formatWindowsDockerNotReadyMessage());
    }
    if (!config.dockerImage) {
      throw new Error(formatWindowsDockerImageMissingMessage());
    }
    if (!dockerImageExists(config.dockerImage)) {
      throw new Error(formatWindowsDockerImageNotPulledMessage(config.dockerImage));
    }
  }

  // tier: full — require OS sandbox on non-Windows platforms
  if (config.tier === 'full' && !capability.available) {
    throw new Error(
      `Sandbox tier "full" requires an OS sandbox but none was detected on ${capability.platform}. ` +
      `Install bubblewrap (Linux) or set sandbox.tier to "auto".`,
    );
  }

  if (!capability.available) {
    return {
      useOsSandbox: false,
      capability,
      config,
      displayStatus: `OS sandbox: not available (${capability.platform})`,
    };
  }

  return {
    useOsSandbox: true,
    capability,
    config,
    displayStatus: `OS sandbox: ${capability.tool} (${capability.platform})`,
  };
}

/**
 * Check whether a Docker image is available locally (already pulled).
 * Returns false on any error (daemon down, image missing, docker not in PATH).
 */
function dockerImageExists(image: string): boolean {
  try {
    execSync(`docker image inspect ${shellQuote(image)}`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Minimal shell quoting for image names — keeps the execSync call safe. */
function shellQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
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
    '  3. Open PowerShell (or any terminal) and pull the recommended image:',
    `       docker pull ${RECOMMENDED_DOCKER_IMAGE}`,
    '',
    '  4. Add this to your moflo.yaml:',
    '       sandbox:',
    '         enabled: true',
    `         dockerImage: ${RECOMMENDED_DOCKER_IMAGE}`,
    '',
    'Not ready to set this up? You can turn sandboxing off instead by setting',
    '`sandbox.enabled: false` in moflo.yaml.',
  ].join('\n');
}

function formatWindowsDockerImageMissingMessage(): string {
  return [
    'Sandboxing is enabled, but no Docker image is configured.',
    '',
    'Docker is ready on this machine — it just needs to know which image to',
    'run your spell steps inside. This is a one-time setup:',
    '',
    '  1. Open PowerShell (or any terminal) and pull the recommended image:',
    `       docker pull ${RECOMMENDED_DOCKER_IMAGE}`,
    '',
    '  2. Add this to your moflo.yaml:',
    '       sandbox:',
    '         enabled: true',
    `         dockerImage: ${RECOMMENDED_DOCKER_IMAGE}`,
    '',
    `The recommended image (${RECOMMENDED_DOCKER_IMAGE}) includes node, npm,`,
    'bash, git, and curl. Any image with bash will work.',
  ].join('\n');
}

function formatWindowsDockerImageNotPulledMessage(image: string): string {
  return [
    `Sandboxing is enabled, but the Docker image "${image}" is not available`,
    'on this machine yet.',
    '',
    'To fix this, open PowerShell (or any terminal) and run:',
    `       docker pull ${image}`,
    '',
    'This only needs to happen once — Docker caches the image afterwards.',
    '',
    'If Docker Desktop is not running, start it from the Start menu first',
    'and wait for the whale icon in your system tray to stop animating.',
  ].join('\n');
}

/**
 * Format a one-line log message for spell startup.
 */
export function formatSandboxLog(effective: EffectiveSandbox): string {
  return `[spell] ${effective.displayStatus}`;
}
