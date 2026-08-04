/**
 * CLI JSON config store — the file behind `flo config init|get|set|reset|
 * export|import|providers`, and the file the healer's `Config File` check
 * looks for.
 *
 * Two neighbouring config surfaces exist; this module is deliberately none of
 * them:
 *   - `src/cli/config/moflo-config.ts` owns **moflo.yaml** (gates, sdd,
 *     daemon, memory backend). `flo config show|generate` operate on that.
 *   - `src/cli/shared/core/config/loader.ts` owns the `SystemConfig` schema
 *     loaded from bare `moflo.config.json`-style files in cwd / `~/.moflo`.
 *
 * This module owns the project-local `.moflo/config.json` — the first entry in
 * the doctor's `Config File` candidate list and the path its auto-fix creates.
 *
 * Before this module existed the whole `flo config` family was display-only:
 * `init` printed "Creating claude-flow.config.json..." and returned
 * `success: true` without a single filesystem call, so `flo doctor --fix`
 * reported the `Config File` warning as fixed on every run while the warning
 * never cleared. Same defect class as the synthetic MCP responses labelled at
 * the call site in #1324/#1325: a success report for work that never happened.
 *
 * @module moflo/cli/config/cli-config-store
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../shared/utils/atomic-file-write.js';
import { mofloDir } from '../services/moflo-paths.js';

/** A configured AI provider entry. */
export interface CliConfigProvider {
  name: string;
  model?: string;
  priority: number;
  enabled: boolean;
}

/** Shape of `.moflo/config.json`. */
export interface CliConfig {
  version: string;
  v3Mode: boolean;
  sparc: boolean;
  agents: {
    defaultType: string;
    maxConcurrent: number;
    autoSpawn: boolean;
    timeout: number;
  };
  swarm: {
    topology: string;
    maxAgents: number;
    autoScale: boolean;
    coordinationStrategy: string;
  };
  memory: {
    backend: string;
    path: string;
    cacheSize: number;
    enableHNSW: boolean;
  };
  mcp: {
    transport: string;
    autoStart: boolean;
    tools: string;
  };
  providers: CliConfigProvider[];
}

/**
 * Candidate filenames, canonical first. Mirrors the list in
 * `doctor-checks-config.ts:checkConfigFile` so the healer's check and this
 * store never disagree about whether a config exists — the mismatch that let
 * the old auto-fix "succeed" against a file the check couldn't see.
 *
 * `claude-flow.*` entries are LEGACY-CONFIG: pre-#699 names, still read so
 * consumers upgrading from older moflo builds keep their existing file.
 */
export const CLI_CONFIG_CANDIDATES = [
  join('.moflo', 'config.json'),
  'moflo.config.json',
  'claude-flow.config.json', // LEGACY-CONFIG: pre-#699 fallback
  '.claude-flow.json',       // LEGACY-CONFIG: pre-#699 fallback
] as const;

/** Absolute path of the canonical config file for a project root. */
export function cliConfigPath(projectRoot: string): string {
  return join(mofloDir(projectRoot), 'config.json');
}

/**
 * Absolute path of the config file that actually exists, canonical first, or
 * `null` when the project has none.
 */
export function findCliConfigFile(projectRoot: string): string | null {
  for (const candidate of CLI_CONFIG_CANDIDATES) {
    const path = join(projectRoot, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Default configuration. Values match what `flo config` reported pre-fix. */
export function defaultCliConfig(opts: { v3?: boolean; sparc?: boolean } = {}): CliConfig {
  return {
    version: '3.0.0',
    v3Mode: opts.v3 ?? true,
    sparc: opts.sparc ?? false,
    agents: {
      defaultType: 'coder',
      maxConcurrent: 15,
      autoSpawn: true,
      timeout: 300,
    },
    swarm: {
      topology: 'hybrid',
      maxAgents: 15,
      autoScale: true,
      coordinationStrategy: 'consensus',
    },
    memory: {
      backend: 'hybrid',
      path: './data/memory',
      cacheSize: 256,
      enableHNSW: true,
    },
    mcp: {
      transport: 'stdio',
      autoStart: true,
      tools: 'all',
    },
    providers: [
      { name: 'anthropic', model: 'claude-sonnet-5', priority: 1, enabled: true },
      { name: 'openrouter', model: 'claude-sonnet-5', priority: 2, enabled: false },
      { name: 'ollama', model: 'llama3.2', priority: 3, enabled: false },
      { name: 'gemini', model: 'gemini-2.0-flash', priority: 4, enabled: false },
    ],
  };
}

/** Thrown when a config file exists but cannot be parsed. */
export class CliConfigParseError extends Error {
  constructor(public readonly path: string, cause: unknown) {
    super(`Invalid JSON in ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'CliConfigParseError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merge `patch` over `base`. Arrays are replaced wholesale, not merged. */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  if (!isPlainObject(base)) return patch as T;

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const current = result[key];
    result[key] = isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : value;
  }
  return result as T;
}

/**
 * Load the project's config, merged over defaults. `path` is `null` when no
 * file exists — callers get usable defaults either way, and can tell the
 * difference.
 *
 * @throws {CliConfigParseError} when a config file exists but is not valid JSON.
 */
export function loadCliConfig(projectRoot: string): { config: CliConfig; path: string | null } {
  const path = findCliConfigFile(projectRoot);
  if (!path) return { config: defaultCliConfig(), path: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new CliConfigParseError(path, err);
  }
  return { config: deepMerge(defaultCliConfig(), parsed), path };
}

/**
 * Write `config` and return the path written. Writes to the existing file when
 * there is one (so a consumer's root-level `moflo.config.json` keeps being the
 * file they edit), otherwise creates the canonical `.moflo/config.json`.
 */
export function saveCliConfig(
  projectRoot: string,
  config: CliConfig,
  opts: { path?: string } = {},
): string {
  const target = opts.path ?? findCliConfigFile(projectRoot) ?? cliConfigPath(projectRoot);
  writeJsonFile(target, config);
  return target;
}

/** Write `content` to `path` atomically, creating parent dirs as needed. */
export function writeTextFile(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(path, content);
}

/** Serialize `value` as pretty JSON to `path`, creating parent dirs. */
export function writeJsonFile(path: string, value: unknown): void {
  writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Split a dot-notation key, rejecting prototype-polluting segments. */
function splitKey(key: string): string[] | null {
  const segments = key.split('.').filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  if (segments.some((s) => s === '__proto__' || s === 'constructor' || s === 'prototype')) return null;
  return segments;
}

/**
 * Read a dot-notation key (`swarm.topology`, `providers.0.enabled`).
 * `found: false` for keys the config does not define.
 */
export function getConfigValue(config: CliConfig, key: string): { found: boolean; value?: unknown } {
  const segments = splitKey(key);
  if (!segments) return { found: false };

  let current: unknown = config;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return { found: false };
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false };
      current = current[index];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return { found: true, value: current };
}

/**
 * Coerce a CLI string to the type of the value already at that key, so
 * `flo config set swarm.maxAgents 20` stores the number 20, not "20".
 */
function coerceValue(raw: string, current: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof current === 'number') {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return { ok: false, error: `expected a number, got "${raw}"` };
    return { ok: true, value: parsed };
  }
  if (typeof current === 'boolean') {
    if (/^(true|1|yes|on)$/i.test(raw)) return { ok: true, value: true };
    if (/^(false|0|no|off)$/i.test(raw)) return { ok: true, value: false };
    return { ok: false, error: `expected a boolean, got "${raw}"` };
  }
  if (typeof current === 'object' && current !== null) {
    return { ok: false, error: 'is a section, not a value — set one of its keys instead' };
  }
  return { ok: true, value: raw };
}

/**
 * Set a dot-notation key in place. Rejects keys the config does not already
 * define — a typo should fail loudly, not silently create a key nothing reads.
 */
export function setConfigValue(
  config: CliConfig,
  key: string,
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const segments = splitKey(key);
  if (!segments) return { ok: false, error: `invalid key: "${key}"` };

  const existing = getConfigValue(config, key);
  if (!existing.found) return { ok: false, error: `unknown key: ${key}` };

  const coerced = coerceValue(raw, existing.value);
  if (!coerced.ok) return coerced;

  const parentSegments = segments.slice(0, -1);
  const leaf = segments[segments.length - 1];
  const parent = parentSegments.length === 0
    ? { found: true, value: config as unknown }
    : getConfigValue(config, parentSegments.join('.'));
  if (!parent.found || parent.value === null || typeof parent.value !== 'object') {
    return { ok: false, error: `unknown key: ${key}` };
  }

  if (Array.isArray(parent.value)) {
    (parent.value as unknown[])[Number(leaf)] = coerced.value;
  } else {
    (parent.value as Record<string, unknown>)[leaf] = coerced.value;
  }
  return { ok: true, value: coerced.value };
}

/** Flatten to dotted leaf keys for tabular display. */
export function flattenConfig(value: unknown, prefix = ''): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  if (Array.isArray(value)) {
    value.forEach((item, index) => Object.assign(flat, flattenConfig(item, `${prefix}${index}.`)));
    return flat;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      Object.assign(flat, flattenConfig(child, `${prefix}${key}.`));
    }
    return flat;
  }
  flat[prefix.replace(/\.$/, '')] = value;
  return flat;
}

/** Config sections `flo config reset --section` accepts. */
export const RESETTABLE_SECTIONS = ['agents', 'swarm', 'memory', 'mcp', 'providers', 'all'] as const;
export type ResettableSection = (typeof RESETTABLE_SECTIONS)[number];

/** Return `config` with `section` (or everything) restored to defaults. */
export function resetSection(config: CliConfig, section: ResettableSection): CliConfig {
  const defaults = defaultCliConfig({ v3: config.v3Mode, sparc: config.sparc });
  if (section === 'all') return defaults;
  return { ...config, [section]: defaults[section] } as CliConfig;
}
