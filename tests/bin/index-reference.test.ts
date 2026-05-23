/**
 * Contract guards for the `reference` library-docs indexer orchestrator
 * (bin/index-reference.mjs) and its registration in the session-start chain
 * (bin/index-all.mjs) — issue #1184.
 *
 * Source-level assertions, matching the established pattern for bin/*.mjs
 * scripts (index-embeddings-pm-registration.test.ts, hooks-test-indexing.test.ts).
 * The behavioral logic lives in bin/lib/reference-docs.mjs and is exercised in
 * reference-docs.test.ts; the embedding-preserving write in incremental-write.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const BIN = resolve(__dirname, '../../bin');
const indexReferenceSrc = readFileSync(resolve(BIN, 'index-reference.mjs'), 'utf-8');
const indexAllSrc = readFileSync(resolve(BIN, 'index-all.mjs'), 'utf-8');

describe('bin/index-reference.mjs — orchestrator contract', () => {
  it('writes to the `reference` namespace', () => {
    expect(indexReferenceSrc).toMatch(/const\s+NAMESPACE\s*=\s*['"]reference['"]/);
  });

  it('delegates discovery/chunking to the pure lib (bin/lib/reference-docs.mjs)', () => {
    expect(indexReferenceSrc).toMatch(/from\s+['"]\.\/lib\/reference-docs\.mjs['"]/);
    expect(indexReferenceSrc).toMatch(/collectReferenceDocs/);
    expect(indexReferenceSrc).toMatch(/buildDocEntries/);
  });

  it('uses the embedding-preserving incremental write (#745), not a wipe-and-rebuild', () => {
    expect(indexReferenceSrc).toMatch(/applyIncrementalChunks/);
    expect(indexReferenceSrc).toMatch(/computeContentListHash/);
    // No raw DELETE FROM ... namespace then re-insert (the regression #745 fixed).
    expect(indexReferenceSrc).not.toMatch(/DELETE\s+FROM\s+memory_entries\s+WHERE\s+namespace/i);
  });

  it('spawns build-embeddings through the shared ProcessManager, not raw spawn (#886)', () => {
    expect(indexReferenceSrc).toMatch(/from\s+['"]\.\/lib\/process-manager\.mjs['"]/);
    expect(indexReferenceSrc).toMatch(/createProcessManager/);
    expect(indexReferenceSrc).not.toMatch(/from\s+['"]child_process['"]/);
    const stripped = indexReferenceSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(stripped).not.toMatch(/(?<!\.)\bspawn\s*\(/);
  });

  it('uses pm.spawn with a stable namespace-derived label (dedup with index-all)', () => {
    expect(indexReferenceSrc).toMatch(/pm\.spawn\s*\(/);
    expect(indexReferenceSrc).toMatch(/build-embeddings-\$\{NAMESPACE\}/);
  });

  it('scopes the background embed to the reference namespace', () => {
    expect(indexReferenceSrc).toMatch(/'--namespace',\s*NAMESPACE/);
  });
});

describe('bin/index-all.mjs — reference-index registration', () => {
  it('registers the reference indexer via consider() with the right cfgKey/script/bin', () => {
    expect(indexAllSrc).toMatch(
      /consider\(\s*'reference-index'\s*,\s*'reference'\s*,\s*'index-reference\.mjs'\s*,\s*'flo-reference'/,
    );
  });

  it('runs reference-index after patterns-index and before build-embeddings', () => {
    const patterns = indexAllSrc.indexOf("'patterns-index'");
    const reference = indexAllSrc.indexOf("'reference-index'");
    const embeddings = indexAllSrc.indexOf("'build-embeddings'");
    expect(patterns).toBeGreaterThan(-1);
    expect(reference).toBeGreaterThan(patterns);
    expect(embeddings).toBeGreaterThan(reference);
  });

  it('includes `reference` in the auto_index keys parsed from moflo.yaml', () => {
    // The isIndexEnabled pre-parse loop must know the key, or the moflo.yaml
    // toggle silently never applies.
    const loop = indexAllSrc.match(/for\s*\(const k of \[([^\]]*)\]\)/);
    expect(loop, 'auto_index key loop must exist').toBeTruthy();
    expect(loop![1]).toMatch(/'reference'/);
  });
});
