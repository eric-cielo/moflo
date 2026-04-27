/**
 * Tests for the `.claude-flow` → `.moflo` migration helper (#699).
 *
 * Covers the rename path, the merge path, idempotency, and parity between the
 * TS implementation in src/cli/services/moflo-paths.ts and the pure-JS twin
 * in bin/lib/moflo-paths.mjs that runs from the consumer launcher.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  LEGACY_CLAUDE_FLOW_DIR,
  MOFLO_DIR,
  legacyClaudeFlowDir,
  migrateClaudeFlowToMoflo,
  mofloDir,
} from '../../services/moflo-paths.js';

function mkRoot(): string {
  return mkdtempSync(join(tmpdir(), 'moflo-migrate-'));
}

describe('migrateClaudeFlowToMoflo (#699)', () => {
  it('exposes the canonical and legacy directory names', () => {
    expect(MOFLO_DIR).toBe('.moflo');
    expect(LEGACY_CLAUDE_FLOW_DIR).toBe('.claude-flow');
  });

  it('no-ops when the legacy dir is absent', () => {
    const root = mkRoot();
    try {
      const result = migrateClaudeFlowToMoflo(root);
      expect(result).toEqual({ migrated: false, reason: 'no-legacy' });
      expect(existsSync(mofloDir(root))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renames .claude-flow → .moflo when target is fresh', () => {
    const root = mkRoot();
    try {
      const legacy = legacyClaudeFlowDir(root);
      mkdirSync(join(legacy, 'claims'), { recursive: true });
      writeFileSync(join(legacy, 'claims', 'claim.json'), '{"id":"abc"}');
      writeFileSync(join(legacy, 'daemon.lock'), '{"pid":123}');

      const result = migrateClaudeFlowToMoflo(root);

      expect(result.migrated).toBe(true);
      expect(existsSync(legacy)).toBe(false);
      expect(readFileSync(join(mofloDir(root), 'claims', 'claim.json'), 'utf8')).toBe('{"id":"abc"}');
      expect(readFileSync(join(mofloDir(root), 'daemon.lock'), 'utf8')).toBe('{"pid":123}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('merges legacy entries into target when both exist (target wins on collision)', () => {
    const root = mkRoot();
    try {
      const legacy = legacyClaudeFlowDir(root);
      const target = mofloDir(root);
      mkdirSync(legacy, { recursive: true });
      mkdirSync(target, { recursive: true });

      // Unique-to-legacy: should move
      writeFileSync(join(legacy, 'old-only.json'), 'old');
      mkdirSync(join(legacy, 'old-dir'));
      writeFileSync(join(legacy, 'old-dir', 'inside.txt'), 'old-inside');

      // Collision: target version must win
      writeFileSync(join(legacy, 'shared.json'), 'old-shared');
      writeFileSync(join(target, 'shared.json'), 'new-shared');

      const result = migrateClaudeFlowToMoflo(root);

      expect(result.migrated).toBe(true);
      expect(readFileSync(join(target, 'old-only.json'), 'utf8')).toBe('old');
      expect(readFileSync(join(target, 'old-dir', 'inside.txt'), 'utf8')).toBe('old-inside');
      // Target preserved on collision.
      expect(readFileSync(join(target, 'shared.json'), 'utf8')).toBe('new-shared');
      // Legacy collision file remains because we never overwrite target.
      expect(existsSync(join(legacy, 'shared.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent — second call after rename is a no-op', () => {
    const root = mkRoot();
    try {
      mkdirSync(legacyClaudeFlowDir(root), { recursive: true });
      writeFileSync(join(legacyClaudeFlowDir(root), 'a.txt'), '1');
      const first = migrateClaudeFlowToMoflo(root);
      const second = migrateClaudeFlowToMoflo(root);
      expect(first.migrated).toBe(true);
      expect(second.migrated).toBe(false);
      expect(second.reason).toBe('no-legacy');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops the legacy dir after a clean merge', () => {
    const root = mkRoot();
    try {
      const legacy = legacyClaudeFlowDir(root);
      mkdirSync(legacy);
      mkdirSync(mofloDir(root));
      writeFileSync(join(legacy, 'movable.json'), 'x');

      migrateClaudeFlowToMoflo(root);

      expect(existsSync(legacy)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the legacy dir when at least one entry collided (so a future run can retry)', () => {
    const root = mkRoot();
    try {
      const legacy = legacyClaudeFlowDir(root);
      const target = mofloDir(root);
      mkdirSync(legacy);
      mkdirSync(target);
      writeFileSync(join(legacy, 'collide.json'), 'old');
      writeFileSync(join(target, 'collide.json'), 'new');

      migrateClaudeFlowToMoflo(root);

      expect(existsSync(legacy)).toBe(true);
      expect(readdirSync(legacy)).toEqual(['collide.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bin/lib/moflo-paths.mjs parity', () => {
  it('exports the same constants and migration semantics as the TS module', async () => {
    // Dynamic import keeps this resilient to ESM quirks during test discovery.
    const mod: typeof import('../../../../bin/lib/moflo-paths.mjs') = await import('../../../../bin/lib/moflo-paths.mjs');

    expect(mod.MOFLO_DIR).toBe(MOFLO_DIR);
    expect(mod.LEGACY_CLAUDE_FLOW_DIR).toBe(LEGACY_CLAUDE_FLOW_DIR);

    const root = mkRoot();
    try {
      mkdirSync(join(root, '.claude-flow'), { recursive: true });
      writeFileSync(join(root, '.claude-flow', 'lock'), '1');
      const result = mod.migrateClaudeFlowToMoflo(root);
      expect(result.migrated).toBe(true);
      expect(existsSync(join(root, '.moflo', 'lock'))).toBe(true);
      expect(existsSync(join(root, '.claude-flow'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
