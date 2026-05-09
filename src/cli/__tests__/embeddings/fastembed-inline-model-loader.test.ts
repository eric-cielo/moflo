/**
 * Unit tests for the model loader — exercises URL slug mapping, cache-hit
 * shortcut, fetch error handling, and the tarball-then-extract sequence
 * with a mock fetch + mock tar extractor. No network, no real disk model.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

import {
  COMPLETION_SENTINEL,
  resolveCacheDir,
  retrieveModel,
} from '../../embeddings/fastembed-inline/model-loader.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'moflo-fastembed-inline-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function makeFetch(status: number, body: Buffer | null) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    body: body ? (Readable.toWeb(Readable.from(body)) as ReadableStream<Uint8Array>) : null,
    headers: { get: (_: string) => null },
  })) as unknown as typeof fetch;
}

describe('resolveCacheDir', () => {
  it('prefers an explicit cacheDir over env and default', () => {
    expect(resolveCacheDir('/explicit', { FASTEMBED_CACHE: '/env-cache' })).toBe('/explicit');
  });

  it('falls back to FASTEMBED_CACHE when no explicit value', () => {
    expect(resolveCacheDir(undefined, { FASTEMBED_CACHE: '/env-cache' })).toBe('/env-cache');
  });

  it('falls back to ~/.cache/fastembed when neither is set', () => {
    const result = resolveCacheDir(undefined, {});
    expect(result.endsWith(join('.cache', 'fastembed'))).toBe(true);
  });
});

describe('retrieveModel', () => {
  it('short-circuits when the model directory and completion marker both exist', async () => {
    const cacheDir = join(tmp, 'cache');
    const modelDir = join(cacheDir, 'fast-all-MiniLM-L6-v2');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, COMPLETION_SENTINEL), '');
    const fetchImpl = vi.fn();
    const result = await retrieveModel('fast-all-MiniLM-L6-v2', cacheDir, false, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBe(modelDir);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redownloads when the model directory exists but the completion marker is missing', async () => {
    const cacheDir = join(tmp, 'cache');
    const modelDir = join(cacheDir, 'fast-all-MiniLM-L6-v2');
    // Simulate a partial extract: directory exists, model.onnx is truncated, no marker.
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'model.onnx'), 'truncated-bytes');

    const fetchImpl = makeFetch(200, Buffer.from('fresh-tarball-content'));
    const extract = vi.fn(async ({ cwd }: { file: string; cwd: string }) => {
      mkdirSync(join(cwd, 'fast-all-MiniLM-L6-v2'), { recursive: true });
      writeFileSync(join(cwd, 'fast-all-MiniLM-L6-v2', 'model.onnx'), 'full-good-bytes');
    });

    const result = await retrieveModel('fast-all-MiniLM-L6-v2', cacheDir, false, {
      fetchImpl,
      extract: extract as unknown as Parameters<typeof retrieveModel>[3]['extract'],
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledOnce();
    expect(result).toBe(modelDir);
    expect(existsSync(join(modelDir, COMPLETION_SENTINEL))).toBe(true);
  });

  it('writes the completion marker after a successful download+extract', async () => {
    const cacheDir = join(tmp, 'cache');
    const fetchImpl = makeFetch(200, Buffer.from('fake-tarball-content'));
    const extract = vi.fn(async ({ cwd }: { file: string; cwd: string }) => {
      mkdirSync(join(cwd, 'fast-all-MiniLM-L6-v2'), { recursive: true });
      writeFileSync(join(cwd, 'fast-all-MiniLM-L6-v2', 'model.onnx'), '');
    });

    const modelDir = await retrieveModel('fast-all-MiniLM-L6-v2', cacheDir, false, {
      fetchImpl,
      extract: extract as unknown as Parameters<typeof retrieveModel>[3]['extract'],
    });

    expect(existsSync(join(modelDir, COMPLETION_SENTINEL))).toBe(true);
  });

  it('downloads the AllMiniLM tarball from the sentence-transformers slug', async () => {
    const cacheDir = join(tmp, 'cache');
    const fetchImpl = makeFetch(200, Buffer.from('fake-tarball-content'));
    const extract = vi.fn(async ({ cwd }: { file: string; cwd: string }) => {
      // Simulate successful extraction by creating the model dir with files.
      mkdirSync(join(cwd, 'fast-all-MiniLM-L6-v2'), { recursive: true });
      writeFileSync(join(cwd, 'fast-all-MiniLM-L6-v2', 'model.onnx'), '');
    });

    const modelDir = await retrieveModel('fast-all-MiniLM-L6-v2', cacheDir, false, {
      fetchImpl,
      extract: extract as unknown as Parameters<typeof retrieveModel>[3]['extract'],
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://storage.googleapis.com/qdrant-fastembed/sentence-transformers-all-MiniLM-L6-v2.tar.gz',
    );
    expect(extract).toHaveBeenCalled();
    expect(modelDir).toBe(join(cacheDir, 'fast-all-MiniLM-L6-v2'));
  });

  it('uses the verbatim model name as the URL slug for non-AllMiniLM models', async () => {
    const cacheDir = join(tmp, 'cache');
    const fetchImpl = makeFetch(200, Buffer.from('fake'));
    const extract = vi.fn(async ({ cwd }: { file: string; cwd: string }) => {
      mkdirSync(join(cwd, 'fast-bge-small-en-v1.5'), { recursive: true });
    });

    await retrieveModel('fast-bge-small-en-v1.5', cacheDir, false, {
      fetchImpl,
      extract: extract as unknown as Parameters<typeof retrieveModel>[3]['extract'],
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://storage.googleapis.com/qdrant-fastembed/fast-bge-small-en-v1.5.tar.gz',
    );
  });

  it('throws a descriptive error when the GCS fetch returns non-2xx', async () => {
    const cacheDir = join(tmp, 'cache');
    const fetchImpl = makeFetch(404, null);
    await expect(
      retrieveModel('fast-all-MiniLM-L6-v2', cacheDir, false, { fetchImpl }),
    ).rejects.toThrow(/GET .* → 404/);
  });

  it('reports a corrupt tarball when extraction does not produce the model dir', async () => {
    const cacheDir = join(tmp, 'cache');
    const fetchImpl = makeFetch(200, Buffer.from('not-actually-a-tarball'));
    const extract = vi.fn(async () => {
      // Extraction "succeeds" but creates nothing — simulates a malformed archive.
    });
    await expect(
      retrieveModel('fast-all-MiniLM-L6-v2', cacheDir, false, {
        fetchImpl,
        extract: extract as unknown as Parameters<typeof retrieveModel>[3]['extract'],
      }),
    ).rejects.toThrow(/extracted but .* is missing/);
  });

  it('retries on transient 5xx then succeeds (issue #1021 cold-fetch)', async () => {
    const cacheDir = join(tmp, 'cache');
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 3) {
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          body: null,
          headers: { get: () => null },
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: Readable.toWeb(Readable.from(Buffer.from('ok'))) as ReadableStream<Uint8Array>,
        headers: { get: () => null },
      };
    }) as unknown as typeof fetch;
    const extract = vi.fn(async ({ cwd }: { file: string; cwd: string }) => {
      mkdirSync(join(cwd, 'fast-all-MiniLM-L6-v2'), { recursive: true });
    });

    const modelDir = await retrieveModel('fast-all-MiniLM-L6-v2', cacheDir, false, {
      fetchImpl,
      extract: extract as unknown as Parameters<typeof retrieveModel>[3]['extract'],
    });

    expect(calls).toBe(3);
    expect(existsSync(join(modelDir, COMPLETION_SENTINEL))).toBe(true);
  });

  it('does NOT retry on a 4xx (deterministic, retry would be wasted)', async () => {
    const cacheDir = join(tmp, 'cache');
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      body: null,
      headers: { get: () => null },
    })) as unknown as typeof fetch;

    await expect(
      retrieveModel('fast-all-MiniLM-L6-v2', cacheDir, false, { fetchImpl }),
    ).rejects.toThrow(/404/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent retrievers — only one process performs the download', async () => {
    const cacheDir = join(tmp, 'cache');
    let extractCalls = 0;
    let fetchCalls = 0;
    const fetchImpl = vi.fn(async () => {
      fetchCalls++;
      // Stretch the response so concurrent callers definitely overlap.
      await new Promise(r => setTimeout(r, 50));
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: Readable.toWeb(Readable.from(Buffer.from('tarball'))) as ReadableStream<Uint8Array>,
        headers: { get: () => null },
      };
    }) as unknown as typeof fetch;
    const extract = vi.fn(async ({ cwd }: { file: string; cwd: string }) => {
      extractCalls++;
      mkdirSync(join(cwd, 'fast-all-MiniLM-L6-v2'), { recursive: true });
    });

    const results = await Promise.all([
      retrieveModel('fast-all-MiniLM-L6-v2', cacheDir, false, {
        fetchImpl,
        extract: extract as unknown as Parameters<typeof retrieveModel>[3]['extract'],
      }),
      retrieveModel('fast-all-MiniLM-L6-v2', cacheDir, false, {
        fetchImpl,
        extract: extract as unknown as Parameters<typeof retrieveModel>[3]['extract'],
      }),
      retrieveModel('fast-all-MiniLM-L6-v2', cacheDir, false, {
        fetchImpl,
        extract: extract as unknown as Parameters<typeof retrieveModel>[3]['extract'],
      }),
    ]);

    expect(results.every(r => r === results[0])).toBe(true);
    expect(fetchCalls).toBe(1);
    expect(extractCalls).toBe(1);
    expect(existsSync(join(results[0], COMPLETION_SENTINEL))).toBe(true);
  });
});
