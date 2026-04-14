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
import { existsSync } from 'node:fs';
import { platform } from 'node:os';

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
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: false,
  tier: 'auto',
};

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

  return {
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_SANDBOX_CONFIG.enabled,
    tier: isValidTier(tier) ? tier : DEFAULT_SANDBOX_CONFIG.tier,
  };
}

function isValidTier(value: unknown): value is SandboxTier {
  return value === 'auto' || value === 'denylist-only' || value === 'full';
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
 * @returns EffectiveSandbox — includes display status for spell-start logging.
 * @throws Error if tier is 'full' but no OS sandbox is available.
 */
export function resolveEffectiveSandbox(config: SandboxConfig): EffectiveSandbox {
  const capability = detectSandboxCapability();

  // Config disabled or tier is denylist-only => no OS sandbox
  if (!config.enabled || config.tier === 'denylist-only') {
    return {
      useOsSandbox: false,
      capability,
      config,
      displayStatus: `OS sandbox: disabled (denylist active)`,
    };
  }

  // tier: full — require OS sandbox
  if (config.tier === 'full' && !capability.available) {
    throw new Error(
      `Sandbox tier "full" requires an OS sandbox but none was detected on ${capability.platform}. ` +
      `Install bubblewrap (Linux), or Docker Desktop (Windows), or set sandbox.tier to "auto".`,
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
 * Format a one-line log message for spell startup.
 */
export function formatSandboxLog(effective: EffectiveSandbox): string {
  return `[spell] ${effective.displayStatus}`;
}
