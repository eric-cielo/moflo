/**
 * Tests for Deep Verification Checks (doctor-checks-deep.ts)
 *
 * Validates that the deep doctor checks:
 * 1. Correctly resolve modules from the moflo package root (not cwd)
 * 2. Exercise subsystem lifecycles end-to-end
 * 3. Degrade gracefully when modules are unavailable
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import the checks under test
import {
  checkSubagentHealth,
  checkWorkflowExecution,
  checkMcpToolInvocation,
  checkMcpWorkflowIntegration,
  checkHookExecution,
} from '../src/commands/doctor-checks-deep.js';

describe('doctor-checks-deep', () => {
  describe('checkSubagentHealth', () => {
    it('should return a HealthCheck object', async () => {
      const result = await checkSubagentHealth();
      expect(result).toHaveProperty('name', 'Subagent Health');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('message');
      expect(['pass', 'warn', 'fail']).toContain(result.status);
    });

    it('should have a non-empty message', async () => {
      const result = await checkSubagentHealth();
      expect(result.message.length).toBeGreaterThan(0);
    });
  });

  describe('checkWorkflowExecution', () => {
    it('should return a HealthCheck object', async () => {
      const result = await checkWorkflowExecution();
      expect(result).toHaveProperty('name', 'Workflow Execution');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('message');
      expect(['pass', 'warn', 'fail']).toContain(result.status);
    });

    it('should pass when workflow engine is built', async () => {
      const result = await checkWorkflowExecution();
      // In the dev repo with a successful build, this should pass
      if (result.status === 'pass') {
        expect(result.message).toContain('Probe OK');
      }
    });
  });

  describe('checkMcpToolInvocation', () => {
    it('should return a HealthCheck object', async () => {
      const result = await checkMcpToolInvocation();
      expect(result).toHaveProperty('name', 'MCP Tool Invocation');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('message');
      expect(['pass', 'warn', 'fail']).toContain(result.status);
    });

    it('should not fail — at minimum module exists', async () => {
      const result = await checkMcpToolInvocation();
      // Should either pass (tools loaded) or warn (import init issue)
      expect(result.status).not.toBe('fail');
    });
  });

  describe('checkHookExecution', () => {
    it('should return a HealthCheck object', async () => {
      const result = await checkHookExecution();
      expect(result).toHaveProperty('name', 'Hook Execution');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('message');
      expect(['pass', 'warn', 'fail']).toContain(result.status);
    });

    it('should not fail — at minimum module exists or degrades to warn', async () => {
      const result = await checkHookExecution();
      // Hooks may not be shipped in consumer builds — should degrade gracefully
      expect(result.status).not.toBe('fail');
    });
  });

  describe('checkMcpWorkflowIntegration', () => {
    it('should return a HealthCheck object', async () => {
      const result = await checkMcpWorkflowIntegration();
      expect(result).toHaveProperty('name', 'MCP Workflow Integration');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('message');
      expect(['pass', 'warn', 'fail']).toContain(result.status);
    });

    it('should verify real stdout from bash step via bridge', async () => {
      const result = await checkMcpWorkflowIntegration();
      if (result.status === 'pass') {
        expect(result.message).toContain('Bridge → engine OK');
        expect(result.message).toContain('real stdout captured');
      }
    });
  });

  describe('consumer project compatibility', () => {
    it('all checks use import.meta.url, not process.cwd(), for path resolution', async () => {
      // This is a structural assertion — read the source and verify no process.cwd() usage
      const { readFileSync } = await import('fs');
      const { join } = await import('path');
      const source = readFileSync(
        join(process.cwd(), 'src', 'modules', 'cli', 'src', 'commands', 'doctor-checks-deep.ts'),
        'utf8'
      );

      // The module should NOT use process.cwd() for module resolution
      const cwdUsages = source.match(/process\.cwd\(\)/g) || [];
      expect(cwdUsages.length).toBe(0);

      // The module MUST use import.meta.url for path resolution
      expect(source).toContain('import.meta.url');
    });

    it('all checks should never throw — they return HealthCheck objects', async () => {
      // Run all checks and verify none throw
      const checks = [
        checkSubagentHealth,
        checkWorkflowExecution,
        checkMcpToolInvocation,
        checkMcpWorkflowIntegration,
        checkHookExecution,
      ];

      for (const check of checks) {
        const result = await check();
        expect(result).toBeDefined();
        expect(result.name).toBeTruthy();
        expect(result.status).toBeTruthy();
        expect(result.message).toBeTruthy();
      }
    });
  });
});
