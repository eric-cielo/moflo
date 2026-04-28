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
import { spawnSync } from 'child_process';
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

  it('reports `.claude-flow/` → `.moflo/` runtime-state migration', () => {
    // Stage a legacy runtime-state directory with a single file. The launcher's
    // step 0 calls migrateClaudeFlowToMoflo() which renames to .moflo/.
    mkdirSync(join(root, '.claude-flow'), { recursive: true });
    writeFileSync(join(root, '.claude-flow', 'metrics.json'), '{}');

    const { stdout } = runLauncher(root);
    const lines = mutationLines(stdout);

    expect(lines).toContain('moflo: migrated runtime state to .moflo/ (from legacy .claude-flow/)');
    // The migration actually moved the file
    expect(existsSync(join(root, '.moflo', 'metrics.json'))).toBe(true);
    expect(existsSync(join(root, '.claude-flow', 'metrics.json'))).toBe(false);
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
    mkdirSync(join(root, '.claude-flow'), { recursive: true });
    writeFileSync(join(root, '.claude-flow', 'x.json'), '{}');
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

  it('clears upgrade-notice.json after completing a version-bump upgrade (#636, #738)', () => {
    // Stage `node_modules/moflo/package.json` at v9.9.9 and a prior cached
    // version at v9.9.8 so the launcher takes the version-bump branch.
    // The launcher writes an in-progress notice while upgrade work is running
    // and DELETES the file when work completes — so the badge disappears once
    // the user is unblocked instead of lingering for an hour (#738).
    mkdirSync(join(root, 'node_modules', 'moflo'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'moflo', 'package.json'),
      JSON.stringify({ name: 'moflo', version: '9.9.9' }),
    );
    mkdirSync(join(root, '.moflo'), { recursive: true });
    writeFileSync(join(root, '.moflo', 'moflo-version'), '9.9.8');

    const { stdout } = runLauncher(root);
    expect(stdout).toContain('moflo: upgraded (9.9.8 → 9.9.9)');

    // After the launcher exits, the notice file must be GONE (#738 AC).
    const noticePath = join(root, '.moflo', 'upgrade-notice.json');
    expect(existsSync(noticePath)).toBe(false);
  });

  it('does NOT write upgrade-notice.json on the silent fast-path', () => {
    // No node_modules/moflo, no version mismatch, no mutations — the notice
    // must not be created.
    const noticePath = join(root, '.moflo', 'upgrade-notice.json');
    expect(existsSync(noticePath)).toBe(false);

    runLauncher(root);
    expect(existsSync(noticePath)).toBe(false);
  });

  it('clears a stale upgrade-notice.json on a subsequent upgrade (#738)', () => {
    // Pre-seed with a stale notice from a prior upgrade. After this session's
    // upgrade work completes the launcher must delete it — no lingering badge.
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

    expect(existsSync(noticePath)).toBe(false);
  });
});
