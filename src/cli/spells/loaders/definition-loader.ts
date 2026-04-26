/**
 * Spell Definition Loader
 *
 * Two-tier definition system:
 *   Tier 1 — Shipped definitions bundled with moflo (read-only defaults)
 *   Tier 2 — User definitions at configurable project path (override by name)
 *
 * Resolution: load shipped first, then user. User definitions with the same
 * name replace shipped ones; new names are additive.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { parseSpell } from '../schema/parser.js';
import { validateSpellDefinition } from '../schema/validator.js';
import type { SpellDefinition, ParsedSpell } from '../types/spell-definition.types.js';

// ============================================================================
// Types
// ============================================================================

export interface LoaderOptions {
  /** Shipped definitions directory (absolute path). */
  readonly shippedDir?: string;
  /** User definition directories (absolute paths), searched in order. */
  readonly userDirs?: readonly string[];
  /** Step types known to the registry (passed to validator). */
  readonly knownStepTypes?: readonly string[];
  /** If true, skip validation (useful for testing). */
  readonly skipValidation?: boolean;
}

export interface LoadedSpell {
  readonly definition: SpellDefinition;
  readonly sourceFile: string;
  readonly tier: 'shipped' | 'user';
}

export interface LoadResult {
  readonly spells: Map<string, LoadedSpell>;
  readonly errors: readonly LoadError[];
}

export interface LoadError {
  readonly file: string;
  readonly message: string;
}

// ============================================================================
// Loader
// ============================================================================

const SPELL_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

/**
 * Load spell definitions from shipped + user directories.
 * User definitions override shipped ones by spell name match.
 */
export function loadSpellDefinitions(options: LoaderOptions = {}): LoadResult {
  const spells = new Map<string, LoadedSpell>();
  const errors: LoadError[] = [];

  // Tier 1: Shipped definitions (lowest priority)
  if (options.shippedDir) {
    loadFromDirectory(options.shippedDir, 'shipped', spells, errors, options);
  }

  // Tier 2: User definitions (override shipped by name)
  if (options.userDirs) {
    for (const dir of options.userDirs) {
      loadFromDirectory(dir, 'user', spells, errors, options);
    }
  }

  return { spells, errors };
}

/**
 * Load a single spell definition by name from the merged registry.
 */
export function loadSpellByName(
  name: string,
  options: LoaderOptions = {},
): LoadedSpell | undefined {
  const { spells } = loadSpellDefinitions(options);
  return spells.get(name);
}

// ============================================================================
// Internal
// ============================================================================

function loadFromDirectory(
  dir: string,
  tier: 'shipped' | 'user',
  spells: Map<string, LoadedSpell>,
  errors: LoadError[],
  options: LoaderOptions,
): void {
  if (!existsSync(dir)) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  const files = entries.filter(f => SPELL_EXTENSIONS.has(extname(f).toLowerCase()));

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = parseSpell(content, filePath);

      if (!options.skipValidation) {
        const validation = validateSpellDefinition(parsed.definition, {
          knownStepTypes: options.knownStepTypes as string[],
        });
        if (!validation.valid) {
          errors.push({
            file: filePath,
            message: validation.errors.map(e => e.message).join('; '),
          });
          continue;
        }
      }

      const key = parsed.definition.name;
      spells.set(key, {
        definition: parsed.definition,
        sourceFile: filePath,
        tier,
      });
    } catch (err) {
      errors.push({
        file: filePath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
