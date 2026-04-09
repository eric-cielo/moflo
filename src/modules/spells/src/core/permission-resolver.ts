/**
 * Permission Resolver — Least-Privilege Escalation for Spell Steps
 *
 * Determines the minimum Claude Code CLI permission flags needed for a step.
 * Always uses --dangerously-skip-permissions (required for non-interactive -p mode)
 * but varies --allowedTools to enforce least-privilege:
 *
 *   readonly   → Read,Glob,Grep                    (analysis only)
 *   standard   → Edit,Write,Read,Glob,Grep         (code changes, no shell)
 *   elevated   → Edit,Write,Bash,Read,Glob,Grep    (shell access for git/npm/etc.)
 *   autonomous → (no --allowedTools restriction)    (explicit opt-in only)
 *
 * Resolution order:
 *   1. Explicit `permissionLevel` on the step definition → use directly
 *   2. Derive from step capabilities: shell → elevated, fs:write → standard, else readonly
 */

import type { StepCapability, CapabilityType } from '../types/step-command.types.js';

// ============================================================================
// Permission Levels
// ============================================================================

export type PermissionLevel = 'readonly' | 'standard' | 'elevated' | 'autonomous';

export const VALID_PERMISSION_LEVELS: readonly PermissionLevel[] = [
  'readonly', 'standard', 'elevated', 'autonomous',
];

/** Tool sets for each permission level (ordered from least to most permissive). */
const TOOL_SETS: Record<Exclude<PermissionLevel, 'autonomous'>, readonly string[]> = {
  readonly:  ['Read', 'Glob', 'Grep'],
  standard:  ['Edit', 'Write', 'Read', 'Glob', 'Grep'],
  elevated:  ['Edit', 'Write', 'Bash', 'Read', 'Glob', 'Grep'],
};

// ============================================================================
// Resolved Permission Args
// ============================================================================

export interface ResolvedPermissions {
  /** The resolved permission level. */
  readonly level: PermissionLevel;
  /** CLI args to append when spawning Claude (e.g. ['--dangerously-skip-permissions', '--allowedTools', 'Read,Glob,Grep']). */
  readonly cliArgs: readonly string[];
  /** Whether --dangerously-skip-permissions is included (always true in non-interactive). */
  readonly skipPermissions: boolean;
  /** The allowed tools list, or undefined for autonomous (no restriction). */
  readonly allowedTools?: readonly string[];
}

// ============================================================================
// Resolver
// ============================================================================

/**
 * Resolve the minimum permission level for a Claude CLI invocation.
 *
 * @param explicitLevel - Optional explicit `permissionLevel` declared on the step.
 * @param capabilities  - The step's effective capabilities (after merging command defaults with YAML restrictions).
 * @param additionalTools - Extra tools to include beyond the level's default set (e.g., 'Agent' for agent steps).
 */
export function resolvePermissions(
  explicitLevel?: PermissionLevel | string,
  capabilities?: readonly StepCapability[],
  additionalTools?: readonly string[],
): ResolvedPermissions {
  const level = explicitLevel && isValidPermissionLevel(explicitLevel)
    ? explicitLevel as PermissionLevel
    : deriveFromCapabilities(capabilities);

  const args: string[] = ['--dangerously-skip-permissions'];
  let allowedTools: string[] | undefined;

  if (level !== 'autonomous') {
    const baseTools = [...TOOL_SETS[level]];
    if (additionalTools) {
      for (const tool of additionalTools) {
        if (!baseTools.includes(tool)) baseTools.push(tool);
      }
    }
    allowedTools = baseTools;
    args.push('--allowedTools', baseTools.join(','));
  }

  return {
    level,
    cliArgs: args,
    skipPermissions: true,
    allowedTools: allowedTools ? Object.freeze([...allowedTools]) : undefined,
  };
}

/**
 * Build the full Claude CLI command for a step that spawns a subagent.
 *
 * @param prompt        - The prompt text for Claude.
 * @param explicitLevel - Optional explicit `permissionLevel` from step config.
 * @param capabilities  - The step's effective capabilities.
 * @param additionalTools - Extra tools beyond the permission level's defaults.
 * @returns The complete command string (e.g. `claude --dangerously-skip-permissions --allowedTools Edit,Write,Read,Glob,Grep -p "..."`)
 */
export function buildClaudeCommand(
  prompt: string,
  explicitLevel?: PermissionLevel | string,
  capabilities?: readonly StepCapability[],
  additionalTools?: readonly string[],
): string {
  const resolved = resolvePermissions(explicitLevel, capabilities, additionalTools);
  const escapedPrompt = prompt.replace(/"/g, '\\"');
  return `claude ${resolved.cliArgs.join(' ')} -p "${escapedPrompt}"`;
}

// ============================================================================
// Capability → Permission Level Derivation
// ============================================================================

/** Capability types that require elevated (shell) permissions. */
const SHELL_CAPABILITIES: ReadonlySet<CapabilityType> = new Set([
  'shell',
  'browser',
]);

/** Capability types that require standard (write) permissions. */
const WRITE_CAPABILITIES: ReadonlySet<CapabilityType> = new Set([
  'fs:write',
  'agent',
]);

/**
 * Derive the minimum permission level from a step's capabilities.
 * - shell or browser → elevated (needs Bash)
 * - fs:write or agent → standard (needs Edit/Write)
 * - everything else → readonly
 */
function deriveFromCapabilities(
  capabilities?: readonly StepCapability[],
): PermissionLevel {
  if (!capabilities || capabilities.length === 0) return 'readonly';

  const types = new Set(capabilities.map(c => c.type));

  for (const cap of SHELL_CAPABILITIES) {
    if (types.has(cap)) return 'elevated';
  }
  for (const cap of WRITE_CAPABILITIES) {
    if (types.has(cap)) return 'standard';
  }

  return 'readonly';
}

// ============================================================================
// Validation
// ============================================================================

export function isValidPermissionLevel(value: string): value is PermissionLevel {
  return VALID_PERMISSION_LEVELS.includes(value as PermissionLevel);
}
