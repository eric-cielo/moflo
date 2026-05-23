/**
 * Behavioral tests for the `reference` (library-docs grounding) indexer's pure
 * logic — bin/lib/reference-docs.mjs (issue #1184).
 *
 * Loaded via dynamic import of the .mjs (same approach as
 * index-fingerprint.test.ts) so the discovery / chunking / entry-shaping logic
 * is exercised against a synthetic node_modules tree in a tmpdir — no sql.js, no
 * background embedding spawn, no network.
 *
 * The embedding-preservation half (content-diff on re-run) is covered by
 * incremental-write.test.ts, since this indexer reuses applyIncrementalChunks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const LIB_PATH = resolve(__dirname, '../../bin/lib/reference-docs.mjs');

async function loadLib() {
  return import(pathToFileURL(LIB_PATH).href);
}

/** Write a file, creating parent dirs. */
function put(path: string, content: string) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Synthetic consumer tree:
 *   alpha          — README + index.d.ts (via "types" field)
 *   @scope/beta    — typings field only (no README), scoped name
 *   gamma          — README only (no types)
 *   silent         — installed but neither README nor types (must drop out)
 *   missing-pkg    — declared dep, NOT installed (must drop out)
 */
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'moflo-refdocs-'));

  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'consumer',
    dependencies: { alpha: '^1.0.0' },
    devDependencies: { '@scope/beta': '^2.0.0', gamma: '^3.0.0', silent: '^1.0.0' },
    optionalDependencies: { 'missing-pkg': '^1.0.0' },
  }));

  put(join(root, 'node_modules/alpha/package.json'), JSON.stringify({ name: 'alpha', version: '1.2.3', types: 'index.d.ts' }));
  put(join(root, 'node_modules/alpha/README.md'), '# alpha\n\nThe alpha package does alpha things.\n');
  put(join(root, 'node_modules/alpha/index.d.ts'), 'export declare function alpha(x: number): number;\n');

  put(join(root, 'node_modules/@scope/beta/package.json'), JSON.stringify({ name: '@scope/beta', version: '2.0.1', typings: 'lib/beta.d.ts' }));
  put(join(root, 'node_modules/@scope/beta/lib/beta.d.ts'), 'export interface Beta { id: string; }\n');

  put(join(root, 'node_modules/gamma/package.json'), JSON.stringify({ name: 'gamma', version: '3.1.0' }));
  put(join(root, 'node_modules/gamma/README.md'), '# gamma\n\nGamma readme body.\n');

  put(join(root, 'node_modules/silent/package.json'), JSON.stringify({ name: 'silent', version: '0.0.1' }));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('collectDependencyNames', () => {
  it('returns direct deps across all dependency fields, sorted + de-duped', async () => {
    const { collectDependencyNames } = await loadLib();
    expect(collectDependencyNames(root)).toEqual(['@scope/beta', 'alpha', 'gamma', 'missing-pkg', 'silent']);
  });

  it('returns [] when there is no package.json', async () => {
    const { collectDependencyNames } = await loadLib();
    const empty = mkdtempSync(join(tmpdir(), 'moflo-refdocs-empty-'));
    try {
      expect(collectDependencyNames(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('resolvePackageDocs', () => {
  it('resolves README + entry .d.ts via the "types" field, with the installed version', async () => {
    const { resolvePackageDocs } = await loadLib();
    const pkg = resolvePackageDocs(root, 'alpha');
    expect(pkg).not.toBeNull();
    expect(pkg.version).toBe('1.2.3');
    expect(pkg.readmePath).toContain('README.md');
    expect(pkg.typesPath?.endsWith('index.d.ts')).toBe(true);
  });

  it('resolves a scoped package via the "typings" field and tolerates a missing README', async () => {
    const { resolvePackageDocs } = await loadLib();
    const pkg = resolvePackageDocs(root, '@scope/beta');
    expect(pkg.version).toBe('2.0.1');
    expect(pkg.readmePath).toBeNull();
    expect(pkg.typesPath?.replace(/\\/g, '/').endsWith('@scope/beta/lib/beta.d.ts')).toBe(true);
  });

  it('resolves README-only packages with no type defs', async () => {
    const { resolvePackageDocs } = await loadLib();
    const pkg = resolvePackageDocs(root, 'gamma');
    expect(pkg.version).toBe('3.1.0');
    expect(pkg.readmePath).toContain('README.md');
    expect(pkg.typesPath).toBeNull();
  });

  it('drops installed packages that have neither README nor types', async () => {
    const { resolvePackageDocs } = await loadLib();
    expect(resolvePackageDocs(root, 'silent')).toBeNull();
  });

  it('drops declared-but-not-installed dependencies (graceful, never throws)', async () => {
    const { resolvePackageDocs } = await loadLib();
    expect(resolvePackageDocs(root, 'missing-pkg')).toBeNull();
  });
});

describe('collectReferenceDocs', () => {
  it('returns only packages with installed docs, plus their doc-file paths', async () => {
    const { collectReferenceDocs } = await loadLib();
    const { packages, docFiles, depCount } = collectReferenceDocs(root);
    expect(depCount).toBe(5);
    expect(packages.map((p: { name: string }) => p.name).sort()).toEqual(['@scope/beta', 'alpha', 'gamma']);
    // alpha (README + dts) + beta (dts) + gamma (README) = 4 doc files.
    expect(docFiles).toHaveLength(4);
  });
});

describe('chunkText', () => {
  it('returns a single chunk for short text', async () => {
    const { chunkText } = await loadLib();
    expect(chunkText('# small\n\nbody')).toEqual(['# small\n\nbody']);
  });

  it('returns [] for empty / whitespace-only text', async () => {
    const { chunkText } = await loadLib();
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('splits oversized text into bounded chunks and caps the count', async () => {
    const { chunkText, MAX_CHUNK_SIZE, MAX_CHUNKS_PER_DOC } = await loadLib();
    const para = 'x'.repeat(1000);
    const huge = Array.from({ length: 500 }, () => para).join('\n\n');
    const chunks = chunkText(huge);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS_PER_DOC);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
  });
});

describe('buildDocEntries', () => {
  it('keys each chunk on name@version with provenance metadata', async () => {
    const { buildDocEntries } = await loadLib();
    const entries = buildDocEntries({ name: 'gamma', version: '3.1.0' }, 'readme', '# gamma\n\nGamma readme body.');
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.key).toBe('reference:gamma@3.1.0:readme:0');
    expect(e.content.startsWith('# gamma@3.1.0 — README')).toBe(true);
    expect(e.tags).toEqual(['reference', 'library-docs', 'readme', 'gamma']);
    expect(e.metadata).toMatchObject({
      type: 'chunk',
      source: 'node_modules',
      package: 'gamma',
      version: '3.1.0',
      docType: 'readme',
      chunkIndex: 0,
      totalChunks: 1,
      prevChunk: null,
      nextChunk: null,
    });
    expect(e.metadata.siblings).toEqual(['reference:gamma@3.1.0:readme:0']);
  });

  it('wires prev/next/siblings navigation across a multi-chunk doc', async () => {
    const { buildDocEntries } = await loadLib();
    const big = Array.from({ length: 12 }, (_, i) => `## Section ${i}\n\n${'y'.repeat(900)}`).join('\n\n');
    const entries = buildDocEntries({ name: 'alpha', version: '1.2.3' }, 'types', big);
    expect(entries.length).toBeGreaterThan(1);
    const keys = entries.map((e: { key: string }) => e.key);
    expect(entries[0].metadata.prevChunk).toBeNull();
    expect(entries[0].metadata.nextChunk).toBe(keys[1]);
    expect(entries[entries.length - 1].metadata.nextChunk).toBeNull();
    for (const e of entries) expect(e.metadata.siblings).toEqual(keys);
  });

  it('truncates a doc larger than its byte cap before chunking', async () => {
    const { buildDocEntries, MAX_DTS_BYTES, MAX_CHUNKS_PER_DOC } = await loadLib();
    const oversized = 'z'.repeat(MAX_DTS_BYTES * 2);
    const entries = buildDocEntries({ name: 'alpha', version: '1.2.3' }, 'types', oversized);
    expect(entries.length).toBeLessThanOrEqual(MAX_CHUNKS_PER_DOC);
  });
});
