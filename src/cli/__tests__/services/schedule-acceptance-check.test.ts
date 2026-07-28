/**
 * Schedule Acceptance Check — integration tests against a real Grimoire and
 * a real `.moflo/accepted-permissions/<name>.json` on a temp dir.
 *
 * Issue #1037: warn at schedule-create time when a spell has no accepted
 * permissions, so users know they need to manually cast once first.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkScheduleAcceptance } from '../../services/schedule-acceptance-check.js';
import { recordAcceptance } from '../../spells/core/permission-acceptance.js';

const SPELL_YAML = `name: acceptance-test
description: A test spell for #1037
steps:
  - id: s1
    type: bash
    config:
      command: echo hello
`;

describe('checkScheduleAcceptance (#1037)', () => {
  let projectRoot: string;
  let userSpellDir: string;
  let mofloYaml: string;

  // Warm the spell engine before any `it` runs.
  //
  // `checkScheduleAcceptance` → `buildGrimoire` → `loadSpellEngine`, which
  // dynamically imports the entire `spells/index.js` module graph and caches it
  // (`engine-loader.ts`). Whichever test triggered it first paid that cold
  // import inside its own 5 s budget — fine in isolation (~700 ms for the whole
  // file), but under a full parallel suite the same import took >5 s and the
  // FIRST test in the file timed out. That is the intermittent failure this
  // file contributed to the non-deterministic suite result: not a logic bug, a
  // one-time setup cost charged to a test-sized timeout.
  //
  // Paying it in `beforeAll` with room to breathe makes every `it` fast and
  // keeps the cost where it belongs — setup, not assertion.
  beforeAll(async () => {
    const { loadSpellEngine } = await import('../../services/engine-loader.js');
    await loadSpellEngine();
  }, 60_000);

  beforeEach(() => {
    // OS-assigned unique temp dir — `Date.now()+Math.random()` name-building
    // collides when tests run in the same millisecond under parallel load
    // (see learning pattern:test-tmpdir-mkdtemp-not-timestamp, #1278).
    projectRoot = mkdtempSync(join(tmpdir(), 'schedule-accept-'));
    userSpellDir = join(projectRoot, '.claude', 'spells');
    mkdirSync(userSpellDir, { recursive: true });
    writeFileSync(join(userSpellDir, 'acceptance-test.yaml'), SPELL_YAML, 'utf-8');

    // Tell the Grimoire builder where to find the spell yaml.
    mofloYaml = join(projectRoot, 'moflo.yaml');
    writeFileSync(mofloYaml, `spells:\n  userDirs:\n    - .claude/spells\n`, 'utf-8');
  });

  afterEach(() => {
    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns spell-not-found when the name is unknown', async () => {
    const result = await checkScheduleAcceptance(projectRoot, 'no-such-spell');
    expect(result.state).toBe('spell-not-found');
    expect(result.message).toContain('not found in the grimoire');
    expect(result.message).toContain('flo spell list');
  });

  it('returns never-accepted when the acceptance file is absent', async () => {
    const result = await checkScheduleAcceptance(projectRoot, 'acceptance-test');
    expect(result.state).toBe('never-accepted');
    expect(result.message).toContain('has not been accepted');
    expect(result.message).toContain('flo spell cast -n acceptance-test');
  });

  it('returns accepted when a matching acceptance file exists', async () => {
    // Compute the same hash the helper would, then record acceptance for it.
    const { analyzeSpellPermissions } = await import('../../spells/core/permission-disclosure.js');
    const { StepCommandRegistry } = await import('../../spells/core/step-command-registry.js');
    const { builtinCommands } = await import('../../spells/commands/index.js');
    const { buildGrimoire } = await import('../../services/grimoire-builder.js');
    const { registry } = await buildGrimoire(projectRoot);
    const loaded = registry.resolve('acceptance-test');
    expect(loaded).toBeTruthy();
    const stepRegistry = new StepCommandRegistry();
    for (const cmd of builtinCommands) stepRegistry.register(cmd, 'built-in');
    const report = analyzeSpellPermissions(loaded!.definition, stepRegistry);
    await recordAcceptance(projectRoot, 'acceptance-test', report.permissionHash);

    const result = await checkScheduleAcceptance(projectRoot, 'acceptance-test');
    expect(result.state).toBe('accepted');
    expect(result.message).toBe('');
  });

  it('returns hash-mismatch when the stored hash is stale', async () => {
    // Record an obviously-fake hash — the spell's real hash will differ.
    await recordAcceptance(projectRoot, 'acceptance-test', 'deadbeef00000000');

    const result = await checkScheduleAcceptance(projectRoot, 'acceptance-test');
    expect(result.state).toBe('hash-mismatch');
    expect(result.message).toContain('permissions have changed');
    expect(result.message).toContain('flo spell cast -n acceptance-test');
  });
});
