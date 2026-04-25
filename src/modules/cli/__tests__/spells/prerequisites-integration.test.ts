/**
 * Prerequisite integration tests — SpellCaster + real spell YAML.
 *
 * Covers `SpellCaster.run` / `dryRun` behavior when prerequisites are
 * unmet/met, plus the OAP retrofit (#518) which exercises YAML parsing,
 * validation, and `resolveUnmetPrerequisites` end-to-end. See issue #522.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import {
  compilePrerequisiteSpec,
  resolveUnmetPrerequisites,
  type PromptLineFn,
} from '../../src/spells/core/prerequisite-checker.js';
import { StepCommandRegistry } from '../../src/spells/core/step-command-registry.js';
import { SpellCaster } from '../../src/spells/core/runner.js';
import { parseSpell } from '../../src/spells/schema/parser.js';
import { validateSpellDefinition } from '../../src/spells/schema/validator.js';
import type { SpellDefinition } from '../../src/spells/types/spell-definition.types.js';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMockCredentials,
  createMockMemory,
  makeCommand,
  makePrereq,
  simpleSpell,
  withEnvVars,
} from './helpers/prereq-fixtures.js';

describe('SpellCaster — prerequisite integration', () => {
  let registry: StepCommandRegistry;
  let runner: SpellCaster;

  beforeEach(() => {
    registry = new StepCommandRegistry();
    runner = new SpellCaster(registry, createMockCredentials(), createMockMemory());
  });

  it('fails spell when prerequisites are not met', async () => {
    const failingPrereq = makePrereq('gh', false, 'Install: brew install gh');
    registry.register(makeCommand('github', [failingPrereq]));

    const def = simpleSpell([{ id: 's1', type: 'github', config: {} }]);
    const result = await runner.run(def, {});

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('PREREQUISITES_FAILED');
    expect(result.errors[0].message).toContain('gh');
    expect(result.errors[0].message).toContain('brew install gh');
  });

  it('succeeds when all prerequisites are met', async () => {
    const passingPrereq = makePrereq('gh', true);
    registry.register(makeCommand('github', [passingPrereq]));

    const def = simpleSpell([{ id: 's1', type: 'github', config: {} }]);
    const result = await runner.run(def, {});

    expect(result.success).toBe(true);
  });

  it('skips prerequisite checks in dry-run mode', async () => {
    const failingPrereq = makePrereq('gh', false);
    registry.register(makeCommand('github', [failingPrereq]));

    const def = simpleSpell([{ id: 's1', type: 'github', config: {} }]);
    const result = await runner.run(def, {}, { dryRun: true });

    // dry-run reports step validity, not prerequisite failure
    expect(result.errors.every(e => e.code !== 'PREREQUISITES_FAILED')).toBe(true);
  });

  it('collects and fails on spell-level YAML prereq', async () => {
    registry.register(makeCommand('bash'));

    const def: SpellDefinition = {
      name: 'needs-env',
      prerequisites: [{
        name: 'FLO_TEST_MISSING_460',
        description: 'Test env var',
        docsUrl: 'https://example.com/460',
        detect: { type: 'env', key: 'FLO_TEST_MISSING_460' },
        promptOnMissing: false, // force non-prompt fail-fast path
      }],
      steps: [{ id: 's1', type: 'bash', config: {} }],
    };

    delete process.env.FLO_TEST_MISSING_460;
    const result = await runner.run(def, {});

    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('PREREQUISITES_FAILED');
    expect(result.errors[0].message).toContain('FLO_TEST_MISSING_460');
    expect(result.errors[0].message).toContain('https://example.com/460');
  });

  it('reports prerequisite status in dry-run step reports', async () => {
    const ghPrereq = makePrereq('gh', true);
    const claudePrereq = makePrereq('claude', false);
    registry.register(makeCommand('github', [ghPrereq]));
    registry.register(makeCommand('agent', [claudePrereq]));

    const def = simpleSpell([
      { id: 's1', type: 'github', config: {} },
      { id: 's2', type: 'agent', config: {} },
    ]);

    const dryResult = await runner.dryRun(def, {});
    const s1Report = dryResult.steps.find(s => s.stepId === 's1')!;
    const s2Report = dryResult.steps.find(s => s.stepId === 's2')!;

    expect(s1Report.prerequisiteResults).toHaveLength(1);
    expect(s1Report.prerequisiteResults![0].satisfied).toBe(true);

    expect(s2Report.prerequisiteResults).toHaveLength(1);
    expect(s2Report.prerequisiteResults![0].satisfied).toBe(false);
  });
});

// OAP retrofit (#518) — outlook-attachment-processor.yaml end-to-end.
// Acceptance criteria:
//   - Both tokens are declared as spell-level `prerequisites:`.
//   - The four hand-rolled preflight steps are removed.
//   - Casting on a non-TTY without env vars fails fast with BOTH tokens listed
//     and both docs URLs present in the error report (no partial run).

describe('OAP spell retrofit (#518)', () => {
  let oapDef: SpellDefinition;

  beforeAll(async () => {
    // Walk up from this test file until we find the repo root (where `spells/`
    // lives). Avoids hard-coding ../ counts, which drift if the test file moves.
    const here = path.dirname(fileURLToPath(import.meta.url));
    let dir = here;
    let oapPath: string | undefined;
    for (let i = 0; i < 10; i++) {
      const candidate = path.join(dir, 'spells', 'dev', 'outlook-attachment-processor.yaml');
      try {
        await fsPromises.access(candidate);
        oapPath = candidate;
        break;
      } catch {
        // keep walking
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!oapPath) {
      throw new Error(`Cannot locate spells/dev/outlook-attachment-processor.yaml above ${here}`);
    }
    const yaml = await fsPromises.readFile(oapPath, 'utf8');
    oapDef = parseSpell(yaml, oapPath).definition;
  });

  it('parses + validates with both prerequisites declared at spell level', () => {
    const result = validateSpellDefinition(oapDef);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);

    const prereqNames = (oapDef.prerequisites ?? []).map(p => p.name);
    expect(prereqNames).toEqual(['GRAPH_ACCESS_TOKEN', 'SLACK_WEBHOOK_URL']);
  });

  it('has no hand-rolled preflight steps (env-graph/ask-graph-token/env-slack/ask-slack-url)', () => {
    const stepIds = oapDef.steps.map(s => s.id);
    expect(stepIds).not.toContain('env-graph');
    expect(stepIds).not.toContain('ask-graph-token');
    expect(stepIds).not.toContain('env-slack');
    expect(stepIds).not.toContain('ask-slack-url');
  });

  it('non-TTY without env vars fails fast with both tokens + docs URLs', async () => {
    await withEnvVars(
      { GRAPH_ACCESS_TOKEN: undefined, SLACK_WEBHOOK_URL: undefined },
      async () => {
        const prereqs = (oapDef.prerequisites ?? []).map(compilePrerequisiteSpec);
        const result = await resolveUnmetPrerequisites(prereqs, { interactive: false });
        expect(result.ok).toBe(false);
        expect(result.message).toContain('GRAPH_ACCESS_TOKEN');
        expect(result.message).toContain('SLACK_WEBHOOK_URL');
        expect(result.message).toContain('https://developer.microsoft.com/en-us/graph/graph-explorer');
        expect(result.message).toContain('https://api.slack.com/messaging/webhooks');
      },
    );
  });

  it('with both env vars set, preflight passes without prompting', async () => {
    await withEnvVars(
      {
        GRAPH_ACCESS_TOKEN: 'test-graph-token',
        SLACK_WEBHOOK_URL: 'https://hooks.slack.com/test',
      },
      async () => {
        const prereqs = (oapDef.prerequisites ?? []).map(compilePrerequisiteSpec);
        const promptLine = vi.fn<PromptLineFn>(async () => 'unreachable');
        const result = await resolveUnmetPrerequisites(prereqs, {
          interactive: true,
          promptLine,
          log: () => {},
        });
        expect(result.ok).toBe(true);
        expect(result.resolvedNames).toEqual([]);
        expect(promptLine).not.toHaveBeenCalled();
      },
    );
  });
});
