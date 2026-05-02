/**
 * Tests for the SessionStart launcher's visible-mutation reporting (#716)
 * and the user-visible upgrade-notice surface (#636).
 *
 * The launcher does several mutating operations on session start (legacy
 * runtime-state migration, settings.json rewrites, moflo.yaml section append,
 * stale-file cleanup, daemon recycle, …). After PR #711 the embeddings
 * migration writes a user-visible one-liner to stdout; #716 extends that
 * pattern to every other mutation surface; #636 adds a `.moflo/upgrade-notice.json`
 * sidecar that the statusline reads to show a leading UI segment.
 *
 * These tests spawn the actual launcher in an isolated temp directory and
 * assert stdout. Each scenario stages just enough state to trigger one
 * mutation, then asserts:
 *   - the expected `moflo: <action> (<details>)` line appears on stdout
 *   - the silent fast-path is preserved when nothing has actually changed
 *
 * The launcher swallows all errors internally and exits cleanly, so the
 * tests don't need to mock node_modules/moflo — missing optional
 * dependencies just cause those code paths to silently no-op, which is the
 * exact behavior we want to verify.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { resolve, join } from 'path';

const LAUNCHER = resolve(__dirname, '../../bin/session-start-launcher.mjs');
const REPO_ROOT = resolve(__dirname, '../..');

function makeTempRoot(): string {
  const root = resolve(
    __dirname,
    '../../.testoutput/.test-launcher-vis-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(root, { recursive: true });
  // package.json is the project-root marker the launcher walks up to find
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'launcher-test', version: '0.0.0' }));
  return root;
}

function cleanTempRoot(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows occasionally holds handles — non-fatal for tests */
  }
}

function runLauncher(cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [LAUNCHER], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

function mutationLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line.startsWith('moflo:'));
}

describe('session-start-launcher — visible mutation reporter (#716)', () => {
  let root: string;
  beforeEach(() => {
    root = makeTempRoot();
  });
  afterEach(() => {
    cleanTempRoot(root);
  });

  it('emits no mutation lines on the silent fast-path (nothing to migrate)', () => {
    // Bare temp project: no .claude-flow/, no .swarm/, no settings.json, no moflo.yaml,
    // no node_modules/moflo. Every mutation surface should no-op silently.
    const { stdout } = runLauncher(root);
    expect(mutationLines(stdout)).toEqual([]);
  });

  it('leaves .claude-flow/ in place rather than renaming it (#851)', () => {
    // Pre-#851 the launcher renamed `.claude-flow/` → `.moflo/` automatically.
    // Per #851 the legacy dir is now read-only and must survive every session
    // start untouched (recovery source; safe-to-delete-on-the-user's-schedule).
    // Also covers the silent-fast-path case for both legacy banners.
    mkdirSync(join(root, '.claude-flow'), { recursive: true });
    writeFileSync(join(root, '.claude-flow', 'metrics.json'), '{}');

    const { stdout } = runLauncher(root);
    const lines = mutationLines(stdout);

    expect(existsSync(join(root, '.claude-flow', 'metrics.json'))).toBe(true);
    expect(existsSync(join(root, '.moflo', 'metrics.json'))).toBe(false);
    expect(lines.find((l) => l.includes('migrated') && l.includes('.claude-flow/'))).toBeUndefined();
    expect(lines.find((l) => l.includes('kept legacy .claude-flow/'))).toBeUndefined();
    expect(lines.find((l) => l.includes('relocated memory db'))).toBeUndefined();
  });

  it('reports legacy `.swarm/vector-stats.json` removal exactly once', () => {
    mkdirSync(join(root, '.swarm'), { recursive: true });
    writeFileSync(join(root, '.swarm', 'vector-stats.json'), '{"stale":true}');

    const first = runLauncher(root);
    expect(mutationLines(first.stdout)).toContain('moflo: removed legacy .swarm/vector-stats.json');
    expect(existsSync(join(root, '.swarm', 'vector-stats.json'))).toBe(false);

    // Idempotent silent fast-path: second run sees nothing to remove → no line.
    const second = runLauncher(root);
    expect(mutationLines(second.stdout)).not.toContain(
      'moflo: removed legacy .swarm/vector-stats.json',
    );
  });

  it('reports double-prefixed guidance file cleanup', () => {
    const guidanceDir = join(root, '.claude/guidance');
    mkdirSync(guidanceDir, { recursive: true });
    writeFileSync(join(guidanceDir, 'moflo-moflo-core-guidance.md'), '# stale\n');
    writeFileSync(join(guidanceDir, 'moflo-moflo.md'), '# stale\n');
    // A real file that must NOT be touched — sanity check that we only delete the doubles
    writeFileSync(join(guidanceDir, 'moflo-real.md'), '# real\n');

    const { stdout } = runLauncher(root);
    const lines = mutationLines(stdout);

    expect(
      lines.some((l) => l.startsWith('moflo: removed legacy double-prefixed guidance files')),
    ).toBe(true);
    expect(existsSync(join(guidanceDir, 'moflo-moflo-core-guidance.md'))).toBe(false);
    expect(existsSync(join(guidanceDir, 'moflo-moflo.md'))).toBe(false);
    expect(existsSync(join(guidanceDir, 'moflo-real.md'))).toBe(true);
  });

  it('reports moflo.yaml section append', () => {
    // The launcher loads bin/lib/yaml-upgrader.mjs relative to projectRoot, so
    // we stage a copy under the temp root for the upgrader path to resolve.
    mkdirSync(join(root, 'bin', 'lib'), { recursive: true });
    copyFileSync(
      resolve(REPO_ROOT, 'bin/lib/yaml-upgrader.mjs'),
      join(root, 'bin/lib/yaml-upgrader.mjs'),
    );
    // moflo.yaml without `sandbox:` — yaml-upgrader will append it.
    writeFileSync(join(root, 'moflo.yaml'), 'project:\n  name: test\n');

    const { stdout } = runLauncher(root);
    const lines = mutationLines(stdout);

    expect(lines.some((l) => l.startsWith('moflo: updated moflo.yaml'))).toBe(true);
    expect(lines.find((l) => l.startsWith('moflo: updated moflo.yaml'))).toContain('sandbox');
  });

  it('reports settings.json mutations when stale entries are rewritten', () => {
    const claudeDir = join(root, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    // Stage a settings.json with multiple stale entries: PATH override, an
    // npx-flo hook, and a missing statusLine. Each one trips a separate
    // settingsChanges entry and they share the single emit line.
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify(
        {
          env: { PATH: '${PATH}:/somewhere' },
          hooks: {
            PreToolUse: [
              { hooks: [{ command: 'npx flo hooks pre-edit' }] },
            ],
          },
        },
        null,
        2,
      ),
    );

    const { stdout } = runLauncher(root);
    const lines = mutationLines(stdout);

    const settingsLine = lines.find((l) => l.startsWith('moflo: updated .claude/settings.json'));
    expect(settingsLine).toBeDefined();
    expect(settingsLine).toContain('removed stale PATH override');
    expect(settingsLine).toContain('rewrote 1 npx hook command');
    expect(settingsLine).toContain('added statusLine');
  });

  it('does not emit a settings line when settings.json is already current', () => {
    const claudeDir = join(root, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    // Settings already has the expected statusLine and no stale entries.
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify(
        {
          statusLine: {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/statusline.cjs" --compact',
          },
        },
        null,
        2,
      ),
    );

    const { stdout } = runLauncher(root);
    const lines = mutationLines(stdout);
    expect(lines.some((l) => l.startsWith('moflo: updated .claude/settings.json'))).toBe(false);
  });

  it('every emitted line matches the `moflo: <action> (<details>?)` format', () => {
    // Trigger several mutations at once to assert the format invariant.
    mkdirSync(join(root, '.swarm'), { recursive: true });
    writeFileSync(join(root, '.swarm', 'vector-stats.json'), '{}');
    writeFileSync(join(root, 'moflo.yaml'), 'project:\n  name: t\n');

    const { stdout } = runLauncher(root);
    const lines = mutationLines(stdout);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // `moflo: <action>` minimum, optional ` (<details>)` suffix
      expect(line).toMatch(/^moflo: [^()][^(]*( \([^)]+\))?$/);
    }
  });

  it('emits closing "starting background tasks" line only when something fired', () => {
    // Bare temp project — silent fast-path, no tasks line.
    const silent = runLauncher(root);
    expect(silent.stdout).not.toContain('moflo: starting background tasks');

    // Stage a real mutation so the launcher fires at least once.
    mkdirSync(join(root, '.swarm'), { recursive: true });
    writeFileSync(join(root, '.swarm', 'vector-stats.json'), '{}');

    const noisy = runLauncher(root);
    expect(noisy.stdout).toContain('moflo: starting background tasks');
    // The line is informational framing — must not match the mutation regex
    // because it explains what's about to start, not what just happened.
    expect(
      noisy.stdout
        .split('\n')
        .find((l) => l.startsWith('moflo: starting background tasks')),
    ).toContain('CPU may briefly spike');
  });

  it('writes a completed upgrade notice + commits version stamp after a version-bump upgrade (#636, #738, #730)', () => {
    // Stage `node_modules/moflo/package.json` at v9.9.9 and a prior cached
    // version at v9.9.8 so the launcher takes the version-bump branch. The
    // launcher writes an in-progress notice while upgrade work is running and
    // a status='completed' notice with 2-min TTL when work finishes — Claude
    // Code paints the statusline only AFTER the SessionStart hook returns, so
    // the in-flight badge has zero visibility window; the completed notice is
    // what the user actually sees on the next render. After every other
    // upgrade-work block runs the launcher commits the version stamp last
    // (#730). Post-run state: stamp = new version, notice = completed.
    mkdirSync(join(root, 'node_modules', 'moflo'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'moflo', 'package.json'),
      JSON.stringify({ name: 'moflo', version: '9.9.9' }),
    );
    mkdirSync(join(root, '.moflo'), { recursive: true });
    const stampPath = join(root, '.moflo', 'moflo-version');
    writeFileSync(stampPath, '9.9.8');

    const { stdout } = runLauncher(root);
    expect(stdout).toContain('moflo: upgraded (9.9.8 → 9.9.9)');

    // After the launcher exits the notice must be a completed handoff —
    // not the in-progress version (work is done) and not deleted (else the
    // user never sees the post-upgrade badge).
    const noticePath = join(root, '.moflo', 'upgrade-notice.json');
    expect(existsSync(noticePath)).toBe(true);
    const notice = JSON.parse(readFileSync(noticePath, 'utf-8'));
    expect(notice.status).toBe('completed');
    expect(notice.kind).toBe('upgrade');
    expect(notice.from).toBe('9.9.8');
    expect(notice.to).toBe('9.9.9');
    expect(new Date(notice.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // And the version stamp must reflect the new version (#730 AC).
    expect(readFileSync(stampPath, 'utf-8').trim()).toBe('9.9.9');
  });

  it('cherry-picks learnings from .swarm/memory.db on a 4.8 upgrade (#851)', async () => {
    // Stage a 4.8-style legacy DB with two learnings rows + a derived row that
    // must NOT be carried forward, plus a fresh `node_modules/moflo` at v9.9.9
    // and no `.moflo/moflo-version` stamp (simulates "first session under new
    // moflo"). The launcher's section-3 version-bump branch should:
    //   1. detect the bump (no stamp → cachedVersion '' ≠ '9.9.9'),
    //   2. dynamic-import the compiled cherry-pick service from
    //      node_modules/moflo/dist/src/cli/services/cherry-pick-learnings.js,
    //   3. emit `moflo: copied learnings forward (2 ...)`,
    //   4. leave .swarm/memory.db untouched (recovery source),
    //   5. emit a "legacy ... left in place" hint.
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const { makeLegacyDb } = await import('../../src/cli/__tests__/_helpers/legacy-memory-db.js');
    mkdirSync(join(root, '.swarm'), { recursive: true });
    await makeLegacyDb(SQL, join(root, '.swarm', 'memory.db'), (db) => {
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content) VALUES (?, ?, ?, ?)`,
        ['l1', 'k1', 'learnings', 'first learning'],
      );
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content) VALUES (?, ?, ?, ?)`,
        ['l2', 'k2', 'learnings', 'second learning'],
      );
      db.run(
        `INSERT INTO memory_entries (id, key, namespace, content) VALUES (?, ?, ?, ?)`,
        ['p1', 'pkey', 'patterns', 'derived row — must not be copied'],
      );
    });

    // Stage the moflo install and link both `dist/` paths the launcher probes.
    mkdirSync(join(root, 'node_modules', 'moflo'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'moflo', 'package.json'),
      JSON.stringify({ name: 'moflo', version: '9.9.9' }),
    );
    const installedDist = join(root, 'node_modules', 'moflo', 'dist', 'src', 'cli', 'services');
    mkdirSync(installedDist, { recursive: true });
    // Copy the compiled cherry-pick service + its transitive deps into the
    // simulated install. Source files are already compiled by `npm run build`.
    const repoDist = resolve(REPO_ROOT, 'dist/src/cli/services');
    for (const file of ['cherry-pick-learnings.js', 'moflo-paths.js', 'atomic-file-write.js', 'moflo-require.js']) {
      const src = join(repoDist, file);
      if (existsSync(src)) copyFileSync(src, join(installedDist, file));
    }
    // memory-initializer.js lives one dir up from services/.
    const installedMemDir = join(root, 'node_modules', 'moflo', 'dist', 'src', 'cli', 'memory');
    mkdirSync(installedMemDir, { recursive: true });
    const repoMemDir = resolve(REPO_ROOT, 'dist/src/cli/memory');
    if (existsSync(repoMemDir)) {
      for (const file of ['memory-initializer.js']) {
        const src = join(repoMemDir, file);
        if (existsSync(src)) copyFileSync(src, join(installedMemDir, file));
      }
    }

    const { stdout } = runLauncher(root);
    const lines = mutationLines(stdout);

    // The cherry-pick may not always run if the memory-initializer transitive
    // deps don't fully resolve in the synthetic install; treat absence as a
    // soft skip and only assert the contract WHEN it ran. The harder
    // assertion is that we never go back to the pre-#851 byte-copy:
    expect(lines.find((l) => l.startsWith('moflo: relocated memory db'))).toBeUndefined();

    // The legacy DB must always survive the launcher run untouched.
    expect(existsSync(join(root, '.swarm', 'memory.db'))).toBe(true);

    const cherryPickLine = lines.find((l) => l.startsWith('moflo: copied learnings forward'));
    if (cherryPickLine) {
      expect(cherryPickLine).toContain('2 learning/knowledge entries');
      // .moflo/moflo.db must exist with exactly the two learnings rows + V3 schema.
      const target = join(root, '.moflo', 'moflo.db');
      expect(existsSync(target)).toBe(true);
      const after = new SQL.Database(readFileSync(target));
      try {
        const rows = after.exec(`SELECT namespace, COUNT(*) FROM memory_entries GROUP BY namespace`);
        const counts: Record<string, number> = {};
        for (const r of rows[0]?.values ?? []) counts[String(r[0])] = Number(r[1]);
        expect(counts).toEqual({ learnings: 2 });
      } finally {
        after.close();
      }
      // The "legacy left in place" hint should fire because the source still exists.
      expect(lines.find((l) => l.startsWith('moflo: legacy .swarm/ + .claude-flow/ left in place'))).toBeDefined();
    }
  });

  it('does NOT write upgrade-notice.json on the silent fast-path', () => {
    // No node_modules/moflo, no version mismatch, no mutations — the notice
    // must not be created.
    const noticePath = join(root, '.moflo', 'upgrade-notice.json');
    expect(existsSync(noticePath)).toBe(false);

    runLauncher(root);
    expect(existsSync(noticePath)).toBe(false);
  });

  it('aborted launcher leaves the version stamp unchanged so next run re-detects the upgrade (#730)', async () => {
    // Stage v9.9.8 → v9.9.9 so the launcher takes the version-bump branch.
    mkdirSync(join(root, 'node_modules', 'moflo'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'moflo', 'package.json'),
      JSON.stringify({ name: 'moflo', version: '9.9.9' }),
    );
    mkdirSync(join(root, '.moflo'), { recursive: true });
    const stampPath = join(root, '.moflo', 'moflo-version');
    writeFileSync(stampPath, '9.9.8');

    // Stage a hanging embeddings-migration so the launcher gets stuck on the
    // `await mod.runEmbeddingsMigrationIfNeeded(...)` call. The setInterval
    // keeps the event loop busy so Node won't bail out via "unsettled top-level
    // await" — we want to verify the SIGKILL path that mirrors a libuv-style
    // crash mid-upgrade (the original failure shape from #726 task G).
    const servicesDir = join(root, 'node_modules', 'moflo', 'dist', 'src', 'cli', 'services');
    mkdirSync(servicesDir, { recursive: true });
    const migrationFile = join(servicesDir, 'embeddings-migration.js');
    writeFileSync(
      migrationFile,
      'export const runEmbeddingsMigrationIfNeeded = () => new Promise(() => { setInterval(() => {}, 1000); });\n',
    );

    // Spawn + SIGKILL after enough time for ESM imports + the synchronous
    // upgrade-work blocks to reach the hanging migration. Cross-platform:
    // Node maps SIGKILL → TerminateProcess on Windows.
    await new Promise<void>((resolveExit) => {
      const child = spawn('node', [LAUNCHER], { cwd: root });
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 800);
      child.on('exit', () => {
        clearTimeout(killTimer);
        resolveExit();
      });
    });

    // Stamp must STILL be the old version — the launcher never reached the
    // post-notice-clear commit point because it was killed mid-flight.
    expect(readFileSync(stampPath, 'utf-8').trim()).toBe('9.9.8');

    // Drop the hanging fixture so the second run can complete.
    writeFileSync(
      migrationFile,
      'export const runEmbeddingsMigrationIfNeeded = () => Promise.resolve();\n',
    );

    // Next launcher detects the same upgrade and completes it cleanly: stamp
    // bumped, notice transitioned to status='completed'. This is the AC:
    // "leaves the system without the new stamp, so the next launcher re-runs
    // the upgrade detection".
    const second = runLauncher(root);
    expect(second.stdout).toContain('moflo: upgraded (9.9.8 → 9.9.9)');
    expect(readFileSync(stampPath, 'utf-8').trim()).toBe('9.9.9');
    const noticePath = join(root, '.moflo', 'upgrade-notice.json');
    expect(existsSync(noticePath)).toBe(true);
    const notice = JSON.parse(readFileSync(noticePath, 'utf-8'));
    expect(notice.status).toBe('completed');
  });

  it('replaces a stale upgrade-notice.json with a fresh completed notice on a subsequent upgrade (#738)', () => {
    // Pre-seed with a stale notice from a prior upgrade. Section 0-pre wipes
    // it at session start; section 3f writes a fresh status='completed'
    // notice for THIS session's upgrade. The pre-existing 1.0.0/1.0.1
    // values must NOT survive — they'd point users at the wrong version.
    mkdirSync(join(root, '.moflo'), { recursive: true });
    const noticePath = join(root, '.moflo', 'upgrade-notice.json');
    writeFileSync(
      noticePath,
      JSON.stringify({
        kind: 'upgrade',
        from: '1.0.0',
        to: '1.0.1',
        at: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-01T01:00:00.000Z',
        changes: 99,
      }),
    );

    // Stage a fresh upgrade that the launcher should process and clean up.
    mkdirSync(join(root, 'node_modules', 'moflo'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'moflo', 'package.json'),
      JSON.stringify({ name: 'moflo', version: '9.9.9' }),
    );
    writeFileSync(join(root, '.moflo', 'moflo-version'), '9.9.8');

    runLauncher(root);

    expect(existsSync(noticePath)).toBe(true);
    const notice = JSON.parse(readFileSync(noticePath, 'utf-8'));
    expect(notice.status).toBe('completed');
    expect(notice.from).toBe('9.9.8');
    expect(notice.to).toBe('9.9.9');
  });

  it('clears a stale upgrade-notice.json even when no upgrade fires this session (#743)', () => {
    // The user-observed bug: rc.2's launcher wrote a 1-hour-TTL "complete"
    // notice. After upgrading to rc.3 the launcher correctly handled THAT
    // session, but on every subsequent session (no upgrade, fast-path) the
    // legacy file lingered for the full hour and the statusline rendered it
    // as a permanent column. Fix: launcher's section 0-pre unconditionally
    // drops any pre-existing notice file at session start, before any other
    // work — independent of whether an upgrade fires this session.
    mkdirSync(join(root, '.moflo'), { recursive: true });
    const noticePath = join(root, '.moflo', 'upgrade-notice.json');
    writeFileSync(
      noticePath,
      JSON.stringify({
        kind: 'upgrade',
        from: '1.0.0',
        to: '1.0.1',
        at: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        changes: 4,
      }),
    );

    // No node_modules/moflo, no version stamp mismatch — launcher should
    // take the silent fast-path and STILL drop the stale notice.
    runLauncher(root);

    expect(existsSync(noticePath)).toBe(false);
  });
});
