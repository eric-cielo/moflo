/**
 * #1497 — code-map and patterns must index only in-scope source files.
 *
 * Before the fix, code-map ran `git ls-files` over the whole repo and applied
 * `code_map.directories` / `code_map.exclude` only in its filesystem fallback,
 * and patterns walked the raw filesystem with no `.gitignore` handling — so
 * gitignored build output and every test file landed in semantic search.
 *
 * Fixtures are real git repos under os.tmpdir(); the indexers are driven as
 * subprocesses from the source tree, the same way the session-start chain runs
 * them. Paths are built with path.join throughout (Rule #1).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(__dirname, '../..');
const SCOPE_LIB = pathToFileURL(join(REPO_ROOT, 'bin', 'lib', 'source-scope.mjs')).href;

type ScopeLib = {
  listScopedSourceFiles: (root: string, opts?: Record<string, unknown>) => string[];
  readCodeMapConfig: (root: string) => { directories: string[]; exclude: string[]; extensions: string[] };
  createScopeFilter: (config: Record<string, unknown>) => (rel: string) => boolean;
};
const loadScope = () => import(/* @vite-ignore */ SCOPE_LIB) as Promise<ScopeLib>;

function write(root: string, rel: string, body = 'export class Fixture {}\n') {
  const full = join(root, ...rel.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function git(root: string, args: string[]) {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd: root, stdio: 'ignore', windowsHide: true,
  });
}

/** A monorepo-shaped fixture exercising every leak class from the issue. */
function makeFixture(yaml: string): string {
  // realpath: macOS tmpdir is a symlink (/var → /private/var).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moflo-1497-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'scope-fixture', version: '0.0.0' }));
  writeFileSync(join(root, 'moflo.yaml'), yaml);
  write(root, 'packages/core/src/service.ts', 'export class CoreService {}\n');
  write(root, 'packages/core/src/service.test.ts', 'export class XTest {}\n');
  write(root, 'packages/core/src/generated/schema.ts', 'export class Schema {}\n');
  write(root, 'packages/core/tests/helper.spec.ts', 'export class YSpec {}\n');
  write(root, 'infra/cdk/lib/stack.ts', 'export class Stack {}\n');
  write(root, 'infra/cdk/cdk.out/asset.abc123/index.mjs', 'export class Bundled {}\n');
  write(root, 'infra/cdk/.gitignore', 'cdk.out/\n');
  write(root, 'scripts/tool.mjs', 'export class Tool {}\n');
  git(root, ['init', '-q', '.']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fixture']);
  // Untracked but not ignored — a brand-new file must still be indexed.
  write(root, 'packages/core/src/new-file.ts', 'export class BrandNew {}\n');
  return root;
}

const SCOPED_YAML = [
  'code_map:',
  '  directories:',
  '    - packages',
  '    - infra/cdk',
  '  extensions: [".ts", ".mjs"]',
  '  exclude: [node_modules, dist, packages/core/src/generated]',
  '',
].join('\n');

function runIndexer(script: string, root: string, extra: string[] = []) {
  const result = spawnSync('node', [join(REPO_ROOT, 'bin', script), ...extra], {
    cwd: root,
    encoding: 'utf-8',
    timeout: 50_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, CI: '1', GIT_CEILING_DIRECTORIES: dirname(root) },
    input: '',
  });
  expect(result.status, `${script} failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
}

async function keysIn(root: string, namespace: string): Promise<string[]> {
  const { openBackend } = await import('../../bin/lib/get-backend.mjs');
  const db = await openBackend(root, { dbPath: join(root, '.moflo', 'moflo.db') });
  try {
    const stmt = db.prepare('SELECT key FROM memory_entries WHERE namespace = ? ORDER BY key');
    stmt.bind([namespace]);
    const keys: string[] = [];
    while (stmt.step()) keys.push(String(stmt.getAsObject().key));
    stmt.free();
    return keys;
  } finally {
    db.close();
  }
}

describe('#1497 source scope (bin/lib/source-scope.mjs)', () => {
  let root: string;
  beforeEach(() => { root = makeFixture(SCOPED_YAML); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('lists only configured, non-ignored, non-excluded, non-test files', async () => {
    const { listScopedSourceFiles } = await loadScope();
    expect(listScopedSourceFiles(root)).toEqual([
      'infra/cdk/lib/stack.ts',
      'packages/core/src/new-file.ts',
      'packages/core/src/service.ts',
    ]);
  });

  it('the filesystem fallback applies the same scope, minus .gitignore', async () => {
    const { listScopedSourceFiles } = await loadScope();
    rmSync(join(root, '.git'), { recursive: true, force: true });
    const files = listScopedSourceFiles(root);
    // Without git there is no .gitignore to consult; everything else holds.
    expect(files).not.toContain('scripts/tool.mjs');
    expect(files).not.toContain('packages/core/src/service.test.ts');
    expect(files).not.toContain('packages/core/tests/helper.spec.ts');
    expect(files).not.toContain('packages/core/src/generated/schema.ts');
    expect(files).toContain('packages/core/src/service.ts');
  });

  it('a block-list `directories:` replaces the default rather than appending to it', async () => {
    const { readCodeMapConfig } = await loadScope();
    // The pre-#1497 parser pushed onto the shared defaults, so a configured
    // list always silently included `src` as well.
    expect(readCodeMapConfig(root).directories).toEqual(['packages', 'infra/cdk']);
  });

  it('an unconfigured code_map scopes to the whole repo, as before #1497', async () => {
    const { readCodeMapConfig, listScopedSourceFiles } = await loadScope();
    writeFileSync(join(root, 'moflo.yaml'), 'project:\n  name: x\n');
    expect(readCodeMapConfig(root).directories).toEqual(['.']);
    // Still no gitignored or test files — only the directory scope widens.
    expect(listScopedSourceFiles(root)).toEqual([
      'infra/cdk/lib/stack.ts',
      'packages/core/src/generated/schema.ts',
      'packages/core/src/new-file.ts',
      'packages/core/src/service.ts',
      'scripts/tool.mjs',
    ]);
  });

  it('a commented-out entry inside a block list does not truncate it', async () => {
    const { readCodeMapConfig } = await loadScope();
    writeFileSync(join(root, 'moflo.yaml'), [
      'code_map:',
      '  directories:',
      '    - packages',
      '    # - legacy',
      '    - infra/cdk',
      '  exclude: [node_modules]',
      '',
    ].join('\n'));
    const config = readCodeMapConfig(root);
    expect(config.directories).toEqual(['packages', 'infra/cdk']);
    expect(config.exclude).toEqual(['node_modules']);
  });

  it('parses a CRLF moflo.yaml (Windows checkout with autocrlf) the same as LF', async () => {
    const { readCodeMapConfig } = await loadScope();
    writeFileSync(join(root, 'moflo.yaml'), SCOPED_YAML.replace(/\n/g, '\r\n'));
    const config = readCodeMapConfig(root);
    expect(config.directories).toEqual(['packages', 'infra/cdk']);
    expect(config.exclude).toEqual(['node_modules', 'dist', 'packages/core/src/generated']);
  });

  it('`.` scopes to the whole repo; bare exclude names match any segment', async () => {
    const { createScopeFilter } = await loadScope();
    const inScope = createScopeFilter({ directories: ['.'], extensions: ['.ts'], exclude: ['generated'] });
    expect(inScope('lib/a.ts')).toBe(true);
    expect(inScope('a/generated/b.ts')).toBe(false);
    expect(inScope('lib/a.spec.ts')).toBe(false);
    expect(inScope('lib/a.md')).toBe(false);
    // Baseline top-level excludes stay top-level: nested `template/` is source.
    expect(inScope('template/x.ts')).toBe(false);
    expect(inScope('src/template/x.ts')).toBe(true);
  });

  it('normalises ./ and backslashes in configured directories', async () => {
    const { createScopeFilter } = await loadScope();
    const inScope = createScopeFilter({ directories: ['./packages\\core/'], extensions: ['.ts'], exclude: [] });
    expect(inScope('packages/core/src/a.ts')).toBe(true);
    expect(inScope('packages/other/a.ts')).toBe(false);
  });
});

describe('#1497 indexers honour scope and sweep previously leaked rows', () => {
  let root: string;
  // Start wide open — the pre-fix effective scope — then narrow and reindex.
  const WIDE_YAML = 'code_map:\n  directories: ["."]\n  extensions: [".ts", ".mjs"]\n  exclude: [node_modules]\n';

  beforeEach(() => { root = makeFixture(WIDE_YAML); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('patterns: never a gitignored file or test file; narrowing scope removes rows', { timeout: 60_000 }, async () => {
    runIndexer('index-patterns.mjs', root);
    let keys = await keysIn(root, 'patterns');
    expect(keys.some(k => k.includes('cdk.out'))).toBe(false);
    expect(keys.some(k => /\.(test|spec)\./.test(k))).toBe(false);
    expect(keys.some(k => k.includes('tool.mjs'))).toBe(true);

    writeFileSync(join(root, 'moflo.yaml'), SCOPED_YAML);
    runIndexer('index-patterns.mjs', root);
    keys = await keysIn(root, 'patterns');
    expect(keys.some(k => k.includes('tool.mjs'))).toBe(false);
    expect(keys.some(k => k.includes('schema.ts'))).toBe(false);
    expect(keys.some(k => k.includes('service.ts'))).toBe(true);
  });

  it('code-map: file entries follow scope on the git path; narrowing scope removes rows', { timeout: 60_000 }, async () => {
    runIndexer('generate-code-map.mjs', root, ['--no-embeddings']);
    let files = (await keysIn(root, 'code-map')).filter(k => k.startsWith('file:'));
    expect(files).toContain('file:scripts/tool.mjs');
    expect(files.some(k => k.includes('cdk.out'))).toBe(false);
    expect(files.some(k => /\.(test|spec)\./.test(k))).toBe(false);

    writeFileSync(join(root, 'moflo.yaml'), SCOPED_YAML);
    runIndexer('generate-code-map.mjs', root, ['--no-embeddings']);
    files = (await keysIn(root, 'code-map')).filter(k => k.startsWith('file:'));
    expect(files.sort()).toEqual([
      'file:infra/cdk/lib/stack.ts',
      'file:packages/core/src/new-file.ts',
      'file:packages/core/src/service.ts',
    ]);
  });
});
