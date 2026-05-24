/**
 * Dual-read regression coverage for the claude-flow → moflo rebrand (#1209).
 *
 * The rebrand switched every WRITER to emit `MOFLO_*` env vars and the
 * `moflo.*` settings tree, but READS must keep honouring the pre-rebrand
 * `CLAUDE_FLOW_*` / `claudeFlow.*` names for at least one deprecation cycle so
 * a consumer whose shell env, persisted settings.json, or installed systemd
 * unit still uses the old names keeps working without a manual migration.
 *
 * These tests pin that contract:
 *   1. `readMofloEnv` prefers MOFLO_*, falls back to CLAUDE_FLOW_*.
 *   2. The update rate-limiter (a real reader) honours BOTH env spellings.
 *   3. `isHookBlockLocked` (the runtime reader of the settings tree) honours
 *      BOTH `moflo.hooks.locked` and the legacy `claudeFlow.hooks.locked`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readMofloEnv } from '../../services/env-compat.js';
import { shouldCheckForUpdates } from '../../update/rate-limiter.js';
import { isHookBlockLocked } from '../../services/hook-block-hash.js';

// Snapshot + restore every env key these tests touch so they don't leak.
const TOUCHED = [
  'MOFLO_DUAL_READ_PROBE',
  'CLAUDE_FLOW_DUAL_READ_PROBE',
  'MOFLO_AUTO_UPDATE',
  'CLAUDE_FLOW_AUTO_UPDATE',
  'MOFLO_FORCE_UPDATE',
  'CLAUDE_FLOW_FORCE_UPDATE',
  'CI',
  'CONTINUOUS_INTEGRATION',
];

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key];
});

describe('env-compat dual-read (#1209)', () => {
  describe('readMofloEnv', () => {
    it('returns undefined when neither name is set', () => {
      expect(readMofloEnv('DUAL_READ_PROBE')).toBeUndefined();
    });

    it('reads the legacy CLAUDE_FLOW_* name as a fallback', () => {
      process.env.CLAUDE_FLOW_DUAL_READ_PROBE = 'legacy';
      expect(readMofloEnv('DUAL_READ_PROBE')).toBe('legacy');
    });

    it('prefers the canonical MOFLO_* name over the legacy name', () => {
      process.env.CLAUDE_FLOW_DUAL_READ_PROBE = 'legacy';
      process.env.MOFLO_DUAL_READ_PROBE = 'canonical';
      expect(readMofloEnv('DUAL_READ_PROBE')).toBe('canonical');
    });
  });

  describe('update rate-limiter honours both env spellings', () => {
    it('disables auto-update via the legacy CLAUDE_FLOW_AUTO_UPDATE', () => {
      delete process.env.CI;
      delete process.env.CONTINUOUS_INTEGRATION;
      process.env.CLAUDE_FLOW_AUTO_UPDATE = 'false';
      const result = shouldCheckForUpdates();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('disabled');
    });

    it('disables auto-update via the canonical MOFLO_AUTO_UPDATE', () => {
      delete process.env.CI;
      delete process.env.CONTINUOUS_INTEGRATION;
      process.env.MOFLO_AUTO_UPDATE = 'false';
      const result = shouldCheckForUpdates();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('disabled');
    });

    it('forces an update via the canonical MOFLO_FORCE_UPDATE', () => {
      delete process.env.CI;
      delete process.env.CONTINUOUS_INTEGRATION;
      delete process.env.CLAUDE_FLOW_AUTO_UPDATE;
      process.env.MOFLO_FORCE_UPDATE = 'true';
      expect(shouldCheckForUpdates().allowed).toBe(true);
    });

    it('forces an update via the legacy CLAUDE_FLOW_FORCE_UPDATE', () => {
      delete process.env.CI;
      delete process.env.CONTINUOUS_INTEGRATION;
      delete process.env.CLAUDE_FLOW_AUTO_UPDATE;
      process.env.CLAUDE_FLOW_FORCE_UPDATE = 'true';
      expect(shouldCheckForUpdates().allowed).toBe(true);
    });
  });

  describe('isHookBlockLocked honours both settings trees', () => {
    it('honours the canonical moflo.hooks.locked', () => {
      expect(isHookBlockLocked({ moflo: { hooks: { locked: true } } })).toBe(true);
    });

    it('falls back to the legacy claudeFlow.hooks.locked', () => {
      expect(isHookBlockLocked({ claudeFlow: { hooks: { locked: true } } })).toBe(true);
    });

    it('is false when neither tree locks', () => {
      expect(isHookBlockLocked({ moflo: { hooks: {} } })).toBe(false);
      expect(isHookBlockLocked({})).toBe(false);
    });
  });
});
