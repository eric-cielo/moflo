# ADR-017: RuVector Integration Architecture

**Status:** Proposed
**Date:** 2026-01-07
**Author:** System Architecture Designer
**Version:** 1.0.0

## Context

The `@claude-flow/cli` package requires integration with `ruvector` for advanced code intelligence features:

1. **Q-Learning Agent Router** - ML-based task routing (80%+ accuracy)
2. **AST Analysis** - Symbol extraction and complexity metrics
3. **Diff Classification** - Change risk scoring
4. **Coverage Routing** - Test-aware agent selection
5. **Graph Analysis** - Code boundaries (MinCut/Louvain)

These features are unique to ruvector and complement claude-flow's existing capabilities without duplicating functionality already present in `@claude-flow/embeddings` or `@claude-flow/memory`.

## Decision

Implement ruvector as an **OPTIONAL dependency** with graceful fallback, following the existing patterns in `@claude-flow/cli`.

### Design Principles

1. **Optional by Default** - ruvector is not required; all commands degrade gracefully
2. **Consistent CLI Patterns** - Match existing command structure (`agent`, `hooks`, `neural`)
3. **MCP-First Architecture** - CLI wraps MCP tools per ADR-005
4. **Lazy Loading** - Only load ruvector modules when needed
5. **Clear Error Messages** - Helpful guidance when ruvector is missing

---

## File Structure

```
v3/@claude-flow/cli/src/
├── commands/
│   ├── route.ts              # NEW: Q-Learning routing command
│   ├── analyze.ts            # NEW: AST/Diff/Graph analysis commands
│   └── index.ts              # Updated: register new commands
├── ruvector/
│   ├── index.ts              # Lazy loader with availability check
│   ├── types.ts              # TypeScript interfaces for ruvector
│   ├── availability.ts       # Package detection utilities
│   └── adapters/
│       ├── router-adapter.ts # Wraps hooks_route, hooks_route_enhanced
│       ├── ast-adapter.ts    # Wraps hooks_ast_analyze, hooks_ast_complexity
│       ├── diff-adapter.ts   # Wraps hooks_diff_analyze, hooks_diff_classify
│       ├── coverage-adapter.ts # Wraps hooks_coverage_route
│       └── graph-adapter.ts  # Wraps hooks_graph_mincut, hooks_graph_cluster
├── mcp-tools/
│   └── ruvector-tools.ts     # NEW: MCP tool definitions for ruvector
└── package.json              # Updated: optionalDependencies
```

---

## Interface Definitions

### 1. RuVector Availability Interface

```typescript
// v3/@claude-flow/cli/src/ruvector/availability.ts

/**
 * RuVector availability state
 */
export interface RuVectorStatus {
  available: boolean;
  version?: string;
  features: RuVectorFeatures;
  error?: string;
}

export interface RuVectorFeatures {
  qLearningRouter: boolean;
  astAnalysis: boolean;
  diffClassification: boolean;
  coverageRouting: boolean;
  graphAnalysis: boolean;
}

/**
 * Check if ruvector is installed and available
 * Uses lazy evaluation and caching
 */
export async function checkRuVectorAvailability(): Promise<RuVectorStatus>;

/**
 * Get human-readable installation instructions
 */
export function getInstallInstructions(): string;

/**
 * Require ruvector feature, throw helpful error if unavailable
 */
export async function requireRuVector(feature: keyof RuVectorFeatures): Promise<void>;
```

### 2. Router Adapter Interface

```typescript
// v3/@claude-flow/cli/src/ruvector/adapters/router-adapter.ts

export interface RouteRequest {
  task: string;
  context?: string;
  options?: {
    useQLearning?: boolean;
    useCoverageAware?: boolean;
    includeExplanation?: boolean;
    maxAgents?: number;
  };
}

export interface RouteResult {
  recommendedAgents: AgentRecommendation[];
  confidence: number;
  reasoning: string;
  learningFeedback?: {
    modelVersion: string;
    trainingEpisodes: number;
  };
}

export interface AgentRecommendation {
  type: string;
  score: number;
  rationale: string;
  capabilities: string[];
}

/**
 * Route task using Q-Learning model
 * @throws RuVectorNotAvailableError if ruvector not installed
 */
export async function routeWithQLearning(request: RouteRequest): Promise<RouteResult>;

/**
 * Route with coverage awareness
 * @throws RuVectorNotAvailableError if ruvector not installed
 */
export async function routeWithCoverage(request: RouteRequest): Promise<RouteResult>;
```

### 3. AST Adapter Interface

```typescript
// v3/@claude-flow/cli/src/ruvector/adapters/ast-adapter.ts

export interface ASTAnalysisRequest {
  path: string;
  options?: {
    includeSymbols?: boolean;
    includeComplexity?: boolean;
    includeDependencies?: boolean;
    recursive?: boolean;
  };
}

export interface ASTAnalysisResult {
  files: FileAnalysis[];
  summary: {
    totalFiles: number;
    totalFunctions: number;
    totalClasses: number;
    avgComplexity: number;
    maxComplexity: number;
  };
}

export interface FileAnalysis {
  path: string;
  language: string;
  symbols: Symbol[];
  complexity: ComplexityMetrics;
  dependencies: string[];
}

export interface Symbol {
  name: string;
  type: 'function' | 'class' | 'interface' | 'variable' | 'type';
  line: number;
  exported: boolean;
  parameters?: string[];
}

export interface ComplexityMetrics {
  cyclomatic: number;
  cognitive: number;
  linesOfCode: number;
  maintainabilityIndex: number;
}

/**
 * Analyze AST of files at path
 * @throws RuVectorNotAvailableError if ruvector not installed
 */
export async function analyzeAST(request: ASTAnalysisRequest): Promise<ASTAnalysisResult>;

/**
 * Get complexity metrics for path
 * @throws RuVectorNotAvailableError if ruvector not installed
 */
export async function getComplexity(path: string): Promise<ComplexityMetrics>;
```

### 4. Diff Adapter Interface

```typescript
// v3/@claude-flow/cli/src/ruvector/adapters/diff-adapter.ts

export interface DiffAnalysisRequest {
  diff?: string;
  baseBranch?: string;
  targetBranch?: string;
  options?: {
    includeRisk?: boolean;
    includeClassification?: boolean;
  };
}

export interface DiffAnalysisResult {
  classification: DiffClassification;
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  affectedFiles: AffectedFile[];
  recommendations: string[];
}

export type DiffClassification =
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'documentation'
  | 'test'
  | 'config'
  | 'dependency'
  | 'breaking';

export interface AffectedFile {
  path: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  riskContribution: number;
}

/**
 * Analyze diff and classify changes
 * @throws RuVectorNotAvailableError if ruvector not installed
 */
export async function analyzeDiff(request: DiffAnalysisRequest): Promise<DiffAnalysisResult>;

/**
 * Get risk score for diff
 * @throws RuVectorNotAvailableError if ruvector not installed
 */
export async function classifyDiffRisk(diff: string): Promise<number>;
```

### 5. Graph Adapter Interface

```typescript
// v3/@claude-flow/cli/src/ruvector/adapters/graph-adapter.ts

export interface GraphAnalysisRequest {
  path: string;
  options?: {
    algorithm?: 'mincut' | 'louvain' | 'both';
    minModuleSize?: number;
    resolution?: number;
  };
}

export interface GraphAnalysisResult {
  modules: CodeModule[];
  boundaries: Boundary[];
  metrics: GraphMetrics;
}

export interface CodeModule {
  id: string;
  name: string;
  files: string[];
  cohesion: number;
  coupling: number;
}

export interface Boundary {
  from: string;
  to: string;
  strength: number;
  suggestedSplit: boolean;
}

export interface GraphMetrics {
  modularity: number;
  avgCohesion: number;
  avgCoupling: number;
  suggestedBoundaries: number;
}

/**
 * Analyze code boundaries using graph algorithms
 * @throws RuVectorNotAvailableError if ruvector not installed
 */
export async function analyzeGraphBoundaries(request: GraphAnalysisRequest): Promise<GraphAnalysisResult>;
```

---

## CLI Command Definitions

### 1. Route Command

```typescript
// v3/@claude-flow/cli/src/commands/route.ts

export const routeCommand: Command = {
  name: 'route',
  description: 'Route tasks to optimal agents using ML-based routing',
  options: [
    {
      name: 'task',
      short: 't',
      description: 'Task description to route',
      type: 'string',
      required: true
    },
    {
      name: 'q-learning',
      short: 'q',
      description: 'Use Q-Learning model for routing (requires ruvector)',
      type: 'boolean',
      default: false
    },
    {
      name: 'coverage-aware',
      short: 'c',
      description: 'Use test coverage data for routing (requires ruvector)',
      type: 'boolean',
      default: false
    },
    {
      name: 'explain',
      short: 'e',
      description: 'Include detailed explanation of routing decision',
      type: 'boolean',
      default: false
    },
    {
      name: 'max-agents',
      short: 'm',
      description: 'Maximum number of agent recommendations',
      type: 'number',
      default: 3
    }
  ],
  examples: [
    {
      command: 'claude-flow route -t "Implement user authentication" --q-learning',
      description: 'Route with Q-Learning model'
    },
    {
      command: 'claude-flow route -t "Fix login bug" --coverage-aware',
      description: 'Route with coverage awareness'
    }
  ],
  action: routeAction
};
```

### 2. Analyze Command

```typescript
// v3/@claude-flow/cli/src/commands/analyze.ts

export const analyzeCommand: Command = {
  name: 'analyze',
  description: 'Code analysis tools (AST, diff, boundaries)',
  subcommands: [astSubcommand, diffSubcommand, boundariesSubcommand],
  options: [],
  action: analyzeHelpAction
};

const astSubcommand: Command = {
  name: 'ast',
  description: 'Analyze code AST for symbols and complexity',
  options: [
    {
      name: 'path',
      short: 'p',
      description: 'Path to analyze (file or directory)',
      type: 'string',
      required: true
    },
    {
      name: 'recursive',
      short: 'r',
      description: 'Recursively analyze directories',
      type: 'boolean',
      default: true
    },
    {
      name: 'complexity',
      description: 'Include complexity metrics',
      type: 'boolean',
      default: true
    },
    {
      name: 'symbols',
      description: 'Include symbol extraction',
      type: 'boolean',
      default: true
    }
  ],
  examples: [
    { command: 'claude-flow analyze ast -p src/', description: 'Analyze src directory' },
    { command: 'claude-flow analyze ast -p src/api.ts --complexity', description: 'Get complexity for file' }
  ],
  action: astAction
};

const diffSubcommand: Command = {
  name: 'diff',
  description: 'Analyze and classify code diffs',
  options: [
    {
      name: 'risk',
      short: 'r',
      description: 'Include risk assessment',
      type: 'boolean',
      default: true
    },
    {
      name: 'base',
      short: 'b',
      description: 'Base branch for comparison',
      type: 'string',
      default: 'main'
    },
    {
      name: 'target',
      description: 'Target branch for comparison',
      type: 'string'
    },
    {
      name: 'stdin',
      description: 'Read diff from stdin',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow analyze diff --risk', description: 'Analyze current diff with risk' },
    { command: 'claude-flow analyze diff --base main --target feature', description: 'Compare branches' },
    { command: 'git diff | claude-flow analyze diff --stdin --risk', description: 'Pipe diff from git' }
  ],
  action: diffAction
};

const boundariesSubcommand: Command = {
  name: 'boundaries',
  description: 'Detect code boundaries using graph algorithms',
  options: [
    {
      name: 'path',
      short: 'p',
      description: 'Path to analyze',
      type: 'string',
      default: '.'
    },
    {
      name: 'algorithm',
      short: 'a',
      description: 'Algorithm: mincut, louvain, or both',
      type: 'string',
      choices: ['mincut', 'louvain', 'both'],
      default: 'both'
    },
    {
      name: 'min-module-size',
      description: 'Minimum files per detected module',
      type: 'number',
      default: 3
    }
  ],
  examples: [
    { command: 'claude-flow analyze boundaries -p src/', description: 'Detect boundaries in src' },
    { command: 'claude-flow analyze boundaries -a louvain', description: 'Use Louvain algorithm' }
  ],
  action: boundariesAction
};
```

---

## Error Handling Strategy

### 1. RuVector Not Available Error

```typescript
// v3/@claude-flow/cli/src/ruvector/errors.ts

export class RuVectorNotAvailableError extends CLIError {
  constructor(feature: string) {
    super(
      `RuVector is required for ${feature} but is not installed.`,
      'RUVECTOR_NOT_AVAILABLE',
      1,
      {
        feature,
        suggestion: 'Install with: npm install ruvector',
        documentation: 'https://github.com/ruvnet/ruvector'
      }
    );
    this.name = 'RuVectorNotAvailableError';
  }
}

export class RuVectorFeatureDisabledError extends CLIError {
  constructor(feature: string, reason: string) {
    super(
      `RuVector feature "${feature}" is disabled: ${reason}`,
      'RUVECTOR_FEATURE_DISABLED',
      1
    );
    this.name = 'RuVectorFeatureDisabledError';
  }
}
```

### 2. Graceful Degradation Pattern

```typescript
// v3/@claude-flow/cli/src/ruvector/availability.ts

let cachedStatus: RuVectorStatus | null = null;

export async function checkRuVectorAvailability(): Promise<RuVectorStatus> {
  if (cachedStatus) return cachedStatus;

  try {
    // Attempt dynamic import
    const ruvector = await import('ruvector');

    cachedStatus = {
      available: true,
      version: ruvector.version ?? 'unknown',
      features: {
        qLearningRouter: typeof ruvector.hooks_route === 'function',
        astAnalysis: typeof ruvector.hooks_ast_analyze === 'function',
        diffClassification: typeof ruvector.hooks_diff_analyze === 'function',
        coverageRouting: typeof ruvector.hooks_coverage_route === 'function',
        graphAnalysis: typeof ruvector.hooks_graph_mincut === 'function',
      }
    };
  } catch (error) {
    cachedStatus = {
      available: false,
      features: {
        qLearningRouter: false,
        astAnalysis: false,
        diffClassification: false,
        coverageRouting: false,
        graphAnalysis: false,
      },
      error: error instanceof Error ? error.message : String(error)
    };
  }

  return cachedStatus;
}

export function getInstallInstructions(): string {
  return `
RuVector provides advanced code intelligence features:
  - Q-Learning agent routing (80%+ accuracy)
  - AST analysis and complexity metrics
  - Diff classification and risk scoring
  - Coverage-aware routing
  - Graph-based boundary detection

Install with:
  npm install ruvector

Or add as optional dependency:
  npm install ruvector --save-optional

Learn more: https://github.com/ruvnet/ruvector
`.trim();
}

export async function requireRuVector(feature: keyof RuVectorFeatures): Promise<void> {
  const status = await checkRuVectorAvailability();

  if (!status.available) {
    throw new RuVectorNotAvailableError(feature);
  }

  if (!status.features[feature]) {
    throw new RuVectorFeatureDisabledError(
      feature,
      `Your version of ruvector (${status.version}) does not support this feature.`
    );
  }
}
```

### 3. CLI Error Display

```typescript
// In command action handlers

async function routeAction(ctx: CommandContext): Promise<CommandResult> {
  const useQLearning = ctx.flags['q-learning'] as boolean;
  const useCoverageAware = ctx.flags['coverage-aware'] as boolean;

  // Check if ruvector features are needed
  if (useQLearning || useCoverageAware) {
    try {
      const feature = useQLearning ? 'qLearningRouter' : 'coverageRouting';
      await requireRuVector(feature);
    } catch (error) {
      if (error instanceof RuVectorNotAvailableError) {
        output.printError(error.message);
        output.writeln();
        output.printBox(getInstallInstructions(), 'Install RuVector');
        output.writeln();
        output.printInfo('Falling back to default agent routing...');

        // Fall back to default routing
        return fallbackRoute(ctx);
      }
      throw error;
    }
  }

  // Continue with ruvector-powered routing
  // ...
}
```

---

## Integration Points with RuVector

### 1. MCP Tool Definitions

```typescript
// v3/@claude-flow/cli/src/mcp-tools/ruvector-tools.ts

import type { MCPTool } from './types.js';

export const ruvectorTools: MCPTool[] = [
  {
    name: 'ruvector/route',
    description: 'Route task to optimal agents using Q-Learning',
    category: 'ruvector',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task to route' },
        useQLearning: { type: 'boolean', default: true },
        useCoverageAware: { type: 'boolean', default: false },
        maxAgents: { type: 'number', default: 3 }
      },
      required: ['task']
    },
    handler: async (input) => {
      const adapter = await import('../ruvector/adapters/router-adapter.js');
      return adapter.routeWithQLearning({
        task: input.task as string,
        options: {
          useQLearning: input.useQLearning as boolean,
          useCoverageAware: input.useCoverageAware as boolean,
          maxAgents: input.maxAgents as number
        }
      });
    }
  },
  {
    name: 'ruvector/analyze-ast',
    description: 'Analyze code AST for symbols and complexity',
    category: 'ruvector',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to analyze' },
        recursive: { type: 'boolean', default: true },
        includeComplexity: { type: 'boolean', default: true },
        includeSymbols: { type: 'boolean', default: true }
      },
      required: ['path']
    },
    handler: async (input) => {
      const adapter = await import('../ruvector/adapters/ast-adapter.js');
      return adapter.analyzeAST({
        path: input.path as string,
        options: {
          recursive: input.recursive as boolean,
          includeComplexity: input.includeComplexity as boolean,
          includeSymbols: input.includeSymbols as boolean
        }
      });
    }
  },
  {
    name: 'ruvector/analyze-diff',
    description: 'Analyze and classify code diffs with risk scoring',
    category: 'ruvector',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'Diff content' },
        baseBranch: { type: 'string', default: 'main' },
        targetBranch: { type: 'string' },
        includeRisk: { type: 'boolean', default: true }
      }
    },
    handler: async (input) => {
      const adapter = await import('../ruvector/adapters/diff-adapter.js');
      return adapter.analyzeDiff({
        diff: input.diff as string,
        baseBranch: input.baseBranch as string,
        targetBranch: input.targetBranch as string,
        options: {
          includeRisk: input.includeRisk as boolean
        }
      });
    }
  },
  {
    name: 'ruvector/analyze-boundaries',
    description: 'Detect code boundaries using graph algorithms',
    category: 'ruvector',
    version: '1.0.0',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to analyze' },
        algorithm: {
          type: 'string',
          enum: ['mincut', 'louvain', 'both'],
          default: 'both'
        },
        minModuleSize: { type: 'number', default: 3 }
      },
      required: ['path']
    },
    handler: async (input) => {
      const adapter = await import('../ruvector/adapters/graph-adapter.js');
      return adapter.analyzeGraphBoundaries({
        path: input.path as string,
        options: {
          algorithm: input.algorithm as 'mincut' | 'louvain' | 'both',
          minModuleSize: input.minModuleSize as number
        }
      });
    }
  }
];
```

### 2. Lazy Loading Pattern

```typescript
// v3/@claude-flow/cli/src/ruvector/index.ts

/**
 * RuVector Integration Module
 *
 * Provides lazy-loaded access to ruvector features with graceful fallback.
 * All imports are dynamic to avoid build failures when ruvector is not installed.
 */

export { checkRuVectorAvailability, requireRuVector, getInstallInstructions } from './availability.js';
export { RuVectorNotAvailableError, RuVectorFeatureDisabledError } from './errors.js';

// Re-export types (these are safe - no runtime dependency)
export type * from './types.js';

// Lazy adapter exports
export async function getRouterAdapter() {
  await requireRuVector('qLearningRouter');
  return import('./adapters/router-adapter.js');
}

export async function getASTAdapter() {
  await requireRuVector('astAnalysis');
  return import('./adapters/ast-adapter.js');
}

export async function getDiffAdapter() {
  await requireRuVector('diffClassification');
  return import('./adapters/diff-adapter.js');
}

export async function getCoverageAdapter() {
  await requireRuVector('coverageRouting');
  return import('./adapters/coverage-adapter.js');
}

export async function getGraphAdapter() {
  await requireRuVector('graphAnalysis');
  return import('./adapters/graph-adapter.js');
}
```

---

## Package.json Updates

```json
{
  "name": "@claude-flow/cli",
  "version": "3.0.0-alpha.16",
  "optionalDependencies": {
    "ruvector": "^0.1.95"
  },
  "peerDependencies": {
    "ruvector": "^0.1.95"
  },
  "peerDependenciesMeta": {
    "ruvector": {
      "optional": true
    }
  }
}
```

---

## Command Index Updates

```typescript
// v3/@claude-flow/cli/src/commands/index.ts

// Existing imports...
import { routeCommand } from './route.js';
import { analyzeCommand } from './analyze.js';

// Update commands array
export const commands: Command[] = [
  // ... existing commands
  routeCommand,
  analyzeCommand,
];
```

---

## Implementation Phases

### Phase 1: Core Infrastructure (Day 1)

1. Create `/ruvector/availability.ts` - Package detection
2. Create `/ruvector/errors.ts` - Error types
3. Create `/ruvector/types.ts` - TypeScript interfaces
4. Create `/ruvector/index.ts` - Lazy loader
5. Update `package.json` - Optional dependency

### Phase 2: Route Command (Day 1-2)

1. Create `/commands/route.ts` - CLI command
2. Create `/ruvector/adapters/router-adapter.ts` - Q-Learning adapter
3. Create `/ruvector/adapters/coverage-adapter.ts` - Coverage adapter
4. Add MCP tools to `/mcp-tools/ruvector-tools.ts`
5. Update command index

### Phase 3: Analyze Command (Day 2-3)

1. Create `/commands/analyze.ts` - CLI command with subcommands
2. Create `/ruvector/adapters/ast-adapter.ts` - AST adapter
3. Create `/ruvector/adapters/diff-adapter.ts` - Diff adapter
4. Create `/ruvector/adapters/graph-adapter.ts` - Graph adapter
5. Add MCP tools

### Phase 4: Testing & Documentation (Day 3-4)

1. Unit tests for availability detection
2. Integration tests for adapters
3. Update CLI help text
4. Update README with ruvector features

---

## Testing Strategy

### 1. Availability Tests

```typescript
// v3/@claude-flow/cli/tests/ruvector/availability.test.ts

import { describe, it, expect, vi } from 'vitest';
import { checkRuVectorAvailability } from '../../src/ruvector/availability.js';

describe('RuVector Availability', () => {
  it('should detect when ruvector is not installed', async () => {
    vi.mock('ruvector', () => {
      throw new Error('Cannot find module');
    });

    const status = await checkRuVectorAvailability();
    expect(status.available).toBe(false);
    expect(status.error).toBeDefined();
  });

  it('should detect available features', async () => {
    vi.mock('ruvector', () => ({
      hooks_route: vi.fn(),
      hooks_ast_analyze: vi.fn(),
      version: '0.1.95'
    }));

    const status = await checkRuVectorAvailability();
    expect(status.available).toBe(true);
    expect(status.features.qLearningRouter).toBe(true);
    expect(status.features.astAnalysis).toBe(true);
  });
});
```

### 2. Command Tests

```typescript
// v3/@claude-flow/cli/tests/commands/route.test.ts

import { describe, it, expect, vi } from 'vitest';
import { routeCommand } from '../../src/commands/route.js';

describe('Route Command', () => {
  it('should show helpful error when ruvector not available', async () => {
    const ctx = {
      args: [],
      flags: { task: 'Build API', 'q-learning': true },
      interactive: false,
      cwd: process.cwd()
    };

    // Mock ruvector as unavailable
    vi.mock('../../src/ruvector/availability.js', () => ({
      requireRuVector: vi.fn().mockRejectedValue(
        new RuVectorNotAvailableError('qLearningRouter')
      )
    }));

    const result = await routeCommand.action!(ctx);
    expect(result.success).toBe(true); // Falls back gracefully
  });
});
```

---

## Consequences

### Positive

1. **Zero breaking changes** - ruvector is optional
2. **Enhanced capabilities** - Q-Learning routing, AST analysis, etc.
3. **Clean separation** - ruvector code isolated in `/ruvector/`
4. **Consistent UX** - Follows existing CLI patterns
5. **MCP-first** - All features available via MCP tools

### Negative

1. **Increased complexity** - More code to maintain
2. **Optional dependency** - Users may not discover features
3. **Version coupling** - Must track ruvector API changes

### Neutral

1. **Bundle size unchanged** - Lazy loading prevents bloat
2. **Build unaffected** - Optional dependency won't break builds

---

## References

- ADR-005: MCP-First API Design
- ADR-004: Plugin-Based Architecture
- RuVector Documentation: https://github.com/ruvnet/ruvector
- Existing hooks command: `/commands/hooks.ts`
- Existing neural command: `/commands/neural.ts`

---

## Appendix: RuVector Function Mapping

| RuVector Function | CLI Command | MCP Tool |
|-------------------|-------------|----------|
| `hooks_route` | `route --q-learning` | `ruvector/route` |
| `hooks_route_enhanced` | `route --q-learning --explain` | `ruvector/route` |
| `hooks_coverage_route` | `route --coverage-aware` | `ruvector/route` |
| `hooks_ast_analyze` | `analyze ast <path>` | `ruvector/analyze-ast` |
| `hooks_ast_complexity` | `analyze ast --complexity` | `ruvector/analyze-ast` |
| `hooks_diff_analyze` | `analyze diff` | `ruvector/analyze-diff` |
| `hooks_diff_classify` | `analyze diff --risk` | `ruvector/analyze-diff` |
| `hooks_graph_mincut` | `analyze boundaries -a mincut` | `ruvector/analyze-boundaries` |
| `hooks_graph_cluster` | `analyze boundaries -a louvain` | `ruvector/analyze-boundaries` |
