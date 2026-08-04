/**
 * Built-in worker reporters and the absent load average — #1358.
 *
 * `createPerformanceWorker` and `createHealthWorker` read `os.loadavg()` at
 * module scope, so the Windows path is reached here by mocking `os` rather
 * than by branching on `process.platform` inside the test — that fork would
 * never execute on the Ubuntu leg that runs this suite (Rule #1, cf. #1145).
 *
 * The mock lives in its own file so the rest of the worker suite keeps running
 * against the real `os`.
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import * as realOs from 'os';

const IS_WINDOWS_MOCK = { value: false };

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: actual,
    // Node returns exactly this on Windows: not an error, not NaN, three
    // zeros indistinguishable from an idle machine.
    loadavg: () => (IS_WINDOWS_MOCK.value ? [0, 0, 0] : actual.loadavg()),
    platform: () => (IS_WINDOWS_MOCK.value ? ('win32' as NodeJS.Platform) : actual.platform()),
  };
});

const { createPerformanceWorker, createHealthWorker } = await import('../../hooks/workers/index.js');

const PROJECT_ROOT = path.join(realOs.tmpdir(), 'moflo-1358-loadavg');

describe('#1358 — worker reporters omit the load average where there is none', () => {
  it('createPerformanceWorker reports null, not "0.00", on Windows', async () => {
    IS_WINDOWS_MOCK.value = true;
    try {
      const result = await createPerformanceWorker(PROJECT_ROOT)();
      const cpu = (result.data as { cpu: { cores: number; loadAvg: string | null } }).cpu;

      expect(cpu.loadAvg).toBeNull();
      // The rest of the payload is still measured — this is a targeted
      // omission, not a blanket "give up on Windows".
      expect(cpu.cores).toBeGreaterThan(0);
    } finally {
      IS_WINDOWS_MOCK.value = false;
    }
  });

  it('createHealthWorker reports null, not ["0.00","0.00","0.00"], on Windows', async () => {
    IS_WINDOWS_MOCK.value = true;
    try {
      const result = await createHealthWorker(PROJECT_ROOT)();
      const system = (result.data as { system: { loadAvg: string[] | null; platform: string } }).system;

      expect(system.loadAvg).toBeNull();
      expect(system.platform).toBe('win32');
    } finally {
      IS_WINDOWS_MOCK.value = false;
    }
  });

  it('createPerformanceWorker still reports a real figure on this platform', async () => {
    const result = await createPerformanceWorker(PROJECT_ROOT)();
    const cpu = (result.data as { cpu: { loadAvg: string | null } }).cpu;

    if (realOs.platform() === 'win32') {
      expect(cpu.loadAvg).toBeNull();
    } else {
      expect(cpu.loadAvg).not.toBeNull();
      expect(Number.isNaN(Number(cpu.loadAvg))).toBe(false);
    }
  });

  it('createHealthWorker still reports a real triple on this platform', async () => {
    const result = await createHealthWorker(PROJECT_ROOT)();
    const system = (result.data as { system: { loadAvg: string[] | null } }).system;

    if (realOs.platform() === 'win32') {
      expect(system.loadAvg).toBeNull();
    } else {
      expect(system.loadAvg).toHaveLength(3);
      expect(system.loadAvg!.every(v => !Number.isNaN(Number(v)))).toBe(true);
    }
  });
});
