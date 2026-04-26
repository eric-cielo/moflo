/**
 * Prerequisite registry tests — step-command-owned prerequisites.
 *
 * Covers `collectPrerequisites` (step-command walker),
 * `checkPrerequisites`, and `formatPrerequisiteErrors`. See issue #522
 * (split of prerequisites.test.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  collectPrerequisites,
  checkPrerequisites,
  formatPrerequisiteErrors,
} from '../../spells/core/prerequisite-checker.js';
import { StepCommandRegistry } from '../../spells/core/step-command-registry.js';
import type { Prerequisite, PrerequisiteResult } from '../../spells/types/step-command.types.js';
import { makeCommand, makePrereq, simpleSpell } from './helpers/prereq-fixtures.js';

describe('collectPrerequisites', () => {
  it('collects prerequisites from multiple step commands', () => {
    const registry = new StepCommandRegistry();
    const ghPrereq = makePrereq('gh', true);
    const claudePrereq = makePrereq('claude', true);

    registry.register(makeCommand('github', [ghPrereq]));
    registry.register(makeCommand('agent', [claudePrereq]));
    registry.register(makeCommand('bash'));

    const def = simpleSpell([
      { id: 's1', type: 'github', config: {} },
      { id: 's2', type: 'agent', config: {} },
      { id: 's3', type: 'bash', config: {} },
    ]);

    const prereqs = collectPrerequisites(def, registry);
    expect(prereqs).toHaveLength(2);
    expect(prereqs.map(p => p.name)).toEqual(['gh', 'claude']);
  });

  it('deduplicates prerequisites by name', () => {
    const registry = new StepCommandRegistry();
    const ghPrereq = makePrereq('gh', true);

    registry.register(makeCommand('github', [ghPrereq]));
    // Second command type that also needs gh
    const cmd2 = makeCommand('github-pr', [ghPrereq]);
    registry.register(cmd2);

    const def = simpleSpell([
      { id: 's1', type: 'github', config: {} },
      { id: 's2', type: 'github-pr', config: {} },
    ]);

    const prereqs = collectPrerequisites(def, registry);
    expect(prereqs).toHaveLength(1);
    expect(prereqs[0].name).toBe('gh');
  });

  it('returns empty array when no prerequisites', () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand('bash'));

    const def = simpleSpell([{ id: 's1', type: 'bash', config: {} }]);
    const prereqs = collectPrerequisites(def, registry);
    expect(prereqs).toHaveLength(0);
  });

  it('ignores steps with unknown command types', () => {
    const registry = new StepCommandRegistry();
    registry.register(makeCommand('bash'));

    const def = simpleSpell([
      { id: 's1', type: 'unknown-type', config: {} },
      { id: 's2', type: 'bash', config: {} },
    ]);

    const prereqs = collectPrerequisites(def, registry);
    expect(prereqs).toHaveLength(0);
  });
});

describe('checkPrerequisites', () => {
  it('returns satisfied for all passing checks', async () => {
    const prereqs = [makePrereq('gh', true), makePrereq('claude', true)];
    const results = await checkPrerequisites(prereqs);

    expect(results).toHaveLength(2);
    expect(results.every(r => r.satisfied)).toBe(true);
  });

  it('returns unsatisfied for failing checks', async () => {
    const prereqs = [makePrereq('gh', true), makePrereq('playwright', false)];
    const results = await checkPrerequisites(prereqs);

    expect(results).toHaveLength(2);
    expect(results[0].satisfied).toBe(true);
    expect(results[1].satisfied).toBe(false);
    expect(results[1].name).toBe('playwright');
  });

  it('treats check() exceptions as unsatisfied', async () => {
    const errPrereq: Prerequisite = {
      name: 'broken',
      check: async () => { throw new Error('boom'); },
      installHint: 'Fix it',
    };
    const results = await checkPrerequisites([errPrereq]);

    expect(results).toHaveLength(1);
    expect(results[0].satisfied).toBe(false);
    expect(results[0].name).toBe('broken');
  });

  it('runs each check exactly once', async () => {
    const checkFn = vi.fn(async () => true);
    const prereq: Prerequisite = { name: 'gh', check: checkFn, installHint: '' };

    await checkPrerequisites([prereq]);
    expect(checkFn).toHaveBeenCalledTimes(1);
  });
});

describe('formatPrerequisiteErrors', () => {
  it('formats failed prerequisites with install hints', () => {
    const results: PrerequisiteResult[] = [
      { name: 'gh', satisfied: false, installHint: 'brew install gh', url: 'https://cli.github.com' },
      { name: 'claude', satisfied: false, installHint: 'npm i -g @anthropic-ai/claude-code' },
    ];

    const msg = formatPrerequisiteErrors(results);
    expect(msg).toContain('Missing prerequisites:');
    expect(msg).toContain('gh: brew install gh');
    expect(msg).toContain('https://cli.github.com');
    expect(msg).toContain('claude: npm i -g @anthropic-ai/claude-code');
  });

  it('returns empty string when all satisfied', () => {
    const results: PrerequisiteResult[] = [
      { name: 'gh', satisfied: true, installHint: '' },
    ];
    expect(formatPrerequisiteErrors(results)).toBe('');
  });

  it('only includes failed prerequisites', () => {
    const results: PrerequisiteResult[] = [
      { name: 'gh', satisfied: true, installHint: '' },
      { name: 'playwright', satisfied: false, installHint: 'npm i playwright' },
    ];
    const msg = formatPrerequisiteErrors(results);
    expect(msg).not.toMatch(/\bgh\b/);
    expect(msg).toContain('playwright');
  });
});
