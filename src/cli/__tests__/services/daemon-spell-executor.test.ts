/**
 * Daemon Spell Executor Tests
 *
 * Unit tests for DaemonSpellExecutor: Grimoire resolution, mofloLevel
 * fallback chain, abort-signal propagation to bridgeCancelSpell, and
 * error handling when the engine throws.
 *
 * Story #445.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonSpellExecutor } from '../../services/daemon-spell-executor.js';
import { Grimoire as RealGrimoire } from '../../spells/registry/spell-registry.js';
import type { EngineModule, SandboxConfig } from '../../services/engine-loader.js';
import type { SpellResult } from '../../../spells/src/types/runner.types.js';
import type { SpellDefinition } from '../../../spells/src/types/spell-definition.types.js';
import type { MofloLevel, MemoryAccessor } from '../../../spells/src/types/step-command.types.js';
import type { Grimoire } from '../../../spells/src/registry/spell-registry.js';

function makeSuccess(spellId: string): SpellResult {
  return {
    spellId,
    success: true,
    steps: [],
    outputs: {},
    errors: [],
    duration: 5,
    cancelled: false,
  };
}

function makeDefinition(overrides: Partial<SpellDefinition> = {}): SpellDefinition {
  return {
    name: 'test-spell',
    steps: [{ id: 's1', type: 'bash', config: { command: 'echo hi' } }],
    ...overrides,
  } as SpellDefinition;
}

function makeEngine(): EngineModule & {
  bridgeExecuteSpell: Mock;
  bridgeCancelSpell: Mock;
  loadSandboxConfigFromProject: Mock;
  loadSpellBudgetFromProject: Mock;
} {
  const emptySandbox: SandboxConfig = {
    enabled: false,
    tier: 'none',
    platform: 'bwrap',
    allowlist: [],
    denylist: [],
  } as unknown as SandboxConfig;

  return {
    bridgeRunSpell: vi.fn(),
    bridgeExecuteSpell: vi.fn().mockImplementation(
      (_def, _args, opts: { spellId?: string }) => Promise.resolve(makeSuccess(opts?.spellId ?? 'spell-x')),
    ),
    bridgeCancelSpell: vi.fn().mockReturnValue(true),
    bridgeIsRunning: vi.fn().mockReturnValue(false),
    bridgeActiveSpells: vi.fn().mockReturnValue([]),
    Grimoire: vi.fn() as unknown as EngineModule['Grimoire'],
    SpellScheduler: vi.fn() as unknown as EngineModule['SpellScheduler'],
    runSpellFromContent: vi.fn(),
    loadSandboxConfigFromProject: vi.fn().mockResolvedValue(emptySandbox),
    // Default: no ceiling configured — the behaviour every install has today.
    loadSpellBudgetFromProject: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRegistry(map: Record<string, SpellDefinition>): Grimoire {
  return {
    resolve: vi.fn((name: string) => {
      const def = map[name];
      return def ? { definition: def, sourceFile: `/spells/${name}.yaml`, tier: 'user' } : undefined;
    }),
    list: vi.fn(() => Object.values(map).map(d => ({ name: d.name, tier: 'user' }))),
    info: vi.fn(),
    load: vi.fn(),
    invalidate: vi.fn(),
  } as unknown as Grimoire;
}

describe('DaemonSpellExecutor', () => {
  let engine: ReturnType<typeof makeEngine>;
  let memory: MemoryAccessor;

  beforeEach(() => {
    engine = makeEngine();
    memory = {
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([]),
    };
  });

  describe('exists', () => {
    it('returns true when the Grimoire resolves the spell', () => {
      const registry = makeRegistry({ 'my-spell': makeDefinition({ name: 'my-spell' }) });
      const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });

      expect(exec.exists('my-spell')).toBe(true);
    });

    it('returns false when the spell is not in the grimoire', () => {
      const registry = makeRegistry({});
      const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });

      expect(exec.exists('missing')).toBe(false);
    });

    it('invalidates the registry cache before resolving (#1034)', () => {
      // Scheduler poll calls exists() once per schedule per minute and
      // auto-disables on stale-false. Must re-scan disk each call so a
      // yaml added at runtime doesn't cause a schedule to be cancelled.
      const def = makeDefinition({ name: 'wf' });
      const registry = makeRegistry({ wf: def });
      const invalidateMock = registry.invalidate as Mock;
      const resolveMock = registry.resolve as Mock;
      const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });

      exec.exists('wf');

      expect(invalidateMock).toHaveBeenCalledTimes(1);
      expect(invalidateMock.mock.invocationCallOrder[0]).toBeLessThan(
        resolveMock.mock.invocationCallOrder[0],
      );
    });
  });

  describe('execute', () => {
    it('resolves the spell via Grimoire and calls bridgeExecuteSpell', async () => {
      const def = makeDefinition({ name: 'wf' });
      const registry = makeRegistry({ wf: def });
      const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', memory, engine });

      await exec.execute('wf', { foo: 'bar' });

      expect(engine.bridgeExecuteSpell).toHaveBeenCalledTimes(1);
      const [passedDef, passedArgs, passedOpts] = engine.bridgeExecuteSpell.mock.calls[0];
      expect(passedDef.name).toBe('wf');
      expect(passedArgs).toEqual({ foo: 'bar' });
      expect(passedOpts.projectRoot).toBe('/p');
      expect(passedOpts.memory).toBe(memory);
      expect(passedOpts.spellId).toMatch(/^scheduled-wf-/);
    });

    it('returns a failed SpellResult when the spell is missing (race after exists check)', async () => {
      const registry = makeRegistry({});
      const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });

      const result = await exec.execute('ghost', {});

      expect(result.success).toBe(false);
      expect(result.errors[0].message).toMatch(/not found in grimoire/);
      expect(engine.bridgeExecuteSpell).not.toHaveBeenCalled();
    });

    it('invalidates the registry cache before resolving (#1034)', async () => {
      // Daemons live forever; without per-fire invalidation, yaml edits on
      // disk are invisible until restart. Invalidate must happen before
      // resolve so the next call re-scans definition files.
      const def = makeDefinition({ name: 'wf' });
      const registry = makeRegistry({ wf: def });
      const invalidateMock = registry.invalidate as Mock;
      const resolveMock = registry.resolve as Mock;
      const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });

      await exec.execute('wf', {});

      expect(invalidateMock).toHaveBeenCalledTimes(1);
      const invalidateOrder = invalidateMock.mock.invocationCallOrder[0];
      const resolveOrder = resolveMock.mock.invocationCallOrder[0];
      expect(invalidateOrder).toBeLessThan(resolveOrder);
    });

    it('surfaces an engine-returned validation failure transparently', async () => {
      // The engine validates spell args internally and returns a SpellResult
      // with success:false rather than throwing. The executor must pass that
      // through untouched so the scheduler records the real failure.
      const registry = makeRegistry({ wf: makeDefinition({ name: 'wf' }) });
      engine.bridgeExecuteSpell.mockResolvedValueOnce({
        spellId: 'spell-x',
        success: false,
        steps: [],
        outputs: {},
        errors: [{ code: 'ARGUMENT_VALIDATION_FAILED', message: 'missing required arg: target' }],
        duration: 1,
        cancelled: false,
      } as SpellResult);
      const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });

      const result = await exec.execute('wf', {});

      expect(result.success).toBe(false);
      expect(result.errors[0].code).toBe('ARGUMENT_VALIDATION_FAILED');
      expect(result.errors[0].message).toMatch(/missing required arg/);
    });

    it('returns a failed SpellResult when the engine throws', async () => {
      const registry = makeRegistry({ wf: makeDefinition({ name: 'wf' }) });
      engine.bridgeExecuteSpell.mockRejectedValueOnce(new Error('engine explosion'));
      const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });

      const result = await exec.execute('wf', {});

      expect(result.success).toBe(false);
      expect(result.errors[0].message).toBe('engine explosion');
    });

    it('uses the scheduled mofloLevel when provided', async () => {
      const def = makeDefinition({ name: 'wf', mofloLevel: 'full' as MofloLevel });
      const registry = makeRegistry({ wf: def });
      const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });

      await exec.execute('wf', {}, undefined, 'hooks' as MofloLevel);

      const [passedDef] = engine.bridgeExecuteSpell.mock.calls[0];
      expect(passedDef.mofloLevel).toBe('hooks');
    });

    it("falls back to the definition's mofloLevel when scheduler gives none", async () => {
      const def = makeDefinition({ name: 'wf', mofloLevel: 'memory' as MofloLevel });
      const registry = makeRegistry({ wf: def });
      const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });

      await exec.execute('wf', {});

      const [passedDef] = engine.bridgeExecuteSpell.mock.calls[0];
      expect(passedDef.mofloLevel).toBe('memory');
    });

    it('falls back to defaultMofloLevel when neither schedule nor definition set one', async () => {
      const def = makeDefinition({ name: 'wf' });
      const registry = makeRegistry({ wf: def });
      const exec = new DaemonSpellExecutor({
        registry,
        projectRoot: '/p',
        engine,
        defaultMofloLevel: 'hooks' as MofloLevel,
      });

      await exec.execute('wf', {});

      const [passedDef] = engine.bridgeExecuteSpell.mock.calls[0];
      expect(passedDef.mofloLevel).toBe('hooks');
    });

    it('leaves mofloLevel unset when no source supplies one', async () => {
      const def = makeDefinition({ name: 'wf' });
      const registry = makeRegistry({ wf: def });
      const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });

      await exec.execute('wf', {});

      const [passedDef] = engine.bridgeExecuteSpell.mock.calls[0];
      expect(passedDef.mofloLevel).toBeUndefined();
    });

    it('propagates abort to the engine via bridgeCancelSpell', async () => {
      const def = makeDefinition({ name: 'wf' });
      const registry = makeRegistry({ wf: def });
      // Make execution hang so we can abort mid-flight
      let release!: (r: SpellResult) => void;
      engine.bridgeExecuteSpell.mockImplementation(
        (_d, _a, opts: { spellId?: string }) => new Promise<SpellResult>((resolve) => {
          release = (r) => resolve({ ...r, spellId: opts?.spellId ?? r.spellId });
        }),
      );
      // Supply sandbox explicitly so bridgeExecuteSpell is the only await gate
      const sandbox = { enabled: false } as unknown as SandboxConfig;
      const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine, sandboxConfig: sandbox });

      const controller = new AbortController();
      const pending = exec.execute('wf', {}, controller.signal);

      // Yield the microtask queue so bridgeExecuteSpell is reached and
      // the abort listener is registered before we cancel
      await Promise.resolve();
      await Promise.resolve();

      controller.abort();
      const [, , opts] = engine.bridgeExecuteSpell.mock.calls[0];
      expect(engine.bridgeCancelSpell).toHaveBeenCalledWith(opts.spellId);

      release(makeSuccess(opts.spellId));
      await pending;
    });

    it('cancels immediately when the signal is already aborted before execute', async () => {
      const def = makeDefinition({ name: 'wf' });
      const registry = makeRegistry({ wf: def });
      const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });

      const controller = new AbortController();
      controller.abort();
      await exec.execute('wf', {}, controller.signal);

      expect(engine.bridgeCancelSpell).toHaveBeenCalled();
    });

    it('uses the explicit sandbox config when provided, skipping auto-load', async () => {
      const def = makeDefinition({ name: 'wf' });
      const registry = makeRegistry({ wf: def });
      const customSandbox = { enabled: true, tier: 'strict' } as unknown as SandboxConfig;
      const exec = new DaemonSpellExecutor({
        registry, projectRoot: '/p', engine, sandboxConfig: customSandbox,
      });

      await exec.execute('wf', {});

      expect(engine.loadSandboxConfigFromProject).not.toHaveBeenCalled();
      const [, , opts] = engine.bridgeExecuteSpell.mock.calls[0];
      expect(opts.sandboxConfig).toBe(customSandbox);
    });
  });
});

// ============================================================================
// Integration — real Grimoire backed by a temp dir (#1034)
// ============================================================================

describe('DaemonSpellExecutor — yaml reload (real Grimoire)', () => {
  let tmpDir: string;
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `daemon-exec-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    engine = makeEngine();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('picks up yaml edits between fires without reconstruction', async () => {
    // The executor must invalidate the registry cache before resolve, otherwise
    // long-lived daemons hold a snapshot from startup and ignore disk edits
    // until restart. This test mirrors PR #1032's real-world repro: change a
    // spell definition between two scheduled fires, observe the new shape.
    const yamlPath = join(tmpDir, 'reload-test.yaml');
    writeFileSync(yamlPath, [
      'name: reload-test',
      'version: "1.0"',
      'steps:',
      '  - id: s1',
      '    type: bash',
      '    config:',
      '      command: echo before',
    ].join('\n'), 'utf-8');

    const registry = new RealGrimoire({ userDirs: [tmpDir], skipValidation: true });
    const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });

    await exec.execute('reload-test', {});
    const [firstDef] = engine.bridgeExecuteSpell.mock.calls[0];
    expect(firstDef.version).toBe('1.0');
    expect(firstDef.steps[0].config.command).toBe('echo before');

    writeFileSync(yamlPath, [
      'name: reload-test',
      'version: "2.0"',
      'steps:',
      '  - id: s1',
      '    type: bash',
      '    config:',
      '      command: echo after',
    ].join('\n'), 'utf-8');

    await exec.execute('reload-test', {});
    const [secondDef] = engine.bridgeExecuteSpell.mock.calls[1];
    expect(secondDef.version).toBe('2.0');
    expect(secondDef.steps[0].config.command).toBe('echo after');
  });

  // ── Spend ceiling (#1335) ───────────────────────────────────────────────

  describe('spend ceiling', () => {
    it('passes the scheduled ceiling from moflo.yaml to the engine', async () => {
      const registry = makeRegistry({ 'my-spell': makeDefinition({ name: 'my-spell' }) });
      engine.loadSpellBudgetFromProject.mockResolvedValue({ maxModelInvocations: 7 });
      const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });

      await exec.execute('my-spell', {});

      expect(engine.loadSpellBudgetFromProject).toHaveBeenCalledWith('/p', 'scheduled');
      const [, , opts] = engine.bridgeExecuteSpell.mock.calls[0];
      expect(opts.budget).toEqual({ maxModelInvocations: 7 });
    });

    it('omits budget entirely when nothing is configured', async () => {
      // Issue #1335 AC3: unset means today's behaviour exactly. A `budget:
      // undefined` key would still be a shape change for anything reading the
      // options object, so the key must be absent, not present-and-empty.
      const registry = makeRegistry({ 'my-spell': makeDefinition({ name: 'my-spell' }) });
      const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });

      await exec.execute('my-spell', {});

      const [, , opts] = engine.bridgeExecuteSpell.mock.calls[0];
      expect(Object.keys(opts)).not.toContain('budget');
    });

    it('prefers an explicitly injected ceiling over moflo.yaml', async () => {
      const registry = makeRegistry({ 'my-spell': makeDefinition({ name: 'my-spell' }) });
      const exec = new DaemonSpellExecutor({
        registry, projectRoot: '/p', engine,
        budgetConfig: { maxWallClockMs: 1234 },
      });

      await exec.execute('my-spell', {});

      expect(engine.loadSpellBudgetFromProject).not.toHaveBeenCalled();
      const [, , opts] = engine.bridgeExecuteSpell.mock.calls[0];
      expect(opts.budget).toEqual({ maxWallClockMs: 1234 });
    });

    it('re-reads the ceiling on every fire, so a yaml edit lands without restart', async () => {
      const registry = makeRegistry({ 'my-spell': makeDefinition({ name: 'my-spell' }) });
      engine.loadSpellBudgetFromProject
        .mockResolvedValueOnce({ maxModelInvocations: 2 })
        .mockResolvedValueOnce({ maxModelInvocations: 9 });
      const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });

      await exec.execute('my-spell', {});
      await exec.execute('my-spell', {});

      expect(engine.bridgeExecuteSpell.mock.calls[0][2].budget).toEqual({ maxModelInvocations: 2 });
      expect(engine.bridgeExecuteSpell.mock.calls[1][2].budget).toEqual({ maxModelInvocations: 9 });
    });

    it('logs a breach so it reaches the daemon log, not only the run record', async () => {
      // A ceiling that fires silently in an unattended process is
      // indistinguishable from the runaway it prevented.
      const registry = makeRegistry({ 'my-spell': makeDefinition({ name: 'my-spell' }) });
      engine.bridgeExecuteSpell.mockResolvedValue({
        spellId: 'scheduled-my-spell-1',
        success: false,
        steps: [],
        outputs: {},
        errors: [{ code: 'BUDGET_EXCEEDED', message: 'ceiling of 2 exceeded' }],
        duration: 12,
        cancelled: false,
      } satisfies SpellResult);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });
        const result = await exec.execute('my-spell', {});

        expect(result.success).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        const line = String(warn.mock.calls[0][0]);
        expect(line).toContain('spend ceiling');
        expect(line).toContain('my-spell');
        expect(line).toContain('ceiling of 2 exceeded');
      } finally {
        warn.mockRestore();
      }
    });

    it('stays quiet for an ordinary failure', async () => {
      const registry = makeRegistry({ 'my-spell': makeDefinition({ name: 'my-spell' }) });
      engine.bridgeExecuteSpell.mockResolvedValue({
        spellId: 'scheduled-my-spell-1',
        success: false,
        steps: [],
        outputs: {},
        errors: [{ code: 'STEP_EXECUTION_FAILED', message: 'boom' }],
        duration: 12,
        cancelled: false,
      } satisfies SpellResult);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const exec = new DaemonSpellExecutor({ registry, projectRoot: '/p', engine });
        await exec.execute('my-spell', {});
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });
});
