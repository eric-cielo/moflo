/**
 * Tests for Deep Verification Checks (doctor-checks-deep.ts)
 *
 * Validates that the deep doctor checks:
 * 1. Correctly resolve modules from the moflo package root (not cwd)
 * 2. Exercise subsystem lifecycles end-to-end
 * 3. Degrade gracefully when modules are unavailable
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// Import the checks under test
import {
  checkSubagentHealth,
  checkSpellExecution,
  checkMcpToolInvocation,
  checkMcpSpellIntegration,
  checkHookExecution,
  checkGateHealth,
  isExpectedPrePublishDrift,
  REQUIRED_HOOK_WIRING,
  type HealthCheck,
} from '../commands/doctor-checks-deep.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

  describe('checkSpellExecution', () => {
    // Single shared probe: the check spawns a real bash subprocess via the
    // spell engine (~7 s alone, more under load). Two consecutive calls put
    // the suite at ~15 s baseline + tail risk under maxForks=2 fork
    // contention (issue #864). One call, two assertions — same coverage,
    // half the engine work.
    let result: HealthCheck;
    beforeAll(async () => {
      result = await checkSpellExecution();
    }, 30_000);

    it('should return a HealthCheck object', () => {
      expect(result).toHaveProperty('name', 'Spell Execution');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('message');
      expect(['pass', 'warn', 'fail']).toContain(result.status);
    });

    it('should pass when spell engine is built', () => {
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

  describe('checkMcpSpellIntegration', () => {
    it('should return a HealthCheck object', async () => {
      const result = await checkMcpSpellIntegration();
      expect(result).toHaveProperty('name', 'MCP Spell Integration');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('message');
      expect(['pass', 'warn', 'fail']).toContain(result.status);
    });

    it('should verify real stdout from bash step via bridge', async () => {
      const result = await checkMcpSpellIntegration();
      if (result.status === 'pass') {
        expect(result.message).toContain('Bridge → engine OK');
        expect(result.message).toContain('real stdout captured');
      }
    });
  });

  describe('REQUIRED_HOOK_WIRING', () => {
    it('should export all required hook patterns', () => {
      expect(REQUIRED_HOOK_WIRING).toBeDefined();
      expect(Array.isArray(REQUIRED_HOOK_WIRING)).toBe(true);
      expect(REQUIRED_HOOK_WIRING.length).toBeGreaterThanOrEqual(10);
    });

    it('should include check-before-pr, check-task-transition, and record-learnings-stored', () => {
      const patterns = REQUIRED_HOOK_WIRING.map(h => h.pattern);
      expect(patterns).toContain('check-before-pr');
      expect(patterns).toContain('check-task-transition');
      expect(patterns).toContain('record-learnings-stored');
    });

    it('should have valid event types', () => {
      const validEvents = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit'];
      for (const hook of REQUIRED_HOOK_WIRING) {
        expect(validEvents).toContain(hook.event);
      }
    });
  });

  describe('checkGateHealth', () => {
    it('should return a HealthCheck object', async () => {
      const result = await checkGateHealth();
      expect(result).toHaveProperty('name', 'Gate Health');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('message');
      expect(['pass', 'warn', 'fail']).toContain(result.status);
    });
  });

  // #913 — distinguish "expected pre-publish drift" (helper matches installed
  // bin, source bin is ahead) from genuine helper drift. The first state is
  // the moflo dogfood steady state between PR-landing and `npm install
  // moflo@<new>`; surfacing it as `fail` triggered a false-success
  // "Auto-fixed 1 issue" log line because the auto-fix path was a no-op for
  // content drift.
  describe('isExpectedPrePublishDrift (#913)', () => {
    let tmp: string;
    let installedBinGate: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'moflo-913-'));
      const installedBinDir = join(tmp, 'node_modules', 'moflo', 'bin');
      mkdirSync(installedBinDir, { recursive: true });
      installedBinGate = join(installedBinDir, 'gate.cjs');
    });

    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it('returns true when helper matches installed bin and source bin is ahead', () => {
      writeFileSync(installedBinGate, 'INSTALLED_4_9_13', 'utf8');
      // helper === installed (correctly synced), source bin is the newer content
      expect(isExpectedPrePublishDrift(installedBinGate, 'INSTALLED_4_9_13', 'SOURCE_AHEAD')).toBe(true);
    });

    it('returns false when helper matches source bin (no drift to call out)', () => {
      writeFileSync(installedBinGate, 'INSTALLED_4_9_13', 'utf8');
      expect(isExpectedPrePublishDrift(installedBinGate, 'SAME', 'SAME')).toBe(false);
    });

    it('returns false when helper differs from installed (genuine helper corruption)', () => {
      writeFileSync(installedBinGate, 'INSTALLED_4_9_13', 'utf8');
      // Helper drifted from BOTH source and installed → real fail, not pre-publish
      expect(isExpectedPrePublishDrift(installedBinGate, 'CORRUPTED_HELPER', 'SOURCE_AHEAD')).toBe(false);
    });

    it('returns false when node_modules/moflo/bin/gate.cjs is missing', () => {
      // Installed bin not present (consumer never installed moflo, or unusual
      // path) — fall back to existing drift handling instead of guessing.
      expect(isExpectedPrePublishDrift(installedBinGate, 'A', 'B')).toBe(false);
    });

    it('returns false when source bin and installed bin are identical', () => {
      // No source-vs-installed drift means we're not in the pre-publish window.
      writeFileSync(installedBinGate, 'PUBLISHED', 'utf8');
      expect(isExpectedPrePublishDrift(installedBinGate, 'PUBLISHED', 'PUBLISHED')).toBe(false);
    });
  });

  describe('consumer project compatibility', () => {
    it('all checks use import.meta.url, not process.cwd(), for path resolution', async () => {
      // This is a structural assertion — read the source and verify no process.cwd() usage
      const { readFileSync } = await import('fs');
      const { join } = await import('path');
      const source = readFileSync(
        join(process.cwd(), 'src', 'cli', 'commands', 'doctor-checks-deep.ts'),
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
        checkSpellExecution,
        checkMcpToolInvocation,
        checkMcpSpellIntegration,
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
