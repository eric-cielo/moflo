/**
 * `flo performance metrics` and the absent load average — #1358.
 *
 * The renderer branch is what this file proves: that a platform with no load
 * average prints "not measured" and emits JSON `null`, rather than the
 * `0.00, 0.00, 0.00` Node hands back on Windows.
 *
 * Rule #1: the platform is reached by mocking `os`, not by branching on
 * `process.platform` inside the test — that fork would never execute on the
 * Ubuntu leg that runs this suite (cf. #1145). The mock lives in its own file
 * so the rest of the command suite keeps running against the real `os`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const MOCK_WINDOWS = { value: false };

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: actual,
    loadavg: () => (MOCK_WINDOWS.value ? [0, 0, 0] : actual.loadavg()),
    platform: () => (MOCK_WINDOWS.value ? ('win32' as NodeJS.Platform) : actual.platform()),
  };
});

const { performanceCommand } = await import('../../commands/performance.js');
const { output } = await import('../../output.js');

const metricsCommand = performanceCommand.subcommands!.find(c => c.name === 'metrics')!;

async function runMetrics(format: string): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(output, 'writeln').mockImplementation((text = '') => {
    lines.push(text);
  });
  try {
    await metricsCommand.action!({ args: [], flags: { format } } as never);
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

describe('#1358 — flo performance metrics omits the load average where there is none', () => {
  beforeEach(() => { MOCK_WINDOWS.value = false; });
  afterEach(() => { MOCK_WINDOWS.value = false; });

  it('text output says "not measured", never 0.00', async () => {
    MOCK_WINDOWS.value = true;
    const text = await runMetrics('text');

    expect(text).toContain('Load Average: not measured (win32 has no load average)');
    expect(text).not.toContain('Load Average: 0.00');
  });

  it('json output emits null for cpu.loadAverage', async () => {
    MOCK_WINDOWS.value = true;
    const json = JSON.parse(await runMetrics('json').then(t => t.slice(t.indexOf('{'))));

    expect(json.cpu.loadAverage).toBeNull();
  });

  it('still renders the real reading on a platform that has one', async () => {
    const text = await runMetrics('text');

    expect(text).not.toContain('not measured');
    expect(text).toMatch(/Load Average: \d+\.\d{2}, \d+\.\d{2}, \d+\.\d{2}/);
  });

  it('still emits a real triple in json on a platform that has one', async () => {
    const json = JSON.parse(await runMetrics('json').then(t => t.slice(t.indexOf('{'))));

    expect(Array.isArray(json.cpu.loadAverage)).toBe(true);
    expect(json.cpu.loadAverage).toHaveLength(3);
  });
});
