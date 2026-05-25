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
  _probeHiveMemoryGetForTest,
  type FunctionalHealthCheck,
} from '../commands/doctor-checks-swarm.js';
import type { FunctionalCheckDetail, ToolHandler } from '../commands/doctor-checks-functional-shared.js';

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

  // #1206: the hive-mind_memory set→get subcheck flaked on a stressed CI
  // runner — an immediate get returning exists=false right after a successful
  // set was reported as a hard write-through failure when it was actually async
  // propagation lag. The fix mirrors the #1111/#1120 pattern on Memory Access:
  // bounded-retry the get; demote to warn when the value lands late; keep a
  // hard fail when it never lands (protected-surface guarantee, epic #798).
  //
  // Driven through the `_probeHiveMemoryGetForTest` seam with a synthetic
  // hive-mind_memory tool and an injected no-op sleep so the classification is
  // exercised without real backoff delays — same approach as the
  // buildEmptyHnswTools / buildStaleNeighborTools harnesses in
  // doctor-checks-memory-access.test.ts.
  describe('checkHiveMindFunctional — #1206 write-through propagation race', () => {
    // A hive-mind_memory whose `get` reports exists=false for the first
    // `missesBeforeHit` reads, then returns the stored sentinel — models the
    // write-through propagation lag the issue describes. `everLands:false`
    // never returns the value (a genuine write-through break).
    function buildLaggyHiveMemory(opts: {
      missesBeforeHit: number;
      sentinel: string;
      everLands?: boolean;
    }): ToolHandler[] {
      let getCalls = 0;
      return [
        {
          name: 'hive-mind_memory',
          handler: async (input) => {
            if (input.action === 'get') {
              getCalls++;
              const landed = (opts.everLands ?? true) && getCalls > opts.missesBeforeHit;
              return landed
                ? { exists: true, value: { sentinel: opts.sentinel } }
                : { exists: false, value: null };
            }
            return { success: true };
          },
        },
      ];
    }

    const noSleep = async () => { /* skip real backoff in tests */ };

    it('passes when the first get already sees the value (happy path, no added latency)', async () => {
      const details: FunctionalCheckDetail[] = [];
      await _probeHiveMemoryGetForTest(
        buildLaggyHiveMemory({ missesBeforeHit: 0, sentinel: 's1' }),
        'k', 's1', details, { sleep: noSleep },
      );
      const d = details.find(x => x.id === 'hive-mind_memory.get');
      expect(d, 'hive-mind_memory.get subcheck must be recorded').toBeDefined();
      expect(d!.status, `expected pass, got ${d!.status}: ${d!.message}`).toBe('pass');
      expect((d!.observed as { attempts?: number }).attempts).toBe(1);
      expect(details.filter(x => x.status === 'fail')).toHaveLength(0);
    });

    it('demotes to warn when get is exists=false at first but lands on a bounded retry', async () => {
      const details: FunctionalCheckDetail[] = [];
      await _probeHiveMemoryGetForTest(
        buildLaggyHiveMemory({ missesBeforeHit: 2, sentinel: 's2' }),
        'k', 's2', details, { sleep: noSleep },
      );
      const d = details.find(x => x.id === 'hive-mind_memory.get');
      expect(d, 'hive-mind_memory.get subcheck must be recorded').toBeDefined();
      expect(d!.status, `expected warn, got ${d!.status}: ${d!.message}`).toBe('warn');
      expect(d!.message).toMatch(/write-through propagation race/i);
      // The whole point of the fix: a propagation lag is never a fail.
      expect(details.filter(x => x.status === 'fail')).toHaveLength(0);
    });

    it('keeps a hard fail when the value never lands within the retry budget', async () => {
      const details: FunctionalCheckDetail[] = [];
      await _probeHiveMemoryGetForTest(
        buildLaggyHiveMemory({ missesBeforeHit: 99, sentinel: 's3', everLands: false }),
        'k', 's3', details, { sleep: noSleep },
      );
      const d = details.find(x => x.id === 'hive-mind_memory.get');
      expect(d, 'hive-mind_memory.get subcheck must be recorded').toBeDefined();
      expect(d!.status, `expected fail, got ${d!.status}`).toBe('fail');
      expect(d!.message).toMatch(/write-through to Memory DB is broken/i);
      // Exhausted the full budget: 1 immediate read + 3 bounded retries.
      expect((d!.observed as { attempts?: number }).attempts).toBe(4);
    });

    it('keeps a hard fail when every get throws (transient error never clears)', async () => {
      const details: FunctionalCheckDetail[] = [];
      const tools: ToolHandler[] = [{
        name: 'hive-mind_memory',
        handler: async (input) => {
          if (input.action === 'get') throw new Error('memory backend offline');
          return { success: true };
        },
      }];
      await _probeHiveMemoryGetForTest(tools, 'k', 's', details, { sleep: noSleep });
      const d = details.find(x => x.id === 'hive-mind_memory.get');
      expect(d, 'hive-mind_memory.get subcheck must be recorded').toBeDefined();
      expect(d!.status, `expected fail, got ${d!.status}`).toBe('fail');
      expect(d!.message).toMatch(/threw on every attempt/i);
      // Same budget as the never-lands case: 1 immediate + 3 bounded retries.
      expect((d!.observed as { attempts?: number; threw?: boolean }).attempts).toBe(4);
      expect((d!.observed as { threw?: boolean }).threw).toBe(true);
    });

    it('fails immediately on a value mismatch — a clobber is a real bug, not a race', async () => {
      const details: FunctionalCheckDetail[] = [];
      const tools: ToolHandler[] = [{
        name: 'hive-mind_memory',
        handler: async (input) =>
          input.action === 'get'
            ? { exists: true, value: { sentinel: 'WRONG' } }
            : { success: true },
      }];
      await _probeHiveMemoryGetForTest(tools, 'k', 'EXPECTED', details, { sleep: noSleep });
      const d = details.find(x => x.id === 'hive-mind_memory.get');
      expect(d, 'hive-mind_memory.get subcheck must be recorded').toBeDefined();
      expect(d!.status).toBe('fail');
      expect(d!.message).toMatch(/value mismatch/i);
      // No retries burned on a clobber — failed on the first read.
      expect((d!.observed as { attempts?: number }).attempts).toBe(1);
    });

    it('fails when the hive-mind_memory tool is not registered', async () => {
      const details: FunctionalCheckDetail[] = [];
      await _probeHiveMemoryGetForTest([], 'k', 's', details, { sleep: noSleep });
      const d = details.find(x => x.id === 'hive-mind_memory.get');
      expect(d, 'hive-mind_memory.get subcheck must be recorded').toBeDefined();
      expect(d!.status).toBe('fail');
      expect(d!.message).toMatch(/not registered/i);
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
      // Path resolution is delegated to the shared functional helpers, which
      // in turn use doctor-checks-deep's `findMofloPackageRoot` — we assert
      // the delegation chain and the absence of cwd usage.
      const cwdUsages = source.match(/process\.cwd\(\)/g) ?? [];
      expect(cwdUsages.length).toBe(0);
      expect(source).toMatch(/from '\.\/doctor-checks-functional-shared\.js'/);
      const shared = readFileSync(
        join(process.cwd(), 'src', 'cli', 'commands', 'doctor-checks-functional-shared.ts'),
        'utf8',
      );
      expect(shared).toMatch(/from '\.\/doctor-checks-deep\.js'/);
      expect(shared).toMatch(/findModule|toImportUrl/);
      expect((shared.match(/process\.cwd\(\)/g) ?? []).length).toBe(0);
    });
  });
});
