/**
 * Runner Factory
 *
 * Creates a fully configured SpellCaster with the built-in command registry,
 * credentials, and memory accessors. Provides a high-level API for MCP tool
 * integration and CLI usage.
 */

import type { CredentialAccessor, MemoryAccessor } from '../types/step-command.types.js';
import type { SpellDefinition } from '../types/spell-definition.types.js';
import type { RunnerOptions, SpellResult } from '../types/runner.types.js';
import { StepCommandRegistry } from '../core/step-command-registry.js';
import { SpellCaster } from '../core/runner.js';
import { builtinCommands } from '../commands/index.js';
import { builtinConnectors } from '../connectors/index.js';
import { parseSpell } from '../schema/parser.js';
import { validateSpellDefinition } from '../schema/validator.js';
import { SpellConnectorRegistry } from '../registry/connector-registry.js';

// ============================================================================
// Types
// ============================================================================

export interface RunnerFactoryOptions {
  readonly credentials?: CredentialAccessor;
  readonly memory?: MemoryAccessor;
  readonly connectorRegistry?: SpellConnectorRegistry;
  /** User directories to scan for pluggable step commands (JS/TS files). */
  readonly stepDirs?: readonly string[];
  /** Project root for npm package discovery (scans node_modules/moflo-step-*). */
  readonly projectRoot?: string;
}

export interface RunSpellOptions extends RunnerOptions {
  /** Arguments to pass to the spell. */
  readonly args?: Record<string, unknown>;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a SpellCaster with built-in commands registered.
 */
export function createRunner(options: RunnerFactoryOptions = {}): SpellCaster {
  const registry = new StepCommandRegistry();
  for (const cmd of builtinCommands) {
    registry.register(cmd, 'built-in');
  }

  // npm packages have lowest priority (overridden by built-in and user steps)
  if (options.projectRoot) {
    registry.loadFromNpm(options.projectRoot);
  }

  // User directories override npm and built-in steps by name
  if (options.stepDirs?.length) {
    registry.loadFromDirectories(options.stepDirs);
  }

  const credentials = options.credentials ?? noopCredentials;
  const memory = options.memory ?? noopMemory;

  // Auto-register shipped connectors into the connector registry
  const connectorRegistry = options.connectorRegistry ?? new SpellConnectorRegistry();
  for (const connector of builtinConnectors) {
    if (!connectorRegistry.has(connector.name)) {
      connectorRegistry.register(connector, 'shipped');
    }
  }

  return new SpellCaster(registry, credentials, memory, connectorRegistry);
}

/**
 * Parse, validate, and run a spell from raw YAML/JSON content.
 * Returns a structured result — never throws.
 */
export async function runSpellFromContent(
  content: string,
  sourceFile: string | undefined,
  options: RunSpellOptions & RunnerFactoryOptions = {},
): Promise<SpellResult> {
  let definition: SpellDefinition;
  try {
    const parsed = parseSpell(content, sourceFile);
    definition = parsed.definition;
  } catch (err) {
    return {
      spellId: options.spellId ?? `sp-${Date.now()}`,
      success: false,
      steps: [],
      outputs: {},
      errors: [{ code: 'DEFINITION_VALIDATION_FAILED', message: `Parse error: ${err instanceof Error ? err.message : String(err)}` }],
      duration: 0,
      cancelled: false,
    };
  }

  const validation = validateSpellDefinition(definition);
  if (!validation.valid) {
    return {
      spellId: options.spellId ?? `sp-${Date.now()}`,
      success: false,
      steps: [],
      outputs: {},
      errors: [{ code: 'DEFINITION_VALIDATION_FAILED', message: validation.errors.map(e => e.message).join('; ') }],
      duration: 0,
      cancelled: false,
    };
  }

  const runner = createRunner(options);
  const { args = {}, ...runnerOptions } = options;
  return runner.run(definition, args, runnerOptions);
}

// ============================================================================
// Noop Accessors (for standalone usage without full CLI context)
// ============================================================================

const noopCredentials: CredentialAccessor = {
  async get() { return undefined; },
  async has() { return false; },
};

export const noopMemory: MemoryAccessor = {
  async read() { return null; },
  async write() { /* noop */ },
  async search() { return []; },
};
