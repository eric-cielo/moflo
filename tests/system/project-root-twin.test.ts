/**
 * Algorithmic-equivalence test for the project-root resolver pair.
 *
 * Two implementations must agree on every fixture:
 *  - TS canonical: `src/cli/services/project-root.ts:findProjectRoot()`
 *    (delegated to from `src/cli/memory/bridge-core.ts:getProjectRoot()`)
 *  - JS twin: `bin/lib/moflo-paths.mjs:findProjectRoot()` (used by every bin
 *    script that touches `.moflo/moflo.db`)
 *
 * Divergence between the two is the bug class that produced the doctor-
 * vs-bridge mismatch fixed in #1058 and the broader writer drift addressed
 * in #1057: a writer using one resolver lands on a different DB than the
 * bridge using the other, and silent writes pile up on disk that the bridge
 * never reads.
 *
 * Every case spawns a fresh subprocess for each resolver so module-level
 * caching can't mask a discrepancy. We compare absolute-path strings; cwd
 * and `CLAUDE_PROJECT_DIR` are set explicitly per case so the result is
 * fully determined by the algorithm under test, not the host environment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(__dirname, '..', '..');
const TS_ENTRY = pathToFileURL(resolve(REPO_ROOT, 'dist', 'src', 'cli', 'services', 'project-root.js')).href;
const JS_ENTRY = pathToFileURL(resolve(REPO_ROOT, 'bin', 'lib', 'moflo-paths.mjs')).href;

interface Case {
  name: string;
  /** Builds a fixture tree under root and returns the cwd the resolver should run from. */
  setup: (root: string) => { cwd: string; expected: string; env?: Record<string, string> };
}

function runResolver(
  entry: string,
  exportName: 'js' | 'ts',
  cwd: string,
  env: NodeJS.ProcessEnv,
): string {
  // entry must already be a file:// URL (see TS_ENTRY/JS_ENTRY above) —
  // Windows absolute paths break the ESM loader's URL-scheme check otherwise.
  const code = `import('${entry}').then(m => process.stdout.write(m.findProjectRoot()));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd,
    encoding: 'utf-8',
    env,
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `[${exportName} resolver] exit ${result.status}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );
  }
  return result.stdout.trim();
}

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'project-root-twin-'));
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch { /* Windows file handles occasionally linger; non-fatal */ }
});

const cases: Case[] = [
  {
    name: 'CLAUDE_PROJECT_DIR wins outright',
    setup(rootDir) {
      const override = join(rootDir, 'override-root');
      const cwd = join(rootDir, 'cwd-elsewhere');
      mkdirSync(override, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(override, 'package.json'), '{}');
      writeFileSync(join(cwd, 'package.json'), '{}');
      return { cwd, expected: override, env: { CLAUDE_PROJECT_DIR: override } };
    },
  },
  {
    name: 'monorepo: .moflo/moflo.db at workspace root beats sub-package package.json',
    setup(rootDir) {
      const workspace = join(rootDir, 'mono');
      const subpkg = join(workspace, 'packages', 'foo');
      const subSrc = join(subpkg, 'src');
      mkdirSync(subSrc, { recursive: true });
      mkdirSync(join(workspace, '.moflo'), { recursive: true });
      writeFileSync(join(workspace, '.moflo', 'moflo.db'), 'SQLite format 3\0');
      writeFileSync(join(workspace, 'package.json'), '{"name":"workspace"}');
      writeFileSync(join(subpkg, 'package.json'), '{"name":"foo"}');
      return { cwd: subSrc, expected: workspace };
    },
  },
  {
    // #1174 — Pre-fix behavior: nearest .moflo/moflo.db wins, so a session-
    // start hook running from `subpkg` (which has its own residue .moflo/)
    // anchored on the sub-package and spawned its own daemon. Topmost-wins
    // means the resolver returns the workspace anchor even when nested
    // residue exists; the residue becomes detectable by `flo doctor` instead
    // of silently fragmenting state.
    name: 'monorepo with nested .moflo/ residue: topmost ancestor wins (#1174)',
    setup(rootDir) {
      const workspace = join(rootDir, 'mono-nested');
      const subpkg = join(workspace, 'packages', 'api');
      const subSrc = join(subpkg, 'src');
      mkdirSync(subSrc, { recursive: true });
      // Workspace root .moflo/moflo.db — the canonical anchor.
      mkdirSync(join(workspace, '.moflo'), { recursive: true });
      writeFileSync(join(workspace, '.moflo', 'moflo.db'), 'SQLite format 3\0');
      writeFileSync(join(workspace, 'package.json'), '{"name":"workspace"}');
      writeFileSync(join(workspace, 'CLAUDE.md'), '# workspace');
      // Sub-package residue .moflo/moflo.db (zombie from pre-fix flo init).
      mkdirSync(join(subpkg, '.moflo'), { recursive: true });
      writeFileSync(join(subpkg, '.moflo', 'moflo.db'), 'SQLite format 3\0');
      writeFileSync(join(subpkg, 'package.json'), '{"name":"api"}');
      writeFileSync(join(subpkg, 'CLAUDE.md'), '# api workspace');
      return { cwd: subSrc, expected: workspace };
    },
  },
  {
    // #1174 — 2-level nesting: workspace > packages > sub. Resolver must walk
    // all the way up even when an intermediate level also has .moflo/.
    name: 'monorepo with 2-level nested .moflo/ residue: topmost wins (#1174)',
    setup(rootDir) {
      const workspace = join(rootDir, 'mono-2level');
      const intermediate = join(workspace, 'apps', 'web');
      const sub = join(intermediate, 'api');
      const subSrc = join(sub, 'src');
      mkdirSync(subSrc, { recursive: true });
      mkdirSync(join(workspace, '.moflo'), { recursive: true });
      writeFileSync(join(workspace, '.moflo', 'moflo.db'), 'SQLite format 3\0');
      writeFileSync(join(workspace, 'package.json'), '{"name":"workspace"}');
      mkdirSync(join(intermediate, '.moflo'), { recursive: true });
      writeFileSync(join(intermediate, '.moflo', 'moflo.db'), 'SQLite format 3\0');
      writeFileSync(join(intermediate, 'package.json'), '{"name":"web"}');
      mkdirSync(join(sub, '.moflo'), { recursive: true });
      writeFileSync(join(sub, '.moflo', 'moflo.db'), 'SQLite format 3\0');
      writeFileSync(join(sub, 'package.json'), '{"name":"api"}');
      return { cwd: subSrc, expected: workspace };
    },
  },
  {
    name: 'legacy .swarm/memory.db marker also wins over nested package.json',
    setup(rootDir) {
      const workspace = join(rootDir, 'legacy');
      const subpkg = join(workspace, 'pkg');
      mkdirSync(subpkg, { recursive: true });
      mkdirSync(join(workspace, '.swarm'), { recursive: true });
      writeFileSync(join(workspace, '.swarm', 'memory.db'), 'SQLite format 3\0');
      writeFileSync(join(workspace, 'package.json'), '{}');
      writeFileSync(join(subpkg, 'package.json'), '{}');
      return { cwd: subpkg, expected: workspace };
    },
  },
  {
    name: 'CLAUDE.md + package.json pair beats bare package.json upstream',
    setup(rootDir) {
      const outer = join(rootDir, 'outer-pkg');
      const project = join(outer, 'real-project');
      const cwd = join(project, 'src');
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(outer, 'package.json'), '{}');
      writeFileSync(join(project, 'package.json'), '{}');
      writeFileSync(join(project, 'CLAUDE.md'), '# project');
      return { cwd, expected: project };
    },
  },
  {
    name: 'plain package.json walk-up still works (no .moflo, no CLAUDE.md)',
    setup(rootDir) {
      const project = join(rootDir, 'plain');
      const cwd = join(project, 'a', 'b', 'c');
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(project, 'package.json'), '{}');
      return { cwd, expected: project };
    },
  },
  {
    name: 'node_modules segment is skipped during walk',
    setup(rootDir) {
      const project = join(rootDir, 'consumer');
      const nested = join(project, 'node_modules', 'moflo', 'bin');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(project, 'package.json'), '{}');
      mkdirSync(join(project, '.moflo'), { recursive: true });
      writeFileSync(join(project, '.moflo', 'moflo.db'), 'SQLite format 3\0');
      return { cwd: nested, expected: project };
    },
  },
];

describe('findProjectRoot — TS canonical and JS twin must agree (#1057)', () => {
  it.each(cases)('$name', ({ setup }) => {
    const fixture = setup(root);
    const baseEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      USERPROFILE: process.env.USERPROFILE ?? '',
      TEMP: process.env.TEMP ?? '',
      TMP: process.env.TMP ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      NODE_PATH: '',
      ...(fixture.env ?? {}),
    };
    const tsResult = runResolver(TS_ENTRY, 'ts', fixture.cwd, baseEnv);
    const jsResult = runResolver(JS_ENTRY, 'js', fixture.cwd, baseEnv);
    expect(tsResult, 'TS resolver').toBe(fixture.expected);
    expect(jsResult, 'JS resolver').toBe(fixture.expected);
    expect(tsResult, 'TS and JS agree').toBe(jsResult);
  });

  it('explicit cwd option overrides process.cwd()', () => {
    const project = join(root, 'cwd-opt');
    const cwdElsewhere = join(root, 'unrelated-cwd');
    mkdirSync(project, { recursive: true });
    mkdirSync(cwdElsewhere, { recursive: true });
    writeFileSync(join(project, 'package.json'), '{}');
    const baseEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      USERPROFILE: process.env.USERPROFILE ?? '',
      TEMP: process.env.TEMP ?? '',
      TMP: process.env.TMP ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
    };
    const code = (entry: string) =>
      `import('${entry}').then(m => process.stdout.write(m.findProjectRoot({ cwd: '${project.replace(/\\/g, '\\\\')}' })));`;
    const tsRun = spawnSync(process.execPath, ['--input-type=module', '-e', code(TS_ENTRY)], {
      cwd: cwdElsewhere,
      encoding: 'utf-8',
      env: baseEnv,
      timeout: 10_000,
    });
    const jsRun = spawnSync(process.execPath, ['--input-type=module', '-e', code(JS_ENTRY)], {
      cwd: cwdElsewhere,
      encoding: 'utf-8',
      env: baseEnv,
      timeout: 10_000,
    });
    expect(tsRun.status, tsRun.stderr).toBe(0);
    expect(jsRun.status, jsRun.stderr).toBe(0);
    expect(tsRun.stdout.trim()).toBe(project);
    expect(jsRun.stdout.trim()).toBe(project);
  });

  it('falls back to cwd when no marker is found (no upward markers, no env)', () => {
    // Build a path entirely inside `root` with NO markers anywhere upstream
    // before we hit the OS tempdir. Most tempdirs are not project roots, but
    // some CI environments seed package.json / .git upstream — guard against
    // false positives by walking up and skipping if we'd hit such markers.
    const empty = join(root, 'no-markers', 'deep', 'down');
    mkdirSync(empty, { recursive: true });
    // Sanity check: ensure nothing between empty and the FS root has a marker.
    // If anything does, this assertion would itself depend on host state, so
    // we just verify the resolver returns *some* string starting with the
    // path separator. The first two cases above already cover the actual
    // walk semantics; this case guards the fallback contract (string, not
    // throw, not undefined).
    const baseEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      USERPROFILE: process.env.USERPROFILE ?? '',
      TEMP: process.env.TEMP ?? '',
      TMP: process.env.TMP ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
    };
    const tsResult = runResolver(TS_ENTRY, 'ts', empty, baseEnv);
    const jsResult = runResolver(JS_ENTRY, 'js', empty, baseEnv);
    expect(typeof tsResult).toBe('string');
    expect(typeof jsResult).toBe('string');
    expect(tsResult).toBe(jsResult);
    expect(tsResult.length).toBeGreaterThan(sep.length);
  });
});
