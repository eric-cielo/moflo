/**
 * Spell MCP Response Types
 *
 * Shared type definitions for spell MCP tool responses.
 * Used by both the MCP tool handlers (spell-tools.ts) and
 * the CLI spell command (commands/spell.ts) for type-safe
 * callMCPTool<T>() deserialization.
 *
 * Story #230: Extract shared spell type definitions.
 * Story #371: Rename workflow tools to spell tools.
 */

/** Response from spell_cast / spell_execute MCP tools. */
export interface SpellRunResponse {
  spellId: string;
  success: boolean;
  cancelled: boolean;
  duration: number;
  stepCount: number;
  steps: SpellStepResponse[];
  outputs: Record<string, unknown>;
  errors: SpellErrorResponse[];
  error?: string;
}

/** Serialized step in a spell MCP response. */
export interface SpellStepResponse {
  [key: string]: unknown;
  stepId: string;
  stepType: string;
  status: string;
  duration: number;
  error?: string;
  errorCode?: string;
  outputData?: unknown;
}

/** Serialized error in a spell MCP response. */
export interface SpellErrorResponse {
  code: string;
  message: string;
  stepId?: string;
}

/** Response from spell_status MCP tool. */
export interface SpellStatusResponse {
  spellId: string;
  name?: string;
  status: string;
  success?: boolean;
  duration?: number;
  stepCount?: number;
  completedSteps?: number;
  progress?: number;
  startedAt?: string;
  completedAt?: string;
  steps?: SpellStepResponse[];
  errors?: SpellErrorResponse[];
  outputs?: Record<string, unknown>;
  error?: string;
}

/** Entry in a spell registry list response. */
export interface GrimoireEntry {
  [key: string]: unknown;
  name: string;
  abbreviation?: string;
  description?: string;
  tier: string;
}

/** Response from spell_list MCP tool. */
export interface SpellListResponse {
  definitions?: GrimoireEntry[];
  runs?: SpellRunEntry[];
  activeSpells?: string[];
  registryError?: string;
  refreshed?: boolean;
}

/** A tracked spell run entry. */
export interface SpellRunEntry {
  [key: string]: unknown;
  spellId: string;
  name: string;
  status: string;
  startedAt: string;
  completedAt?: string;
}

/** Response from spell_cancel MCP tool. */
export interface SpellCancelResponse {
  spellId: string;
  status: string;
  cancelledAt?: string;
  reason?: string;
  error?: string;
}

/** Response from spell_template list action. */
export interface SpellTemplateListResponse {
  action: string;
  templates: GrimoireEntry[];
  total: number;
  error?: string;
}

/** Response from spell_template info action. */
export interface SpellTemplateInfoResponse {
  action: string;
  name?: string;
  abbreviation?: string;
  description?: string;
  version?: string;
  sourceFile?: string;
  tier?: string;
  arguments?: Record<string, unknown>;
  stepCount?: number;
  stepTypes?: string[];
  error?: string;
}
