/**
 * Regression tests for the launcher's AUTOMATIC worktree durable-sharing gate
 * (#1231 follow-up) — session-start-launcher §3e-1232.
 *
 * The durable flush/seed + auto-derivation is covered exhaustively at the
 * service layer by src/cli/__tests__/services/durable-sync.test.ts. What that
 * suite does NOT exercise is the thin-but-load-bearing launcher glue: the CHEAP,
 * IMPORT-FREE pre-gate that decides whether the durable service loads AT ALL.
 *
 * This gate ships to every consumer in `node_modules/moflo/bin/...` and is
 * default-ON for worktrees, so a regression is high-blast-radius in two
 * directions: if the worktree detection broke, worktree users would silently
 * stop converging; if the opt-out regex broke, `worktree_sharing: false` would
 * be ignored and the service would load for users who turned it off. This file
 * locks both:
 *
 *   1. Source-invariant: the launcher still contains the opt-out regex, the
 *      import-free `.git` worktree detection, the durable-sync service wiring,
 *      and the auto-mode mutation.
 *   2. Behavioral: the exact opt-out regex fires only on a real
 *      `worktree_sharing: false` line and ignores `true` / commented / absent.
 *
 * Pure string/regex work — no launcher spawn, no `.git` fixture — so it is
 * deterministic and cross-platform (Rule #1).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const LAUNCHER = resolve(__dirname, '../../bin/session-start-launcher.mjs');
const src = readFileSync(LAUNCHER, 'utf-8');

// The exact opt-out pre-gate regex the launcher uses (§3e-1232). The
// source-invariant test asserts the launcher still contains this literal, so
// the behavioral tests are guaranteed to exercise the real gate.
const OPT_OUT_REGEX = /^[ \t]*worktree_sharing[ \t]*:[ \t]*false\b/m;

describe('session-start-launcher — automatic worktree durable gate (#1231)', () => {
  describe('source-invariant: §3e-1232 durable auto-share wiring', () => {
    it('uses the exact `worktree_sharing: false` opt-out regex', () => {
      expect(src).toContain('/^[ \\t]*worktree_sharing[ \\t]*:[ \\t]*false\\b/m');
    });

    it('detects worktrees import-free via .git stat + worktrees registry', () => {
      // Linked-worktree branch (.git is a file) and primary-with-worktrees
      // branch (.git/worktrees non-empty) — both must be present so a single
      // checkout short-circuits without importing the service.
      expect(src).toMatch(/statSync\(dotgit\)/);
      expect(src).toContain("join(dotgit, 'worktrees')");
      expect(src).toMatch(/readdirSync\(wt\)\.length/);
    });

    it('still honors the explicit durable_path pre-gate + env override', () => {
      expect(src).toContain('/^[ \\t]*durable_path[ \\t]*:/m');
      expect(src).toMatch(/process\.env\.MOFLO_DURABLE_PATH/);
    });

    it('resolves the service from the installed package OR local dist', () => {
      expect(src).toContain('node_modules/moflo/dist/src/cli/services/durable-sync.js');
      expect(src).toContain('dist/src/cli/services/durable-sync.js');
    });

    it('imports + calls syncDurableAtSessionStart and explains auto mode once', () => {
      expect(src).toMatch(/syncDurableAtSessionStart\(\{\s*projectRoot\s*\}\)/);
      expect(src).toContain('auto-shared learnings across git worktrees');
      // The auto explanation is gated on rows actually moving, so it never
      // repeats every session on a 0/0 no-op.
      expect(src).toMatch(/result\?\.autoWorktree/);
    });

    it('runs BEFORE the daemon/background spawn framing', () => {
      const durableBlockAt = src.indexOf('3e-1232');
      const bgAt = src.indexOf('starting background tasks (daemon, indexer, pretrain');
      expect(durableBlockAt).toBeGreaterThan(-1);
      expect(bgAt).toBeGreaterThan(-1);
      expect(durableBlockAt).toBeLessThan(bgAt);
    });
  });

  describe('behavioral: worktree_sharing opt-out regex', () => {
    const disabling = {
      'nested 2-space (typical moflo.yaml)': 'memory:\n  worktree_sharing: false\n',
      'tab-indented': 'memory:\n\tworktree_sharing: false\n',
      'top-level': 'worktree_sharing: false\n',
    };
    for (const [label, yaml] of Object.entries(disabling)) {
      it(`OPTS OUT on a real worktree_sharing: false line — ${label}`, () => {
        expect(OPT_OUT_REGEX.test(yaml)).toBe(true);
      });
    }

    const notDisabling = {
      'explicitly true (auto stays on)': 'memory:\n  worktree_sharing: true\n',
      'commented out': 'memory:\n  # worktree_sharing: false\n',
      'absent entirely': 'memory:\n  durable_path: ./d.db\n',
      'unrelated substring key': 'memory:\n  no_worktree_sharing_here: false\n',
    };
    for (const [label, yaml] of Object.entries(notDisabling)) {
      it(`does NOT opt out — ${label}`, () => {
        expect(OPT_OUT_REGEX.test(yaml)).toBe(false);
      });
    }
  });
});
