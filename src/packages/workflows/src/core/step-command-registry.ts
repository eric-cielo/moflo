/**
 * Step Command Registry
 *
 * Plugin-style registry for workflow step commands.
 * Uses source-based priority: user > built-in > npm.
 */

import type {
  StepCommand,
  StepCommandEntry,
  StepCommandSource,
} from '../types/step-command.types.js';
import type { DirectoryLoadWarning } from '../loaders/directory-step-loader.js';
import { loadStepsFromDirectories } from '../loaders/directory-step-loader.js';
import { loadStepsFromNpm } from '../loaders/npm-step-loader.js';

// ============================================================================
// Priority
// ============================================================================

const SOURCE_PRIORITY: Record<StepCommandSource, number> = {
  npm: 0,
  'built-in': 1,
  user: 2,
};

// ============================================================================
// Step Command Registry
// ============================================================================

export class StepCommandRegistry {
  private readonly commands = new Map<string, StepCommandEntry>();
  /** Optional debug logger. Set to receive override notifications. */
  debugLog?: (message: string) => void;

  private static assertValidType(command: StepCommand): void {
    if (!command.type || typeof command.type !== 'string') {
      throw new Error('StepCommand must have a non-empty string type');
    }
  }

  /** @throws if a command with the same type is already registered at equal or higher priority. */
  register(command: StepCommand, source: StepCommandSource = 'built-in'): void {
    StepCommandRegistry.assertValidType(command);
    const existing = this.commands.get(command.type);
    if (existing && SOURCE_PRIORITY[existing.source] >= SOURCE_PRIORITY[source]) {
      throw new Error(
        `Step command type "${command.type}" is already registered (source: ${existing.source})`
      );
    }
    this.commands.set(command.type, {
      command,
      source,
      registeredAt: new Date(),
    });
  }

  /** @returns true if removed, false if not found. */
  unregister(type: string): boolean {
    return this.commands.delete(type);
  }

  get(type: string): StepCommand | undefined {
    return this.commands.get(type)?.command;
  }

  getEntry(type: string): StepCommandEntry | undefined {
    return this.commands.get(type);
  }

  has(type: string): boolean {
    return this.commands.has(type);
  }

  list(): StepCommandEntry[] {
    return Array.from(this.commands.values());
  }

  types(): string[] {
    return Array.from(this.commands.keys());
  }

  get size(): number {
    return this.commands.size;
  }

  clear(): void {
    this.commands.clear();
  }

  /**
   * Register or replace a command, but only if the new source has equal or
   * higher priority than the existing one. This prevents npm steps from
   * overriding built-in or user steps regardless of loading order.
   */
  registerOrReplace(command: StepCommand, source: StepCommandSource = 'npm'): void {
    StepCommandRegistry.assertValidType(command);

    const existing = this.commands.get(command.type);
    if (existing) {
      if (SOURCE_PRIORITY[source] < SOURCE_PRIORITY[existing.source]) {
        return;
      }
      if (this.debugLog) {
        this.debugLog(
          `Step "${command.type}" overridden: ${existing.source} → ${source}`,
        );
      }
    }

    this.commands.set(command.type, {
      command,
      source,
      registeredAt: new Date(),
    });
  }

  /**
   * Scan directories for JS/TS files exporting StepCommand implementations
   * and register them. User steps override built-in and npm commands.
   *
   * @returns warnings from files that could not be loaded.
   */
  loadFromDirectories(dirs: readonly string[]): DirectoryLoadWarning[] {
    const result = loadStepsFromDirectories({ dirs });
    for (const [, discovered] of result.steps) {
      this.registerOrReplace(discovered.command, 'user');
    }
    return result.warnings as DirectoryLoadWarning[];
  }

  /**
   * Scan node_modules for `moflo-step-*` packages and register their exports.
   * npm steps have lowest priority — they cannot override built-in or user steps.
   *
   * @returns warnings from packages that could not be loaded.
   */
  loadFromNpm(projectRoot: string): DirectoryLoadWarning[] {
    const result = loadStepsFromNpm(projectRoot);
    for (const [, discovered] of result.steps) {
      this.registerOrReplace(discovered.command, 'npm');
    }
    return result.warnings as DirectoryLoadWarning[];
  }
}
