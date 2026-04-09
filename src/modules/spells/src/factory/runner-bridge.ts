/**
 * Runner Bridge
 *
 * Provides a high-level, context-free API for MCP tool integration.
 * Each function is self-contained — no setup required. The bridge
 * creates runners on demand with built-in commands.
 *
 * This module is the integration point between MCP spell tools
 * and the SpellCaster engine.
 */

import type { SpellResult } from '../types/runner.types.js';
import type { CredentialAccessor, MemoryAccessor } from '../types/step-command.types.js';
import { createRunner, runSpellFromContent } from './runner-factory.js';

// Track active spells for cancellation
const activeSpells = new Map<string, AbortController>();

// ============================================================================
// Public API
// ============================================================================

/**
 * Run a spell from raw file content (YAML/JSON).
 */
export async function bridgeRunSpell(
  content: string,
  sourceFile: string | undefined,
  args: Record<string, unknown>,
  options: { dryRun?: boolean; memory?: MemoryAccessor; credentials?: CredentialAccessor } = {},
): Promise<SpellResult> {
  const spellId = `sp-${Date.now()}`;
  const controller = new AbortController();
  activeSpells.set(spellId, controller);

  try {
    const result = await runSpellFromContent(content, sourceFile, {
      spellId,
      args,
      dryRun: options.dryRun,
      signal: controller.signal,
      memory: options.memory,
      credentials: options.credentials,
    });
    return result;
  } finally {
    activeSpells.delete(spellId);
  }
}

/**
 * Run a SpellDefinition directly (for spell_execute).
 */
export async function bridgeExecuteSpell(
  definition: import('../types/spell-definition.types.js').SpellDefinition,
  args: Record<string, unknown>,
  options: { spellId?: string; memory?: MemoryAccessor; credentials?: CredentialAccessor } = {},
): Promise<SpellResult> {
  const spellId = options.spellId ?? `sp-${Date.now()}`;
  const controller = new AbortController();
  activeSpells.set(spellId, controller);

  try {
    const runner = createRunner({ memory: options.memory, credentials: options.credentials });
    return await runner.run(definition, args, {
      spellId,
      signal: controller.signal,
    });
  } finally {
    activeSpells.delete(spellId);
  }
}

/**
 * Cancel a running spell by ID.
 */
export function bridgeCancelSpell(spellId: string): boolean {
  const controller = activeSpells.get(spellId);
  if (!controller) return false;
  controller.abort();
  activeSpells.delete(spellId);
  return true;
}

/**
 * Check if a spell is currently running.
 */
export function bridgeIsRunning(spellId: string): boolean {
  return activeSpells.has(spellId);
}

/**
 * Get IDs of all currently running spells.
 */
export function bridgeActiveSpells(): string[] {
  return [...activeSpells.keys()];
}
