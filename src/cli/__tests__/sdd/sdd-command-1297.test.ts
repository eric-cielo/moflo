/**
 * `flo sdd` command tests for issue #1297 — slug-stamping + PR-body embed.
 *
 * Covers:
 *   - `flo sdd spec` stamps sddMode + activeSddSlug into workflow-state.json so
 *     the check-before-implement gate knows which unit the run is building
 *   - `flo sdd embed` prints a collapsible spec+plan block for the PR body, and
 *     is a silent no-op when no spec exists
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sddCommand from '../../commands/sdd.js';
import type { CommandContext } from '../../types.js';

let root: string;

function ctx(args: string[], flags: Record<string, unknown> = {}): CommandContext {
  return { args, flags: flags as CommandContext['flags'], cwd: root, interactive: false };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'moflo-sdd-cmd-'));
  // A moflo.yaml marks the temp dir as the project root for findProjectRoot.
  writeFileSync(join(root, 'moflo.yaml'), 'sdd:\n  default: false\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('#1297 flo sdd spec stamps the active slug', () => {
  it('writes sddMode + activeSddSlug to workflow-state.json', async () => {
    await sddCommand.action(ctx(['spec', 'Add rate limiting']));
    const statePath = join(root, '.claude', 'workflow-state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(state.sddMode).toBe(true);
    expect(state.activeSddSlug).toBe('add-rate-limiting');
  });

  it('merges into an existing workflow-state without clobbering', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, '.claude'), { recursive: true });
    const statePath = join(root, '.claude', 'workflow-state.json');
    writeFileSync(statePath, JSON.stringify({ testsRun: true, verifyRun: true }));
    await sddCommand.action(ctx(['spec', 'My Feature']));
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(state.testsRun).toBe(true);
    expect(state.verifyRun).toBe(true);
    expect(state.activeSddSlug).toBe('my-feature');
  });
});

describe('#1297 flo sdd embed', () => {
  it('prints a collapsible spec+plan block', async () => {
    await sddCommand.action(ctx(['spec', 'Add caching']));
    await sddCommand.action(ctx(['plan', 'add-caching'], { force: true }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await sddCommand.action(ctx(['embed', 'add-caching']));
      expect(res.success).toBe(true);
      const out = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).toContain('<details>');
      expect(out).toContain('📋 SDD spec');
      expect(out).toContain('### Spec — Add caching');
      expect(out).toContain('### Plan');
      expect(out).toContain('</details>');
    } finally {
      log.mockRestore();
    }
  });

  it('is a silent success when no spec exists', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await sddCommand.action(ctx(['embed', 'nonexistent']));
      expect(res.success).toBe(true);
      expect((res.data as { embedded: boolean }).embedded).toBe(false);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
