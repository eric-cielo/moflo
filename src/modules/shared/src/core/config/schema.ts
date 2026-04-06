/**
 * V3 Configuration Schemas
 * Valibot schemas for all configuration types
 */

import * as v from 'valibot';

/**
 * Agent configuration schema
 */
export const AgentConfigSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1)),
  type: v.pipe(v.string(), v.minLength(1)),
  capabilities: v.optional(v.array(v.string()), []),
  maxConcurrentTasks: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 5),
  priority: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100)), 50),
  timeout: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  retryPolicy: v.optional(v.object({
    maxRetries: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 3),
    backoffMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 1000),
    backoffMultiplier: v.optional(v.pipe(v.number(), v.minValue(0, 'Must be positive')), 2),
  })),
  resources: v.optional(v.object({
    maxMemoryMb: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    maxCpuPercent: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(100))),
  })),
  metadata: v.optional(v.record(v.string(), v.unknown())),
});

/**
 * Task configuration schema
 */
export const TaskConfigSchema = v.object({
  type: v.pipe(v.string(), v.minLength(1)),
  description: v.pipe(v.string(), v.minLength(1)),
  priority: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100)), 50),
  timeout: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  assignedAgent: v.optional(v.string()),
  input: v.optional(v.record(v.string(), v.unknown())),
  metadata: v.optional(v.object({
    requiredCapabilities: v.optional(v.array(v.string())),
    retryCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    maxRetries: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    critical: v.optional(v.boolean()),
    parentTaskId: v.optional(v.string()),
    childTaskIds: v.optional(v.array(v.string())),
    tags: v.optional(v.array(v.string())),
  })),
});

/**
 * Swarm configuration schema
 */
export const SwarmConfigSchema = v.object({
  topology: v.picklist(['hierarchical', 'mesh', 'ring', 'star', 'adaptive', 'hierarchical-mesh']),
  maxAgents: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 20),
  autoScale: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    minAgents: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 1),
    maxAgents: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 20),
    scaleUpThreshold: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.8),
    scaleDownThreshold: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.3),
  })),
  coordination: v.optional(v.object({
    consensusRequired: v.optional(v.boolean(), false),
    timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 10000),
    retryPolicy: v.object({
      maxRetries: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 3),
      backoffMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 500),
    }),
  })),
  communication: v.optional(v.object({
    protocol: v.optional(v.picklist(['events', 'messages', 'shared-memory']), 'events'),
    batchSize: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 10),
    flushIntervalMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 100),
  })),
  metadata: v.optional(v.record(v.string(), v.unknown())),
});

/**
 * Memory configuration schema
 */
export const MemoryConfigSchema = v.object({
  type: v.optional(v.picklist(['sqlite', 'agentdb', 'hybrid', 'redis', 'memory']), 'hybrid'),
  path: v.optional(v.string()),
  maxSize: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  ttlMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  sqlite: v.optional(v.object({
    filename: v.optional(v.string()),
    inMemory: v.optional(v.boolean(), false),
    wal: v.optional(v.boolean(), true),
  })),
  agentdb: v.optional(v.object({
    dimensions: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 1536),
    indexType: v.optional(v.picklist(['hnsw', 'flat', 'ivf']), 'hnsw'),
    efConstruction: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 200),
    m: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 16),
    quantization: v.optional(v.picklist(['none', 'scalar', 'product']), 'none'),
  })),
  redis: v.optional(v.object({
    host: v.optional(v.string(), 'localhost'),
    port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 6379),
    password: v.optional(v.string()),
    db: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
    keyPrefix: v.optional(v.string(), 'claude-flow:'),
  })),
  hybrid: v.optional(v.object({
    vectorThreshold: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 100),
  })),
});

/**
 * MCP server configuration schema
 */
export const MCPServerConfigSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.minLength(1)), 'moflo'),
  version: v.optional(v.pipe(v.string(), v.minLength(1)), '3.0.0'),
  transport: v.object({
    type: v.optional(v.picklist(['stdio', 'http', 'websocket']), 'stdio'),
    port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    host: v.optional(v.string()),
    path: v.optional(v.string()),
  }),
  capabilities: v.optional(v.object({
    tools: v.optional(v.boolean(), true),
    resources: v.optional(v.boolean(), true),
    prompts: v.optional(v.boolean(), true),
    logging: v.optional(v.boolean(), true),
    experimental: v.optional(v.record(v.string(), v.boolean())),
  })),
});

/**
 * Orchestrator configuration schema
 */
export const OrchestratorConfigSchema = v.object({
  session: v.object({
    persistSessions: v.optional(v.boolean(), true),
    dataDir: v.optional(v.string(), './data'),
    sessionRetentionMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 3600000),
  }),
  health: v.object({
    checkInterval: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 30000),
    historyLimit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 100),
    degradedThreshold: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 1),
    unhealthyThreshold: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 2),
  }),
  lifecycle: v.object({
    maxConcurrentAgents: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 20),
    spawnTimeout: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 30000),
    terminateTimeout: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 10000),
    maxSpawnRetries: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 3),
  }),
});

/**
 * Full system configuration schema
 */
export const SystemConfigSchema = v.object({
  orchestrator: OrchestratorConfigSchema,
  memory: v.optional(MemoryConfigSchema),
  mcp: v.optional(MCPServerConfigSchema),
  swarm: v.optional(SwarmConfigSchema),
});

/**
 * Export schema types
 * Using InferOutput to get post-default types (fields with defaults are required in output)
 */
export type AgentConfig = v.InferOutput<typeof AgentConfigSchema>;
export type TaskConfig = v.InferOutput<typeof TaskConfigSchema>;
export type SwarmConfig = v.InferOutput<typeof SwarmConfigSchema>;
export type MemoryConfig = v.InferOutput<typeof MemoryConfigSchema>;
export type MCPServerConfig = v.InferOutput<typeof MCPServerConfigSchema>;
export type OrchestratorConfig = v.InferOutput<typeof OrchestratorConfigSchema>;
export type SystemConfig = v.InferOutput<typeof SystemConfigSchema>;

/**
 * Input types (for validation before defaults are applied)
 */
export type AgentConfigInput = v.InferInput<typeof AgentConfigSchema>;
export type TaskConfigInput = v.InferInput<typeof TaskConfigSchema>;
export type SwarmConfigInput = v.InferInput<typeof SwarmConfigSchema>;
export type MemoryConfigInput = v.InferInput<typeof MemoryConfigSchema>;
export type MCPServerConfigInput = v.InferInput<typeof MCPServerConfigSchema>;
export type OrchestratorConfigInput = v.InferInput<typeof OrchestratorConfigSchema>;
export type SystemConfigInput = v.InferInput<typeof SystemConfigSchema>;
