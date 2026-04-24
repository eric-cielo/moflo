// Regression guard for issue #560 — `moflo benchmark pretrain` must measure
// the real fastembed embedder, never an inline charCodeAt+Math.sin hash.
//
// The repo-wide ESLint structural rule in .eslintrc.cjs deliberately exempts
// benchmarks/ paths (benchmarks legitimately compute synthetic vectors for
// math throughput). That exemption is how the hash implementations originally
// landed in benchmarkEmbeddingGeneration + benchmarkPretrainPipeline and
// shipped under a user-visible "Embedding Generation: N ops/sec" label.
//
// Consumer-smoke's verifyNoInlineHashEmbeddings catches this at dist time,
// but that only runs per-PR; this fast unit-level guard fails immediately if
// the pattern is reintroduced.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PRETRAIN_SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'benchmarks',
  'pretrain',
  'index.ts',
);

// Matches `function NAME(`, `async function NAME(`, and optionally-prefixed
// `export` variants — so dropping `export` or `async` during a refactor still
// lets the guard find the body instead of silently passing as "function gone".
function extractFunctionBody(source: string, name: string): string {
  const header = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`,
  ).exec(source);
  if (!header) throw new Error(`function ${name} not found in pretrain/index.ts`);
  const openBrace = source.indexOf('{', header.index + header[0].length);
  if (openBrace === -1) throw new Error(`function ${name} has no body`);

  let depth = 1;
  for (let i = openBrace + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(openBrace, i + 1);
    }
  }
  throw new Error(`function ${name} body is unbalanced`);
}

describe('pretrain benchmark hash-embedding regression guard (#560)', () => {
  const source = readFileSync(PRETRAIN_SRC, 'utf8');
  const embeddingGenBody = extractFunctionBody(source, 'benchmarkEmbeddingGeneration');
  const pipelineBody = extractFunctionBody(source, 'benchmarkPretrainPipeline');

  const cases: Array<[string, string]> = [
    ['benchmarkEmbeddingGeneration', embeddingGenBody],
    ['benchmarkPretrainPipeline', pipelineBody],
  ];

  for (const [fn, body] of cases) {
    it(`${fn} contains no inline hash-embedding pattern`, () => {
      // These two functions are embedding benchmarks — charCodeAt in their
      // body is never legitimate, so a bare presence check is the right gate.
      expect(body).not.toMatch(/\bcharCodeAt\s*\(/);
      // Catches FNV `hash / 0xffffffff` even if charCodeAt gets renamed.
      expect(body).not.toMatch(/\/\s*0x[fF]{8}\b/);
    });
  }

  it('benchmarkEmbeddingGeneration exercises the real IEmbeddingService', () => {
    // Route through the production factory; a renamed local fallback
    // (e.g. an inline `generateEmbedding`) would fail these assertions.
    expect(embeddingGenBody).toMatch(/createEmbeddingService\s*\(/);
    expect(embeddingGenBody).toMatch(/['"]fastembed['"]/);
    expect(embeddingGenBody).toMatch(/service\.embed\(/);
  });

  it('benchmarkPretrainPipeline uses synthetic random vectors, not hash-derived ones', () => {
    // Math.random is obviously synthetic; Math.sin(charCodeAt) looks real and
    // misled users about `moflo benchmark pretrain` throughput in #560.
    expect(pipelineBody).toMatch(/Math\.random\s*\(/);
  });
});
