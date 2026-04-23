/**
 * Red tests for the hash-fallback regression guard (issue #545). If a case
 * goes GREEN, the guard regressed — fix the config, don't mute the test.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { ESLint } from 'eslint';

import {
  BANNED_EMBEDDING_IDENTIFIERS,
  BANNED_EMBEDDING_LITERAL_RE,
} from '../../harness/consumer-smoke/lib/checks.mjs';

const REPO_ROOT = resolve(__dirname, '../..');

// `filePath` drives ESLint's override resolution; the file is never written.
const SRC_FIXTURE_PATH = join(REPO_ROOT, 'src', '__guard_fixture__.ts');

let eslint: ESLint;

beforeAll(() => {
  // One ESLint instance reused across cases — constructing ESLint parses the
  // full config cascade (~300-700ms on Windows).
  eslint = new ESLint({ cwd: REPO_ROOT });
});

async function lintSource(source: string): Promise<ESLint.LintResult[]> {
  return eslint.lintText(source, { filePath: SRC_FIXTURE_PATH });
}

function hasRuleViolation(
  results: ESLint.LintResult[],
  ruleId: string,
): boolean {
  return results.some(r =>
    r.messages.some(m => m.ruleId === ruleId && m.severity === 2),
  );
}

describe('hash-fallback regression guard — ESLint', () => {
  it('rejects a standalone hashEmbed function', async () => {
    const results = await lintSource(`
      export function hashEmbed(text: string): number[] {
        return [text.length];
      }
    `);
    expect(hasRuleViolation(results, 'no-restricted-syntax')).toBe(true);
  });

  it('rejects an embedWithFallback helper', async () => {
    const results = await lintSource(`
      export async function embedWithFallback(text: string) {
        return [text];
      }
    `);
    expect(hasRuleViolation(results, 'no-restricted-syntax')).toBe(true);
  });

  it('rejects the domain-aware-hash model literal', async () => {
    const results = await lintSource(`
      export const MODEL = 'domain-aware-hash-v2';
    `);
    expect(hasRuleViolation(results, 'no-restricted-syntax')).toBe(true);
  });

  it('rejects a renamed function that builds Float32Array + charCodeAt', async () => {
    // The point of the structural rule: no matter what you call the function,
    // if it constructs a Float32Array AND calls charCodeAt in the same body,
    // it is a hash embedding.
    const results = await lintSource(`
      export function totallyLegit(text: string, dim = 8): Float32Array {
        const out = new Float32Array(dim);
        for (let i = 0; i < dim; i++) {
          out[i] = text.charCodeAt(i % text.length);
        }
        return out;
      }
    `);
    expect(hasRuleViolation(results, 'no-restricted-syntax')).toBe(true);
  });

  it('rejects an @xenova/transformers import', async () => {
    const results = await lintSource(`
      import { pipeline } from '@xenova/transformers';
      export const p = pipeline;
    `);
    expect(hasRuleViolation(results, 'no-restricted-imports')).toBe(true);
  });

  it('allows the legitimate generateEmbedding public API', async () => {
    const results = await lintSource(`
      import { generateEmbedding } from './memory/memory-initializer.js';
      export async function run(text: string) {
        const r = await generateEmbedding(text);
        return r.embedding;
      }
    `);
    expect(hasRuleViolation(results, 'no-restricted-syntax')).toBe(false);
  });
});

describe('hash-fallback regression guard — smoke walker', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'moflo-guard-'));
  });

  afterEach(() => {
    if (existsSync(tmp)) {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('banned identifiers list contains the issue #545 additions', () => {
    expect(BANNED_EMBEDDING_IDENTIFIERS).toContain('hashEmbed');
    expect(BANNED_EMBEDDING_IDENTIFIERS).toContain('embedWithFallback');
  });

  it('literal regex matches the domain-aware-hash prefix', () => {
    expect('domain-aware-hash-v1').toMatch(BANNED_EMBEDDING_LITERAL_RE);
    expect('domain-aware-hash-384').toMatch(BANNED_EMBEDDING_LITERAL_RE);
    expect('onnx-minilm-v2').not.toMatch(BANNED_EMBEDDING_LITERAL_RE);
  });

  it('verifyNoBannedEmbeddings detects a banned re-export in a .d.ts', async () => {
    // Simulate a consumer install layout. walker scans `consumerDir/node_modules/moflo/`.
    const mofloDir = join(tmp, 'node_modules', 'moflo');
    mkdirSync(mofloDir, { recursive: true });
    writeFileSync(
      join(mofloDir, 'leak.d.ts'),
      `export declare function hashEmbed(text: string): Float32Array;\n`,
    );
    writeFileSync(
      join(mofloDir, 'package.json'),
      JSON.stringify({ name: 'moflo', version: '0.0.0' }),
    );

    // Drive the real check through the recording reporter so we can assert
    // the outcome without relying on process exits. `getResults()` returns a
    // live module-scoped array; snapshot its length before running so we only
    // inspect records the check itself produced.
    const checks = await import(
      pathToFileURL(resolve(REPO_ROOT, 'harness/consumer-smoke/lib/checks.mjs')).href
    );
    const reporter = await import(
      pathToFileURL(resolve(REPO_ROOT, 'harness/consumer-smoke/lib/report.mjs')).href
    );
    reporter.configure({ json: true }); // silence stdout while still recording
    const before = reporter.getResults().length;
    checks.verifyNoBannedEmbeddings(tmp);
    const added = reporter.getResults().slice(before) as Array<{
      step: string;
      status: string;
      detail: string;
    }>;
    const hit = added.find(r => r.step === 'no-banned-embeddings');
    expect(hit).toBeDefined();
    expect(hit?.status).toBe('fail');
    expect(hit?.detail).toContain('hashEmbed');
  });

  it('verifyNoInlineHashEmbeddings detects Float32Array + charCodeAt co-occurrence', async () => {
    const mofloDir = join(tmp, 'node_modules', 'moflo');
    mkdirSync(mofloDir, { recursive: true });
    writeFileSync(
      join(mofloDir, 'leak.mjs'),
      `export function looksInnocent(text) {
  const out = new Float32Array(8);
  for (let i = 0; i < 8; i++) out[i] = text.charCodeAt(i % text.length);
  return out;
}
`,
    );
    writeFileSync(
      join(mofloDir, 'package.json'),
      JSON.stringify({ name: 'moflo', version: '0.0.0' }),
    );

    const checks = await import(
      pathToFileURL(resolve(REPO_ROOT, 'harness/consumer-smoke/lib/checks.mjs')).href
    );
    const reporter = await import(
      pathToFileURL(resolve(REPO_ROOT, 'harness/consumer-smoke/lib/report.mjs')).href
    );
    reporter.configure({ json: true });
    const before = reporter.getResults().length;
    checks.verifyNoInlineHashEmbeddings(tmp);
    const added = reporter.getResults().slice(before) as Array<{
      step: string;
      status: string;
      detail: string;
    }>;
    const hit = added.find(r => r.step === 'no-inline-hash-embeddings');
    expect(hit).toBeDefined();
    expect(hit?.status).toBe('fail');
    expect(hit?.detail).toContain('leak.mjs');
  });
});
