/**
 * `resolveUnmetPrerequisites` tests — prompt + fail-fast paths (#460).
 *
 * Covers TTY prompting, non-TTY fail-fast, empty answers, command-type
 * prereqs that can't be resolved via prompt, explicit promptOnMissing=false,
 * and mid-prompt abort. See issue #522.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  compilePrerequisiteSpec,
  resolveUnmetPrerequisites,
  type PromptLineFn,
} from '../../src/spells/core/prerequisite-checker.js';
import type { Prerequisite } from '../../src/spells/types/step-command.types.js';
import type { PrerequisiteSpec } from '../../src/spells/types/spell-definition.types.js';
import { makePrereq } from './helpers/prereq-fixtures.js';

describe('resolveUnmetPrerequisites', () => {
  const ENV_KEY = 'FLO_RESOLVE_TEST_460';

  beforeEach(() => { delete process.env[ENV_KEY]; });

  it('returns ok immediately when every prereq is satisfied', async () => {
    const result = await resolveUnmetPrerequisites([makePrereq('ok', true)], {
      interactive: false,
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedNames).toEqual([]);
  });

  it('non-TTY path: fails fast with a report listing every unmet prereq', async () => {
    const prereqs: Prerequisite[] = [
      compilePrerequisiteSpec({
        name: 'TOK_A',
        docsUrl: 'https://a.example',
        detect: { type: 'env', key: 'TOK_A_460' },
      }),
      compilePrerequisiteSpec({
        name: 'TOK_B',
        docsUrl: 'https://b.example',
        detect: { type: 'env', key: 'TOK_B_460' },
      }),
    ];
    const result = await resolveUnmetPrerequisites(prereqs, { interactive: false });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('TOK_A');
    expect(result.message).toContain('TOK_B');
    expect(result.message).toContain('https://a.example');
    expect(result.message).toContain('https://b.example');
  });

  it('TTY path: prompts for unmet env prereq and writes answer into process.env', async () => {
    const spec: PrerequisiteSpec = {
      name: 'GRAPH_TOKEN',
      description: 'Graph token',
      docsUrl: 'https://graph.example',
      detect: { type: 'env', key: ENV_KEY },
      promptOnMissing: true,
    };
    const prereq = compilePrerequisiteSpec(spec);
    const promptLine = vi.fn<PromptLineFn>(async () => 'provided-value');
    const logged: string[] = [];
    const result = await resolveUnmetPrerequisites([prereq], {
      interactive: true,
      promptLine,
      log: (l) => logged.push(l),
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedNames).toEqual(['GRAPH_TOKEN']);
    expect(process.env[ENV_KEY]).toBe('provided-value');
    expect(promptLine).toHaveBeenCalledTimes(1);
    expect(logged.some(l => l.includes('Preflight'))).toBe(true);
    expect(logged.some(l => l.includes('Graph token'))).toBe(true);
    expect(logged.some(l => l.includes('https://graph.example'))).toBe(true);
  });

  it('TTY path: empty answer fails with "was not provided"', async () => {
    const prereq = compilePrerequisiteSpec({
      name: 'X',
      detect: { type: 'env', key: ENV_KEY },
    });
    const promptLine = vi.fn<PromptLineFn>(async () => '');
    const result = await resolveUnmetPrerequisites([prereq], {
      interactive: true,
      promptLine,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('was not provided');
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it('command-type unmet prereq with no promptable partner fails fast even on TTY', async () => {
    const prereq = compilePrerequisiteSpec({
      name: 'UNICORN_CLI',
      detect: { type: 'command', command: 'this-command-does-not-exist-xyz-460' },
    });
    const promptLine = vi.fn<PromptLineFn>(async () => 'ignored');
    const result = await resolveUnmetPrerequisites([prereq], {
      interactive: true,
      promptLine,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('UNICORN_CLI');
    expect(promptLine).not.toHaveBeenCalled();
  });

  it('does not prompt when promptOnMissing is explicitly false', async () => {
    const prereq = compilePrerequisiteSpec({
      name: 'OPT_OUT',
      promptOnMissing: false,
      detect: { type: 'env', key: ENV_KEY },
    });
    const promptLine = vi.fn<PromptLineFn>(async () => 'ignored');
    const result = await resolveUnmetPrerequisites([prereq], {
      interactive: true,
      promptLine,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(promptLine).not.toHaveBeenCalled();
  });

  it('aborts mid-prompt when abortSignal fires', async () => {
    const controller = new AbortController();
    const prereq = compilePrerequisiteSpec({
      name: 'X',
      detect: { type: 'env', key: ENV_KEY },
    });
    const promptLine: PromptLineFn = async (_line, signal) => {
      controller.abort();
      if (signal?.aborted) throw new Error('Prompt aborted');
      return '';
    };
    const result = await resolveUnmetPrerequisites([prereq], {
      interactive: true,
      promptLine,
      abortSignal: controller.signal,
      log: () => {},
    });
    expect(result.ok).toBe(false);
  });
});
