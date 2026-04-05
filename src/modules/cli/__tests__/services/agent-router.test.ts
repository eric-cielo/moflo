/**
 * Agent Router Tests
 *
 * Happy-path smoke tests for AgentRouter: route returns correct
 * agent type for task descriptions, capabilities lookup, defaults.
 *
 * Filesystem is mocked — no learned patterns loaded.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs so loadLearnedPatterns returns empty map
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import {
  AgentRouter,
  routeTask,
  getAgentRouter,
  AGENT_CAPABILITIES,
  type RouteResult,
} from '../../src/services/agent-router.js';

describe('AgentRouter', () => {
  let router: AgentRouter;

  beforeEach(() => {
    router = new AgentRouter('/tmp/test-project');
  });

  // ===========================================================================
  // Exports
  // ===========================================================================
  describe('exports', () => {
    it('should export AgentRouter class', () => {
      expect(AgentRouter).toBeDefined();
      expect(typeof AgentRouter).toBe('function');
    });

    it('should export routeTask convenience function', () => {
      expect(typeof routeTask).toBe('function');
    });

    it('should export getAgentRouter singleton factory', () => {
      expect(typeof getAgentRouter).toBe('function');
    });

    it('should export AGENT_CAPABILITIES map', () => {
      expect(AGENT_CAPABILITIES).toBeDefined();
      expect(AGENT_CAPABILITIES.coder).toContain('code-generation');
    });
  });

  // ===========================================================================
  // routeTask — Static Patterns
  // ===========================================================================
  describe('routeTask', () => {
    it('should route "implement login feature" to coder', () => {
      const result = router.routeTask('implement login feature');
      expect(result.agentType).toBe('coder');
      expect(result.confidence).toBe(0.8);
    });

    it('should route "write unit tests" to tester', () => {
      const result = router.routeTask('write unit tests for auth module');
      expect(result.agentType).toBe('tester');
      expect(result.confidence).toBe(0.8);
    });

    it('should route "review the pull request" to reviewer', () => {
      const result = router.routeTask('review the pull request for security');
      expect(result.agentType).toBe('reviewer');
      expect(result.confidence).toBe(0.8);
    });

    it('should route "research best practices" to researcher', () => {
      const result = router.routeTask('research best practices for caching');
      expect(result.agentType).toBe('researcher');
      expect(result.confidence).toBe(0.8);
    });

    it('should route "design the architecture" to architect', () => {
      const result = router.routeTask('design the architecture for microservices');
      expect(result.agentType).toBe('architect');
      expect(result.confidence).toBe(0.8);
    });

    it('should route "deploy to kubernetes" to devops', () => {
      const result = router.routeTask('deploy to kubernetes cluster');
      expect(result.agentType).toBe('devops');
      expect(result.confidence).toBe(0.8);
    });

    it('should route "profile the hot path" to optimizer', () => {
      const result = router.routeTask('profile the hot path for speed improvements');
      expect(result.agentType).toBe('optimizer');
      expect(result.confidence).toBe(0.8);
    });

    it('should default to coder with 0.5 confidence for unrecognized tasks', () => {
      const result = router.routeTask('do something completely unrelated xyz');
      expect(result.agentType).toBe('coder');
      expect(result.confidence).toBe(0.5);
      expect(result.reason).toContain('Default');
    });
  });

  // ===========================================================================
  // RouteResult shape
  // ===========================================================================
  describe('RouteResult shape', () => {
    it('should return agentType, confidence, and reason', () => {
      const result = router.routeTask('build a REST API');
      expect(result).toHaveProperty('agentType');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('reason');
      expect(typeof result.agentType).toBe('string');
      expect(typeof result.confidence).toBe('number');
      expect(typeof result.reason).toBe('string');
    });
  });

  // ===========================================================================
  // getAgentTypes / getCapabilities
  // ===========================================================================
  describe('getAgentTypes', () => {
    it('should return a non-empty array of agent types', () => {
      const types = router.getAgentTypes();
      expect(types.length).toBeGreaterThan(0);
      expect(types).toContain('coder');
      expect(types).toContain('tester');
      expect(types).toContain('reviewer');
    });
  });

  describe('getCapabilities', () => {
    it('should return capabilities for a known agent type', () => {
      const caps = router.getCapabilities('coder');
      expect(caps).toContain('code-generation');
      expect(caps).toContain('refactoring');
    });

    it('should return empty array for unknown agent type', () => {
      const caps = router.getCapabilities('nonexistent');
      expect(caps).toEqual([]);
    });
  });

  // ===========================================================================
  // Learned Patterns
  // ===========================================================================
  describe('learned patterns', () => {
    it('should report zero learned patterns when file does not exist', () => {
      expect(router.getLearnedPatternCount()).toBe(0);
    });
  });

  // ===========================================================================
  // Convenience function
  // ===========================================================================
  describe('routeTask (standalone)', () => {
    it('should work as a standalone function', () => {
      const result = routeTask('implement feature', '/tmp/test-project');
      expect(result.agentType).toBe('coder');
    });
  });
});
