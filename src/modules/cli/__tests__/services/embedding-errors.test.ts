/**
 * Tests for the friendly embedding-error formatter (#553).
 *
 * Covers each mapped error code path (network, cache permission, corrupted
 * download, missing package, generic) and the verbose gate that hides the
 * raw message + stack behind `--verbose` / `DEBUG=moflo:*`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  classifyEmbeddingError,
  formatEmbeddingError,
  isVerboseEmbeddingErrors,
} from '../../src/memory/embedding-errors.js';

describe('embedding-errors: classifyEmbeddingError', () => {
  it('classifies ENETUNREACH by errno code as network', () => {
    const err = Object.assign(new Error('boom'), { code: 'ENETUNREACH' });
    expect(classifyEmbeddingError(err).code).toBe('network');
  });

  it('classifies ENOTFOUND / getaddrinfo in the message as network', () => {
    const err = new Error('getaddrinfo ENOTFOUND huggingface.co');
    expect(classifyEmbeddingError(err).code).toBe('network');
  });

  it('classifies wrapped fastembed network failure via cause chain', () => {
    const root = Object.assign(new Error('network unreachable'), { code: 'ENETUNREACH' });
    const wrapped = new Error('Failed to initialize fastembed: network unreachable');
    (wrapped as Error & { cause?: unknown }).cause = root;
    expect(classifyEmbeddingError(wrapped).code).toBe('network');
  });

  it('classifies EACCES by errno code as cache-permission', () => {
    const err = Object.assign(new Error('permission'), { code: 'EACCES' });
    expect(classifyEmbeddingError(err).code).toBe('cache-permission');
  });

  it('classifies "permission denied" in message as cache-permission', () => {
    const err = new Error('mkdir /home/x/.cache/fastembed: permission denied');
    expect(classifyEmbeddingError(err).code).toBe('cache-permission');
  });

  it('classifies corrupted / size-mismatch downloads as cache-corrupted', () => {
    const cases = [
      'checksum mismatch for model.onnx',
      'unexpected end of file while reading model',
      'corrupted gzip stream',
      'invalid onnx model signature',
    ];
    for (const msg of cases) {
      expect(classifyEmbeddingError(new Error(msg)).code).toBe('cache-corrupted');
    }
  });

  it('classifies missing @moflo/embeddings package', () => {
    const err = new Error(
      '@moflo/embeddings is not installed. Neural embeddings are required — the hash fallback was removed in epic #527.',
    );
    expect(classifyEmbeddingError(err).code).toBe('missing-package');
  });

  it('falls through to generic when nothing matches', () => {
    const err = new Error('something weird happened inside ONNX runtime');
    expect(classifyEmbeddingError(err).code).toBe('generic');
  });

  it('handles non-Error inputs (strings, plain objects)', () => {
    expect(classifyEmbeddingError('ENETUNREACH').code).toBe('network');
    expect(classifyEmbeddingError({ code: 'EACCES' }).code).toBe('cache-permission');
    expect(classifyEmbeddingError(null).code).toBe('generic');
  });
});

describe('embedding-errors: formatEmbeddingError default (non-verbose)', () => {
  const originalDebug = process.env.DEBUG;
  beforeEach(() => {
    delete process.env.DEBUG;
  });
  afterEach(() => {
    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;
  });

  it('hides stack trace and raw message by default', () => {
    const err = new Error('getaddrinfo ENOTFOUND huggingface.co');
    const formatted = formatEmbeddingError(err);
    expect(formatted).not.toContain('getaddrinfo ENOTFOUND');
    expect(formatted).not.toContain('Underlying error:');
    expect(formatted).not.toMatch(/\s+at\s+/);
  });

  it('renders the plain-English message + next step for network failures', () => {
    const err = Object.assign(new Error('ENETUNREACH'), { code: 'ENETUNREACH' });
    const formatted = formatEmbeddingError(err);
    expect(formatted).toContain("Couldn't reach the model server");
    expect(formatted).toContain('flo doctor');
  });

  it('renders the plain-English message + next step for cache-permission failures', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const formatted = formatEmbeddingError(err);
    expect(formatted).toContain("Couldn't write the embedding model cache");
    expect(formatted).toContain('~/.cache/fastembed');
    expect(formatted).toContain('FASTEMBED_CACHE');
  });

  it('renders the delete-cache next step for corrupted downloads', () => {
    const err = new Error('size mismatch while reading model.onnx');
    const formatted = formatEmbeddingError(err);
    expect(formatted).toContain('corrupted');
    expect(formatted).toContain('Delete `~/.cache/fastembed`');
  });

  it('renders a generic next step when classification is unclear', () => {
    const err = new Error('something weird happened');
    const formatted = formatEmbeddingError(err);
    expect(formatted).toContain("Couldn't load the neural embedding model");
    expect(formatted).toContain('--verbose');
  });
});

describe('embedding-errors: formatEmbeddingError verbose gate', () => {
  const originalDebug = process.env.DEBUG;
  beforeEach(() => {
    delete process.env.DEBUG;
  });
  afterEach(() => {
    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;
  });

  it('includes the raw message when verbose=true', () => {
    const err = new Error('getaddrinfo ENOTFOUND huggingface.co');
    const formatted = formatEmbeddingError(err, { verbose: true });
    expect(formatted).toContain('Underlying error: getaddrinfo ENOTFOUND huggingface.co');
  });

  it('includes the stack trace when verbose=true', () => {
    const err = new Error('boom');
    const formatted = formatEmbeddingError(err, { verbose: true });
    expect(formatted).toMatch(/Error: boom[\s\S]*at\s+/);
  });

  it('activates verbose when DEBUG is the moflo namespace', () => {
    process.env.DEBUG = 'moflo:memory';
    expect(isVerboseEmbeddingErrors()).toBe(true);
    const err = new Error('boom');
    expect(formatEmbeddingError(err)).toContain('Underlying error:');
  });

  it('activates verbose when DEBUG is the wildcard "*"', () => {
    process.env.DEBUG = '*';
    expect(isVerboseEmbeddingErrors()).toBe(true);
  });

  it('activates verbose when DEBUG has comma-separated namespaces including moflo', () => {
    process.env.DEBUG = 'express,moflo,other';
    expect(isVerboseEmbeddingErrors()).toBe(true);
  });

  it('stays non-verbose when DEBUG is an unrelated namespace', () => {
    process.env.DEBUG = 'other:thing';
    expect(isVerboseEmbeddingErrors()).toBe(false);
  });

  it('stays non-verbose when DEBUG contains a literal "*" inside another string', () => {
    process.env.DEBUG = 'foo*bar';
    expect(isVerboseEmbeddingErrors()).toBe(false);
  });

  it('stays non-verbose when DEBUG contains "moflo" as a substring (not a namespace)', () => {
    process.env.DEBUG = 'xmoflo';
    expect(isVerboseEmbeddingErrors()).toBe(false);
  });
});
