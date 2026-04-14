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
import type { SandboxConfig } from '../core/platform-sandbox.js';
import { loadSandboxConfigFromProject } from '../core/platform-sandbox.js';
import { createRunner, runSpellFromContent } from './runner-factory.js';

/**
 * Resolve sandbox config: prefer caller-supplied; fall back to auto-loading
 * from moflo.yaml at projectRoot. Returns undefined when neither is available
 * (runner falls back to DEFAULT_SANDBOX_CONFIG with denylist-only).
 */
async function resolveSandbox(
  explicit: SandboxConfig | undefined,
  projectRoot: string | undefined,
): Promise<SandboxConfig | undefined> {
  if (explicit) return explicit;
  if (!projectRoot) return undefined;
  return loadSandboxConfigFromProject(projectRoot);
}

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
  options: { dryRun?: boolean; memory?: MemoryAccessor; credentials?: CredentialAccessor; projectRoot?: string; sandboxConfig?: SandboxConfig } = {},
): Promise<SpellResult> {
  const spellId = `sp-${Date.now()}`;
  const controller = new AbortController();
  activeSpells.set(spellId, controller);

  try {
    const sandboxConfig = await resolveSandbox(options.sandboxConfig, options.projectRoot);
    const result = await runSpellFromContent(content, sourceFile, {
      spellId,
      args,
      dryRun: options.dryRun,
      signal: controller.signal,
      memory: options.memory,
      credentials: options.credentials,
      ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      ...(sandboxConfig ? { sandboxConfig } : {}),
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
  options: { spellId?: string; memory?: MemoryAccessor; credentials?: CredentialAccessor; projectRoot?: string; sandboxConfig?: SandboxConfig } = {},
): Promise<SpellResult> {
  const spellId = options.spellId ?? `sp-${Date.now()}`;
  const controller = new AbortController();
  activeSpells.set(spellId, controller);

  try {
    const sandboxConfig = await resolveSandbox(options.sandboxConfig, options.projectRoot);
    const runner = createRunner({ memory: options.memory, credentials: options.credentials });
    return await runner.run(definition, args, {
      spellId,
      signal: controller.signal,
      ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      ...(sandboxConfig ? { sandboxConfig } : {}),
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
