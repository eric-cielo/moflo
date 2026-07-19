/**
 * #1270: doctor's `AGENTS.md Interop` check — presence + freshness against the
 * generator, plus the `agents_md.enabled: false` opt-out.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { checkAgentsMd } from '../commands/doctor-checks-agents-md.js';
import { generateAgentsMd, AGENTS_MARKER_START, AGENTS_MARKER_END } from '../init/agentsmd-generator.js';

describe('checkAgentsMd — presence + freshness', () => {
  let tmpDir: string;
  let prevCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'moflo-doctor-agents-'));
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    // findProjectRoot() anchors on CLAUDE_PROJECT_DIR / package.json (see the
    // CLAUDE.md drift test) — point it at the fixture.
    writeFileSync(join(tmpDir, 'package.json'), '{"name":"tmp-fixture"}');
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    prevCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    delete process.env.CLAUDE_PROJECT_DIR;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('warns when AGENTS.md does not exist (default-on)', async () => {
    const r = await checkAgentsMd();
    expect(r.status).toBe('warn');
    expect(r.message).toContain('not found');
    expect(r.fix).toBeDefined();
  });

  it('passes when the block matches the canonical generator output', async () => {
    writeFileSync(join(tmpDir, 'AGENTS.md'), `# Agent Configuration\n\n${generateAgentsMd().trimEnd()}\n`);
    const r = await checkAgentsMd();
    expect(r.status).toBe('pass');
    expect(r.message).toContain('matches reference');
  });

  it('warns when a user-authored AGENTS.md has no moflo block (no-marker)', async () => {
    writeFileSync(join(tmpDir, 'AGENTS.md'), '# Our own AGENTS.md\n');
    const r = await checkAgentsMd();
    expect(r.status).toBe('warn');
    expect(r.message).toContain('no moflo block');
    expect(r.fix).toBeDefined();
  });

  it('warns when the block has drifted from canonical (drifted)', async () => {
    writeFileSync(join(tmpDir, 'AGENTS.md'), `${AGENTS_MARKER_START}\nstale\n${AGENTS_MARKER_END}\n`);
    const r = await checkAgentsMd();
    expect(r.status).toBe('warn');
    expect(r.message).toContain('drifted');
  });

  it('passes + reports skipped when opted out via moflo.yaml', async () => {
    writeFileSync(join(tmpDir, 'moflo.yaml'), 'project:\n  name: fixture\nagents_md:\n  enabled: false\n');
    // Even with no AGENTS.md present, the opt-out short-circuits to pass.
    const r = await checkAgentsMd();
    expect(r.status).toBe('pass');
    expect(r.message).toContain('disabled');
  });
});
