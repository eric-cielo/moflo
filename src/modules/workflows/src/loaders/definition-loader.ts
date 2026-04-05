/**
 * Workflow Definition Loader
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
import { parseWorkflow } from '../schema/parser.js';
import { validateWorkflowDefinition } from '../schema/validator.js';
import type { WorkflowDefinition, ParsedWorkflow } from '../types/workflow-definition.types.js';

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

export interface LoadedWorkflow {
  readonly definition: WorkflowDefinition;
  readonly sourceFile: string;
  readonly tier: 'shipped' | 'user';
}

export interface LoadResult {
  readonly workflows: Map<string, LoadedWorkflow>;
  readonly errors: readonly LoadError[];
}

export interface LoadError {
  readonly file: string;
  readonly message: string;
}

// ============================================================================
// Loader
// ============================================================================

const WORKFLOW_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

/**
 * Load workflow definitions from shipped + user directories.
 * User definitions override shipped ones by workflow name match.
 */
export function loadWorkflowDefinitions(options: LoaderOptions = {}): LoadResult {
  const workflows = new Map<string, LoadedWorkflow>();
  const errors: LoadError[] = [];

  // Tier 1: Shipped definitions (lowest priority)
  if (options.shippedDir) {
    loadFromDirectory(options.shippedDir, 'shipped', workflows, errors, options);
  }

  // Tier 2: User definitions (override shipped by name)
  if (options.userDirs) {
    for (const dir of options.userDirs) {
      loadFromDirectory(dir, 'user', workflows, errors, options);
    }
  }

  return { workflows, errors };
}

/**
 * Load a single workflow definition by name from the merged registry.
 */
export function loadWorkflowByName(
  name: string,
  options: LoaderOptions = {},
): LoadedWorkflow | undefined {
  const { workflows } = loadWorkflowDefinitions(options);
  return workflows.get(name);
}

// ============================================================================
// Internal
// ============================================================================

function loadFromDirectory(
  dir: string,
  tier: 'shipped' | 'user',
  workflows: Map<string, LoadedWorkflow>,
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

  const files = entries.filter(f => WORKFLOW_EXTENSIONS.has(extname(f).toLowerCase()));

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = parseWorkflow(content, filePath);

      if (!options.skipValidation) {
        const validation = validateWorkflowDefinition(parsed.definition, {
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
      workflows.set(key, {
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
