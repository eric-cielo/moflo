/**
 * Issues #1324 and #1325 — MCP tools that return fabricated data must say so.
 *
 * Several registered tools return hardcoded literals, `Math.random()` draws, or
 * local-only state that never reaches the service they appear to describe.
 * Two of them actively asserted authenticity (`_real: true`, a description
 * advertising "REAL metrics"), which is the part that makes the numbers
 * undiscountable rather than merely useless.
 *
 * These tests pin the labeling in the two places a caller can see it — the
 * `description` returned by `tools/list`, and every response object — and pin
 * the boundary just as hard: tools that genuinely measure something must NOT
 * be labelled, or the marker degrades into noise.
 *
 * Cross-platform (Rule #1): the only filesystem contact is a `mkdtemp` project
 * root built with `path.join`; no shell, no platform-specific path literal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MCPTool } from '../../mcp-tools/types.js';

let fakeProjectRoot = '';
vi.mock('../../services/project-root.js', () => ({
  findProjectRoot: () => fakeProjectRoot,
}));

import {
  applySyntheticNotices,
  withSyntheticNotice,
  SYNTHETIC_PREFIX,
} from '../../mcp-tools/synthetic.js';
import { getMofloVersion, UNKNOWN_VERSION } from '../../services/moflo-version.js';
import { githubTools } from '../../mcp-tools/github-tools.js';
import { performanceTools } from '../../mcp-tools/performance-tools.js';
import { systemTools } from '../../mcp-tools/system-tools.js';
import { neuralTools } from '../../mcp-tools/neural-tools.js';
import { hooksTools } from '../../mcp-tools/hooks-tools.js';

const ALL_TOOLS: MCPTool[] = [
  ...githubTools,
  ...performanceTools,
  ...systemTools,
  ...neuralTools,
  ...hooksTools,
];

const byName = (name: string): MCPTool => {
  const tool = ALL_TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
};

/** Every tool #1324 + #1325 require to carry the marker. */
const LABELLED = [
  'github_repo_analyze',
  'github_pr_manage',
  'github_issue_track',
  'github_metrics',
  'performance_report',
  'system_health',
  'neural_train',
  'neural_predict',
  'hooks_metrics',
  'hooks_intelligence',
  'hooks_intelligence-reset',
];

/**
 * Tools in the same files that DO measure something. Labelling these would put
 * a SYNTHETIC banner on real results, which is the mirror-image failure.
 */
const NOT_LABELLED = [
  'performance_benchmark',
  'neural_patterns',
  'neural_status',
  'hooks_list',
];

/** Handlers cheap enough to invoke — neural_predict is excluded deliberately. */
const CHEAP_HANDLER_CASES: Array<{ name: string; input: Record<string, unknown> }> = [
  { name: 'github_repo_analyze', input: { owner: 'o', repo: 'r' } },
  { name: 'github_pr_manage', input: { action: 'list' } },
  { name: 'github_issue_track', input: { action: 'list' } },
  { name: 'github_metrics', input: { metric: 'all' } },
  { name: 'performance_report', input: { format: 'summary' } },
  { name: 'system_health', input: {} },
  { name: 'neural_train', input: { modelType: 'classifier', epochs: 1 } },
  { name: 'hooks_metrics', input: { period: '24h' } },
  { name: 'hooks_intelligence', input: { showStatus: true } },
  { name: 'hooks_intelligence-reset', input: {} },
];

beforeEach(() => {
  fakeProjectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-synthetic-')));
  writeFileSync(join(fakeProjectRoot, 'package.json'), '{"name":"fake"}');
});

afterEach(() => {
  try { rmSync(fakeProjectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  fakeProjectRoot = '';
});

describe('withSyntheticNotice', () => {
  const base: MCPTool = {
    name: 'sample',
    description: 'Do a thing',
    category: 'test',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ success: true, value: 1 }),
  };

  it('appends the notice to the description with the greppable prefix', () => {
    const wrapped = withSyntheticNotice(base, 'nothing is measured');
    expect(wrapped.description).toBe(`Do a thing. ${SYNTHETIC_PREFIX} nothing is measured`);
  });

  it('adds the marker and the notice to an object response', async () => {
    const wrapped = withSyntheticNotice(base, 'nothing is measured');
    const result = await wrapped.handler({}) as Record<string, unknown>;
    expect(result.synthetic).toBe(true);
    expect(result.syntheticNotice).toContain('nothing is measured');
    // The honest fields survive — this is labeling, not a rewrite.
    expect(result.success).toBe(true);
    expect(result.value).toBe(1);
  });

  it('overrides a handler that returns its own contradicting marker', async () => {
    const liar: MCPTool = { ...base, handler: async () => ({ synthetic: false, ok: true }) };
    const result = await withSyntheticNotice(liar, 'x').handler({}) as Record<string, unknown>;
    expect(result.synthetic).toBe(true);
  });

  it('passes a non-object result through rather than reshaping it', async () => {
    const stringy: MCPTool = { ...base, handler: async () => 'plain text' };
    expect(await withSyntheticNotice(stringy, 'x').handler({})).toBe('plain text');
  });

  it('passes an array result through rather than spreading it into an object', async () => {
    const arrayed: MCPTool = { ...base, handler: async () => [1, 2, 3] };
    expect(await withSyntheticNotice(arrayed, 'x').handler({})).toEqual([1, 2, 3]);
  });

  it('lets handler errors propagate — the wrapper must not swallow failures', async () => {
    const thrower: MCPTool = { ...base, handler: async () => { throw new Error('boom'); } };
    await expect(withSyntheticNotice(thrower, 'x').handler({})).rejects.toThrow('boom');
  });

  it('preserves every other tool field', () => {
    const wrapped = withSyntheticNotice(base, 'x');
    expect(wrapped.name).toBe('sample');
    expect(wrapped.category).toBe('test');
    expect(wrapped.inputSchema).toEqual(base.inputSchema);
  });

  it('forwards the context argument to the inner handler', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const spy: MCPTool = { ...base, handler: async (_i, ctx) => { seen.push(ctx); return {}; } };
    await withSyntheticNotice(spy, 'x').handler({}, { sessionId: 'abc' });
    expect(seen[0]).toEqual({ sessionId: 'abc' });
  });

  it('applySyntheticNotices leaves a tool absent from the map untouched', () => {
    const other: MCPTool = { ...base, name: 'honest' };
    const [labelled, untouched] = applySyntheticNotices([base, other], { sample: 'x' });
    expect(labelled.description).toContain(SYNTHETIC_PREFIX);
    expect(untouched.description).toBe('Do a thing');
    expect(untouched).toBe(other);
  });
});

describe('labelled tools (#1324, #1325 AC: markers present)', () => {
  it.each(LABELLED)('%s carries the notice in its description', name => {
    expect(byName(name).description).toContain(SYNTHETIC_PREFIX);
  });

  it.each(CHEAP_HANDLER_CASES)('$name returns synthetic: true', async ({ name, input }) => {
    const result = await byName(name).handler(input) as Record<string, unknown>;
    expect(result.synthetic).toBe(true);
    expect(String(result.syntheticNotice)).toContain(SYNTHETIC_PREFIX);
  });

  it('every labelled tool has a notice that actually says something', () => {
    for (const name of LABELLED) {
      const notice = byName(name).description.split(SYNTHETIC_PREFIX)[1] ?? '';
      expect(notice.trim().length).toBeGreaterThan(20);
    }
  });
});

describe('boundary — measured tools must stay unlabelled', () => {
  it.each(NOT_LABELLED)('%s is not marked synthetic in its description', name => {
    expect(byName(name).description).not.toContain(SYNTHETIC_PREFIX);
  });

  it('performance_benchmark still reports _real: true, because it really measures', async () => {
    const result = await byName('performance_benchmark').handler({
      suite: 'io', iterations: 5, warmup: false,
    }) as Record<string, unknown>;
    expect(result._real).toBe(true);
    expect(result.synthetic).toBeUndefined();
  });
});

describe('#1324 — github_pr_manage', () => {
  const tool = () => byName('github_pr_manage');

  it('states at the call site that no GitHub API call is made', () => {
    // The pre-fix description was the four words "Manage pull requests"; the
    // no-API-calls contract lived only in a source header comment, which an
    // agent selecting a tool never sees.
    expect(tool().description.toLowerCase()).toContain('no github api call is made');
    expect(tool().description).not.toBe('Manage pull requests');
  });

  it('marks a fabricated merge record', async () => {
    const result = await tool().handler({ action: 'merge', prNumber: 42 }) as Record<string, unknown>;
    expect(result.synthetic).toBe(true);
    // Behaviour is unchanged — still reports merged, still returns success.
    expect(result.action).toBe('merged');
    expect(result.success).toBe(true);
  });

  it('marks a fabricated review approval', async () => {
    const result = await tool().handler({ action: 'review', prNumber: 42 }) as Record<string, unknown>;
    expect(result.synthetic).toBe(true);
    expect((result.review as Record<string, unknown>).status).toBe('approved');
  });

  it('marks the honest list action too — local state is still not GitHub', async () => {
    const result = await tool().handler({ action: 'list' }) as Record<string, unknown>;
    expect(result.synthetic).toBe(true);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.pullRequests)).toBe(true);
  });

  it('marks the unknown-action error path', async () => {
    const result = await tool().handler({ action: 'nope' }) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.synthetic).toBe(true);
  });
});

describe('#1325 — no response claims authenticity it does not have', () => {
  it('performance_report no longer returns _real in summary format', async () => {
    const result = await byName('performance_report').handler({ format: 'summary' }) as Record<string, unknown>;
    expect(result._real).toBeUndefined();
    expect(result.synthetic).toBe(true);
  });

  it('performance_report no longer returns _real in detailed format', async () => {
    const result = await byName('performance_report').handler({ format: 'detailed' }) as Record<string, unknown>;
    expect(result._real).toBeUndefined();
    expect(result.synthetic).toBe(true);
  });

  it('performance_report still reports the CPU and memory it genuinely measures', async () => {
    const result = await byName('performance_report').handler({ format: 'summary' }) as Record<string, unknown>;
    expect(result.cpu).toMatch(/%$/);
    expect(result.memory).toMatch(/MB \/ \d+MB$/);
  });

  it('hooks_intelligence no longer advertises REAL metrics', () => {
    expect(byName('hooks_intelligence').description).not.toMatch(/REAL metrics/i);
  });

  it('hooks_intelligence-reset warns that nothing is reset', () => {
    // The strongest case in the set: the others misreport state, this one
    // reports an action that never happened.
    expect(byName('hooks_intelligence-reset').description).toContain('NOTHING IS RESET');
  });

  it('hooks_metrics is labelled, since period is accepted and ignored', async () => {
    const oneHour = await byName('hooks_metrics').handler({ period: '1h' }) as Record<string, unknown>;
    const thirtyDays = await byName('hooks_metrics').handler({ period: '30d' }) as Record<string, unknown>;
    expect(oneHour.synthetic).toBe(true);
    // Documents the behaviour the notice describes: identical numbers, and the
    // only difference is the echoed period and the timestamp.
    expect(oneHour.agents).toEqual(thirtyDays.agents);
    expect(oneHour.commands).toEqual(thirtyDays.commands);
  });
});

describe('#1325 — version is derived, not hardcoded', () => {
  const pkgVersion = (): string => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../../package.json'), 'utf-8'));
    return pkg.version as string;
  };

  it('getMofloVersion resolves this package.json', () => {
    expect(getMofloVersion()).toBe(pkgVersion());
    expect(getMofloVersion()).not.toBe(UNKNOWN_VERSION);
  });

  it('is stable across calls', () => {
    expect(getMofloVersion()).toBe(getMofloVersion());
  });

  it('hooks_intelligence reports the real version, not the 3.0.0-alpha.102 literal', async () => {
    const result = await byName('hooks_intelligence').handler({ showStatus: true }) as Record<string, unknown>;
    expect(result.version).toBe(pkgVersion());
    expect(result.version).not.toBe('3.0.0-alpha.102');
  });
});
