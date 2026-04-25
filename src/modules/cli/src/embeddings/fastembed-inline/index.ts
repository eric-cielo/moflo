/**
 * In-tree replacement for the `fastembed` npm package.
 *
 * Why this exists: `fastembed@2.1.0` exact-pins `onnxruntime-node@1.21.0`,
 * which crashes on macOS process exit with a libc++ mutex teardown bug fixed
 * upstream in ORT 1.24.1+ (microsoft/onnxruntime#24579). Owning the ORT
 * dependency directly lets us track the fix without postinstall surgery —
 * see issue #613 for the full chain of constraints.
 *
 * Public surface mirrors fastembed-js exactly so `fastembed-embedding-service.ts`
 * continues to consume it as `import('fastembed')` via a swappable loader.
 * Implementation port is line-for-line faithful to fastembed-js's `FlagEmbedding`
 * (only the `AllMiniLML6V2` model path is supported — the only one we ship).
 *
 * Embedding shape note: this preserves fastembed's CLS-token + L2-normalize
 * extraction (the mean-pool block is commented out in upstream — see
 * https://github.com/qdrant/fastembed/commit/a335c8898f11042fdb311fce2dab3acf50c23011).
 * Output is byte-identical to the previous fastembed run; no embedding
 * migration is required for existing stored vectors.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AddedToken, Tokenizer } from '@anush008/tokenizers';
import { InferenceSession, Tensor } from 'onnxruntime-node';

import { resolveCacheDir, retrieveModel, type DownloadDeps } from './model-loader.js';

export const EmbeddingModel = {
  AllMiniLML6V2: 'fast-all-MiniLM-L6-v2',
} as const;

export type EmbeddingModelName = (typeof EmbeddingModel)[keyof typeof EmbeddingModel];

export interface FlagEmbeddingInitOptions {
  model?: string;
  cacheDir?: string;
  maxLength?: number;
  showDownloadProgress?: boolean;
}

interface AddedTokenSpec {
  content: string;
  single_word: boolean;
  lstrip: boolean;
  rstrip: boolean;
  normalized: boolean;
}

function isAddedTokenSpec(value: unknown): value is AddedTokenSpec {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    'single_word' in value &&
    'lstrip' in value &&
    'rstrip' in value &&
    'normalized' in value
  );
}

function readJson<T>(path: string, label: string): T {
  if (!existsSync(path)) throw new Error(`${label} not found at ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * Configure a `Tokenizer` instance to match fastembed-js's setup exactly:
 * truncation + padding to a single uniform `maxLength`, then merge in
 * special tokens declared by `special_tokens_map.json`.
 *
 * Truncation/padding to a fixed length means every batch produces tensors
 * of identical shape `[batch, maxLength]` — the embed loop relies on this.
 */
function loadTokenizer(modelDir: string, requestedMaxLength: number): Tokenizer {
  const config = readJson<{ pad_token_id: number }>(join(modelDir, 'config.json'), 'config.json');
  const tokenizerConfig = readJson<{ pad_token: string; model_max_length: number }>(
    join(modelDir, 'tokenizer_config.json'),
    'tokenizer_config.json',
  );
  const tokensMap = readJson<Record<string, unknown>>(
    join(modelDir, 'special_tokens_map.json'),
    'special_tokens_map.json',
  );

  const maxLength = Math.min(requestedMaxLength, tokenizerConfig.model_max_length);
  // `Tokenizer.fromFile` throws on missing file with its own message — no
  // separate existsSync check needed.
  const tokenizer = Tokenizer.fromFile(join(modelDir, 'tokenizer.json'));
  tokenizer.setTruncation(maxLength);
  tokenizer.setPadding({
    maxLength,
    padId: config.pad_token_id,
    padToken: tokenizerConfig.pad_token,
  });

  for (const token of Object.values(tokensMap)) {
    if (typeof token === 'string') {
      tokenizer.addSpecialTokens([token]);
    } else if (isAddedTokenSpec(token)) {
      tokenizer.addAddedTokens([
        new AddedToken(token.content, true, {
          singleWord: token.single_word,
          leftStrip: token.lstrip,
          rightStrip: token.rstrip,
          normalized: token.normalized,
        }),
      ]);
    }
  }
  return tokenizer;
}

/**
 * Normalize a Float32Array view in a single pass and emit a `number[]` so
 * the public generator API stays compatible with fastembed-js's surface.
 * Two passes (sumSq then divide) is unavoidable; what we save is the
 * intermediate `Array.from(slice)` allocation per output row.
 */
function l2NormalizeSlice(view: Float32Array): number[] {
  let sumSq = 0;
  for (let i = 0; i < view.length; i++) sumSq += view[i] * view[i];
  const inv = 1 / Math.max(Math.sqrt(sumSq), 1e-12);
  const out = new Array<number>(view.length);
  for (let i = 0; i < view.length; i++) out[i] = view[i] * inv;
  return out;
}

/**
 * Pack an array of `number[]` token sequences (one per text in a batch) into
 * the contiguous `BigInt64Array` ORT expects for `int64` tensors. Replaces
 * the per-element `BigInt()` map + `Array.from().flat()` chain that allocated
 * O(batch × paddedLen) intermediate arrays per embed call.
 */
function packInt64Batch(rows: number[][], paddedLen: number): BigInt64Array {
  const buf = new BigInt64Array(rows.length * paddedLen);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const base = r * paddedLen;
    for (let i = 0; i < paddedLen; i++) buf[base + i] = BigInt(row[i]);
  }
  return buf;
}

export class FlagEmbedding {
  private constructor(
    private readonly tokenizer: Tokenizer,
    private readonly session: InferenceSession,
  ) {}

  static async init(
    options: FlagEmbeddingInitOptions = {},
    deps: DownloadDeps = {},
  ): Promise<FlagEmbedding> {
    const model = options.model ?? EmbeddingModel.AllMiniLML6V2;
    const cacheDir = resolveCacheDir(options.cacheDir);
    const maxLength = options.maxLength ?? 512;
    const showDownloadProgress = options.showDownloadProgress ?? false;

    const modelDir = await retrieveModel(model, cacheDir, showDownloadProgress, deps);
    const tokenizer = loadTokenizer(modelDir, maxLength);

    const modelPath = join(modelDir, 'model.onnx');
    if (!existsSync(modelPath)) {
      throw new Error(`Model file not found at ${modelPath}`);
    }
    const session = await InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
    return new FlagEmbedding(tokenizer, session);
  }

  /**
   * Yield batches of CLS-pooled, L2-normalized embeddings — one inner array
   * per input text. Tokenizer pads every encoding to the same length, so the
   * batch tensor shape is `[batchSize, paddedLen]` and the model output is
   * `[batchSize, paddedLen, hiddenSize]`. The CLS token is position 0 of
   * each row — extract via `data.subarray(b * seqLen * hiddenSize, … + hiddenSize)`.
   *
   * Uses `encodeBatch` (single NAPI crossing per batch instead of `batchSize`)
   * and packs the int64 tensors via pre-allocated `BigInt64Array` to avoid
   * O(batch × paddedLen) per-element BigInt boxing on the hot path.
   */
  async *embed(
    textStrings: string[],
    batchSize = 256,
  ): AsyncGenerator<number[][], void, unknown> {
    for (let i = 0; i < textStrings.length; i += batchSize) {
      const batch = textStrings.slice(i, i + batchSize);
      const encoded = await this.tokenizer.encodeBatch(batch);

      const ids = encoded.map((e) => e.getIds());
      const masks = encoded.map((e) => e.getAttentionMask());
      const typeIds = encoded.map((e) => e.getTypeIds());
      const paddedLen = ids[0].length;
      const dims: [number, number] = [batch.length, paddedLen];

      const output = await this.session.run({
        input_ids: new Tensor('int64', packInt64Batch(ids, paddedLen), dims),
        attention_mask: new Tensor('int64', packInt64Batch(masks, paddedLen), dims),
        token_type_ids: new Tensor('int64', packInt64Batch(typeIds, paddedLen), dims),
      });

      const hidden = output.last_hidden_state;
      const data = hidden.data as Float32Array;
      const [, seqLen, hiddenSize] = hidden.dims as [number, number, number];

      const out: number[][] = [];
      for (let b = 0; b < batch.length; b++) {
        const start = b * seqLen * hiddenSize;
        out.push(l2NormalizeSlice(data.subarray(start, start + hiddenSize)));
      }
      yield out;
    }
  }

  async queryEmbed(query: string): Promise<number[]> {
    const result = await this.embed([`query: ${query}`]).next();
    if (!result.value || result.value.length === 0) {
      throw new Error('queryEmbed: model produced no output');
    }
    return result.value[0];
  }
}
