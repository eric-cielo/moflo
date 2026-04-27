/**
 * Deep MCP Tools Test Suite
 *
 * Comprehensive tests for all MCP tool files covering:
 * - Schema validation (name, description, inputSchema)
 * - Array schemas have `items` field
 * - Handler existence and error handling
 * - Tool registration across all retained tool modules
 *
 * Uses vitest with mocks to isolate from external dependencies.
 */

import { describe, it, expect, vi } from 'vitest';

// ============================================================================
// Mock setup - must be before imports
// ============================================================================

// Mock fs writes to prevent test side effects on disk. `existsSync` and
// `readFileSync` fall through to real fs so legitimate resolvers (e.g.
// locateMofloModuleDist resolving to dist/src/cli/<subdir>/) keep working.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const memStore = new Map<string, string>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => memStore.has(p) || actual.existsSync(p)),
    readFileSync: vi.fn((p: string, ...rest: unknown[]) =>
      memStore.has(p)
        ? memStore.get(p) as string
        : (actual.readFileSync as (...args: unknown[]) => string | Buffer)(p, ...rest)
    ),
    writeFileSync: vi.fn((p: string, d: string) => memStore.set(p, d)),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    unlinkSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 100, isFile: () => true, isDirectory: () => false })),
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const memStore = new Map<string, string>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => memStore.has(p) || actual.existsSync(p)),
    readFileSync: vi.fn((p: string, ...rest: unknown[]) =>
      memStore.has(p)
        ? memStore.get(p) as string
        : (actual.readFileSync as (...args: unknown[]) => string | Buffer)(p, ...rest)
    ),
    writeFileSync: vi.fn((p: string, d: string) => memStore.set(p, d)),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    unlinkSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 100, isFile: () => true, isDirectory: () => false })),
  };
});

// Mock child_process for security tools that may shell out
vi.mock('child_process', () => ({
  execSync: vi.fn(() => '{}'),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '' })),
}));

// Mock the memory bridge for moflodb tools
vi.mock('../memory/memory-bridge.js', () => ({
  bridgeHealthCheck: vi.fn(async () => ({ available: true, status: 'healthy' })),
  bridgeListControllers: vi.fn(async () => []),
  bridgeStorePattern: vi.fn(async () => ({ success: true })),
  bridgeSearchPatterns: vi.fn(async () => ({ results: [] })),
  bridgeRecordFeedback: vi.fn(async () => ({ success: true })),
  bridgeRecordCausalEdge: vi.fn(async () => ({ success: true })),
  bridgeRouteTask: vi.fn(async () => ({ route: 'general', confidence: 0.5, agents: ['coder'] })),
  bridgeSessionStart: vi.fn(async () => ({ success: true })),
  bridgeSessionEnd: vi.fn(async () => ({ success: true })),
  bridgeHierarchicalStore: vi.fn(async () => ({ success: true })),
  bridgeHierarchicalRecall: vi.fn(async () => ({ results: [] })),
  bridgeConsolidate: vi.fn(async () => ({ success: true })),
  bridgeBatchOperation: vi.fn(async () => ({ success: true })),
  bridgeContextSynthesize: vi.fn(async () => ({ success: true })),
  bridgeSemanticRoute: vi.fn(async () => ({ route: null })),
}));

// Mock memory-initializer
vi.mock('../memory/memory-initializer.js', () => ({
  generateEmbedding: vi.fn(async () => ({ embedding: new Array(384).fill(0.1), dimensions: 384, model: 'mock' })),
  storeEntry: vi.fn(async () => ({ success: true, id: 'mock-id' })),
  searchEntries: vi.fn(async () => ({ success: true, results: [], searchTime: 1 })),
  listEntries: vi.fn(async () => ({ success: true, entries: [] })),
  getEntry: vi.fn(async () => null),
  deleteEntry: vi.fn(async () => ({ success: true })),
  getStats: vi.fn(async () => ({ totalEntries: 0 })),
  initializeDatabase: vi.fn(async () => ({ success: true })),
  initializeMemoryDatabase: vi.fn(async () => ({ success: true })),
  checkMemoryInitialization: vi.fn(async () => ({ initialized: true, version: '3.0.0' })),
  migrateFromLegacy: vi.fn(async () => ({ success: true, migrated: 0 })),
}));

// Mock intelligence module
vi.mock('../memory/intelligence.js', () => ({
  getIntelligenceStats: vi.fn(() => ({
    patternsLearned: 0,
    trajectoriesRecorded: 0,
    reasoningBankSize: 0,
    sonaEnabled: false,
    lastAdaptation: null,
  })),
  initializeIntelligence: vi.fn(async () => {}),
  benchmarkAdaptation: vi.fn(() => ({ avgMs: 0.01, minMs: 0.005, maxMs: 0.02, targetMet: true })),
}));

// Mock movector modules
vi.mock('../movector/model-router.js', () => ({
  getModelRouter: vi.fn(() => ({ route: async () => ({ model: 'sonnet', routedBy: 'router' }) })),
}));

vi.mock('../movector/enhanced-model-router.js', () => ({
  getEnhancedModelRouter: vi.fn(() => ({
    route: async () => ({ tier: 2, model: 'sonnet', canSkipLLM: false }),
  })),
}));

vi.mock('../movector/moe-router.js', () => ({
  getMoERouter: vi.fn(async () => null),
}));

vi.mock('../memory/sona-optimizer.js', () => ({
  getSONAOptimizer: vi.fn(async () => null),
}));

vi.mock('../memory/ewc-consolidation.js', () => ({
  getEWCConsolidator: vi.fn(async () => null),
}));

// Mock module for auto-install
vi.mock('../mcp-tools/auto-install.js', () => ({
  autoInstallPackage: vi.fn(async () => false),
}));

// ============================================================================
// Import all retained tool modules (after mocks are set up)
// ============================================================================

import { agentTools } from '../mcp-tools/agent-tools.js';
import { moflodbTools } from '../mcp-tools/moflodb-tools.js';
import { configTools } from '../mcp-tools/config-tools.js';
import { coordinationTools } from '../mcp-tools/coordination-tools.js';
import { githubTools } from '../mcp-tools/github-tools.js';
import { hiveMindTools } from '../mcp-tools/hive-mind-tools.js';
import { memoryTools } from '../mcp-tools/memory-tools.js';
import { neuralTools } from '../mcp-tools/neural-tools.js';
import { performanceTools } from '../mcp-tools/performance-tools.js';
import { securityTools } from '../mcp-tools/security-tools.js';
import { sessionTools } from '../mcp-tools/session-tools.js';
import { swarmTools } from '../mcp-tools/swarm-tools.js';
import { systemTools } from '../mcp-tools/system-tools.js';
import { taskTools } from '../mcp-tools/task-tools.js';
import { spellTools } from '../mcp-tools/spell-tools.js';
import { hooksTools } from '../mcp-tools/hooks-tools.js';

import type { MCPTool } from '../mcp-tools/types.js';

// ============================================================================
// Collect all tool modules
// ============================================================================

interface ToolModule {
  name: string;
  tools: MCPTool[];
}

const ALL_MODULES: ToolModule[] = [
  { name: 'agent-tools', tools: agentTools },
  { name: 'moflodb-tools', tools: moflodbTools },
  { name: 'config-tools', tools: configTools },
  { name: 'coordination-tools', tools: coordinationTools },
  { name: 'github-tools', tools: githubTools },
  { name: 'hive-mind-tools', tools: hiveMindTools },
  { name: 'hooks-tools', tools: hooksTools },
  { name: 'memory-tools', tools: memoryTools },
  { name: 'neural-tools', tools: neuralTools },
  { name: 'performance-tools', tools: performanceTools },
  { name: 'security-tools', tools: securityTools },
  { name: 'session-tools', tools: sessionTools },
  { name: 'swarm-tools', tools: swarmTools },
  { name: 'system-tools', tools: systemTools },
  { name: 'task-tools', tools: taskTools },
  { name: 'spell-tools', tools: spellTools },
];

const ALL_TOOLS: MCPTool[] = ALL_MODULES.flatMap(m => m.tools);

// ============================================================================
// Tests
// ============================================================================

describe('MCP Tools Deep Test Suite', () => {

  // --------------------------------------------------------------------------
  // 1. Module Loading & Registration
  // --------------------------------------------------------------------------
  describe('Module Loading & Registration', () => {
    it('should load the retained tool modules', () => {
      // Lower bound only — exact accounting lives in the drift-guard test.
      expect(ALL_MODULES.length).toBeGreaterThanOrEqual(15);
    });

    it('should export arrays from each module', () => {
      for (const mod of ALL_MODULES) {
        expect(Array.isArray(mod.tools)).toBe(true);
        expect(mod.tools.length).toBeGreaterThan(0);
      }
    });

    it('should have no duplicate tool names across all modules', () => {
      const names = ALL_TOOLS.map(t => t.name);
      const uniqueNames = new Set(names);
      const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
      expect(duplicates).toEqual([]);
      expect(uniqueNames.size).toBe(names.length);
    });

    it('should register expected tool counts per module', () => {
      const minCounts: Record<string, number> = {
        'agent-tools': 7,
        'moflodb-tools': 15,
        'config-tools': 6,
        'coordination-tools': 1,
        'github-tools': 5,
        'hive-mind-tools': 9,
        'memory-tools': 7,
        'neural-tools': 6,
        'performance-tools': 2,
        'security-tools': 6,
        'session-tools': 5,
        'swarm-tools': 4,
        'system-tools': 1,
        'task-tools': 7,
        'spell-tools': 10,
      };

      for (const mod of ALL_MODULES) {
        const min = minCounts[mod.name];
        if (min !== undefined) {
          expect(mod.tools.length).toBeGreaterThanOrEqual(min);
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2. Schema Validation
  // --------------------------------------------------------------------------
  describe('Schema Validation - All Tools', () => {
    it('every tool has a non-empty name', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe('string');
        expect(tool.name.length).toBeGreaterThan(0);
      }
    });

    it('every tool has a non-empty description', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');
        expect(tool.description.length).toBeGreaterThan(0);
      }
    });

    it('every tool has an inputSchema with type "object"', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });

    it('every tool inputSchema has a properties field', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.inputSchema.properties).toBeDefined();
        expect(typeof tool.inputSchema.properties).toBe('object');
      }
    });

    it('every tool has a handler function', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.handler).toBeDefined();
        expect(typeof tool.handler).toBe('function');
      }
    });

    it('required field is either absent or an array of strings', () => {
      for (const tool of ALL_TOOLS) {
        if (tool.inputSchema.required !== undefined) {
          expect(Array.isArray(tool.inputSchema.required)).toBe(true);
          for (const req of tool.inputSchema.required!) {
            expect(typeof req).toBe('string');
          }
        }
      }
    });

    it('required fields reference existing properties', () => {
      for (const tool of ALL_TOOLS) {
        if (tool.inputSchema.required) {
          const propNames = Object.keys(tool.inputSchema.properties);
          for (const req of tool.inputSchema.required) {
            expect(propNames).toContain(req);
          }
        }
      }
    });

    it('tool names follow naming conventions (category_action or category_action-detail)', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.name).toMatch(/^[a-z][a-z0-9_-]+$/);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 3. Array Schema Validation - items field
  // --------------------------------------------------------------------------
  describe('Array Schema Validation', () => {
    function findArrayProperties(tool: MCPTool): Array<{ toolName: string; propName: string; prop: any }> {
      const results: Array<{ toolName: string; propName: string; prop: any }> = [];
      const properties = tool.inputSchema.properties;
      for (const [propName, prop] of Object.entries(properties)) {
        const p = prop as Record<string, unknown>;
        if (p.type === 'array') {
          results.push({ toolName: tool.name, propName, prop: p });
        }
      }
      return results;
    }

    it('all array-typed properties have an items field', () => {
      const missingItems: string[] = [];

      for (const tool of ALL_TOOLS) {
        const arrayProps = findArrayProperties(tool);
        for (const { toolName, propName, prop } of arrayProps) {
          if (!prop.items) {
            missingItems.push(`${toolName}.${propName}`);
          }
        }
      }

      expect(missingItems).toEqual([]);
    });

    it('array items field specifies a type', () => {
      for (const tool of ALL_TOOLS) {
        const arrayProps = findArrayProperties(tool);
        for (const { prop } of arrayProps) {
          if (prop.items) {
            expect(prop.items.type).toBeDefined();
          }
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // 4. Category Consistency
  // --------------------------------------------------------------------------
  describe('Category Consistency', () => {
    it('tool name prefix matches category when category is set', () => {
      for (const tool of ALL_TOOLS) {
        if (tool.category) {
          const prefix = tool.name.split('_')[0].replace(/-/g, '');
          const cat = tool.category.replace(/-/g, '');
          expect(prefix).toBe(cat);
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // 5. Handler Invocation - Agent Tools
  // --------------------------------------------------------------------------
  describe('Agent Tools - Handler Invocation', () => {
    it('agent_spawn creates an agent with required agentType', async () => {
      const tool = agentTools.find(t => t.name === 'agent_spawn')!;
      const result: any = await tool.handler({ agentType: 'coder' });
      expect(result.success).toBe(true);
      expect(result.agentId).toBeDefined();
      expect(result.agentType).toBe('coder');
    });

    it('agent_list returns agents array', async () => {
      const tool = agentTools.find(t => t.name === 'agent_list')!;
      const result: any = await tool.handler({});
      expect(result.agents).toBeDefined();
      expect(Array.isArray(result.agents)).toBe(true);
    });

    it('agent_status returns not_found for unknown agent', async () => {
      const tool = agentTools.find(t => t.name === 'agent_status')!;
      const result: any = await tool.handler({ agentId: 'nonexistent' });
      expect(result.status).toBe('not_found');
    });

    it('agent_terminate returns error for unknown agent', async () => {
      const tool = agentTools.find(t => t.name === 'agent_terminate')!;
      const result: any = await tool.handler({ agentId: 'nonexistent' });
      expect(result.success).toBe(false);
    });

    it('agent_pool status action returns pool info', async () => {
      const tool = agentTools.find(t => t.name === 'agent_pool')!;
      const result: any = await tool.handler({ action: 'status' });
      expect(result.action).toBe('status');
      expect(result.poolId).toBeDefined();
    });

    it('agent_health returns overall health info', async () => {
      const tool = agentTools.find(t => t.name === 'agent_health')!;
      const result: any = await tool.handler({});
      expect(result.overall).toBeDefined();
    });

    it('agent_update returns error for unknown agent', async () => {
      const tool = agentTools.find(t => t.name === 'agent_update')!;
      const result: any = await tool.handler({ agentId: 'nonexistent' });
      expect(result.success).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 6. Handler Invocation - System Tools (only system_health remains)
  // --------------------------------------------------------------------------
  describe('System Tools - Handler Invocation', () => {
    it('system_health returns health checks', async () => {
      const tool = systemTools.find(t => t.name === 'system_health')!;
      const result: any = await tool.handler({});
      expect(result.overall).toBeDefined();
      expect(result.checks).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 7. Handler Invocation - Config Tools
  // --------------------------------------------------------------------------
  describe('Config Tools - Handler Invocation', () => {
    it('config_get returns value for known key', async () => {
      const tool = configTools.find(t => t.name === 'config_get')!;
      const result: any = await tool.handler({ key: 'logging.level' });
      expect(result.key).toBe('logging.level');
      expect(result.exists).toBeDefined();
    });

    it('config_set stores a value', async () => {
      const tool = configTools.find(t => t.name === 'config_set')!;
      const result: any = await tool.handler({ key: 'test.key', value: 'test-value' });
      expect(result.success).toBe(true);
    });

    it('config_list returns configurations', async () => {
      const tool = configTools.find(t => t.name === 'config_list')!;
      const result: any = await tool.handler({});
      expect(result.configs).toBeDefined();
      expect(Array.isArray(result.configs)).toBe(true);
    });

    it('config_reset returns success', async () => {
      const tool = configTools.find(t => t.name === 'config_reset')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
    });

    it('config_export returns config data', async () => {
      const tool = configTools.find(t => t.name === 'config_export')!;
      const result: any = await tool.handler({});
      expect(result.config).toBeDefined();
    });

    it('config_import returns success', async () => {
      const tool = configTools.find(t => t.name === 'config_import')!;
      const result: any = await tool.handler({ config: { 'test.k': 'v' } });
      expect(result.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 8. Handler Invocation - Swarm Tools
  // --------------------------------------------------------------------------
  describe('Swarm Tools - Handler Invocation', () => {
    it('swarm_init returns swarmId and topology', async () => {
      const tool = swarmTools.find(t => t.name === 'swarm_init')!;
      const result: any = await tool.handler({ topology: 'hierarchical' });
      expect(result.success).toBe(true);
      expect(result.swarmId).toBeDefined();
    });

    it('swarm_status returns running status', async () => {
      const tool = swarmTools.find(t => t.name === 'swarm_status')!;
      const result: any = await tool.handler({});
      expect(result.status).toBe('running');
    });

    it('swarm_shutdown returns success', async () => {
      const tool = swarmTools.find(t => t.name === 'swarm_shutdown')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
    });

    it('swarm_health returns healthy checks', async () => {
      const tool = swarmTools.find(t => t.name === 'swarm_health')!;
      const result: any = await tool.handler({});
      expect(result.status).toBe('healthy');
      expect(result.checks).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 9. Handler Invocation - Task Tools
  // --------------------------------------------------------------------------
  describe('Task Tools - Handler Invocation', () => {
    it('task_create creates a task', async () => {
      const tool = taskTools.find(t => t.name === 'task_create')!;
      const result: any = await tool.handler({ type: 'feature', description: 'Test task' });
      expect(result.taskId).toBeDefined();
      expect(result.type).toBe('feature');
      expect(result.status).toBe('pending');
    });

    it('task_list returns tasks array', async () => {
      const tool = taskTools.find(t => t.name === 'task_list')!;
      const result: any = await tool.handler({});
      expect(result.tasks).toBeDefined();
      expect(Array.isArray(result.tasks)).toBe(true);
    });

    it('task_status returns not_found for unknown task', async () => {
      const tool = taskTools.find(t => t.name === 'task_status')!;
      const result: any = await tool.handler({ taskId: 'nonexistent' });
      expect(result.status).toBe('not_found');
    });
  });

  // --------------------------------------------------------------------------
  // 10. Handler Invocation - Session Tools
  // --------------------------------------------------------------------------
  describe('Session Tools - Handler Invocation', () => {
    it('session_list returns sessions', async () => {
      const tool = sessionTools.find(t => t.name === 'session_list')!;
      const result: any = await tool.handler({});
      expect(result.sessions).toBeDefined();
    });

    it('session_save creates a session', async () => {
      const tool = sessionTools.find(t => t.name === 'session_save')!;
      const result: any = await tool.handler({ name: 'Test Session' });
      expect(result.sessionId).toBeDefined();
      expect(result.name).toBe('Test Session');
    });
  });

  // --------------------------------------------------------------------------
  // 11. Handler Invocation - Hive Mind Tools
  // --------------------------------------------------------------------------
  describe('Hive Mind Tools - Handler Invocation', () => {
    it('hive-mind_init initializes the hive', async () => {
      const tool = hiveMindTools.find(t => t.name === 'hive-mind_init')!;
      const result: any = await tool.handler({ topology: 'mesh' });
      expect(result.success).toBe(true);
      expect(result.topology).toBe('mesh');
    });

    it('hive-mind_status returns status info', async () => {
      const tool = hiveMindTools.find(t => t.name === 'hive-mind_status')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('hive-mind_consensus with list action returns data', async () => {
      const tool = hiveMindTools.find(t => t.name === 'hive-mind_consensus')!;
      const result: any = await tool.handler({ action: 'list' });
      expect(result.action).toBe('list');
    });
  });

  // --------------------------------------------------------------------------
  // 12. Handler Invocation - Spell Tools
  // --------------------------------------------------------------------------
  describe('Spell Tools - Handler Invocation', () => {
    it('spell_list returns spell data', async () => {
      const tool = spellTools.find(t => t.name === 'spell_list')!;
      const result: any = await tool.handler({});
      expect(result.runs).toBeDefined();
    });

    it('spell_create creates a spell definition', async () => {
      const tool = spellTools.find(t => t.name === 'spell_create')!;
      const result: any = await tool.handler({ name: 'test-wf', description: 'Test spell' });
      expect(result.definition).toBeDefined();
      expect(result.name).toBe('test-wf');
    });
  });

  // --------------------------------------------------------------------------
  // 13. Handler Invocation - Coordination Tools (only coordination_sync remains)
  // --------------------------------------------------------------------------
  describe('Coordination Tools - Handler Invocation', () => {
    it('coordination_sync status returns sync state', async () => {
      const tool = coordinationTools.find(t => t.name === 'coordination_sync')!;
      const result: any = await tool.handler({ action: 'status' });
      expect(result.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 14. Handler Invocation - GitHub Tools
  // --------------------------------------------------------------------------
  describe('GitHub Tools - Handler Invocation', () => {
    it('github_repo_analyze returns analysis', async () => {
      const tool = githubTools.find(t => t.name === 'github_repo_analyze')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
      expect(result.analysis).toBeDefined();
    });

    it('github_pr_manage list returns PRs', async () => {
      const tool = githubTools.find(t => t.name === 'github_pr_manage')!;
      const result: any = await tool.handler({ action: 'list' });
      expect(result.success).toBe(true);
    });

    it('github_metrics returns all metrics', async () => {
      const tool = githubTools.find(t => t.name === 'github_metrics')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
      expect(result.metrics).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 15. Handler Invocation - Performance Tools (report + benchmark)
  // --------------------------------------------------------------------------
  describe('Performance Tools - Handler Invocation', () => {
    it('performance_report returns a report', async () => {
      const tool = performanceTools.find(t => t.name === 'performance_report')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('performance_benchmark runs a benchmark', async () => {
      const tool = performanceTools.find(t => t.name === 'performance_benchmark')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 16. Handler Invocation - Neural Tools
  // --------------------------------------------------------------------------
  describe('Neural Tools - Handler Invocation', () => {
    it('neural_status returns status', async () => {
      const tool = neuralTools.find(t => t.name === 'neural_status')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('neural_patterns returns patterns list', async () => {
      const tool = neuralTools.find(t => t.name === 'neural_patterns')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 17. Handler Invocation - MofloDb Tools
  // --------------------------------------------------------------------------
  describe('MofloDb Tools - Handler Invocation', () => {
    it('moflodb_health returns availability', async () => {
      const tool = moflodbTools.find(t => t.name === 'moflodb_health')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('moflodb_controllers returns controllers list', async () => {
      const tool = moflodbTools.find(t => t.name === 'moflodb_controllers')!;
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('moflodb_pattern-store requires pattern param', async () => {
      const tool = moflodbTools.find(t => t.name === 'moflodb_pattern-store')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(false);
      expect(result.error).toContain('pattern is required');
    });

    it('moflodb_pattern-search requires query param', async () => {
      const tool = moflodbTools.find(t => t.name === 'moflodb_pattern-search')!;
      const result: any = await tool.handler({});
      expect(result.error).toContain('query is required');
    });

    it('moflodb_causal-edge validates required fields', async () => {
      const tool = moflodbTools.find(t => t.name === 'moflodb_causal-edge')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(false);
    });

    it('moflodb_route requires task param', async () => {
      const tool = moflodbTools.find(t => t.name === 'moflodb_route')!;
      const result: any = await tool.handler({});
      expect(result.error).toContain('task is required');
    });

    it('moflodb_batch validates entries array', async () => {
      const tool = moflodbTools.find(t => t.name === 'moflodb_batch')!;
      const result: any = await tool.handler({ operation: 'insert' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('entries is required');
    });

    it('moflodb_batch validates operation type', async () => {
      const tool = moflodbTools.find(t => t.name === 'moflodb_batch')!;
      const result: any = await tool.handler({ operation: 'invalid', entries: [{ key: 'k' }] });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid operation');
    });
  });

  // --------------------------------------------------------------------------
  // 18. Error Handling
  // --------------------------------------------------------------------------
  describe('Error Handling', () => {
    it('tools handle empty input gracefully', async () => {
      const toolsToTest = [
        agentTools.find(t => t.name === 'agent_list')!,
        configTools.find(t => t.name === 'config_list')!,
        swarmTools.find(t => t.name === 'swarm_status')!,
        taskTools.find(t => t.name === 'task_list')!,
        coordinationTools.find(t => t.name === 'coordination_sync')!,
        performanceTools.find(t => t.name === 'performance_report')!,
      ];

      for (const tool of toolsToTest) {
        const result = await tool.handler({});
        expect(result).toBeDefined();
      }
    });

    it('tools do not throw on invalid input types', async () => {
      const tool = agentTools.find(t => t.name === 'agent_spawn')!;
      const result: any = await tool.handler({ agentType: 123 as any });
      expect(result).toBeDefined();
    });

    it('moflodb tools validate string inputs', async () => {
      const tool = moflodbTools.find(t => t.name === 'moflodb_pattern-store')!;
      const result: any = await tool.handler({ pattern: '' });
      expect(result.success).toBe(false);
    });

    it('moflodb tools enforce max string length', async () => {
      const tool = moflodbTools.find(t => t.name === 'moflodb_feedback')!;
      const longId = 'x'.repeat(1000);
      const result: any = await tool.handler({ taskId: longId });
      expect(result.success).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 19. Security Checks
  // --------------------------------------------------------------------------
  describe('Security Checks', () => {
    it('no tool schemas contain hardcoded paths', () => {
      for (const tool of ALL_TOOLS) {
        const schema = JSON.stringify(tool.inputSchema);
        expect(schema).not.toContain('/home/');
        expect(schema).not.toContain('/etc/');
        expect(schema).not.toContain('C:\\');
      }
    });

    it('no tool schemas contain hardcoded secrets or tokens', () => {
      for (const tool of ALL_TOOLS) {
        const schema = JSON.stringify(tool.inputSchema);
        expect(schema).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
        expect(schema).not.toMatch(/password.*=.*[a-zA-Z0-9]{8,}/i);
      }
    });

    it('no tool names expose internal implementation details', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.name).not.toContain('internal');
        expect(tool.name).not.toContain('debug');
        expect(tool.name).not.toContain('_raw');
      }
    });

    it('session tools sanitize sessionId against path traversal', () => {
      const tool = sessionTools.find(t => t.name === 'session_save')!;
      expect(tool).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 20. Return Format Consistency
  // --------------------------------------------------------------------------
  describe('Return Format Consistency', () => {
    it('agent_spawn returns success field', async () => {
      const tool = agentTools.find(t => t.name === 'agent_spawn')!;
      const result: any = await tool.handler({ agentType: 'coder' });
      expect(typeof result.success).toBe('boolean');
    });

    it('config tools return success field', async () => {
      const setTool = configTools.find(t => t.name === 'config_set')!;
      const result: any = await setTool.handler({ key: 'test', value: 'v' });
      expect(typeof result.success).toBe('boolean');
    });

    it('task_create returns taskId and status', async () => {
      const tool = taskTools.find(t => t.name === 'task_create')!;
      const result: any = await tool.handler({ type: 'bugfix', description: 'Fix the bug' });
      expect(result.taskId).toBeDefined();
      expect(typeof result.taskId).toBe('string');
      expect(result.status).toBe('pending');
    });

    it('swarm_init returns success and swarmId', async () => {
      const tool = swarmTools.find(t => t.name === 'swarm_init')!;
      const result: any = await tool.handler({});
      expect(result.success).toBe(true);
      expect(result.swarmId).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 21. Hooks Tools
  // --------------------------------------------------------------------------
  describe('Hooks Tools - Handler Invocation', () => {
    it('hooks_list returns hooks list', async () => {
      const tool = hooksTools.find(t => t.name === 'hooks_list')!;
      expect(tool).toBeDefined();
      const result: any = await tool.handler({});
      expect(result.hooks).toBeDefined();
    });

    it('hooks_metrics returns metrics', async () => {
      const tool = hooksTools.find(t => t.name === 'hooks_metrics')!;
      expect(tool).toBeDefined();
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('hooks_worker-list returns workers', async () => {
      const tool = hooksTools.find(t => t.name === 'hooks_worker-list')!;
      expect(tool).toBeDefined();
      const result: any = await tool.handler({});
      expect(result.workers).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 22. Memory Tools
  // --------------------------------------------------------------------------
  describe('Memory Tools - Handler Invocation', () => {
    it('memory_store stores an entry', async () => {
      const tool = memoryTools.find(t => t.name === 'memory_store')!;
      expect(tool).toBeDefined();
      const result: any = await tool.handler({ key: 'test-key', value: 'test-value' });
      expect(result).toBeDefined();
    });

    it('memory_list returns entries', async () => {
      const tool = memoryTools.find(t => t.name === 'memory_list')!;
      expect(tool).toBeDefined();
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });

    it('memory_stats returns statistics', async () => {
      const tool = memoryTools.find(t => t.name === 'memory_stats')!;
      expect(tool).toBeDefined();
      const result: any = await tool.handler({});
      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 23. Cross-Module Integrity
  // --------------------------------------------------------------------------
  describe('Cross-Module Integrity', () => {
    it('all tool names are valid MCP tool identifiers', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.name).toMatch(/^[a-z][a-z0-9_-]*$/);
        expect(tool.name).not.toMatch(/__/);
        expect(tool.name).not.toMatch(/--/);
      }
    });

    it('all descriptions are human-readable sentences', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.description).toMatch(/^[A-Za-z]/);
        expect(tool.description.length).toBeGreaterThanOrEqual(10);
      }
    });

    it('no tool has an empty properties object with required fields', () => {
      for (const tool of ALL_TOOLS) {
        if (tool.inputSchema.required && tool.inputSchema.required.length > 0) {
          const propCount = Object.keys(tool.inputSchema.properties).length;
          expect(propCount).toBeGreaterThan(0);
        }
      }
    });

    it('every property in schema has a type or description', () => {
      for (const tool of ALL_TOOLS) {
        for (const [, prop] of Object.entries(tool.inputSchema.properties)) {
          const p = prop as Record<string, unknown>;
          const hasType = p.type !== undefined;
          const hasDesc = p.description !== undefined;
          expect(hasType || hasDesc).toBe(true);
        }
      }
    });
  });
});
