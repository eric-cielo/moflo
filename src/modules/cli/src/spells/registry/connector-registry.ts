/**
 * Spell Connector Registry
 *
 * Plugin-style registry for spell connectors (external resource bridges).
 * Parallel to StepCommandRegistry — duplicate names are rejected.
 *
 * Discovery priority (highest to lowest):
 * 1. User project: `spells/connectors/` or `.claude/spells/connectors/`
 * 2. Shipped: `src/modules/cli/src/spells/connectors/` (bundled with moflo)
 * 3. npm packages: `moflo-connector-*` naming convention
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  SpellConnector,
  ConnectorRegistryEntry,
  ConnectorSource,
} from '../types/spell-connector.types.js';

// ============================================================================
// Types
// ============================================================================

export interface ConnectorRegistryOptions {
  /** Shipped connectors directory (bundled with moflo). */
  readonly shippedDir?: string;
  /** User connector directories (project-level overrides). */
  readonly userDirs?: readonly string[];
  /** Project root for npm package scanning (looks for node_modules/moflo-connector-*). */
  readonly projectRoot?: string;
}

export interface ConnectorScanResult {
  readonly registered: number;
  readonly errors: ConnectorScanError[];
}

export interface ConnectorScanError {
  readonly file: string;
  readonly message: string;
}

// ============================================================================
// Validation
// ============================================================================

function isValidConnector(obj: unknown): obj is SpellConnector {
  if (!obj || typeof obj !== 'object') return false;
  const t = obj as Record<string, unknown>;
  return (
    typeof t.name === 'string' && t.name.length > 0 &&
    typeof t.description === 'string' &&
    typeof t.version === 'string' &&
    Array.isArray(t.capabilities) &&
    typeof t.initialize === 'function' &&
    typeof t.dispose === 'function' &&
    typeof t.execute === 'function' &&
    typeof t.listActions === 'function'
  );
}

// ============================================================================
// Connector Registry
// ============================================================================

export class SpellConnectorRegistry {
  private readonly connectors = new Map<string, ConnectorRegistryEntry>();
  private readonly options: ConnectorRegistryOptions;

  constructor(options: ConnectorRegistryOptions = {}) {
    this.options = options;
  }

  /** @throws if a connector with the same name is already registered. */
  register(connector: SpellConnector, source: ConnectorSource = 'shipped'): void {
    if (!isValidConnector(connector)) {
      throw new Error('Object does not implement SpellConnector interface');
    }

    if (this.connectors.has(connector.name)) {
      throw new Error(
        `Spell connector "${connector.name}" is already registered`
      );
    }

    this.connectors.set(connector.name, {
      connector,
      source,
      registeredAt: new Date(),
    });
  }

  /** @returns true if removed, false if not found. */
  unregister(name: string): boolean {
    return this.connectors.delete(name);
  }

  get(name: string): SpellConnector | undefined {
    return this.connectors.get(name)?.connector;
  }

  has(name: string): boolean {
    return this.connectors.has(name);
  }

  list(): ConnectorRegistryEntry[] {
    return Array.from(this.connectors.values());
  }

  names(): string[] {
    return Array.from(this.connectors.keys());
  }

  get size(): number {
    return this.connectors.size;
  }

  clear(): void {
    this.connectors.clear();
  }

  /**
   * Scan directories for connector files and register them.
   * User connectors override shipped connectors by name.
   */
  async scan(): Promise<ConnectorScanResult> {
    const errors: ConnectorScanError[] = [];
    let registered = 0;

    // Collect connectors: shipped first, then user (user overrides shipped)
    const candidates: Array<{ file: string; source: ConnectorSource }> = [];

    if (this.options.shippedDir) {
      for (const file of listConnectorFiles(this.options.shippedDir)) {
        candidates.push({ file, source: 'shipped' });
      }
    }

    if (this.options.userDirs) {
      for (const dir of this.options.userDirs) {
        for (const file of listConnectorFiles(dir)) {
          candidates.push({ file, source: 'user' });
        }
      }
    }

    // Scan npm packages (lowest priority)
    if (this.options.projectRoot) {
      for (const entry of discoverNpmConnectors(this.options.projectRoot)) {
        if (entry.ok) {
          candidates.push({ file: entry.file, source: 'npm' });
        } else {
          errors.push(entry.error);
        }
      }
    }

    // Import, validate, and resolve priority in a single pass
    const byName = new Map<string, { connector: SpellConnector; source: ConnectorSource }>();
    const SOURCE_PRIORITY: Record<ConnectorSource, number> = { npm: 0, shipped: 1, user: 2 };

    for (const candidate of candidates) {
      try {
        if (!(candidate.source in SOURCE_PRIORITY)) {
          errors.push({ file: candidate.file, message: `Unknown ConnectorSource: "${candidate.source}"` });
          continue;
        }

        const mod = await import(candidate.file);
        const connector = mod.default ?? mod;

        if (!isValidConnector(connector)) {
          errors.push({ file: candidate.file, message: 'Does not implement SpellConnector interface' });
          continue;
        }

        const existing = byName.get(connector.name);
        if (existing && SOURCE_PRIORITY[candidate.source] <= SOURCE_PRIORITY[existing.source]) {
          continue;
        }
        byName.set(connector.name, { connector, source: candidate.source });
      } catch (err) {
        errors.push({
          file: candidate.file,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Register resolved connectors (skip any already registered programmatically)
    for (const [, { connector, source }] of byName) {
      if (this.connectors.has(connector.name)) continue;
      this.connectors.set(connector.name, { connector, source, registeredAt: new Date() });
      registered++;
    }

    return { registered, errors };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function listConnectorFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  try {
    return fs.readdirSync(dir)
      .filter(f => /\.(ts|js|mts|mjs)$/.test(f) && !f.endsWith('.d.ts') && f !== 'index.ts' && f !== 'index.js')
      .map(f => path.resolve(dir, f));
  } catch {
    return [];
  }
}

type NpmConnectorDiscovery =
  | { ok: true; file: string }
  | { ok: false; error: ConnectorScanError };

/**
 * Scan node_modules for moflo-connector-* packages.
 * Each package can declare a `moflo-connector` field in package.json
 * pointing to the connector entry file, or fall back to `main`/`exports`.
 */
function discoverNpmConnectors(projectRoot: string): NpmConnectorDiscovery[] {
  const nodeModules = path.join(projectRoot, 'node_modules');
  if (!fs.existsSync(nodeModules)) return [];

  const results: NpmConnectorDiscovery[] = [];

  try {
    const dirs = fs.readdirSync(nodeModules);
    for (const dir of dirs) {
      if (!dir.startsWith('moflo-connector-')) continue;

      const pkgJsonPath = path.join(nodeModules, dir, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) {
        results.push({ ok: false, error: { file: pkgJsonPath, message: 'Missing package.json' } });
        continue;
      }

      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        // Prefer moflo-connector field, fall back to main/exports
        const entryPoint = pkgJson['moflo-connector'] ?? pkgJson.main ?? 'index.js';
        const entryFile = path.resolve(nodeModules, dir, entryPoint);

        if (!fs.existsSync(entryFile)) {
          results.push({ ok: false, error: { file: entryFile, message: `Entry point not found: ${entryPoint}` } });
          continue;
        }

        results.push({ ok: true, file: entryFile });
      } catch (err) {
        results.push({
          ok: false,
          error: {
            file: pkgJsonPath,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  } catch {
    // node_modules unreadable — silently skip
  }

  return results;
}
