/**
 * Issue #1152 — `intelligence.ts` neural pattern storage must anchor on
 * `findProjectRoot()`, never `process.cwd()` or `homedir()`.
 *
 * Pre-fix: when cwd lacked a `.moflo` directory, `getDataDir()` fell back to
 * `~/.moflo/neural/` — a global path shared by every moflo-using project on
 * the machine. Cross-project ReasoningBank bleed surfaced as `findSimilar`
 * hits from foreign-repo patterns.
 *
 * The fix routes through `findProjectRoot()` (matching `neural-tools.ts` and
 * the #829 store-path precedent) and copies legacy `~/.moflo/neural/{patterns,
 * stats}.json` once into the active project on first load so users do not
 * lose history.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const realHome = homedir();
const realHomeNeural = join(realHome, '.moflo', 'neural');
const homePatternsPath = join(realHomeNeural, 'patterns.json');
const homeStatsPath = join(realHomeNeural, 'stats.json');
let backupSuffix: string | null = null;

function stashHomeNeural(): void {
  if (existsSync(realHomeNeural)) {
    backupSuffix = `.bak-1152-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stash = `${realHomeNeural}${backupSuffix}`;
    rmSync(stash, { recursive: true, force: true });
    renameSync(realHomeNeural, stash);
  }
}

function restoreHomeNeural(): void {
  if (backupSuffix) {
    const stash = `${realHomeNeural}${backupSuffix}`;
    rmSync(realHomeNeural, { recursive: true, force: true });
    if (existsSync(stash)) {
      renameSync(stash, realHomeNeural);
    }
    backupSuffix = null;
  } else {
    rmSync(realHomeNeural, { recursive: true, force: true });
  }
}

describe('intelligence.ts neural storage anchors on findProjectRoot (#1152)', () => {
  let projectRoot: string;
  let foreignCwd: string;
  let prevCwd: string;
  let prevClaudeProjectDir: string | undefined;

  beforeEach(async () => {
    stashHomeNeural();
    projectRoot = mkdtempSync(join(tmpdir(), 'moflo-1152-root-'));
    foreignCwd = mkdtempSync(join(tmpdir(), 'moflo-1152-cwd-'));
    // Use the CLAUDE.md + package.json marker pair (not moflo.db) — having
    // a moflo.db at projectRoot makes memory-bridge open it as a real DB,
    // which on Windows holds a file handle that EPERMs the temp-dir cleanup.
    writeFileSync(join(projectRoot, 'CLAUDE.md'), '# fake');
    writeFileSync(join(projectRoot, 'package.json'), '{"name":"fake-1152"}');
    prevCwd = process.cwd();
    prevClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = projectRoot;
    process.chdir(foreignCwd);

    // Reset module-level migration latch so each test exercises the copy path.
    const intel = await import('../../memory/intelligence.js');
    intel.clearIntelligence();
  });

  afterEach(async () => {
    // Tear module state down so the debounced ReasoningBank flush cannot
    // fire after the temp dirs are removed.
    const intel = await import('../../memory/intelligence.js');
    intel.flushPatterns();
    intel.clearIntelligence();

    process.chdir(prevCwd);
    if (prevClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevClaudeProjectDir;
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(foreignCwd, { recursive: true, force: true });
    restoreHomeNeural();
  });

  it('getNeuralDataDir() returns <projectRoot>/.moflo/neural, not cwd or homedir', async () => {
    const { getNeuralDataDir } = await import('../../memory/intelligence.js');
    const dir = getNeuralDataDir();
    expect(dir).toBe(join(projectRoot, '.moflo', 'neural'));
    expect(dir).not.toBe(join(foreignCwd, '.moflo', 'neural'));
    expect(dir).not.toBe(realHomeNeural);
  });

  it('persists patterns under projectRoot, never under homedir', async () => {
    const intel = await import('../../memory/intelligence.js');
    await intel.initializeIntelligence();
    // Provide a pre-computed embedding so the bridge/fastembed loader is not
    // touched (avoids holding a moflo.db handle that EPERMs Windows cleanup).
    await intel.recordStep({
      type: 'thought',
      content: 'project-A-pattern',
      embedding: [0.1, 0.2, 0.3],
    });
    intel.flushPatterns();

    expect(existsSync(join(projectRoot, '.moflo', 'neural', 'patterns.json'))).toBe(true);
    expect(existsSync(homePatternsPath)).toBe(false);
    expect(existsSync(join(foreignCwd, '.moflo', 'neural', 'patterns.json'))).toBe(false);
  });

  it('copies legacy ~/.moflo/neural/patterns.json into projectRoot on first load (migration)', async () => {
    // Seed the legacy global location as if an older moflo build wrote there.
    mkdirSync(realHomeNeural, { recursive: true });
    const seeded = [{
      id: 'legacy-1',
      type: 'observation',
      embedding: [0.1, 0.2, 0.3],
      content: 'legacy pattern from pre-1152 build',
      confidence: 1.0,
      usageCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    }];
    writeFileSync(homePatternsPath, JSON.stringify(seeded));
    writeFileSync(homeStatsPath, JSON.stringify({ trajectoriesRecorded: 7, lastAdaptation: 12345 }));

    const intel = await import('../../memory/intelligence.js');
    await intel.initializeIntelligence();

    // Migration is triggered on load; the file should now exist locally.
    const localPatterns = join(projectRoot, '.moflo', 'neural', 'patterns.json');
    expect(existsSync(localPatterns)).toBe(true);
    expect(existsSync(join(projectRoot, '.moflo', 'neural', 'stats.json'))).toBe(true);

    const copied = JSON.parse(readFileSync(localPatterns, 'utf-8'));
    expect(Array.isArray(copied)).toBe(true);
    expect(copied[0].id).toBe('legacy-1');

    // Legacy file must still exist — copy, not move (other projects on older
    // moflo versions may still read from it).
    expect(existsSync(homePatternsPath)).toBe(true);
    expect(existsSync(homeStatsPath)).toBe(true);

    const stats = intel.getIntelligenceStats();
    expect(stats.trajectoriesRecorded).toBe(7);
  });

  it('does NOT clobber an existing local patterns.json with the legacy copy', async () => {
    const localNeural = join(projectRoot, '.moflo', 'neural');
    mkdirSync(localNeural, { recursive: true });
    const existingLocal = [{
      id: 'local-1',
      type: 'thought',
      embedding: [0.9, 0.8, 0.7],
      content: 'local pattern already present',
      confidence: 1.0,
      usageCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    }];
    writeFileSync(join(localNeural, 'patterns.json'), JSON.stringify(existingLocal));

    mkdirSync(realHomeNeural, { recursive: true });
    writeFileSync(homePatternsPath, JSON.stringify([{
      id: 'legacy-should-not-overwrite',
      type: 'observation',
      embedding: [0.1, 0.1, 0.1],
      content: 'must NOT clobber',
      confidence: 1.0,
      usageCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    }]));

    const intel = await import('../../memory/intelligence.js');
    await intel.initializeIntelligence();
    const all = await intel.getAllPatterns();
    expect(all.map(p => p.id)).toContain('local-1');
    expect(all.map(p => p.id)).not.toContain('legacy-should-not-overwrite');
  });

  it('two projects with the same cwd-divergence write to separate neural dirs (cross-project isolation)', async () => {
    // Project A
    const intelA = await import('../../memory/intelligence.js');
    await intelA.initializeIntelligence();
    await intelA.recordStep({
      type: 'thought',
      content: 'A-pattern',
      embedding: [0.1, 0.2, 0.3],
    });
    intelA.flushPatterns();
    intelA.clearIntelligence();

    // Switch to Project B
    const projectRootB = mkdtempSync(join(tmpdir(), 'moflo-1152-root-B-'));
    writeFileSync(join(projectRootB, 'CLAUDE.md'), '# fake');
    writeFileSync(join(projectRootB, 'package.json'), '{"name":"fake-1152-B"}');
    process.env.CLAUDE_PROJECT_DIR = projectRootB;

    try {
      const intelB = await import('../../memory/intelligence.js');
      await intelB.initializeIntelligence();
      const bPatterns = await intelB.getAllPatterns();
      // B must not see A's pattern through any shared global path.
      expect(bPatterns.find(p => p.content === 'A-pattern')).toBeUndefined();

      // And A's patterns.json lives under A's root, not under B's.
      expect(existsSync(join(projectRoot, '.moflo', 'neural', 'patterns.json'))).toBe(true);
      expect(existsSync(join(projectRootB, '.moflo', 'neural', 'patterns.json'))).toBe(false);
    } finally {
      rmSync(projectRootB, { recursive: true, force: true });
    }
  });
});
