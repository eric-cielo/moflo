/**
 * #1142: doctor's `CLAUDE.md Injection Drift` check covers the five drift
 * states and honours `auto_update.claudemd_injection_drift: off`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { checkClaudeMdInjectionDrift } from '../commands/doctor-checks-deep.js';
import { generateClaudeMd, MARKER_START, MARKER_END, LEGACY_MARKER_STARTS, LEGACY_MARKER_ENDS } from '../init/claudemd-generator.js';

describe('checkClaudeMdInjectionDrift — five states', () => {
  let tmpDir: string;
  let prevCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'moflo-doctor-claudemd-'));
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
    // findProjectRoot() walks up from cwd looking for package.json/.git.
    // Anchor the search at tmpDir so the doctor check reads from the fixture.
    writeFileSync(join(tmpDir, 'package.json'), '{"name":"tmp-fixture"}');
    // Set CLAUDE_PROJECT_DIR for findProjectRoot's primary anchor (per
    // feedback_unified_project_root_resolver.md — tests with tmp roots must
    // set this env var).
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    prevCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    delete process.env.CLAUDE_PROJECT_DIR;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("warns when CLAUDE.md does not exist (no-file)", async () => {
    const result = await checkClaudeMdInjectionDrift();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('not found');
    expect(result.fix).toBeDefined();
  });

  it("warns when CLAUDE.md has no MoFlo marker pair (no-marker)", async () => {
    writeFileSync(join(tmpDir, 'CLAUDE.md'), '# Project\n\nNo moflo block.');
    const result = await checkClaudeMdInjectionDrift();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('no MOFLO');
    expect(result.fix).toBeDefined();
  });

  it("warns when CLAUDE.md uses a legacy marker pair (legacy-marker)", async () => {
    const legacy = `# Project\n\n${LEGACY_MARKER_STARTS[0]}\nold content\n${LEGACY_MARKER_ENDS[0]}\n`;
    writeFileSync(join(tmpDir, 'CLAUDE.md'), legacy);
    const result = await checkClaudeMdInjectionDrift();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('legacy');
    expect(result.fix).toBeDefined();
  });

  it("passes when the injected block matches the canonical generator output (in-sync)", async () => {
    const canonical = generateClaudeMd({});
    writeFileSync(join(tmpDir, 'CLAUDE.md'), `# Project\n\n${canonical.trimEnd()}\n`);
    const result = await checkClaudeMdInjectionDrift();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('matches reference');
  });

  it("warns when the injected block has drifted from canonical (drifted)", async () => {
    const stale = `${MARKER_START}\nstale content\nold .claude/guidance/shipped/foo.md path\n${MARKER_END}`;
    writeFileSync(join(tmpDir, 'CLAUDE.md'), `# Project\n\n${stale}\n`);
    const result = await checkClaudeMdInjectionDrift();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('drifted');
    expect(result.fix).toBeDefined();
  });

  it("returns pass when auto_update.claudemd_injection_drift: off (skip suppression)", async () => {
    const stale = `${MARKER_START}\nstale\n${MARKER_END}`;
    writeFileSync(join(tmpDir, 'CLAUDE.md'), `# Project\n\n${stale}\n`);
    writeFileSync(
      join(tmpDir, 'moflo.yaml'),
      `auto_update:\n  enabled: true\n  claudemd_injection_drift: off\n`,
    );
    const result = await checkClaudeMdInjectionDrift();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('off');
  });

  it("repairs the motailz-style stale block when the fix is applied", async () => {
    // Frozen fixture replicating motailz/code/CLAUDE.md (pre-1142 state).
    const motailzBlock = [
      MARKER_START,
      '## MoFlo — AI Agent Orchestration',
      '',
      'This project uses [MoFlo](https://github.com/eric-cielo/moflo) for AI-assisted development spells.',
      '',
      '### Full Reference',
      '',
      'For CLI commands, hooks, agents, swarm config, memory commands, and moflo.yaml options, see:',
      '`.claude/guidance/shipped/moflo-core-guidance.md`',
      MARKER_END,
    ].join('\n');
    writeFileSync(join(tmpDir, 'CLAUDE.md'), `# Project\n\n${motailzBlock}\n`);

    // First check: drifted.
    const before = await checkClaudeMdInjectionDrift();
    expect(before.status).toBe('warn');
    expect(before.message).toContain('drifted');

    // Apply fix using the shared service (exact same code path as the
    // `CLAUDE.md Injection Drift` entry in doctor-fixes.ts).
    const { applyInjectionReplacement } = await import('../services/claudemd-injection.js');
    const { readFileSync, writeFileSync: ws } = await import('fs');
    const canonical = generateClaudeMd({});
    const existing = readFileSync(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    const repaired = applyInjectionReplacement(existing, canonical);
    expect(repaired.changed).toBe(true);
    ws(join(tmpDir, 'CLAUDE.md'), repaired.contents!);

    // Second check: in-sync, no shipped/ reference remaining.
    const after = await checkClaudeMdInjectionDrift();
    expect(after.status).toBe('pass');
    expect(after.message).toContain('matches reference');

    const finalContents = readFileSync(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(finalContents).not.toContain('.claude/guidance/shipped/moflo-core-guidance.md');
    expect(finalContents).toContain('.claude/guidance/moflo-core-guidance.md');
  });
});
