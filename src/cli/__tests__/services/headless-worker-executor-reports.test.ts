/**
 * HeadlessWorkerExecutor — report persistence path
 *
 * Asserts that headless worker output always lands at the canonical
 * `<projectRoot>/.moflo/reports/<workerType>.<ext>` location, and never
 * at the project root. Pre-fix, the spawned `claude --print` was free to
 * write `test-coverage-gap.md`, `performance-analysis.md`, etc. wherever
 * the model chose — typically the project root — cluttering every
 * consumer install. This test pins the new behaviour.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { join } from 'path';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue(''),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

vi.mock('glob', () => ({
  glob: vi.fn().mockResolvedValue([]),
  globSync: vi.fn().mockReturnValue([]),
}));

import { spawn, execSync, type SpawnOptions } from 'child_process';
import { writeFileSync } from 'fs';
import {
  HeadlessWorkerExecutor,
  HEADLESS_WORKER_CONFIGS,
  type HeadlessWorkerType,
} from '../../services/headless-worker-executor.js';

const PROJECT_ROOT = '/tmp/test-headless-reports';
const SAMPLE_OUTPUT = '# Test Coverage Gaps\n\n- src/foo.ts: parseConfig untested\n';

/** Build a stub child that emits a chunk of stdout then closes cleanly. */
function makeStubChild(stdoutChunk: string): ChildProcess {
  const ee = new EventEmitter() as ChildProcess;
  ee.stdout = new EventEmitter() as NodeJS.ReadableStream;
  ee.stderr = new EventEmitter() as NodeJS.ReadableStream;
  // @ts-expect-error — stub doesn't need full ChildProcess surface
  ee.kill = vi.fn();
  setImmediate(() => {
    ee.stdout!.emit('data', Buffer.from(stdoutChunk));
    setImmediate(() => ee.emit('close', 0));
  });
  return ee;
}

describe('HeadlessWorkerExecutor — report persistence', () => {
  let executor: HeadlessWorkerExecutor;

  beforeEach(() => {
    (execSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue('1.2.3');
    (writeFileSync as unknown as ReturnType<typeof vi.fn>).mockClear();
    executor = new HeadlessWorkerExecutor(PROJECT_ROOT, { maxConcurrent: 1 });
    executor.on('error', () => { /* swallow */ });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the deepdive report to .moflo/reports/deepdive.md, never the project root', async () => {
    const child = makeStubChild(SAMPLE_OUTPUT);
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);

    const result = await executor.execute('deepdive');

    expect(result.success).toBe(true);

    const writes = (writeFileSync as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string]>;
    const reportWrite = writes.find(([p]) => p === join(PROJECT_ROOT, '.moflo', 'reports', 'deepdive.md'));
    expect(reportWrite, 'expected a write to .moflo/reports/deepdive.md').toBeTruthy();
    expect(reportWrite![1]).toBe(SAMPLE_OUTPUT);

    // No write should land at <projectRoot>/<something>.md — those are the
    // analysis files consumers were complaining about.
    const rootMdWrite = writes.find(([p]) => {
      if (!p.startsWith(PROJECT_ROOT)) return false;
      const rest = p.slice(PROJECT_ROOT.length + 1);
      return !rest.includes('/') && !rest.includes('\\') && rest.endsWith('.md');
    });
    expect(rootMdWrite, `unexpected MD write at project root: ${rootMdWrite?.[0]}`).toBeFalsy();
  });

  it('injects the absolute report path into the prompt so Claude writes to the same place', async () => {
    const child = makeStubChild(SAMPLE_OUTPUT);
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);

    await executor.execute('deepdive');

    const spawnCalls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[], SpawnOptions]>;
    // The executor probes availability separately; pick the `claude --print` call.
    const printCall = spawnCalls.find(([cmd, args]) => cmd === 'claude' && args[0] === '--print');
    expect(printCall, 'expected a claude --print spawn').toBeTruthy();
    const prompt = printCall![1][1];
    expect(prompt).toContain(join(PROJECT_ROOT, '.moflo', 'reports', 'deepdive.md'));
    expect(prompt).toMatch(/Save the full report to/);
  });

  it('spawns the worker read-only — allowlists Read/Glob/Grep, never Write/Edit (gate integrity, #1229)', async () => {
    const child = makeStubChild(SAMPLE_OUTPUT);
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);

    await executor.execute('deepdive');

    const spawnCalls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[], SpawnOptions]>;
    const printCall = spawnCalls.find(([cmd, args]) => cmd === 'claude' && args[0] === '--print');
    expect(printCall, 'expected a claude --print spawn').toBeTruthy();
    const args = printCall![1];

    // --print first, prompt second (callers depend on this ordering).
    expect(args[0]).toBe('--print');
    expect(typeof args[1]).toBe('string');

    // The read-only allowlist must be present and must NOT grant any
    // file-mutating tool — otherwise a "performance optimization" worker can
    // edit moflo.yaml to disable the memory_first gate (#1229).
    const allowIdx = args.indexOf('--allowedTools');
    expect(allowIdx, 'expected --allowedTools on the spawn').toBeGreaterThan(-1);
    const allowed = args[allowIdx + 1];
    expect(allowed).toBe('Read,Glob,Grep');
    for (const writeTool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) {
      expect(allowed.split(','), `${writeTool} must not be allow-listed`).not.toContain(writeTool);
    }
  });

  it('prompt forbids editing moflo.yaml / disabling gates (defense in depth, #1229)', async () => {
    const child = makeStubChild(SAMPLE_OUTPUT);
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);

    await executor.execute('deepdive');

    const spawnCalls = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[], SpawnOptions]>;
    const printCall = spawnCalls.find(([cmd, args]) => cmd === 'claude' && args[0] === '--print');
    const prompt = printCall![1][1];
    expect(prompt).toMatch(/never edit `moflo\.yaml`/);
    expect(prompt).toMatch(/never disable it/);
    expect(prompt).not.toMatch(/using the Write tool/);
  });

  it('uses the configured outputFormat to pick the file extension', async () => {
    // ultralearn declares outputFormat: 'json' — the report path must reflect it.
    const child = makeStubChild('{"insights":[]}');
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);

    await executor.execute('ultralearn');

    const writes = (writeFileSync as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string]>;
    const jsonReport = writes.find(([p]) => p === join(PROJECT_ROOT, '.moflo', 'reports', 'ultralearn.json'));
    expect(jsonReport, 'ultralearn report should be .json not .md').toBeTruthy();
  });

  it('covers all headless worker types', () => {
    // Pin the worker set so a future worker addition forces a deliberate
    // decision about its report location. optimize/testgaps were removed in
    // #1258 (moved to the /quicken + /ward skills).
    const workerTypes = Object.keys(HEADLESS_WORKER_CONFIGS).sort() as HeadlessWorkerType[];
    expect(workerTypes).toEqual(['deepdive', 'refactor', 'ultralearn']);
  });
});
