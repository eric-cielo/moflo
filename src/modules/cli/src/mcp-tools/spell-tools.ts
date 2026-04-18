/**
 * Spell MCP Tools for CLI
 *
 * Wired to the real spell engine via runner-bridge.ts.
 * Story #225: Replace mock file-based store with engine integration.
 * Story #371: Rename workflow_* tools to spell_* with wizard terminology.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MCPTool } from './types.js';
import {
  loadSpellEngine,
  getCachedEngine,
  type EngineModule,
  type SpellResult,
  type SpellDefinition,
  type Grimoire,
} from '../services/engine-loader.js';
import { findProjectRoot } from '../services/project-root.js';
import { buildGrimoire } from '../services/grimoire-builder.js';


// ============================================================================
// Constants
// ============================================================================

const SPELL_STATUS = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
type SpellStatus = typeof SPELL_STATUS[keyof typeof SPELL_STATUS];

const LIST_SOURCE = {
  REGISTRY: 'registry',
  RUNS: 'runs',
  ALL: 'all',
} as const;

const TEMPLATE_ACTION = {
  LIST: 'list',
  INFO: 'info',
} as const;

// ============================================================================
// In-memory result tracking (for status queries between runs)
// ============================================================================

interface TrackedSpell {
  spellId: string;
  name: string;
  description?: string;
  status: SpellStatus;
  result?: SpellResult;
  startedAt: string;
  completedAt?: string;
}

const MAX_TRACKED = 100;
const trackedSpells = new Map<string, TrackedSpell>();

function evictOldest(): void {
  if (trackedSpells.size <= MAX_TRACKED) return;
  // Map iteration order is insertion order — delete the oldest
  const first = trackedSpells.keys().next().value;
  if (first) trackedSpells.delete(first);
}

function trackStart(spellId: string, name: string, description?: string): TrackedSpell {
  const tracked: TrackedSpell = {
    spellId,
    name,
    description,
    status: SPELL_STATUS.RUNNING,
    startedAt: new Date().toISOString(),
  };
  trackedSpells.set(spellId, tracked);
  evictOldest();
  return tracked;
}

function trackResult(tracked: TrackedSpell, result: SpellResult): void {
  tracked.status = result.cancelled ? SPELL_STATUS.CANCELLED : result.success ? SPELL_STATUS.COMPLETED : SPELL_STATUS.FAILED;
  tracked.result = result;
  tracked.completedAt = new Date().toISOString();
}

/** Execute a definition via the engine with tracking and error handling. */
async function executeAndTrack(
  engine: EngineModule,
  definition: SpellDefinition,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const spellId = `sp-${Date.now()}`;
  const tracked = trackStart(spellId, definition.name, definition.description);

  try {
    const sandboxConfig = await engine.loadSandboxConfigFromProject(findProjectRoot());
    const result = await engine.bridgeExecuteSpell(definition, args, { spellId, sandboxConfig });
    trackResult(tracked, result);
    return serializeResult(result);
  } catch (err) {
    tracked.status = SPELL_STATUS.FAILED;
    tracked.completedAt = new Date().toISOString();
    return { spellId, error: errorMsg(err) };
  }
}

// ============================================================================
// Registry singleton (created once per session, refreshable on demand)
// ============================================================================

let registryInstance: Grimoire | null = null;
let pendingRegistry: Promise<Grimoire> | null = null;

async function getRegistry(): Promise<Grimoire> {
  if (registryInstance) return registryInstance;
  if (pendingRegistry) return pendingRegistry;

  pendingRegistry = (async () => {
    try {
      const { registry } = await buildGrimoire(findProjectRoot());
      registryInstance = registry;
      return registryInstance;
    } finally {
      pendingRegistry = null;
    }
  })();

  return pendingRegistry;
}

/** Drop the cached registry singleton, forcing a fresh re-scan on next access. */
export function invalidateRegistry(): void {
  registryInstance = null;
}

// ============================================================================
// Serialization helpers
// ============================================================================

/** Extract error message from an unknown catch value. */
function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Serialize a single step for MCP responses. */
function serializeStep(s: SpellResult['steps'][number]) {
  return {
    stepId: s.stepId,
    stepType: s.stepType,
    status: s.status,
    duration: s.duration,
    error: s.error,
    errorCode: s.errorCode,
    outputData: s.output?.data,
  };
}

/** Count succeeded steps in a result. */
function countCompleted(result: SpellResult): number {
  return result.steps.filter(s => s.status === 'succeeded').length;
}

/** Serialize a SpellResult for MCP response (typed errors, step details). */
function serializeResult(result: SpellResult): Record<string, unknown> {
  return {
    spellId: result.spellId,
    success: result.success,
    cancelled: result.cancelled,
    duration: result.duration,
    stepCount: result.steps.length,
    steps: result.steps.map(serializeStep),
    outputs: result.outputs,
    errors: result.errors.map(e => ({
      stepId: e.stepId,
      code: e.code,
      message: e.message,
    })),
  };
}

// ============================================================================
// MCP Tool Definitions
// ============================================================================

export const spellTools: MCPTool[] = [
  // --------------------------------------------------------------------------
  // spell_cast — Cast a spell from a file, grimoire name, or incantation
  // --------------------------------------------------------------------------
  {
    name: 'spell_cast',
    description: 'Cast a spell from a YAML/JSON scroll, grimoire name/abbreviation, or inline incantation',
    category: 'spell',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Spell name or abbreviation (resolved via grimoire)' },
        file: { type: 'string', description: 'Path to a YAML/JSON spell scroll file' },
        content: { type: 'string', description: 'Inline YAML/JSON spell incantation' },
        args: { type: 'object', description: 'Reagents (arguments) to pass to the spell' },
        dryRun: { type: 'boolean', description: 'Preview the spell without casting' },
      },
    },
    handler: async (input) => {
      const args = (input.args as Record<string, unknown>) ?? {};
      const dryRun = input.dryRun as boolean | undefined;

      if (input.name) {
        // Resolve via registry and execute the parsed definition directly
        const registry = await getRegistry();
        const loaded = registry.resolve(input.name as string);
        if (!loaded) {
          return { error: `Spell not found in grimoire: ${input.name}` };
        }
        const engine = await loadSpellEngine();
        return executeAndTrack(engine, loaded.definition, args);
      }

      // Determine raw content source
      let content: string;
      let sourceFile: string | undefined;
      let spellName: string;

      if (input.content) {
        content = input.content as string;
        spellName = 'inline';
      } else if (input.file) {
        const filePath = resolve(findProjectRoot(), input.file as string);
        try {
          content = readFileSync(filePath, 'utf-8');
        } catch {
          return { error: `Spell scroll not found or unreadable: ${filePath}` };
        }
        sourceFile = filePath;
        spellName = String(input.file);
      } else {
        return { error: 'One of name, file, or content is required to cast a spell' };
      }

      // Run from raw content via bridge
      const engine = await loadSpellEngine();
      const sandboxConfig = await engine.loadSandboxConfigFromProject(findProjectRoot());
      const result = await engine.bridgeRunSpell(content, sourceFile, args, { dryRun, sandboxConfig });
      const tracked = trackStart(result.spellId, spellName);
      trackResult(tracked, result);
      return serializeResult(result);
    },
  },

  // --------------------------------------------------------------------------
  // spell_create — Scribe a new spell definition (returns parseable YAML)
  // --------------------------------------------------------------------------
  {
    name: 'spell_create',
    description: 'Scribe a new spell definition from steps (returns YAML scroll)',
    category: 'spell',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Spell name' },
        description: { type: 'string', description: 'Spell description' },
        steps: {
          type: 'array',
          description: 'Spell steps (incantation sequence)',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string' },
              config: { type: 'object' },
            },
          },
        },
        arguments: { type: 'object', description: 'Spell reagent definitions (arguments)' },
      },
      required: ['name'],
    },
    handler: async (input) => {
      const name = input.name as string;
      const description = input.description as string | undefined;
      const steps = (input.steps as Array<{ id?: string; type?: string; config?: Record<string, unknown> }>) ?? [];
      const args = input.arguments as Record<string, unknown> | undefined;

      // Build a SpellDefinition-compatible object from untyped MCP input
      const definition = {
        name,
        description,
        arguments: args,
        steps: steps.map((s, i) => ({
          id: s.id ?? `step-${i + 1}`,
          type: s.type ?? 'bash',
          config: s.config ?? {},
        })),
      } as SpellDefinition;

      return {
        name,
        description,
        stepCount: definition.steps.length,
        definition,
        message: 'Spell scribed. Pass it to spell_execute or spell_cast to invoke it.',
      };
    },
  },

  // --------------------------------------------------------------------------
  // spell_execute — Execute a spell from a definition object
  // --------------------------------------------------------------------------
  {
    name: 'spell_execute',
    description: 'Execute a spell from a definition object directly',
    category: 'spell',
    inputSchema: {
      type: 'object',
      properties: {
        definition: { type: 'object', description: 'SpellDefinition object (from spell_create or parsed YAML scroll)' },
        args: { type: 'object', description: 'Reagents (runtime arguments)' },
        dryRun: { type: 'boolean', description: 'Preview the spell without casting' },
      },
      required: ['definition'],
    },
    handler: async (input) => {
      const definition = input.definition as SpellDefinition;
      const args = (input.args as Record<string, unknown>) ?? {};

      if (!definition || !definition.name || !definition.steps) {
        return { error: 'Invalid definition: must have name and steps' };
      }

      if (input.dryRun) {
        const engine = await loadSpellEngine();
        const content = JSON.stringify(definition);
        const result = await engine.runSpellFromContent(content, undefined, {
          dryRun: true,
          args,
        });
        return serializeResult(result);
      }

      const engine = await loadSpellEngine();
      return executeAndTrack(engine, definition, args);
    },
  },

  // --------------------------------------------------------------------------
  // spell_status — Scry the status of a tracked spell
  // --------------------------------------------------------------------------
  {
    name: 'spell_status',
    description: 'Scry the execution status of a cast spell',
    category: 'spell',
    inputSchema: {
      type: 'object',
      properties: {
        spellId: { type: 'string', description: 'Spell invocation ID' },
        verbose: { type: 'boolean', description: 'Include step details in the scrying' },
      },
      required: ['spellId'],
    },
    handler: async (input) => {
      const spellId = input.spellId as string;
      const tracked = trackedSpells.get(spellId);

      // Only check engine if it's already loaded (avoid unnecessary dynamic import)
      const isRunning = getCachedEngine()?.bridgeIsRunning(spellId) ?? false;

      if (!tracked && !isRunning) {
        return { spellId, error: 'Spell invocation not found' };
      }

      if (isRunning) {
        return {
          spellId,
          status: SPELL_STATUS.RUNNING,
          name: tracked?.name,
          startedAt: tracked?.startedAt,
        };
      }

      if (!tracked) {
        return { spellId, status: 'unknown' as const };
      }

      const response: Record<string, unknown> = {
        spellId: tracked.spellId,
        name: tracked.name,
        status: tracked.status,
        startedAt: tracked.startedAt,
        completedAt: tracked.completedAt,
      };

      if (tracked.result) {
        const completed = countCompleted(tracked.result);
        const total = tracked.result.steps.length;
        response.success = tracked.result.success;
        response.duration = tracked.result.duration;
        response.stepCount = total;
        response.completedSteps = completed;
        response.progress = total > 0 ? (completed / total) * 100 : 0;

        if (input.verbose) {
          response.steps = tracked.result.steps.map(serializeStep);
          response.errors = tracked.result.errors;
          response.outputs = tracked.result.outputs;
        }
      }

      return response;
    },
  },

  // --------------------------------------------------------------------------
  // spell_list — List spells from grimoire and tracked castings
  // --------------------------------------------------------------------------
  {
    name: 'spell_list',
    description: 'List available spells from the grimoire and recent castings',
    category: 'spell',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['registry', 'runs', 'all'], description: 'What to list (default: all)' },
        status: { type: 'string', description: 'Filter castings by status' },
        limit: { type: 'number', description: 'Max spells to return' },
        refresh: { type: 'boolean', description: 'Re-scan grimoire scrolls before listing' },
      },
    },
    handler: async (input) => {
      const source = (input.source as string) ?? LIST_SOURCE.ALL;
      const limit = (input.limit as number) ?? 20;
      const result: Record<string, unknown> = {};

      if (input.refresh) {
        invalidateRegistry();
        result.refreshed = true;
      }

      if (source === LIST_SOURCE.REGISTRY || source === LIST_SOURCE.ALL) {
        try {
          const registry = await getRegistry();
          result.definitions = registry.list();
        } catch {
          result.definitions = [];
          result.registryError = 'Spell engine not available';
        }
      }

      if (source === LIST_SOURCE.RUNS || source === LIST_SOURCE.ALL) {
        let runs = [...trackedSpells.values()];
        if (input.status) {
          runs = runs.filter(r => r.status === input.status);
        }
        runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
        result.runs = runs.slice(0, limit).map(r => ({
          spellId: r.spellId,
          name: r.name,
          status: r.status,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
        }));
      }

      // Also include currently running spells from the engine
      try {
        const engine = await loadSpellEngine();
        result.activeSpells = engine.bridgeActiveSpells();
      } catch {
        result.activeSpells = [];
      }

      return result;
    },
  },

  // --------------------------------------------------------------------------
  // spell_suspend — Suspend a running spell (converts to dispel — spells run to completion)
  // --------------------------------------------------------------------------
  {
    name: 'spell_suspend',
    description: 'Suspend a running spell (converts to dispel — spells run to completion)',
    category: 'spell',
    inputSchema: {
      type: 'object',
      properties: {
        spellId: { type: 'string', description: 'Spell invocation ID' },
      },
      required: ['spellId'],
    },
    handler: async (input) => {
      const spellId = input.spellId as string;
      const engine = await loadSpellEngine();

      if (!engine.bridgeIsRunning(spellId)) {
        return { spellId, error: 'Spell not currently active' };
      }

      // Engine doesn't support pause — cancel via AbortController
      const cancelled = engine.bridgeCancelSpell(spellId);
      if (cancelled) {
        const tracked = trackedSpells.get(spellId);
        if (tracked) {
          tracked.status = SPELL_STATUS.CANCELLED;
          tracked.completedAt = new Date().toISOString();
        }
      }

      return {
        spellId,
        status: cancelled ? SPELL_STATUS.CANCELLED : 'not_found',
        note: 'Spells cannot be suspended mid-cast — dispelled instead. Use spell_cast to re-invoke.',
      };
    },
  },

  // --------------------------------------------------------------------------
  // spell_resume — Resume a spell (re-casts from beginning — mid-spell resume not supported)
  // --------------------------------------------------------------------------
  {
    name: 'spell_resume',
    description: 'Resume a spell (re-casts from beginning — mid-spell resume not yet supported)',
    category: 'spell',
    inputSchema: {
      type: 'object',
      properties: {
        spellId: { type: 'string', description: 'Spell invocation ID of a previously tracked spell' },
        args: { type: 'object', description: 'Override reagents for the re-cast' },
      },
      required: ['spellId'],
    },
    handler: async (input) => {
      const spellId = input.spellId as string;
      const tracked = trackedSpells.get(spellId);

      if (!tracked) {
        return { spellId, error: 'Spell not found in tracked castings' };
      }

      if (!tracked.result) {
        return { spellId, error: 'No previous result to resume from' };
      }

      // Re-run the spell from scratch
      // Note: The engine's runner supports initialVariables for paused-state resume,
      // but MCP tools don't currently persist paused definitions. This re-runs from start.
      return {
        spellId,
        note: 'Mid-spell resume is not yet supported. Use spell_cast to re-invoke the spell.',
        previousStatus: tracked.status,
        previousResult: {
          success: tracked.result.success,
          stepCount: tracked.result.steps.length,
          completedSteps: countCompleted(tracked.result),
        },
      };
    },
  },

  // --------------------------------------------------------------------------
  // spell_cancel — Dispel a running spell
  // --------------------------------------------------------------------------
  {
    name: 'spell_cancel',
    description: 'Dispel (cancel) a running spell',
    category: 'spell',
    inputSchema: {
      type: 'object',
      properties: {
        spellId: { type: 'string', description: 'Spell invocation ID' },
        reason: { type: 'string', description: 'Reason for dispelling' },
      },
      required: ['spellId'],
    },
    handler: async (input) => {
      const spellId = input.spellId as string;
      const engine = await loadSpellEngine();

      const cancelled = engine.bridgeCancelSpell(spellId);

      if (cancelled) {
        const tracked = trackedSpells.get(spellId);
        if (tracked) {
          tracked.status = SPELL_STATUS.CANCELLED;
          tracked.completedAt = new Date().toISOString();
        }
        return {
          spellId,
          status: SPELL_STATUS.CANCELLED,
          cancelledAt: new Date().toISOString(),
          reason: (input.reason as string) ?? 'Cancelled by user',
        };
      }

      // Check if it's a tracked but already finished spell
      const tracked = trackedSpells.get(spellId);
      if (tracked) {
        return { spellId, error: `Spell already ${tracked.status}` };
      }

      return { spellId, error: 'Spell invocation not found' };
    },
  },

  // --------------------------------------------------------------------------
  // spell_delete — Remove a tracked spell record from memory
  // --------------------------------------------------------------------------
  {
    name: 'spell_delete',
    description: 'Delete a tracked spell casting record',
    category: 'spell',
    inputSchema: {
      type: 'object',
      properties: {
        spellId: { type: 'string', description: 'Spell invocation ID' },
      },
      required: ['spellId'],
    },
    handler: async (input) => {
      const spellId = input.spellId as string;

      // Only check engine if already loaded (avoid unnecessary dynamic import)
      if (getCachedEngine()?.bridgeIsRunning(spellId)) {
        return { spellId, error: 'Cannot delete an active spell — dispel it first' };
      }

      const existed = trackedSpells.delete(spellId);
      return {
        spellId,
        deleted: existed,
        deletedAt: existed ? new Date().toISOString() : undefined,
      };
    },
  },

  // --------------------------------------------------------------------------
  // spell_template — Browse spell templates from the grimoire
  // --------------------------------------------------------------------------
  {
    name: 'spell_template',
    description: 'Browse spell templates from the grimoire',
    category: 'spell',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'info'], description: 'Grimoire action' },
        query: { type: 'string', description: 'Spell name or abbreviation (for info)' },
      },
      required: ['action'],
    },
    handler: async (input) => {
      const action = input.action as string;

      if (action === TEMPLATE_ACTION.LIST) {
        try {
          const registry = await getRegistry();
          const entries = registry.list();
          return {
            action,
            templates: entries,
            total: entries.length,
          };
        } catch (err) {
          return { action, error: errorMsg(err) };
        }
      }

      if (action === TEMPLATE_ACTION.INFO) {
        const query = input.query as string;
        if (!query) {
          return { action, error: 'Query required for info action' };
        }
        try {
          const registry = await getRegistry();
          const info = registry.info(query);
          if (!info) {
            return { action, error: `Spell not found in grimoire: ${query}` };
          }
          return { action, ...info };
        } catch (err) {
          return { action, error: errorMsg(err) };
        }
      }

      return { action, error: `Unknown action: ${action}. Use 'list' or 'info'.` };
    },
  },

  // --------------------------------------------------------------------------
  // spell_accept — Accept a spell's permissions after reviewing risk analysis
  // --------------------------------------------------------------------------
  {
    name: 'spell_accept',
    description: 'Accept a spell\'s permissions after reviewing the risk analysis. Required before first execution.',
    category: 'spell',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Spell name (as shown in the risk analysis)' },
      },
      required: ['name'],
    },
    handler: async (input) => {
      const spellName = input.name as string;

      // Dynamically import to avoid circular deps with the spell engine
      const { recordAcceptance } = await import(
        '../../../../modules/spells/src/core/permission-acceptance.js'
      );
      const { analyzeSpellPermissions } = await import(
        '../../../../modules/spells/src/core/permission-disclosure.js'
      );
      const { StepCommandRegistry } = await import(
        '../../../../modules/spells/src/core/step-command-registry.js'
      );
      const { builtinCommands } = await import(
        '../../../../modules/spells/src/commands/index.js'
      );

      const projectRoot = findProjectRoot();

      // Resolve the spell definition
      const registry = await getRegistry();
      const loaded = registry.resolve(spellName);
      if (!loaded) {
        return { error: `Spell not found in grimoire: ${spellName}` };
      }

      // Build a step command registry for permission analysis
      const stepRegistry = new StepCommandRegistry();
      for (const cmd of builtinCommands) {
        stepRegistry.register(cmd, 'built-in');
      }
      const report = analyzeSpellPermissions(loaded.definition, stepRegistry);

      await recordAcceptance(projectRoot, loaded.definition.name, report.permissionHash);

      return {
        accepted: true,
        spell: loaded.definition.name,
        permissionHash: report.permissionHash,
        overallRisk: report.overallRisk,
        message: `Permissions accepted for "${loaded.definition.name}". You can now cast this spell.`,
      };
    },
  },
];
