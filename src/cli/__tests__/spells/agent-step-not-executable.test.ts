/**
 * Agent Step — spell-level behaviour (#1334).
 *
 * `built-in-commands.test.ts` covers `agentCommand.execute()` directly. These
 * tests assert the two acceptance criteria that are only meaningful one level
 * up — that a *spell* containing an `agent` step fails its cast, and that such
 * a spell still parses and schema-validates so an upgrade does not break it.
 *
 * A command-level assertion cannot prove either: the runner could in principle
 * swallow a step failure, and parse/validate runs before any command executes.
 */

import { describe, it, expect } from 'vitest';
import { SpellCaster } from '../../spells/core/runner.js';
import { StepCommandRegistry } from '../../spells/core/step-command-registry.js';
import { agentCommand, AGENT_STEP_NOT_EXECUTABLE } from '../../spells/commands/agent-command.js';
import { validateSpellDefinition } from '../../spells/schema/validator.js';
import { parseSpell } from '../../spells/schema/parser.js';
import { makeCredentials, makeMemory } from './helpers.js';
import type { SpellDefinition } from '../../spells/types/spell-definition.types.js';

/** A spell of the exact shape the shipped docs used to teach. */
const AGENT_SPELL_YAML = `
name: research-spell
version: "1.0"
steps:
  - id: research
    type: agent
    config:
      agentType: researcher
      prompt: "Find all API endpoints"
`;

function agentSpell(): SpellDefinition {
  return {
    name: 'research-spell',
    steps: [
      { id: 'research', type: 'agent', config: { agentType: 'researcher', prompt: 'Find all API endpoints' } },
    ],
  };
}

function makeRunner(): SpellCaster {
  const registry = new StepCommandRegistry();
  registry.register(agentCommand);
  return new SpellCaster(registry, makeCredentials(), makeMemory());
}

describe('agent step — spell level (#1334)', () => {
  // AC 1 — the headline criterion. Before this change the cast returned
  // success:true and downstream steps consumed "Agent task prepared: ...".
  it('a spell containing an agent step does not report success', async () => {
    const result = await makeRunner().run(agentSpell(), {});
    expect(result.success).toBe(false);
  });

  // AC 2, at the level a spell author actually sees it.
  it('surfaces the not-executable reason in the cast result', async () => {
    const result = await makeRunner().run(agentSpell(), {});
    const serialised = JSON.stringify(result);
    expect(serialised).toContain('not executable');
    expect(serialised).toContain('claude -p');
  });

  it('produces no consumable result output for downstream steps', async () => {
    const result = await makeRunner().run(agentSpell(), {});
    expect(JSON.stringify(result)).not.toContain('Agent task prepared');
  });

  // AC 4 — the reason the step type was kept registered rather than deleted.
  // Parsing and validation must stay green so an upgrade does not turn a
  // silently-useless step into a hard error on a consumer's existing spell.
  it('existing agent-step YAML still parses', () => {
    const parsed = parseSpell(AGENT_SPELL_YAML, 'research-spell.yaml');
    expect(parsed.definition.steps[0].type).toBe('agent');
  });

  it('existing agent-step YAML still validates', () => {
    const parsed = parseSpell(AGENT_SPELL_YAML, 'research-spell.yaml');
    const result = validateSpellDefinition(parsed.definition);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('exports the failure message so callers can match on it', () => {
    expect(AGENT_STEP_NOT_EXECUTABLE).toContain('"agent" step type is not executable');
  });
});
