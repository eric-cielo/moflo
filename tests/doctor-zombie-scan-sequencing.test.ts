/**
 * Regression test for #992: doctor's zombie scan must NOT race the parallel
 * health checks. `checkBuildTools` runs `npx tsc --version`; on Windows the
 * npx shim exits before its tsc child finishes, briefly orphaning tsc. If the
 * zombie scan runs in the same Promise.allSettled batch, it picks up that
 * tsc as a leak — flagging doctor's own subprocess as a zombie.
 *
 * The architectural invariant: `checkZombieProcesses` is exported as
 * `zombieScanCheck` and is NOT in `allChecks`. The doctor action runs it
 * sequentially after the parallel batch settles.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

describe('doctor zombie scan sequencing (#992)', () => {
  it('checkZombieProcesses is not part of the parallel allChecks batch', async () => {
    const registry = await import('../src/cli/commands/doctor-registry.js');
    const zombies = await import('../src/cli/commands/doctor-zombies.js');
    expect(registry.allChecks).not.toContain(zombies.checkZombieProcesses);
  });

  it('exports zombieScanCheck so doctor.ts can sequence it after the batch', async () => {
    const registry = await import('../src/cli/commands/doctor-registry.js');
    const zombies = await import('../src/cli/commands/doctor-zombies.js');
    expect(registry.zombieScanCheck).toBe(zombies.checkZombieProcesses);
  });

  it('checkBuildTools (the offending npx-spawning check) is in allChecks', async () => {
    // Lock the relationship: as long as checkBuildTools runs in the parallel
    // batch and zombieScanCheck does not, the race in #992 cannot recur.
    const registry = await import('../src/cli/commands/doctor-registry.js');
    const runtime = await import('../src/cli/commands/doctor-checks-runtime.js');
    expect(registry.allChecks).toContain(runtime.checkBuildTools);
  });

  it('doctor.ts orchestrator imports and invokes zombieScanCheck', () => {
    // Catches the inverse failure mode: the registry-side guard above passes
    // even if someone removes the sequential block from doctor.ts. Read the
    // source directly to lock the orchestration invariant.
    const here = dirname(fileURLToPath(import.meta.url));
    const doctorTs = readFileSync(join(here, '..', 'src', 'cli', 'commands', 'doctor.ts'), 'utf8');
    expect(doctorTs).toMatch(/import\s+\{[^}]*\bzombieScanCheck\b[^}]*\}\s+from\s+['"]\.\/doctor-registry/);
    expect(doctorTs).toMatch(/zombieScanCheck\s*\(\s*\)/);
  });
});
