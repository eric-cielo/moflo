/**
 * Agent Router Service
 *
 * Routes tasks to optimal agent types based on learned patterns
 * and hardcoded keyword matching. Learned patterns take priority
 * over static patterns (0.9 vs 0.8 confidence).
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface RouteResult {
  agentType: string;
  confidence: number;
  reason: string;
}

export type AgentType =
  | 'coder'
  | 'tester'
  | 'reviewer'
  | 'researcher'
  | 'architect'
  | 'backend-dev'
  | 'frontend-dev'
  | 'devops'
  | 'security-architect'
  | 'security-auditor'
  | 'memory-specialist'
  | 'coordinator'
  | 'analyst'
  | 'optimizer';

// ============================================================================
// Agent Capabilities Map
// ============================================================================

export const AGENT_CAPABILITIES: Record<string, string[]> = {
  coder: ['code-generation', 'refactoring', 'debugging', 'implementation'],
  tester: ['unit-testing', 'integration-testing', 'coverage', 'test-generation'],
  reviewer: ['code-review', 'security-audit', 'quality-check', 'best-practices'],
  researcher: ['web-search', 'documentation', 'analysis', 'summarization'],
  architect: ['system-design', 'architecture', 'patterns', 'scalability'],
  'backend-dev': ['api', 'database', 'server', 'authentication'],
  'frontend-dev': ['ui', 'react', 'css', 'components'],
  devops: ['ci-cd', 'docker', 'deployment', 'infrastructure'],
  'security-architect': ['security-design', 'threat-modeling', 'auth-flow'],
  'security-auditor': ['vulnerability-scan', 'dependency-audit', 'compliance'],
  'memory-specialist': ['memory-management', 'caching', 'persistence'],
  coordinator: ['task-distribution', 'orchestration', 'scheduling'],
  analyst: ['data-analysis', 'metrics', 'reporting', 'monitoring'],
  optimizer: ['performance', 'profiling', 'optimization', 'benchmarking'],
};

// ============================================================================
// Static Task Patterns (regex -> agent type)
// ============================================================================

const TASK_PATTERNS: Array<{ regex: RegExp; agentType: string }> = [
  // Code patterns
  { regex: /implement|create|build|add|write code/i, agentType: 'coder' },
  { regex: /test|spec|coverage|unit test|integration/i, agentType: 'tester' },
  { regex: /review|audit|check|validate|security/i, agentType: 'reviewer' },
  { regex: /research|find|search|documentation|explore/i, agentType: 'researcher' },
  { regex: /design|architect|structure|plan/i, agentType: 'architect' },

  // Domain patterns
  { regex: /api|endpoint|server|backend|database/i, agentType: 'backend-dev' },
  { regex: /ui|frontend|component|react|css|style/i, agentType: 'frontend-dev' },
  { regex: /deploy|docker|ci|cd|pipeline|infrastructure/i, agentType: 'devops' },

  // Specialized patterns
  { regex: /security|auth|permission|rbac|oauth/i, agentType: 'security-architect' },
  { regex: /vulnerability|cve|dependency.*update|npm audit/i, agentType: 'security-auditor' },
  { regex: /performance|optimize|profile|benchmark|speed/i, agentType: 'optimizer' },
  { regex: /analyz|metric|report|monitor|dashboard/i, agentType: 'analyst' },
];

// ============================================================================
// Learned Patterns (loaded from persisted file)
// ============================================================================

interface LearnedPattern {
  pattern: string;
  agent: string;
  confidence: number;
}

function loadLearnedPatterns(projectRoot: string): Map<string, string> {
  const patterns = new Map<string, string>();
  const filePath = join(projectRoot, '.claude-flow', 'routing-outcomes.json');

  try {
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (data.patterns && Array.isArray(data.patterns)) {
        for (const p of data.patterns as LearnedPattern[]) {
          if (p.pattern && p.agent && p.confidence > 0.6) {
            patterns.set(p.pattern, p.agent);
          }
        }
      }
    }
  } catch {
    // Learned patterns not available — use static only
  }

  return patterns;
}

// ============================================================================
// Router
// ============================================================================

export class AgentRouter {
  private learnedPatterns: Map<string, string>;

  constructor(projectRoot?: string) {
    const root = projectRoot || process.cwd();
    this.learnedPatterns = loadLearnedPatterns(root);
  }

  /**
   * Route a task description to the optimal agent type.
   *
   * Priority:
   * 1. Learned patterns (confidence 0.9)
   * 2. Static regex patterns (confidence 0.8)
   * 3. Default to 'coder' (confidence 0.5)
   */
  routeTask(description: string): RouteResult {
    const taskLower = description.toLowerCase();

    // 1. Check learned patterns first (higher priority from actual usage)
    for (const [pattern, agent] of this.learnedPatterns) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(taskLower)) {
          return {
            agentType: agent,
            confidence: 0.9,
            reason: `Matched learned pattern: ${pattern}`,
          };
        }
      } catch {
        // Invalid regex in learned pattern — skip
      }
    }

    // 2. Check static patterns
    for (const { regex, agentType } of TASK_PATTERNS) {
      if (regex.test(taskLower)) {
        return {
          agentType,
          confidence: 0.8,
          reason: `Matched pattern: ${regex.source}`,
        };
      }
    }

    // 3. Default
    return {
      agentType: 'coder',
      confidence: 0.5,
      reason: 'Default routing — no specific pattern matched',
    };
  }

  /**
   * Reload learned patterns from disk.
   */
  reload(projectRoot?: string): void {
    const root = projectRoot || process.cwd();
    this.learnedPatterns = loadLearnedPatterns(root);
  }

  /**
   * Get all available agent types.
   */
  getAgentTypes(): string[] {
    return Object.keys(AGENT_CAPABILITIES);
  }

  /**
   * Get capabilities for an agent type.
   */
  getCapabilities(agentType: string): string[] {
    return AGENT_CAPABILITIES[agentType] || [];
  }

  /**
   * Get the number of loaded learned patterns.
   */
  getLearnedPatternCount(): number {
    return this.learnedPatterns.size;
  }
}

// Singleton
let _router: AgentRouter | null = null;

export function getAgentRouter(projectRoot?: string): AgentRouter {
  if (!_router) {
    _router = new AgentRouter(projectRoot);
  }
  return _router;
}

/**
 * Convenience function matching the original router.js API.
 */
export function routeTask(description: string, projectRoot?: string): RouteResult {
  return getAgentRouter(projectRoot).routeTask(description);
}
