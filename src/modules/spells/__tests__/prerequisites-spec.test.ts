/**
 * Prerequisite spec tests — YAML-driven detectors + walker.
 *
 * Covers `compilePrerequisiteSpec` (env/file/command detectors, default
 * behavior) and the YAML walker branch of `collectPrerequisites`
 * (spell-level, step-level, nested steps, dedupe). See issue #522.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  collectPrerequisites,
  compilePrerequisiteSpec,
} from '../src/core/prerequisite-checker.js';
import { StepCommandRegistry } from '../src/core/step-command-registry.js';
import type {
  SpellDefinition,
  PrerequisiteSpec,
} from '../src/types/spell-definition.types.js';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { makeCommand, makePrereq } from './helpers/prereq-fixtures.js';

describe('compilePrerequisiteSpec', () => {
  const ENV_KEY = 'FLO_PREREQ_TEST_ENV';

  beforeEach(() => { delete process.env[ENV_KEY]; });

  it('env detector: passes when env var is set to non-empty', async () => {
    process.env[ENV_KEY] = 'value';
    const compiled = compilePrerequisiteSpec({
      name: 'TEST_ENV',
      detect: { type: 'env', key: ENV_KEY },
    });
    expect(await compiled.check()).toBe(true);
    expect(compiled.envKey).toBe(ENV_KEY);
  });

  it('env detector: fails when env var is unset', async () => {
    const compiled = compilePrerequisiteSpec({
      name: 'TEST_ENV',
      detect: { type: 'env', key: ENV_KEY },
    });
    expect(await compiled.check()).toBe(false);
  });

  it('env detector: fails when env var is an empty string', async () => {
    process.env[ENV_KEY] = '';
    const compiled = compilePrerequisiteSpec({
      name: 'TEST_ENV',
      detect: { type: 'env', key: ENV_KEY },
    });
    expect(await compiled.check()).toBe(false);
  });

  it('file detector: passes when file exists, fails when missing', async () => {
    const tmp = path.join(os.tmpdir(), `flo-prereq-${Date.now()}.txt`);
    await fsPromises.writeFile(tmp, 'x');
    try {
      const present = compilePrerequisiteSpec({
        name: 'CFG',
        detect: { type: 'file', path: tmp },
      });
      expect(await present.check()).toBe(true);
    } finally {
      await fsPromises.unlink(tmp);
    }

    const missing = compilePrerequisiteSpec({
      name: 'CFG',
      detect: { type: 'file', path: path.join(os.tmpdir(), 'flo-prereq-nonexistent-xyz') },
    });
    expect(await missing.check()).toBe(false);
  });

  it('command detector: fails when command is not on PATH', async () => {
    const compiled = compilePrerequisiteSpec({
      name: 'UNICORN',
      detect: { type: 'command', command: 'this-command-definitely-does-not-exist-xyz-460' },
    });
    expect(await compiled.check()).toBe(false);
    expect(compiled.envKey).toBeUndefined();
  });

  it('defaults promptOnMissing to true, url passes through from docsUrl', () => {
    const compiled = compilePrerequisiteSpec({
      name: 'X',
      docsUrl: 'https://docs.example',
      detect: { type: 'env', key: 'X' },
    });
    expect(compiled.promptOnMissing).toBe(true);
    expect(compiled.url).toBe('https://docs.example');
  });

  it('respects explicit promptOnMissing=false', () => {
    const compiled = compilePrerequisiteSpec({
      name: 'X',
      promptOnMissing: false,
      detect: { type: 'env', key: 'X' },
    });
    expect(compiled.promptOnMissing).toBe(false);
  });
});

describe('collectPrerequisites — YAML walker', () => {
  it('picks up spell-level YAML prereqs', () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand('bash'));
    const def: SpellDefinition = {
      name: 'x',
      prerequisites: [{ name: 'TOK', detect: { type: 'env', key: 'TOK' } }],
      steps: [{ id: 's1', type: 'bash', config: {} }],
    };
    const prereqs = collectPrerequisites(def, registry);
    expect(prereqs.map(p => p.name)).toContain('TOK');
    expect(prereqs.find(p => p.name === 'TOK')!.envKey).toBe('TOK');
  });

  it('picks up step-level YAML prereqs', () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand('bash'));
    const def: SpellDefinition = {
      name: 'x',
      steps: [{
        id: 's1', type: 'bash', config: {},
        prerequisites: [{ name: 'GH', detect: { type: 'command', command: 'gh' } }],
      }],
    };
    expect(collectPrerequisites(def, registry).map(p => p.name)).toEqual(['GH']);
  });

  it('walks nested loop/condition/parallel step bodies', () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand('loop'));
    registry.register(makeCommand('bash'));
    const def: SpellDefinition = {
      name: 'x',
      steps: [{
        id: 'outer', type: 'loop', config: {},
        steps: [{
          id: 'inner', type: 'bash', config: {},
          prerequisites: [{ name: 'NESTED', detect: { type: 'env', key: 'NESTED' } }],
        }],
      }],
    };
    expect(collectPrerequisites(def, registry).map(p => p.name)).toContain('NESTED');
  });

  it('dedupes across spell + step + step-command built-in (first wins)', () => {
    const registry = new StepCommandRegistry();
    const builtin = makePrereq('SHARED', true, 'builtin-hint');
    registry.register(makeCommand('github', [builtin]));

    const spellSpec: PrerequisiteSpec = {
      name: 'SHARED',
      description: 'spell-level',
      detect: { type: 'env', key: 'SHARED' },
    };
    const def: SpellDefinition = {
      name: 'x',
      prerequisites: [spellSpec],
      steps: [{ id: 's1', type: 'github', config: {} }],
    };

    const prereqs = collectPrerequisites(def, registry);
    expect(prereqs).toHaveLength(1);
    // Spell-level declaration wins (compiled from the YAML spec)
    expect(prereqs[0].description).toBe('spell-level');
    expect(prereqs[0].installHint).toBe('spell-level');
    expect(prereqs[0].envKey).toBe('SHARED');
  });
});
