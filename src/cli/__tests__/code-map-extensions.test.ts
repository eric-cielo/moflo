/**
 * Regression tests for #1337 — `.mjs`/`.cjs` were excluded from the code-map,
 * making moflo's entire hook/gate/launcher runtime invisible to `memory_search`
 * while the `memory_first` gate blocked the tools that would have found it.
 *
 * Two distinct defects are covered:
 *
 *   1. Extension coverage — `.cjs` was absent from the indexer defaults, from
 *      the pattern/test indexers, and (the consumer-facing root cause) from the
 *      `SOURCE_EXTENSIONS` list that `flo init` uses to write every consumer's
 *      `code_map.extensions`. Because an explicit `extensions:` key shadows the
 *      indexer defaults, fixing the defaults alone fixed nothing downstream.
 *
 *   2. Case normalisation (Rule #1) — `extname()` returns the literal `.MJS`
 *      for a file committed as `Foo.MJS` on *every* platform, and git pathspec
 *      globs are case-sensitive regardless of `core.ignorecase`. NTFS and APFS
 *      are case-insensitive by default, so such filenames are routine there.
 *
 * These assert against the real shipped sources and real `git` behaviour rather
 * than re-implementing the logic — a replicated-logic test cannot catch a drift
 * between the test's copy and what actually ships.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { detectExtensions } from '../init/moflo-yaml-template.js';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf-8');

/** Every enumeration surface that must agree on which JS flavours are sources. */
const JS_SOURCE_SURFACES = [
  { file: 'bin/generate-code-map.mjs', anchor: "'.ts', '.tsx', '.js'" },
  { file: 'bin/index-patterns.mjs', anchor: 'SOURCE_EXTENSIONS' },
  { file: 'bin/index-tests.mjs', anchor: 'TEST_EXTENSIONS' },
];

describe('#1337 extension coverage', () => {
  it.each(JS_SOURCE_SURFACES)('$file lists both .mjs and .cjs', ({ file, anchor }) => {
    const src = read(file);
    const line = src.split('\n').find(l => l.includes(anchor) && l.includes('.ts'));
    expect(line, `no extension list found near "${anchor}"`).toBeDefined();
    expect(line).toContain("'.mjs'");
    expect(line).toContain("'.cjs'");
  });

  it('flo init detects .mjs/.cjs as source extensions (consumer surface)', () => {
    // The generated moflo.yaml `extensions:` key SHADOWS the indexer defaults,
    // so this list — not generate-code-map.mjs — is what consumers actually get.
    const src = read('src/cli/init/moflo-yaml-template.ts');
    const block = src.slice(src.indexOf('const SOURCE_EXTENSIONS'), src.indexOf('const SOURCE_EXTENSIONS') + 300);
    expect(block).toContain("'.mjs'");
    expect(block).toContain("'.cjs'");
  });

  it('this repo indexes its own bin/ runtime', () => {
    const yaml = read('moflo.yaml');
    const exts = yaml.match(/code_map:[\s\S]*?extensions:\s*\[([^\]]+)\]/)?.[1] ?? '';
    expect(exts).toContain('.mjs');
    expect(exts).toContain('.cjs');
  });

  it('the code-map language maps already knew about .cjs — the omission was an oversight', () => {
    // EXT_TO_LANG and detectLanguage both mapped '.cjs' while the enumeration
    // list did not, which is what made the gap silent rather than loud.
    const src = read('bin/generate-code-map.mjs');
    expect(src).toContain("'.cjs': 'ts'");
    expect(src).toContain("'.cjs': 'CommonJS'");
  });
});

describe('#1337 case normalisation (Rule #1)', () => {
  it('every extname() comparison in the indexers is case-normalised', () => {
    const offenders: string[] = [];
    for (const file of ['bin/generate-code-map.mjs', 'bin/index-patterns.mjs', 'bin/index-tests.mjs']) {
      read(file).split('\n').forEach((line, i) => {
        if (!line.includes('extname(')) return;
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
        if (line.includes('import ')) return;
        if (line.includes('.toLowerCase()')) return;
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, 'un-normalised extname() call sites').toEqual([]);
  });

  it('git ls-files pathspecs use :(icase)', () => {
    // The filesystem walk is only the FALLBACK. git ls-files is the primary
    // enumeration path, so normalising extname() alone leaves the real gap open.
    // Globs reach `git ls-files` either inline (index-tests) or via a built
    // array (generate-code-map), so scan every line that constructs one.
    const bare: string[] = [];
    let globLines = 0;
    for (const file of ['bin/generate-code-map.mjs', 'bin/index-tests.mjs']) {
      read(file).split('\n').forEach((line, i) => {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
        // A pathspec glob: a quoted/templated string starting with `*`.
        if (!/['"`]\*|\$\{ext\}/.test(line)) return;
        if (!/ls-files|GlobArgs|pathspec/i.test(line) && !/['"`](?::\(icase\))?\*\./.test(line)) return;
        globLines++;
        if (!line.includes(':(icase)')) bare.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(globLines, 'no git pathspec globs found — did the call sites move?').toBeGreaterThan(0);
    expect(bare, 'case-sensitive git pathspec globs').toEqual([]);
  });

  it('detectExtensions() lowercases what it discovers', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'moflo-1337-'));
    try {
      const src = path.join(root, 'src');
      mkdirSync(src, { recursive: true });
      // Distinct basenames on purpose: `a.mjs` + `a.MJS` would collide on the
      // case-insensitive filesystems this test exists to protect.
      writeFileSync(path.join(src, 'runtime.mjs'), 'export const a = 1;\n');
      writeFileSync(path.join(src, 'gate.cjs'), 'module.exports = {};\n');
      writeFileSync(path.join(src, 'Legacy.CJS'), 'module.exports = {};\n');

      const exts = detectExtensions(root, ['src']);
      expect(exts).toContain('.mjs');
      expect(exts).toContain('.cjs');
      expect(exts.every(e => e === e.toLowerCase())).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('#1337 dispatch-command indexing', () => {
  // Indexing bin/gate.cjs made it PRESENT but still unfindable: its gate names
  // live only as `case` string literals, so the one token a caller would query
  // on never reached the index. Presence and findability are separate wins.
  const src = read('bin/generate-code-map.mjs');

  it('file entries include dispatch-command literals', () => {
    expect(src).toContain('extractDispatchCommands');
    expect(src).toContain('Handles commands:');
  });

  it('the extractor requires an internal separator (no bare enum words)', () => {
    const pattern = src.match(/const DISPATCH_CASE = (\/.*\/g);/)?.[1];
    expect(pattern, 'DISPATCH_CASE regex not found').toBeDefined();
    // Rebuild the shipped regex and the shipped separator guard.
    const re = new RegExp(pattern!.slice(1, -2), 'g');
    const sample = `
      switch (cmd) {
        case 'check-before-done': return 1;
        case 'hooks:post-edit': return 2;
        case 'open': return 3;
        case 'a': return 4;
      }`;
    const hits = [...sample.matchAll(re)].map(m => m[1]).filter(s => /[.:-]/.test(s));
    expect(hits).toContain('check-before-done');
    expect(hits).toContain('hooks:post-edit');
    expect(hits).not.toContain('open');
    expect(hits).not.toContain('a');
  });

  it("gate.cjs's own gate names are extractable", () => {
    const gate = read('bin/gate.cjs');
    const re = new RegExp(read('bin/generate-code-map.mjs').match(/const DISPATCH_CASE = \/(.*)\/g;/)![1], 'g');
    const names = [...gate.matchAll(re)].map(m => m[1]).filter(s => /[.:-]/.test(s));
    expect(names).toContain('check-before-done');
  });
});

describe('#1337 git pathspec case-sensitivity (the reason :(icase) is required)', () => {
  let repo: string | null = null;
  let gitAvailable = true;

  const git = (args: string[], cwd: string) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd,
      encoding: 'utf-8',
      windowsHide: true,
    });

  beforeAll(() => {
    try {
      // realpath both sides: macOS tmpdir is a symlink (/var -> /private/var).
      repo = mkdtempSync(path.join(tmpdir(), 'moflo-1337-git-'));
      git(['init', '-q', '.'], repo);
      writeFileSync(path.join(repo, 'lower.mjs'), 'export const a = 1;\n');
      writeFileSync(path.join(repo, 'Upper.MJS'), 'export const b = 2;\n');
      git(['add', '-A'], repo);
    } catch {
      gitAvailable = false;
    }
  });

  afterAll(() => {
    if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  it('a bare *.mjs pathspec misses an uppercase extension', () => {
    if (!gitAvailable || !repo) return;
    const out = git(['ls-files', '--', '*.mjs'], repo).trim().split('\n').filter(Boolean);
    expect(out).toContain('lower.mjs');
    expect(out).not.toContain('Upper.MJS');
  });

  it(':(icase) finds both — and is a superset, so nothing drops out', () => {
    if (!gitAvailable || !repo) return;
    const out = git(['ls-files', '--', ':(icase)*.mjs'], repo).trim().split('\n').filter(Boolean);
    expect(out).toContain('lower.mjs');
    expect(out).toContain('Upper.MJS');
  });
});
