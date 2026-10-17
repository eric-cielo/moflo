/**
 * Model loader — fetches a model's ONNX bundle into a per-model cache
 * directory. Cache layout matches `fastembed-js` exactly so existing
 * `FASTEMBED_CACHE` directories stay valid.
 *
 * Sources, tried in order:
 *
 * 1. **Hugging Face**, for models listed in `HF_SOURCES` — each file fetched
 *    individually from a pinned revision, `model.onnx` checked against its
 *    sha256. Qdrant's GCS bucket began answering 403 to every request, so
 *    this is the source that works today.
 * 2. **Qdrant's GCS bucket** (the source `fastembed-js` uses) — a single
 *    tarball at `https://storage.googleapis.com/qdrant-fastembed/<slug>.tar.gz`.
 *    For `fast-all-MiniLM-L6-v2` the slug is `sentence-transformers-all-MiniLM-L6-v2`
 *    but the on-disk directory keeps the `fast-` prefix — verbatim from upstream.
 *
 * Concurrency: a per-model file lock (`<cacheDir>/.<model>.download.lock`,
 * created with `wx`) serializes the download/extract for any number of
 * parallel processes — only one process performs the work, the rest poll for
 * the completion sentinel. This was issue #1021's secondary failure mode:
 * the smoke harness spawns ~12 parallel doctor + memory probes on a cold
 * cache, and Windows file locking exposed the race when the in-tree
 * "synchronization point" was just a shared directory write.
 */
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { x as tarExtract } from 'tar';

const GCS_BASE_URL = 'https://storage.googleapis.com/qdrant-fastembed';
const HF_BASE_URL = 'https://huggingface.co';

export interface HfSource {
  repo: string;
  /** A commit sha, never a branch — the bytes must not move under us. */
  revision: string;
  files: readonly string[];
  /** Per-file sha256 checks; a mismatch fails this source. */
  sha256: Readonly<Record<string, string>>;
  /** Fields written over the repo's `tokenizer_config.json` after download. */
  tokenizerConfig?: Readonly<Record<string, unknown>>;
}

/**
 * Hugging Face mirrors of the GCS bundles. `model.onnx`, `vocab.txt`,
 * `config.json` and `special_tokens_map.json` are byte-identical to the GCS
 * tarball. The repo's tokenizer config caps `model_max_length` at 256 where
 * the tarball said 512, and the tokenizer truncates at the smaller of that
 * and the requested length — so it is pinned back to 512, or chunks over 256
 * tokens would embed differently from vectors already in every index.
 */
export const HF_SOURCES: Readonly<Record<string, HfSource>> = {
  'fast-all-MiniLM-L6-v2': {
    repo: 'Qdrant/all-MiniLM-L6-v2-onnx',
    revision: 'd13954661f83248295ba75c1ed411eef3b7b936e',
    files: [
      'model.onnx',
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'special_tokens_map.json',
      'vocab.txt',
    ],
    sha256: {
      'model.onnx': 'bbd7b466f6d58e646fdc2bd5fd67b2f5e93c0b687011bd4548c420f7bd46f0c5',
    },
    tokenizerConfig: { model_max_length: 512 },
  },
};

// Lock-poll: how long a non-holder waits for the holder to finish before
// concluding the holder crashed. Cold-fetch is ~90 MB on slow CI runners, so
// a generous timeout avoids false takeovers under network back-pressure.
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_POLL_INTERVAL_MS = 250;

// Standard transient-error retry per feedback_transient_retry_circuit_breaker.md:
// 50/200/800ms backoff, only on network errors and 5xx (4xx is deterministic).
const HTTP_BACKOFF_MS = [50, 200, 800] as const;

/**
 * Sentinel file written into the model directory only after the tarball has
 * been fully downloaded AND extracted. Cache hits without it are treated as
 * incomplete (interrupted download, partial extract, OS reboot mid-write) —
 * the model dir is wiped and redownloaded. The `-v1` suffix lets us bump
 * the format if the cache layout ever changes.
 */
export const COMPLETION_SENTINEL = '.moflo-fastembed-complete-v1';

/**
 * Maps fastembed's on-disk model identifier to the GCS tarball slug. Most
 * models use the same slug; AllMiniLM is the only documented exception in
 * upstream's `downloadFileFromGCS`.
 */
function gcsSlugFor(model: string): string {
  if (model === 'fast-all-MiniLM-L6-v2') {
    return 'sentence-transformers-all-MiniLM-L6-v2';
  }
  return model;
}

/**
 * Resolution order matches `FastembedEmbeddingConfig.cacheDir` docs:
 * explicit arg > FASTEMBED_CACHE env > `~/.cache/fastembed/`.
 *
 * Fastembed-js itself defaults to a CWD-relative `"local_cache"`, which
 * scatters caches across whatever directory `flo` was launched from. We
 * upgrade the default to the standard XDG-style location; users with
 * FASTEMBED_CACHE already set are unaffected.
 */
export function resolveCacheDir(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return explicit ?? env.FASTEMBED_CACHE ?? join(homedir(), '.cache', 'fastembed');
}

export interface DownloadDeps {
  fetchImpl?: typeof fetch;
  extract?: typeof tarExtract;
  /** Overrides `HF_SOURCES` (tests supply a source whose hashes they control). */
  hfSources?: Readonly<Record<string, HfSource>>;
}

class TransientHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientHttpError';
  }
}

/**
 * Stream a file to a unique temp path, then atomic-rename to the final path.
 * The temp suffix prevents the in-flight write stream from being observed at
 * the final path — readers always see a complete file.
 *
 * Throws `TransientHttpError` on 5xx / network failure (caller retries) and
 * a plain Error on 4xx (caller fails fast — retrying won't help).
 */
async function downloadFile(
  url: string,
  destPath: string,
  showProgress: boolean,
  deps: DownloadDeps,
): Promise<void> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const tmpPath = `${destPath}.${process.pid}.tmp`;
  mkdirSync(dirname(destPath), { recursive: true });

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetchFn(url);
  } catch (err) {
    throw new TransientHttpError(`Model download failed: GET ${url} → ${(err as Error).message}`);
  }
  if (!res.ok || !res.body) {
    const msg = `Model download failed: GET ${url} → ${res.status} ${res.statusText}`;
    if (res.status >= 500) throw new TransientHttpError(msg);
    throw new Error(msg);
  }

  if (showProgress) {
    const total = Number(res.headers.get('content-length') ?? 0);
    const totalMb = (total / (1024 * 1024)).toFixed(1);
    process.stderr.write(`fastembed: downloading ${totalMb} MB from ${url}\n`);
  }

  try {
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      createWriteStream(tmpPath),
    );
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw new TransientHttpError(
      `Model download stream failed mid-transfer (${url}): ${(err as Error).message}`,
    );
  }
  renameSync(tmpPath, destPath);
}

async function downloadFileWithRetry(
  url: string,
  destPath: string,
  showProgress: boolean,
  deps: DownloadDeps,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= HTTP_BACKOFF_MS.length; attempt++) {
    try {
      await downloadFile(url, destPath, showProgress, deps);
      return;
    } catch (err) {
      lastErr = err;
      if (!(err instanceof TransientHttpError) || attempt === HTTP_BACKOFF_MS.length) break;
      if (showProgress) {
        process.stderr.write(
          `fastembed: download attempt ${attempt + 1} failed (${(err as Error).message}); retrying in ${HTTP_BACKOFF_MS[attempt]}ms.\n`,
        );
      }
      await delay(HTTP_BACKOFF_MS[attempt]);
    }
  }
  throw lastErr;
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * Fetch every file of `source` into `stagingDir`, verify the pinned hashes,
 * then apply the tokenizer-config overrides. The caller renames the staging
 * dir into place, so a half-finished fetch never looks like a model dir.
 */
async function fetchFromHuggingFace(
  source: HfSource,
  stagingDir: string,
  showProgress: boolean,
  deps: DownloadDeps,
): Promise<void> {
  mkdirSync(stagingDir, { recursive: true });
  for (const file of source.files) {
    const dest = join(stagingDir, file);
    await downloadFileWithRetry(
      `${HF_BASE_URL}/${source.repo}/resolve/${source.revision}/${file}`,
      dest,
      showProgress,
      deps,
    );
    const expected = source.sha256[file];
    if (expected) {
      const actual = await sha256Of(dest);
      if (actual !== expected) {
        throw new Error(`${file} from ${source.repo} failed its sha256 check (expected ${expected}, got ${actual}).`);
      }
    }
  }
  if (source.tokenizerConfig) {
    if (!source.files.includes('tokenizer_config.json')) {
      throw new Error(`${source.repo} overrides tokenizer_config.json but does not download it.`);
    }
    const path = join(stagingDir, 'tokenizer_config.json');
    const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...config, ...source.tokenizerConfig }, null, 2));
  }
}

async function fetchFromGcs(
  model: string,
  cacheDir: string,
  modelDir: string,
  showProgress: boolean,
  deps: DownloadDeps,
): Promise<void> {
  const tarballPath = join(cacheDir, `${model}.tar.gz`);
  const url = `${GCS_BASE_URL}/${gcsSlugFor(model)}.tar.gz`;
  await downloadFileWithRetry(url, tarballPath, showProgress, deps);
  const extract = deps.extract ?? tarExtract;
  await extract({ file: tarballPath, cwd: cacheDir });
  rmSync(tarballPath, { force: true });
  if (!existsSync(modelDir)) {
    throw new Error(`Model archive extracted but ${modelDir} is missing — corrupt tarball?`);
  }
}

/**
 * Cross-process serialization for the download/extract step. Lock holder runs
 * `work`; non-holders poll for the completion sentinel and return as soon as
 * it appears. If the lock holder crashes (lockfile remains but no sentinel
 * after the timeout), the next caller cleans up and retries — preventing a
 * permanently-stuck cache after a Ctrl+C mid-download.
 */
async function withModelLock(
  lockPath: string,
  completionPath: string,
  work: () => Promise<void>,
): Promise<void> {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    await waitForCompletionOrTakeover(lockPath, completionPath, work);
    return;
  }
  try {
    await work();
  } finally {
    try { rmSync(lockPath, { force: true }); } catch { /* best effort */ }
  }
}

async function waitForCompletionOrTakeover(
  lockPath: string,
  completionPath: string,
  work: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(completionPath)) return;
    if (!existsSync(lockPath)) {
      // Holder finished without writing the sentinel (crashed). Try to take
      // over the lock ourselves.
      await withModelLock(lockPath, completionPath, work);
      return;
    }
    await delay(LOCK_POLL_INTERVAL_MS);
  }
  // Stale lock — clear it and let the next caller (or our own retry above)
  // pick up the work. Force unlinking is safer than leaving the cache
  // permanently wedged.
  try { rmSync(lockPath, { force: true }); } catch { /* best effort */ }
  throw new Error(
    `fastembed: timed out after ${LOCK_TIMEOUT_MS}ms waiting for ${lockPath}. ` +
    `Stale lock cleared — retry the operation.`,
  );
}

/**
 * Ensure the per-model directory exists in the cache. Returns the absolute
 * path. If already present AND the completion sentinel is in place, no
 * network/disk work happens — this is the hot path for every embed call
 * after first run.
 *
 * If the directory exists without a sentinel, a prior download was
 * interrupted (Ctrl+C, network drop, OS reboot during extract). The dir
 * is wiped and redownloaded — otherwise truncated files like a 4.7 MB
 * `model.onnx` (real is ~22 MB) silently slip through to ORT and blow up
 * with an opaque "Protobuf parsing failed" at session-creation time.
 */
export async function retrieveModel(
  model: string,
  cacheDir: string,
  showProgress: boolean,
  deps: DownloadDeps = {},
): Promise<string> {
  const modelDir = join(cacheDir, model);
  const completionPath = join(modelDir, COMPLETION_SENTINEL);

  // Fast path: complete cache hit needs no lock, no fs writes.
  if (existsSync(completionPath)) return modelDir;

  mkdirSync(cacheDir, { recursive: true });
  const lockPath = join(cacheDir, `.${model}.download.lock`);

  await withModelLock(lockPath, completionPath, async () => {
    // Re-check inside the lock — another process may have completed the
    // download between our fast-path check and our lock acquisition.
    if (existsSync(completionPath)) return;

    if (existsSync(modelDir)) {
      if (showProgress) {
        process.stderr.write(
          `fastembed: cached model at ${modelDir} is incomplete (no completion marker); redownloading.\n`,
        );
      }
      rmSync(modelDir, { recursive: true, force: true });
    }

    const hf = (deps.hfSources ?? HF_SOURCES)[model];
    let hfError: Error | undefined;
    if (hf) {
      // One fixed name, safe because only the lock holder gets here — and it
      // clears whatever a crashed holder left behind.
      const stagingDir = join(cacheDir, `.${model}.staging`);
      try {
        rmSync(stagingDir, { recursive: true, force: true });
        await fetchFromHuggingFace(hf, stagingDir, showProgress, deps);
        renameSync(stagingDir, modelDir);
      } catch (err) {
        hfError = err as Error;
        if (showProgress) {
          process.stderr.write(
            `fastembed: Hugging Face download failed (${hfError.message}); trying the fastembed bucket.\n`,
          );
        }
      } finally {
        rmSync(stagingDir, { recursive: true, force: true });
      }
    }

    if (!existsSync(modelDir)) {
      try {
        await fetchFromGcs(model, cacheDir, modelDir, showProgress, deps);
      } catch (err) {
        if (!hfError) throw err;
        throw new Error(
          `Could not download embedding model ${model}. ` +
          `Hugging Face: ${hfError.message}; fastembed bucket: ${(err as Error).message}`,
        );
      }
    }
    writeFileSync(completionPath, '');
  });

  return modelDir;
}
