/**
 * Workflow Tool Registry
 *
 * Plugin-style registry for workflow tools (external resource connectors).
 * Parallel to StepCommandRegistry — duplicate names are rejected.
 *
 * Discovery priority (highest to lowest):
 * 1. User project: `workflows/tools/` or `.claude/workflows/tools/`
 * 2. Shipped: `src/packages/workflows/tools/` (bundled with moflo)
 * 3. npm packages: `moflo-tool-*` naming convention
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  WorkflowTool,
  ToolRegistryEntry,
  ToolSource,
} from '../types/workflow-tool.types.js';

// ============================================================================
// Types
// ============================================================================

export interface ToolRegistryOptions {
  /** Shipped tools directory (bundled with moflo). */
  readonly shippedDir?: string;
  /** User tool directories (project-level overrides). */
  readonly userDirs?: readonly string[];
  /** Project root for npm package scanning (looks for node_modules/moflo-tool-*). */
  readonly projectRoot?: string;
}

export interface ToolScanResult {
  readonly registered: number;
  readonly errors: ToolScanError[];
}

export interface ToolScanError {
  readonly file: string;
  readonly message: string;
}

// ============================================================================
// Validation
// ============================================================================

function isValidTool(obj: unknown): obj is WorkflowTool {
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
// Tool Registry
// ============================================================================

export class WorkflowToolRegistry {
  private readonly tools = new Map<string, ToolRegistryEntry>();
  private readonly options: ToolRegistryOptions;

  constructor(options: ToolRegistryOptions = {}) {
    this.options = options;
  }

  /** @throws if a tool with the same name is already registered. */
  register(tool: WorkflowTool, source: ToolSource = 'shipped'): void {
    if (!isValidTool(tool)) {
      throw new Error('Object does not implement WorkflowTool interface');
    }

    if (this.tools.has(tool.name)) {
      throw new Error(
        `Workflow tool "${tool.name}" is already registered`
      );
    }

    this.tools.set(tool.name, {
      tool,
      source,
      registeredAt: new Date(),
    });
  }

  /** @returns true if removed, false if not found. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): WorkflowTool | undefined {
    return this.tools.get(name)?.tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolRegistryEntry[] {
    return Array.from(this.tools.values());
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }

  get size(): number {
    return this.tools.size;
  }

  clear(): void {
    this.tools.clear();
  }

  /**
   * Scan directories for tool files and register them.
   * User tools override shipped tools by name.
   */
  async scan(): Promise<ToolScanResult> {
    const errors: ToolScanError[] = [];
    let registered = 0;

    // Collect tools: shipped first, then user (user overrides shipped)
    const candidates: Array<{ file: string; source: ToolSource }> = [];

    if (this.options.shippedDir) {
      for (const file of listToolFiles(this.options.shippedDir)) {
        candidates.push({ file, source: 'shipped' });
      }
    }

    if (this.options.userDirs) {
      for (const dir of this.options.userDirs) {
        for (const file of listToolFiles(dir)) {
          candidates.push({ file, source: 'user' });
        }
      }
    }

    // Scan npm packages (lowest priority)
    if (this.options.projectRoot) {
      for (const entry of discoverNpmTools(this.options.projectRoot)) {
        if (entry.ok) {
          candidates.push({ file: entry.file, source: 'npm' });
        } else {
          errors.push(entry.error);
        }
      }
    }

    // Import, validate, and resolve priority in a single pass
    const byName = new Map<string, { tool: WorkflowTool; source: ToolSource }>();
    const SOURCE_PRIORITY: Record<string, number> = { npm: 0, shipped: 1, user: 2 };

    for (const candidate of candidates) {
      try {
        const mod = await import(candidate.file);
        const tool = mod.default ?? mod;

        if (!isValidTool(tool)) {
          errors.push({ file: candidate.file, message: 'Does not implement WorkflowTool interface' });
          continue;
        }

        const existing = byName.get(tool.name);
        if (existing && (SOURCE_PRIORITY[candidate.source] ?? 0) <= (SOURCE_PRIORITY[existing.source] ?? 0)) {
          continue;
        }
        byName.set(tool.name, { tool, source: candidate.source });
      } catch (err) {
        errors.push({
          file: candidate.file,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Register resolved tools (skip any already registered programmatically)
    for (const [, { tool, source }] of byName) {
      if (this.tools.has(tool.name)) continue;
      this.tools.set(tool.name, { tool, source, registeredAt: new Date() });
      registered++;
    }

    return { registered, errors };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function listToolFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  try {
    return fs.readdirSync(dir)
      .filter(f => /\.(ts|js|mts|mjs)$/.test(f) && !f.endsWith('.d.ts') && f !== 'index.ts' && f !== 'index.js')
      .map(f => path.resolve(dir, f));
  } catch {
    return [];
  }
}

type NpmToolDiscovery =
  | { ok: true; file: string }
  | { ok: false; error: ToolScanError };

/**
 * Scan node_modules for moflo-tool-* packages.
 * Each package can declare a `moflo-tool` field in package.json
 * pointing to the tool entry file, or fall back to `main`/`exports`.
 */
function discoverNpmTools(projectRoot: string): NpmToolDiscovery[] {
  const nodeModules = path.join(projectRoot, 'node_modules');
  if (!fs.existsSync(nodeModules)) return [];

  const results: NpmToolDiscovery[] = [];

  try {
    const dirs = fs.readdirSync(nodeModules);
    for (const dir of dirs) {
      if (!dir.startsWith('moflo-tool-')) continue;

      const pkgJsonPath = path.join(nodeModules, dir, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) {
        results.push({ ok: false, error: { file: pkgJsonPath, message: 'Missing package.json' } });
        continue;
      }

      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        // Prefer moflo-tool field, fall back to main/exports
        const entryPoint = pkgJson['moflo-tool'] ?? pkgJson.main ?? 'index.js';
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
