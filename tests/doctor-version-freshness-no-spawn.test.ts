// Regression: Version Freshness must not spawn subprocesses, and the
// Zombie Processes warning must surface command lines for spawn-discipline
// forensics (otherwise every regression starts as a separate live trace).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const VERSION_TS = resolve(__dirname, '../src/cli/commands/doctor-version.ts');
const ZOMBIES_TS = resolve(__dirname, '../src/cli/commands/doctor-zombies.ts');

describe('checkVersionFreshness must not shell out to npm', () => {
  const src = readFileSync(VERSION_TS, 'utf-8');

  it('does NOT call `npm view` via runCommand/exec/spawn', () => {
    expect(src).not.toMatch(/npm\s+view\s+moflo/);
    // Also defend against alternative wordings that would re-introduce the
    // subprocess chain — `runCommand('npm`, `execAsync('npm`, etc.
    expect(src).not.toMatch(/runCommand\(['"]npm/);
    expect(src).not.toMatch(/execAsync\(['"]npm/);
    expect(src).not.toMatch(/spawn\(['"]npm/);
  });

  it('uses fetch() against the npm registry', () => {
    expect(src).toMatch(/fetch\(/);
    expect(src).toMatch(/registry\.npmjs\.org/);
  });

  it('exports checkVersionFreshness', () => {
    expect(src).toMatch(/export\s+async\s+function\s+checkVersionFreshness/);
  });
});

describe('findZombieProcesses surfaces command lines', () => {
  const src = readFileSync(ZOMBIES_TS, 'utf-8');

  it('declares ZombieDetail with a cmdline field', () => {
    expect(src).toMatch(/interface\s+ZombieDetail\s*\{[\s\S]*?cmdline\s*:\s*string/);
  });

  it('returns details from findZombieProcesses', () => {
    // The return shape must surface ZombieDetail so the warning can quote
    // the offending command line — accept either an inline `Promise<{...}>`
    // signature or a named return type alias (e.g. ZombieScanResult).
    expect(src).toMatch(/async function findZombieProcesses[\s\S]*?\)\s*:\s*Promise<[^>]*?>/);
    expect(src).toMatch(/details\s*:\s*ZombieDetail\[\]/);
  });

  it('Zombie Processes warn-branch surfaces details into the warning', () => {
    // The user-visible warning must reference the scanned details rather
    // than only PIDs, so a future regression is diagnosable from one run.
    const start = src.indexOf('export async function checkZombieProcesses');
    expect(start, 'checkZombieProcesses must exist').toBeGreaterThan(-1);
    const slice = src.slice(start, start + 3000);
    expect(slice).toMatch(/scan\.details/);
    expect(slice).toMatch(/'Zombie Processes'[\s\S]*?'warn'/);
  });

  it('cmdline formatting helper is wired in', () => {
    // The warning + --kill-zombies output both go through a single
    // formatter that emits `pid=… ppid=… cmd=…` for each orphan.
    expect(src).toMatch(/function formatZombieDetail\b/);
    expect(src).toMatch(/cmd=\$\{formatCmdline/);
  });
});
