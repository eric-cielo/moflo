/**
 * Regression test for issue #757 — `status_line.show_agentdb` was dead config
 * after agentdb was removed in 4.8.80. This guards against re-adding it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadMofloConfig, type MofloConfig } from '../config/moflo-config.js';

// Compile-time guard: the type itself must not expose show_agentdb.
type _NoShowAgentdb = 'show_agentdb' extends keyof MofloConfig['status_line']
  ? never
  : true;
const _typeGuard: _NoShowAgentdb = true;
void _typeGuard;

describe('moflo-config: status_line.show_agentdb is dropped (#757)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'moflo-config-statusline-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('default config has no show_agentdb key', () => {
    const config = loadMofloConfig(root);
    expect(config.status_line).not.toHaveProperty('show_agentdb');
  });

  it('ignores show_agentdb when present in moflo.yaml', async () => {
    await writeFile(
      join(root, 'moflo.yaml'),
      'status_line:\n  show_agentdb: true\n  show_swarm: false\n',
    );
    const config = loadMofloConfig(root);
    expect(config.status_line).not.toHaveProperty('show_agentdb');
    expect(config.status_line.show_swarm).toBe(false);
  });
});
