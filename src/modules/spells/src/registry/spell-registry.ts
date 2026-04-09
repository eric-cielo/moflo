/**
 * Spell Registry
 *
 * Maps spell names AND abbreviations to loaded spell definitions.
 * Wraps the definition-loader with abbreviation-based lookup, collision
 * detection, and list/info capabilities.
 *
 * Story #105: Spell Registry + /flo -wf Integration
 */

import { loadSpellDefinitions } from '../loaders/definition-loader.js';
import type { LoaderOptions, LoadedSpell, LoadError } from '../loaders/definition-loader.js';
import type { SpellDefinition, ArgumentDefinition, StepDefinition } from '../types/spell-definition.types.js';

// ============================================================================
// Types
// ============================================================================

export interface RegistryOptions extends LoaderOptions {
  /** Additional directories to scan (convenience alias for userDirs). */
  readonly extraDirs?: readonly string[];
}

export interface RegistryResult {
  readonly spells: ReadonlyMap<string, LoadedSpell>;
  readonly abbreviations: ReadonlyMap<string, string>;
  readonly collisions: readonly AbbreviationCollision[];
  readonly errors: readonly LoadError[];
}

export interface AbbreviationCollision {
  readonly abbreviation: string;
  readonly spells: readonly string[];
}

export interface SpellInfo {
  readonly name: string;
  readonly abbreviation?: string;
  readonly description?: string;
  readonly version?: string;
  readonly sourceFile: string;
  readonly tier: 'shipped' | 'user';
  readonly arguments: Record<string, ArgumentDefinition>;
  readonly stepCount: number;
  readonly stepTypes: readonly string[];
}

export interface SpellListEntry {
  readonly name: string;
  readonly abbreviation?: string;
  readonly description?: string;
  readonly tier: 'shipped' | 'user';
}

// ============================================================================
// Registry
// ============================================================================

export class Grimoire {
  private readonly loaderOptions: LoaderOptions;
  private cachedResult: RegistryResult | null = null;

  constructor(options: RegistryOptions = {}) {
    const userDirs = [
      ...(options.userDirs ?? []),
      ...(options.extraDirs ?? []),
    ];
    this.loaderOptions = {
      shippedDir: options.shippedDir,
      userDirs,
      knownStepTypes: options.knownStepTypes,
      skipValidation: options.skipValidation,
    };
  }

  /**
   * Load and index all spell definitions.
   * Builds the abbreviation map and detects collisions.
   */
  load(): RegistryResult {
    const { spells, errors } = loadSpellDefinitions(this.loaderOptions);
    const abbreviations = new Map<string, string>();
    const collisionMap = new Map<string, string[]>();

    for (const [name, loaded] of spells) {
      const abbr = loaded.definition.abbreviation;
      if (!abbr) continue;

      if (collisionMap.has(abbr)) {
        collisionMap.get(abbr)!.push(name);
      } else if (abbreviations.has(abbr)) {
        const existing = abbreviations.get(abbr)!;
        collisionMap.set(abbr, [existing, name]);
        abbreviations.delete(abbr);
      } else {
        abbreviations.set(abbr, name);
      }
    }

    const collisions: AbbreviationCollision[] = [];
    for (const [abbreviation, names] of collisionMap) {
      collisions.push({ abbreviation, spells: names });
    }

    this.cachedResult = { spells, abbreviations, collisions, errors };
    return this.cachedResult;
  }

  /**
   * Resolve a query (abbreviation OR full name) to a loaded spell.
   * Returns undefined if no match is found.
   */
  resolve(query: string): LoadedSpell | undefined {
    const result = this.cachedResult ?? this.load();

    // Try full name first
    const byName = result.spells.get(query);
    if (byName) return byName;

    // Try abbreviation
    const fullName = result.abbreviations.get(query);
    if (fullName) return result.spells.get(fullName);

    return undefined;
  }

  /**
   * List all registered spells (name, abbreviation, description, tier).
   */
  list(): readonly SpellListEntry[] {
    const result = this.cachedResult ?? this.load();
    const entries: SpellListEntry[] = [];

    for (const [, loaded] of result.spells) {
      entries.push({
        name: loaded.definition.name,
        abbreviation: loaded.definition.abbreviation,
        description: loaded.definition.description,
        tier: loaded.tier,
      });
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get detailed info about a specific spell (by name or abbreviation).
   */
  info(query: string): SpellInfo | undefined {
    const loaded = this.resolve(query);
    if (!loaded) return undefined;

    const def = loaded.definition;
    const { count, types } = analyzeSteps(def.steps);

    return {
      name: def.name,
      abbreviation: def.abbreviation,
      description: def.description,
      version: def.version,
      sourceFile: loaded.sourceFile,
      tier: loaded.tier,
      arguments: def.arguments ?? {},
      stepCount: count,
      stepTypes: [...types].sort(),
    };
  }

  /**
   * Invalidate the cached load result, forcing a re-scan on next access.
   */
  invalidate(): void {
    this.cachedResult = null;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Single-pass step analysis: counts steps and collects unique types. */
function analyzeSteps(
  steps: readonly StepDefinition[],
  types: Set<string> = new Set(),
): { count: number; types: Set<string> } {
  let count = 0;
  for (const step of steps) {
    count++;
    types.add(step.type);
    if (step.steps) {
      count += analyzeSteps(step.steps, types).count;
    }
  }
  return { count, types };
}
