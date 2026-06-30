/**
 * Regression tests for the launcher's snapshot-hydration / auto-snapshot
 * pre-gates (#1244, epic #1231) — session-start-launcher §3e-1244 and §4b-1244.
 *
 * The whole snapshot service (backup/restore/hydrate/auto-snapshot) is covered
 * exhaustively by src/cli/__tests__/services/snapshot-restore.test.ts. What that
 * suite does NOT exercise is the thin-but-load-bearing glue in the launcher: the
 * CHEAP PRE-GATE that decides whether the feature engages AT ALL for a consumer.
 *
 * That gate ships to every consumer in `node_modules/moflo/bin/...`. If its regex
 * regressed — e.g. it started matching the commented `# hydrate_from:` example
 * `flo init` writes, or stopped matching a real `hydrate_from:` line — the feature
 * would silently misfire (load the service on every no-op session, or never
 * hydrate a configured worktree) with no test catching it. This file locks:
 *
 *   1. Source-invariant: the launcher still contains the exact pre-gate regex and
 *      the hydrate/auto-snapshot service wiring (resolve → import → call → mutate).
 *   2. Behavioral: that exact regex enables on a real `hydrate_from:` /
 *      `snapshot_to:` line (nested, tab-indented, or top-level) and IGNORES the
 *      commented example + unrelated substring keys.
 *
 * Pure string/regex work — no launcher spawn, no symlink, no dist copy — so it is
 * deterministic and cross-platform (Rule #1).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const LAUNCHER = resolve(__dirname, '../../bin/session-start-launcher.mjs');
const src = readFileSync(LAUNCHER, 'utf-8');

// The exact pre-gate regexes the launcher uses (§3e-1244 / §4b-1244). The
// source-invariant tests below assert the launcher still contains these literals,
// so the behavioral tests are guaranteed to be exercising the real gate.
const HYDRATE_REGEX = /^[ \t]*hydrate_from[ \t]*:/m;
const SNAPSHOT_REGEX = /^[ \t]*snapshot_to[ \t]*:/m;

describe('session-start-launcher — snapshot hydration pre-gate (#1244)', () => {
  describe('source-invariant: §3e-1244 hydrate-from wiring', () => {
    it('uses the exact uncommented `hydrate_from:` pre-gate regex', () => {
      expect(src).toContain('/^[ \\t]*hydrate_from[ \\t]*:/m');
    });

    it('honors the MOFLO_HYDRATE_FROM env override before parsing yaml', () => {
      expect(src).toMatch(/process\.env\.MOFLO_HYDRATE_FROM/);
    });

    it('resolves the service from the installed package OR local dist', () => {
      expect(src).toContain('node_modules/moflo/dist/src/cli/services/snapshot-restore.js');
      expect(src).toContain('dist/src/cli/services/snapshot-restore.js');
    });

    it('imports + calls hydrateAtSessionStart and emits a mutation on restore', () => {
      expect(src).toMatch(/hydrateAtSessionStart\(\{\s*projectRoot\s*\}\)/);
      expect(src).toContain('hydrated workspace from snapshot');
    });

    it('runs BEFORE the daemon/background spawn framing', () => {
      // Anchor on the §3e-1244 section banner and the real background-spawn emit
      // (the parenthetical is unique to the emit at the end of the launcher; an
      // earlier comment mentions "starting background tasks" without it). The
      // before-daemon ordering is load-bearing: the hydrated rows must exist
      // before the daemon builds its in-RAM HNSW index.
      const hydrateBlockAt = src.indexOf('3e-1244');
      const bgAt = src.indexOf('starting background tasks (daemon, indexer, pretrain');
      expect(hydrateBlockAt).toBeGreaterThan(-1);
      expect(bgAt).toBeGreaterThan(-1);
      expect(hydrateBlockAt).toBeLessThan(bgAt);
    });
  });

  describe('source-invariant: §4b-1244 auto-snapshot wiring', () => {
    it('uses the exact uncommented `snapshot_to:` pre-gate regex', () => {
      expect(src).toContain('/^[ \\t]*snapshot_to[ \\t]*:/m');
    });

    it('honors the MOFLO_SNAPSHOT_TO env override before parsing yaml', () => {
      expect(src).toMatch(/process\.env\.MOFLO_SNAPSHOT_TO/);
    });

    it('imports + calls autoSnapshotAtSessionStart and emits a mutation on write', () => {
      expect(src).toMatch(/autoSnapshotAtSessionStart\(\{\s*projectRoot\s*\}\)/);
      expect(src).toContain('refreshed memory snapshot');
    });
  });

  describe('behavioral: hydrate_from pre-gate regex', () => {
    const enabling = {
      'nested 2-space (typical moflo.yaml)': 'memory:\n  hydrate_from: ~/snap.db\n',
      'tab-indented': 'memory:\n\thydrate_from: ~/snap.db\n',
      'top-level': 'hydrate_from: ~/snap.db\n',
      'space before colon (valid YAML)': 'memory:\n  hydrate_from : ~/snap.db\n',
    };
    for (const [label, yaml] of Object.entries(enabling)) {
      it(`ENABLES on a real hydrate_from line — ${label}`, () => {
        expect(HYDRATE_REGEX.test(yaml)).toBe(true);
      });
    }

    const skipping = {
      'commented example flo init ships': 'memory:\n  # hydrate_from: ~/snap.db\n',
      'commented, no space after #': 'memory:\n  #hydrate_from: ~/snap.db\n',
      'unrelated key containing the substring': 'memory:\n  no_hydrate_from_here: true\n',
      'absent entirely': 'memory:\n  durable_path: ./d.db\n',
    };
    for (const [label, yaml] of Object.entries(skipping)) {
      it(`stays OFF — ${label}`, () => {
        expect(HYDRATE_REGEX.test(yaml)).toBe(false);
      });
    }
  });

  describe('behavioral: snapshot_to pre-gate regex', () => {
    it('ENABLES on a real snapshot_to line', () => {
      expect(SNAPSHOT_REGEX.test('memory:\n  snapshot_to: ~/seed.db\n')).toBe(true);
    });
    it('stays OFF on the commented example', () => {
      expect(SNAPSHOT_REGEX.test('memory:\n  # snapshot_to: ~/seed.db\n')).toBe(false);
    });
    it('stays OFF on an unrelated substring key', () => {
      expect(SNAPSHOT_REGEX.test('memory:\n  my_snapshot_to_keep: 1\n')).toBe(false);
    });
  });
});
