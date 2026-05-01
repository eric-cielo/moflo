/**
 * Tests for the swarm + hive-mind functional doctor checks (issue #818, epic #798).
 *
 * The detailed regression-detection contract is exercised end-to-end in
 * `tests/system/swarm-restoration-e2e.test.ts` and
 * `tests/system/hive-mind-e2e.test.ts` (via `flo doctor --json`); these unit
 * tests cover the structural contract — return shape, detail records, and
 * graceful-degradation when modules are missing.
 */

import { describe, expect, it } from 'vitest';
import {
  checkSwarmFunctional,
  checkHiveMindFunctional,
  type FunctionalHealthCheck,
} from '../commands/doctor-checks-swarm.js';

function expectFunctionalShape(result: FunctionalHealthCheck) {
  expect(result.name).toBeTruthy();
  expect(['pass', 'warn', 'fail']).toContain(result.status);
  expect(result.message.length).toBeGreaterThan(0);
}

describe('doctor-checks-swarm', () => {
  describe('checkSwarmFunctional', () => {
    it('returns a HealthCheck with details when modules are built', { timeout: 30_000 }, async () => {
      const result = await checkSwarmFunctional();
      expect(result.name).toBe('Swarm Functional');
      expectFunctionalShape(result);

      // When the dist is built, every subcheck has structured details (id +
      // mcpTool + observed + expected). When it's not built, the check
      // degrades to a single 'warn' with no details — that's the documented
      // fallback.
      if (result.status === 'pass' || result.status === 'fail') {
        expect(Array.isArray(result.details)).toBe(true);
        expect(result.details!.length).toBeGreaterThan(0);
        for (const d of result.details!) {
          expect(d.id).toBeTruthy();
          expect(d.mcpTool).toBeTruthy();
          expect(['pass', 'warn', 'fail']).toContain(d.status);
          expect(d.expected).toBeTruthy();
        }
      }
    });

    it('passes against the real UnifiedSwarmCoordinator (regression tripwire)', { timeout: 30_000 }, async () => {
      const result = await checkSwarmFunctional();

      // A 'warn' here means the dist isn't built — skip the strict assertion
      // (the dev repo always has dist; CI builds before testing).
      if (result.status === 'warn' && /not built/i.test(result.message)) {
        return;
      }

      expect(result.status, `expected pass, got ${result.status}: ${result.message}`).toBe('pass');
      const details = result.details ?? [];
      const ids = details.map(d => d.id);

      // Spot-check the regression-critical subchecks are present.
      expect(ids).toContain('swarm_init.coordinator-issued-id');
      expect(ids).toContain('agent_spawn.coordinator-backed');
      expect(ids).toContain('swarm_status.live-counts');
      expect(ids).toContain('agent_list.coordinator-state');

      // Every subcheck must have passed.
      const failures = details.filter(d => d.status === 'fail');
      expect(failures, `subcheck failures: ${JSON.stringify(failures, null, 2)}`).toHaveLength(0);
    });
  });

  describe('checkHiveMindFunctional', () => {
    it('returns a HealthCheck with details when modules are built', { timeout: 30_000 }, async () => {
      const result = await checkHiveMindFunctional();
      expect(result.name).toBe('Hive-Mind Functional');
      expectFunctionalShape(result);

      if (result.status === 'pass' || result.status === 'fail') {
        expect(Array.isArray(result.details)).toBe(true);
        expect(result.details!.length).toBeGreaterThan(0);
        for (const d of result.details!) {
          expect(d.id).toBeTruthy();
          expect(d.mcpTool).toBeTruthy();
          expect(['pass', 'warn', 'fail']).toContain(d.status);
          expect(d.expected).toBeTruthy();
        }
      }
    });

    it('passes (or degrades to warn) against the real MessageBus + coordinator', { timeout: 30_000 }, async () => {
      const result = await checkHiveMindFunctional();

      if (result.status === 'warn' && /not built/i.test(result.message)) {
        return;
      }

      // 'pass' is the happy path; 'warn' is acceptable only when memory backend
      // is unavailable (softFailMessage path) — never 'fail'.
      expect(result.status, `expected pass or warn, got fail: ${result.message}`).not.toBe('fail');

      const details = result.details ?? [];
      const ids = details.map(d => d.id);
      expect(ids).toContain('hive-mind_init.bus-and-adapter');
      expect(ids).toContain('hive-mind_spawn.shared-coordinator');
      expect(ids).toContain('agent_list.hive-domain-visible');
      expect(ids).toContain('hive-mind_broadcast.bus-exchange');

      // No subcheck should have failed.
      const failures = details.filter(d => d.status === 'fail');
      expect(failures, `subcheck failures: ${JSON.stringify(failures, null, 2)}`).toHaveLength(0);
    });
  });

  describe('consumer-path resolution', () => {
    it('uses import.meta.url / findMofloPackageRoot, never process.cwd()', async () => {
      const { readFileSync } = await import('fs');
      const { join } = await import('path');
      const source = readFileSync(
        join(process.cwd(), 'src', 'cli', 'commands', 'doctor-checks-swarm.ts'),
        'utf8',
      );
      // Same contract as doctor-checks-deep — no `process.cwd()` for module
      // resolution because that breaks when moflo is installed under
      // `node_modules/moflo/...` (see feedback_consumer_path_resolution.md).
      // Path resolution is delegated to doctor-checks-deep's exported
      // `findModule` + `toImportUrl`, which use `findMofloPackageRoot` under
      // the hood — we just assert the import.
      const cwdUsages = source.match(/process\.cwd\(\)/g) ?? [];
      expect(cwdUsages.length).toBe(0);
      expect(source).toMatch(/from '\.\/doctor-checks-deep\.js'/);
      expect(source).toMatch(/findModule|toImportUrl/);
    });
  });
});
