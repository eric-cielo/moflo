/**
 * Daemon Spell Executor Tests
 *
 * Unit tests for DaemonSpellExecutor: Grimoire resolution, mofloLevel
 * fallback chain, abort-signal propagation to bridgeCancelSpell, and
 * error handling when the engine throws.
 *
 * Story #445.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { DaemonSpellExecutor } from '../../services/daemon-spell-executor.js';
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
