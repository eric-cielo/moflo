/**
 * Tests for FastembedEmbeddingService
 *
 * Most tests inject a mock `fastembed` module via constructor DI so they run
 * offline without downloading the ~90 MB ONNX model. A single integration test
 * (guarded by `FASTEMBED_INTEGRATION=1`) exercises the real model to verify
 * dimension parity with `TransformersEmbeddingService`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FastembedEmbeddingService,
  type FastembedModule,
} from '../src/fastembed-embedding-service.js';

const DIM = 384;

function makeVector(seed: number): number[] {
  const vec = new Array<number>(DIM);
  for (let i = 0; i < DIM; i++) {
    vec[i] = Math.sin(seed * 31 + i) * 0.5;
  }
  return vec;
}

type MockModel = {
  embed: ReturnType<typeof vi.fn>;
  queryEmbed: ReturnType<typeof vi.fn>;
};

function createMockModel(): MockModel {
  return {
    queryEmbed: vi.fn(async (text: string) => makeVector(text.length)),
    embed: vi.fn(async function* (texts: string[], _batchSize?: number) {
      // Stamp index into slot 0 so ordering is directly observable in assertions.
      yield texts.map((t, i) => {
        const v = makeVector(t.length + i);
        v[0] = i;
        return v;
      });
    }),
  };
}

describe('FastembedEmbeddingService', () => {
  let mockModel: MockModel;
  let initSpy: ReturnType<typeof vi.fn>;
  let loadModule: () => Promise<FastembedModule>;

  beforeEach(() => {
    // FASTEMBED_CACHE is read as a cacheDir fallback in production; clear it
    // so init-arg assertions are deterministic regardless of host env.
    vi.stubEnv('FASTEMBED_CACHE', '');
    mockModel = createMockModel();
    initSpy = vi.fn(async () => mockModel);
    loadModule = async () => ({
      EmbeddingModel: { AllMiniLML6V2: 'fast-all-MiniLM-L6-v2' },
      FlagEmbedding: { init: initSpy } as unknown as FastembedModule['FlagEmbedding'],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('init', () => {
    it('constructs without throwing and defers fastembed load', () => {
      const service = new FastembedEmbeddingService({ provider: 'fastembed' }, { loadModule });
      expect(service.provider).toBe('fastembed');
      expect(initSpy).not.toHaveBeenCalled();
    });

    it('defaults model to EmbeddingModel.AllMiniLML6V2 when none provided', async () => {
      const service = new FastembedEmbeddingService({ provider: 'fastembed' }, { loadModule });
      await service.embed('warm up');

      expect(initSpy).toHaveBeenCalledTimes(1);
      expect(initSpy).toHaveBeenCalledWith({
        model: 'fast-all-MiniLM-L6-v2',
        showDownloadProgress: false,
      });
    });

    it('passes configured options through to FlagEmbedding.init', async () => {
      const service = new FastembedEmbeddingService(
        {
          provider: 'fastembed',
          model: 'fast-bge-small-en-v1.5',
          cacheDir: '/tmp/fe-cache',
          maxLength: 256,
          showDownloadProgress: true,
        },
        { loadModule },
      );
      await service.embed('warm up');

      expect(initSpy).toHaveBeenCalledWith({
        model: 'fast-bge-small-en-v1.5',
        cacheDir: '/tmp/fe-cache',
        maxLength: 256,
        showDownloadProgress: true,
      });
    });

    describe('FASTEMBED_CACHE env var fallback', () => {
      it('uses FASTEMBED_CACHE as cacheDir when config omits cacheDir', async () => {
        vi.stubEnv('FASTEMBED_CACHE', '/opt/fastembed-cache');
        const service = new FastembedEmbeddingService({ provider: 'fastembed' }, { loadModule });
        await service.embed('warm up');

        expect(initSpy).toHaveBeenCalledWith({
          model: 'fast-all-MiniLM-L6-v2',
          cacheDir: '/opt/fastembed-cache',
          showDownloadProgress: false,
        });
      });

      it('explicit config.cacheDir wins over FASTEMBED_CACHE', async () => {
        vi.stubEnv('FASTEMBED_CACHE', '/opt/fastembed-cache');
        const service = new FastembedEmbeddingService(
          { provider: 'fastembed', cacheDir: '/tmp/explicit' },
          { loadModule },
        );
        await service.embed('warm up');

        expect(initSpy).toHaveBeenCalledWith(
          expect.objectContaining({ cacheDir: '/tmp/explicit' }),
        );
      });

      it('ignores empty FASTEMBED_CACHE and lets fastembed default win', async () => {
        const service = new FastembedEmbeddingService({ provider: 'fastembed' }, { loadModule });
        await service.embed('warm up');

        expect(initSpy).toHaveBeenCalledWith({
          model: 'fast-all-MiniLM-L6-v2',
          showDownloadProgress: false,
        });
      });
    });
  });

  describe('init failure', () => {
    it('surfaces the inner cause when loadModule throws', async () => {
      const failingLoad = async () => {
        throw new Error('cache write denied');
      };
      const service = new FastembedEmbeddingService(
        { provider: 'fastembed' },
        { loadModule: failingLoad },
      );

      await expect(service.embed('x')).rejects.toThrow(
        /Failed to initialize fastembed:.*cache write denied/,
      );
    });

    it('rejects both embed() and embedBatch() when init failed', async () => {
      const failingLoad = async () => {
        throw new Error('model file missing');
      };
      const service = new FastembedEmbeddingService(
        { provider: 'fastembed' },
        { loadModule: failingLoad },
      );

      await expect(service.embed('x')).rejects.toThrow(/model file missing/);
      await expect(service.embedBatch(['a', 'b'])).rejects.toThrow(/model file missing/);
    });

    it('recovers on retry when the loader succeeds the second time', async () => {
      const flakyLoad = vi
        .fn<() => Promise<FastembedModule>>()
        .mockRejectedValueOnce(new Error('transient network'))
        .mockImplementation(loadModule);
      const service = new FastembedEmbeddingService(
        { provider: 'fastembed' },
        { loadModule: flakyLoad },
      );

      await expect(service.embed('x')).rejects.toThrow(/transient network/);

      const result = await service.embed('x');
      expect(result.embedding).toBeInstanceOf(Float32Array);
      expect(result.embedding.length).toBe(DIM);
      expect(flakyLoad).toHaveBeenCalledTimes(2);
    });
  });

  describe('single embed', () => {
    it('returns Float32Array of length 384', async () => {
      const service = new FastembedEmbeddingService({ provider: 'fastembed' }, { loadModule });
      const result = await service.embed('hello world');

      expect(result.embedding).toBeInstanceOf(Float32Array);
      expect(result.embedding.length).toBe(DIM);
      expect(mockModel.queryEmbed).toHaveBeenCalledOnce();
      expect(mockModel.queryEmbed).toHaveBeenCalledWith('hello world');
    });
  });

  describe('batch embed', () => {
    it('returns embeddings for all inputs in original order', async () => {
      const service = new FastembedEmbeddingService({ provider: 'fastembed' }, { loadModule });
      const texts = ['a', 'bb', 'ccc'];
      const result = await service.embedBatch(texts);

      expect(result.embeddings).toHaveLength(3);
      result.embeddings.forEach(emb => {
        expect(emb).toBeInstanceOf(Float32Array);
        expect(emb.length).toBe(DIM);
      });

      // The mock stamps the source index into slot 0, so order is directly verifiable.
      expect((result.embeddings[0] as Float32Array)[0]).toBe(0);
      expect((result.embeddings[1] as Float32Array)[0]).toBe(1);
      expect((result.embeddings[2] as Float32Array)[0]).toBe(2);
      expect(result.cacheStats).toEqual({ hits: 0, misses: 3 });
    });

    it('reuses cached entries and only fetches the uncached subset', async () => {
      const service = new FastembedEmbeddingService({ provider: 'fastembed' }, { loadModule });
      await service.embed('a');
      mockModel.embed.mockClear();

      const result = await service.embedBatch(['a', 'b', 'c']);
      expect(result.cacheStats).toEqual({ hits: 1, misses: 2 });
      expect(mockModel.embed).toHaveBeenCalledOnce();
      const [batchTexts] = mockModel.embed.mock.calls[0];
      expect(batchTexts).toEqual(['b', 'c']);
    });
  });

  describe('cache hit', () => {
    it('marks second call as cached without invoking the model again', async () => {
      const service = new FastembedEmbeddingService({ provider: 'fastembed' }, { loadModule });
      const first = await service.embed('hello');
      const second = await service.embed('hello');

      expect(first.cached).toBeUndefined();
      expect(second.cached).toBe(true);
      expect(second.latencyMs).toBe(0);
      expect(mockModel.queryEmbed).toHaveBeenCalledOnce();
    });
  });

  describe('shutdown', () => {
    it('clears cache, nulls model, and forces re-init on next embed', async () => {
      const service = new FastembedEmbeddingService({ provider: 'fastembed' }, { loadModule });
      await service.embed('hello');
      expect(service.getCacheStats().size).toBe(1);
      expect(initSpy).toHaveBeenCalledTimes(1);

      await service.shutdown();
      expect(service.getCacheStats().size).toBe(0);

      await service.embed('hello again');
      expect(initSpy).toHaveBeenCalledTimes(2);
    });
  });
});

describe.skipIf(process.env.FASTEMBED_INTEGRATION !== '1')(
  'FastembedEmbeddingService (integration)',
  () => {
    it('loads the real all-MiniLM-L6-v2 model and produces 384-dim vectors', async () => {
      const service = new FastembedEmbeddingService({ provider: 'fastembed' });
      const result = await service.embed('integration test');
      expect(result.embedding).toBeInstanceOf(Float32Array);
      expect(result.embedding.length).toBe(DIM);
      await service.shutdown();
    }, 300_000);
  },
);
