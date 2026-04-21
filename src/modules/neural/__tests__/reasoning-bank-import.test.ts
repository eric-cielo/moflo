/**
 * Tests for ReasoningBank's @moflo/memory dynamic-import shape validation (issue #482).
 *
 * The production code silently swallows two failure modes:
 *   1. @moflo/memory not installed (expected — optional peer)
 *   2. @moflo/memory installed but exports renamed (dangerous — degrades to pass-through)
 *
 * This file asserts that case (2) emits a warning.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted mock — returns an empty module so the production code sees a module
// that loads but has none of the expected exports (simulating a rename).
vi.mock('@moflo/memory', () => ({}));

describe('ReasoningBank @moflo/memory import contract', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns when @moflo/memory is present but expected exports are missing', async () => {
    const { ReasoningBank } = await import('../src/reasoning-bank.js');
    const bank = new ReasoningBank({ enableMofloDb: true });
    await bank.initialize();

    const missingExportsCalls = warnSpy.mock.calls.filter(call =>
      typeof call[0] === 'string' && call[0].includes('missing expected exports'),
    );
    expect(missingExportsCalls.length).toBeGreaterThan(0);
    expect(missingExportsCalls[0][0]).toContain('MofloDbAdapter');
    expect(missingExportsCalls[0][0]).toContain('createDefaultEntry');
    // Persistence must stay off so we don't call undefined as a constructor
    expect(bank.isMofloDbAvailable()).toBe(false);

    await bank.shutdown();
  });
});
