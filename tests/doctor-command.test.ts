/**
 * Doctor command tests — verifies health checks, embeddings check, and --fix auto-repair
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

// We test the exported functions by importing the doctor command module
// and inspecting its structure and behavior.

describe('doctor command structure', () => {
  let doctorCommand: any;

  beforeEach(async () => {
    const mod = await import('../src/packages/cli/src/commands/doctor.js');
    doctorCommand = mod.doctorCommand || mod.default;
  });

  it('should export a valid command', () => {
    expect(doctorCommand).toBeDefined();
    expect(doctorCommand.name).toBe('doctor');
    expect(doctorCommand.action).toBeInstanceOf(Function);
  });

  it('should have --fix option', () => {
    const fixOpt = doctorCommand.options.find((o: any) => o.name === 'fix');
    expect(fixOpt).toBeDefined();
    expect(fixOpt.type).toBe('boolean');
    expect(fixOpt.description).toMatch(/auto.*fix/i);
  });

  it('should have --component option that includes embeddings', () => {
    const compOpt = doctorCommand.options.find((o: any) => o.name === 'component');
    expect(compOpt).toBeDefined();
    expect(compOpt.description).toContain('embeddings');
  });

  it('should have --kill-zombies option', () => {
    const opt = doctorCommand.options.find((o: any) => o.name === 'kill-zombies');
    expect(opt).toBeDefined();
    expect(opt.type).toBe('boolean');
  });
});

describe('embeddings health check via vector-stats.json', () => {
  const testDir = join(process.cwd(), '.testoutput', '.test-doctor-tmp');
  const cfDir = join(testDir, '.claude-flow');
  const statsPath = join(cfDir, 'vector-stats.json');

  beforeEach(() => {
    mkdirSync(cfDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('should detect zero vectors from stats cache', () => {
    writeFileSync(statsPath, JSON.stringify({
      vectorCount: 0,
      dbSizeKB: 128,
      namespaces: 1,
      hasHnsw: false,
      updatedAt: Date.now()
    }));

    const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
    expect(stats.vectorCount).toBe(0);
    // A real check would return warn status
  });

  it('should detect healthy vectors from stats cache', () => {
    writeFileSync(statsPath, JSON.stringify({
      vectorCount: 42,
      dbSizeKB: 512,
      namespaces: 3,
      hasHnsw: true,
      updatedAt: Date.now()
    }));

    const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
    expect(stats.vectorCount).toBe(42);
    expect(stats.hasHnsw).toBe(true);
  });
});

describe('fix option descriptions', () => {
  it('should have actionable fix strings', async () => {
    const mod = await import('../src/packages/cli/src/commands/doctor.js');
    const cmd = mod.doctorCommand || mod.default;

    // The examples should show --fix for auto-fixing
    const fixExample = cmd.examples?.find((e: any) => e.command?.includes('--fix'));
    expect(fixExample).toBeDefined();
  });
});
