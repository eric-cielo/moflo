/**
 * Model loader — downloads pre-packaged ONNX bundles from Qdrant's GCS bucket
 * (the same source `fastembed-js` uses) and extracts them into a per-model
 * cache directory. Cache layout matches `fastembed-js` exactly so existing
 * `FASTEMBED_CACHE` directories stay valid.
 *
 * URL convention: `https://storage.googleapis.com/qdrant-fastembed/<urlName>.tar.gz`
 * For `fast-all-MiniLM-L6-v2`, the URL slug is `sentence-transformers-all-MiniLM-L6-v2`
 * but the on-disk directory keeps the `fast-` prefix — verbatim from upstream.
 *
 * Concurrency: a per-model file lock (`<cacheDir>/.<model>.download.lock`,
 * created with `wx`) serializes the download/extract for any number of
 * parallel processes — only one process performs the work, the rest poll for
 * the completion sentinel. This was issue #1021's secondary failure mode:
 * the smoke harness spawns ~12 parallel doctor + memory probes on a cold
 * cache, and Windows file locking exposed the race when the in-tree
 * "synchronization point" was just a shared directory write.
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
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
}

class TransientHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientHttpError';
  }
}

/**
 * Stream the tarball to a unique temp path, then atomic-rename to the final
 * tarball path before extracting. The temp suffix prevents the in-flight
 * write stream from being observed at the final path — extraction always
 * sees a complete file.
 *
 * Throws `TransientHttpError` on 5xx / network failure (caller retries) and
 * a plain Error on 4xx (caller fails fast — retrying won't help).
 */
async function downloadTarball(
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

async function downloadTarballWithRetry(
  url: string,
  destPath: string,
  showProgress: boolean,
  deps: DownloadDeps,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= HTTP_BACKOFF_MS.length; attempt++) {
    try {
      await downloadTarball(url, destPath, showProgress, deps);
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
  const tarballPath = join(cacheDir, `${model}.tar.gz`);
  const url = `${GCS_BASE_URL}/${gcsSlugFor(model)}.tar.gz`;

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

    await downloadTarballWithRetry(url, tarballPath, showProgress, deps);
    const extract = deps.extract ?? tarExtract;
    await extract({ file: tarballPath, cwd: cacheDir });
    rmSync(tarballPath, { force: true });

    if (!existsSync(modelDir)) {
      throw new Error(`Model archive extracted but ${modelDir} is missing — corrupt tarball?`);
    }
    writeFileSync(completionPath, '');
  });

  return modelDir;
}
