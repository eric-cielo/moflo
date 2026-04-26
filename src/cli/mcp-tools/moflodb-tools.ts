/**
 * MofloDb MCP Tools — Phase 6 of ADR-053
 *
 * Exposes MofloDb v3 controller operations as MCP tools.
 * Provides direct access to ReasoningBank, CausalGraph, SkillLibrary,
 * AttestationLog, and bridge health through the MCP protocol.
 *
 * Security: All handlers validate input types, enforce length bounds,
 * and sanitize error messages before returning to MCP callers.
 *
 * @module v3/cli/mcp-tools/moflodb-tools
 */

import type { MCPTool } from './types.js';

// ===== Shared validation helpers =====

const MAX_STRING_LENGTH = 100_000; // 100KB max for any string input
const MAX_BATCH_SIZE = 500;        // Max entries per batch operation
const MAX_TOP_K = 100;             // Max results per query

function validateString(value: unknown, name: string, maxLen = MAX_STRING_LENGTH): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > maxLen) return null;
  return value;
}

function validatePositiveInt(value: unknown, defaultVal: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultVal;
  const n = Math.floor(value);
  return n > 0 ? Math.min(n, max) : defaultVal;
}

function validateScore(value: unknown, defaultVal: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultVal;
  return Math.max(0, Math.min(1, value));
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    // Strip filesystem paths from error messages
    return error.message.replace(/\/[^\s:]+\//g, '<path>/').substring(0, 500);
  }
  return 'Internal error';
}

// Lazy-cached bridge module
let bridgeModule: typeof import('../memory/memory-bridge.js') | null = null;
async function getBridge() {
  if (!bridgeModule) {
    bridgeModule = await import('../memory/memory-bridge.js');
  }
  return bridgeModule;
}

/**
 * When the bridge returns null, surface the underlying init error instead of
 * the generic "bridge not available" stub.
 */
async function bridgeUnavailableReason(fallback: string): Promise<string> {
  const bridge = await getBridge();
  const err = bridge.getBridgeLastError?.();
  if (err) return `MofloDb bridge init failed: ${sanitizeError(err)}`;
  return fallback;
}

// ===== moflodb_health — Controller health check =====

export const moflodbHealth: MCPTool = {
  name: 'moflodb_health',
  description: 'Get MofloDb v3 controller health status including cache stats and attestation count',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      const health = await bridge.bridgeHealthCheck();
      if (!health) {
        return { available: false, error: await bridgeUnavailableReason('MofloDb bridge not available') };
      }
      return health;
    } catch (error) {
      return { available: false, error: sanitizeError(error) };
    }
  },
};

// ===== moflodb_controllers — List all controllers =====

export const moflodbControllers: MCPTool = {
  name: 'moflodb_controllers',
  description: 'List all MofloDb v3 controllers and their initialization status',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const bridge = await getBridge();
      const controllers = await bridge.bridgeListControllers();
      if (!controllers) {
        return {
          available: false,
          controllers: [],
          error: await bridgeUnavailableReason(
            'MofloDb bridge not available — controllers could not be listed. Use memory_store/memory_search tools instead.',
          ),
        };
      }
      return {
        available: true,
        controllers,
        total: controllers.length,
        active: controllers.filter((c: any) => c.enabled).length,
      };
    } catch (error) {
      return { available: false, error: sanitizeError(error) };
    }
  },
};

// ===== moflodb_pattern_store — Store via ReasoningBank =====

export const moflodbPatternStore: MCPTool = {
  name: 'moflodb_pattern-store',
  description: 'Store a pattern directly via ReasoningBank controller',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Pattern description' },
      type: { type: 'string', description: 'Pattern type (e.g., task-routing, error-recovery)' },
      confidence: { type: 'number', description: 'Confidence score (0-1)' },
    },
    required: ['pattern'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const pattern = validateString(params.pattern, 'pattern');
      if (!pattern) return { success: false, error: 'pattern is required (non-empty string, max 100KB)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeStorePattern({
        pattern,
        type: validateString(params.type, 'type', 200) ?? 'general',
        confidence: validateScore(params.confidence, 0.8),
      });
      return result ?? { success: false, error: 'MofloDb bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== moflodb_pattern_search — Search via ReasoningBank =====

export const moflodbPatternSearch: MCPTool = {
  name: 'moflodb_pattern-search',
  description: 'Search patterns via ReasoningBank controller with BM25+semantic hybrid',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      topK: { type: 'number', description: 'Number of results (default: 5)' },
      minConfidence: { type: 'number', description: 'Minimum score threshold (0-1)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { results: [], error: 'query is required (non-empty string, max 10KB)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSearchPatterns({
        query,
        topK: validatePositiveInt(params.topK, 5, MAX_TOP_K),
        minConfidence: validateScore(params.minConfidence, 0.3),
      });
      return result ?? { results: [], controller: 'unavailable' };
    } catch (error) {
      return { results: [], error: sanitizeError(error) };
    }
  },
};

// ===== moflodb_feedback — Record task feedback =====

export const moflodbFeedback: MCPTool = {
  name: 'moflodb_feedback',
  description: 'Record task feedback for learning via LearningSystem + ReasoningBank controllers',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task identifier' },
      success: { type: 'boolean', description: 'Whether task succeeded' },
      quality: { type: 'number', description: 'Quality score (0-1)' },
      agent: { type: 'string', description: 'Agent that performed the task' },
    },
    required: ['taskId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const taskId = validateString(params.taskId, 'taskId', 500);
      if (!taskId) return { success: false, error: 'taskId is required (non-empty string, max 500 chars)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeRecordFeedback({
        taskId,
        success: params.success === true,
        quality: validateScore(params.quality, 0.85),
        agent: validateString(params.agent, 'agent', 200) ?? undefined,
      });
      return result ?? { success: false, error: 'MofloDb bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== moflodb_causal_edge — Record causal relationships =====

export const moflodbCausalEdge: MCPTool = {
  name: 'moflodb_causal-edge',
  description: 'Record a causal edge between two memory entries via CausalMemoryGraph',
  inputSchema: {
    type: 'object',
    properties: {
      sourceId: { type: 'string', description: 'Source entry ID' },
      targetId: { type: 'string', description: 'Target entry ID' },
      relation: { type: 'string', description: 'Relationship type (e.g., caused, preceded, succeeded)' },
      weight: { type: 'number', description: 'Edge weight (0-1)' },
    },
    required: ['sourceId', 'targetId', 'relation'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const sourceId = validateString(params.sourceId, 'sourceId', 500);
      const targetId = validateString(params.targetId, 'targetId', 500);
      const relation = validateString(params.relation, 'relation', 200);
      if (!sourceId) return { success: false, error: 'sourceId is required (non-empty string)' };
      if (!targetId) return { success: false, error: 'targetId is required (non-empty string)' };
      if (!relation) return { success: false, error: 'relation is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeRecordCausalEdge({
        sourceId,
        targetId,
        relation,
        weight: typeof params.weight === 'number' ? validateScore(params.weight, 0.5) : undefined,
      });
      return result ?? { success: false, error: 'MofloDb bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== moflodb_route — Route via SemanticRouter =====

export const moflodbRoute: MCPTool = {
  name: 'moflodb_route',
  description: 'Route a task via MofloDb SemanticRouter or LearningSystem recommendAlgorithm',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description to route' },
      context: { type: 'string', description: 'Additional context' },
    },
    required: ['task'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const task = validateString(params.task, 'task', 10_000);
      if (!task) return { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'error', error: 'task is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeRouteTask({
        task,
        context: validateString(params.context, 'context', 10_000) ?? undefined,
      });
      return result ?? { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'fallback' };
    } catch (error) {
      return { route: 'general', confidence: 0.5, agents: ['coder'], controller: 'error', error: sanitizeError(error) };
    }
  },
};

// ===== moflodb_session_start — Session with ReflexionMemory =====

export const moflodbSessionStart: MCPTool = {
  name: 'moflodb_session-start',
  description: 'Start a session with ReflexionMemory episodic replay',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session identifier' },
      context: { type: 'string', description: 'Session context for pattern retrieval' },
    },
    required: ['sessionId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const sessionId = validateString(params.sessionId, 'sessionId', 500);
      if (!sessionId) return { success: false, error: 'sessionId is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSessionStart({
        sessionId,
        context: validateString(params.context, 'context', 10_000) ?? undefined,
      });
      return result ?? { success: false, error: 'MofloDb bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== moflodb_session_end — End session + NightlyLearner =====

export const moflodbSessionEnd: MCPTool = {
  name: 'moflodb_session-end',
  description: 'End session, persist to ReflexionMemory, trigger NightlyLearner consolidation',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Session identifier' },
      summary: { type: 'string', description: 'Session summary' },
      tasksCompleted: { type: 'number', description: 'Number of tasks completed' },
    },
    required: ['sessionId'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const sessionId = validateString(params.sessionId, 'sessionId', 500);
      if (!sessionId) return { success: false, error: 'sessionId is required (non-empty string)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSessionEnd({
        sessionId,
        summary: validateString(params.summary, 'summary', 50_000) ?? undefined,
        tasksCompleted: validatePositiveInt(params.tasksCompleted, 0, 10_000),
      });
      return result ?? { success: false, error: 'MofloDb bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== moflodb_hierarchical_store — Store to hierarchical memory =====

export const moflodbHierarchicalStore: MCPTool = {
  name: 'moflodb_hierarchical-store',
  description: 'Store to hierarchical memory with tier (working, episodic, semantic)',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Memory entry key' },
      value: { type: 'string', description: 'Memory entry value' },
      tier: {
        type: 'string',
        description: 'Memory tier (working, episodic, semantic)',
        enum: ['working', 'episodic', 'semantic'],
        default: 'working',
      },
    },
    required: ['key', 'value'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const key = validateString(params.key, 'key', 1000);
      const value = validateString(params.value, 'value');
      if (!key) return { success: false, error: 'key is required (non-empty string, max 1KB)' };
      if (!value) return { success: false, error: 'value is required (non-empty string, max 100KB)' };
      const tier = validateString(params.tier, 'tier', 20) ?? 'working';
      if (!['working', 'episodic', 'semantic'].includes(tier)) {
        return { success: false, error: `Invalid tier: ${tier}. Must be working, episodic, or semantic` };
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeHierarchicalStore({ key, value, tier });
      return result ?? { success: false, error: 'MofloDb bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== moflodb_hierarchical_recall — Recall from hierarchical memory =====

export const moflodbHierarchicalRecall: MCPTool = {
  name: 'moflodb_hierarchical-recall',
  description: 'Recall from hierarchical memory with optional tier filter',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Recall query' },
      tier: { type: 'string', description: 'Filter by tier (working, episodic, semantic)' },
      topK: { type: 'number', description: 'Number of results (default: 5)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { results: [], error: 'query is required (non-empty string, max 10KB)' };
      const tier = validateString(params.tier, 'tier', 20);
      if (tier && !['working', 'episodic', 'semantic'].includes(tier)) {
        return { results: [], error: `Invalid tier: ${tier}. Must be working, episodic, or semantic` };
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeHierarchicalRecall({
        query,
        tier: tier ?? undefined,
        topK: validatePositiveInt(params.topK, 5, MAX_TOP_K),
      });
      return result ?? { results: [], error: 'MofloDb bridge not available. Use memory_search instead.' };
    } catch (error) {
      return { results: [], error: sanitizeError(error) };
    }
  },
};

// ===== moflodb_consolidate — Run memory consolidation =====

export const moflodbConsolidate: MCPTool = {
  name: 'moflodb_consolidate',
  description: 'Run memory consolidation to promote entries across tiers and compress old data',
  inputSchema: {
    type: 'object',
    properties: {
      minAge: { type: 'number', description: 'Minimum age in hours since store (optional)' },
      maxEntries: { type: 'number', description: 'Maximum entries to consolidate (optional)' },
    },
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const bridge = await getBridge();
      const result = await bridge.bridgeConsolidate({
        minAge: typeof params.minAge === 'number' ? Math.max(0, params.minAge) : undefined,
        maxEntries: validatePositiveInt(params.maxEntries, 1000, 10_000),
      });
      return result ?? { success: false, error: 'MofloDb bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== moflodb_batch — Batch operations (insert, update, delete) =====

export const moflodbBatch: MCPTool = {
  name: 'moflodb_batch',
  description: 'Batch operations on memory entries (insert, update, delete)',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        description: 'Batch operation type',
        enum: ['insert', 'update', 'delete'],
      },
      entries: {
        type: 'array',
        description: 'Array of {key, value} entries to operate on',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['key'],
        },
      },
    },
    required: ['operation', 'entries'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const operation = validateString(params.operation, 'operation', 20);
      if (!operation) return { success: false, error: 'operation is required (string)' };
      if (!['insert', 'update', 'delete'].includes(operation)) {
        return { success: false, error: `Invalid operation: ${operation}. Must be insert, update, or delete` };
      }
      if (!Array.isArray(params.entries) || params.entries.length === 0) {
        return { success: false, error: 'entries is required (non-empty array)' };
      }
      if (params.entries.length > MAX_BATCH_SIZE) {
        return { success: false, error: `Too many entries: ${params.entries.length}. Max is ${MAX_BATCH_SIZE}` };
      }
      // Validate each entry
      const validatedEntries: Array<{ key: string; value?: string; metadata?: Record<string, unknown> }> = [];
      for (let i = 0; i < params.entries.length; i++) {
        const entry = params.entries[i];
        if (!entry || typeof entry !== 'object') {
          return { success: false, error: `entries[${i}] must be an object` };
        }
        const key = validateString((entry as any).key, `entries[${i}].key`, 1000);
        if (!key) return { success: false, error: `entries[${i}].key is required (non-empty string)` };
        const value = validateString((entry as any).value, `entries[${i}].value`);
        validatedEntries.push({ key, value: value ?? undefined });
      }
      const bridge = await getBridge();
      const result = await bridge.bridgeBatchOperation({
        operation,
        entries: validatedEntries,
      });
      return result ?? { success: false, error: 'MofloDb bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== moflodb_context_synthesize — Synthesize context from memories =====

export const moflodbContextSynthesize: MCPTool = {
  name: 'moflodb_context-synthesize',
  description: 'Synthesize context from stored memories for a given query',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Query to synthesize context for' },
      maxEntries: { type: 'number', description: 'Maximum entries to include (default: 10)' },
    },
    required: ['query'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const query = validateString(params.query, 'query', 10_000);
      if (!query) return { success: false, error: 'query is required (non-empty string, max 10KB)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeContextSynthesize({
        query,
        maxEntries: validatePositiveInt(params.maxEntries, 10, MAX_TOP_K),
      });
      return result ?? { success: false, error: 'MofloDb bridge not available. Use memory_store/memory_search instead.' };
    } catch (error) {
      return { success: false, error: sanitizeError(error) };
    }
  },
};

// ===== moflodb_semantic_route — Route via SemanticRouter =====

export const moflodbSemanticRoute: MCPTool = {
  name: 'moflodb_semantic-route',
  description: 'Route an input via MofloDb SemanticRouter for intent classification',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'Input text to route' },
    },
    required: ['input'],
  },
  handler: async (params: Record<string, unknown>) => {
    try {
      const input = validateString(params.input, 'input', 10_000);
      if (!input) return { route: null, error: 'input is required (non-empty string, max 10KB)' };
      const bridge = await getBridge();
      const result = await bridge.bridgeSemanticRoute({ input });
      return result ?? { route: null, error: 'MofloDb bridge not available. Use hooks route instead.' };
    } catch (error) {
      return { route: null, error: sanitizeError(error) };
    }
  },
};

// ===== Export all tools =====

export const moflodbTools: MCPTool[] = [
  moflodbHealth,
  moflodbControllers,
  moflodbPatternStore,
  moflodbPatternSearch,
  moflodbFeedback,
  moflodbCausalEdge,
  moflodbRoute,
  moflodbSessionStart,
  moflodbSessionEnd,
  moflodbHierarchicalStore,
  moflodbHierarchicalRecall,
  moflodbConsolidate,
  moflodbBatch,
  moflodbContextSynthesize,
  moflodbSemanticRoute,
];
