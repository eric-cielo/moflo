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
 * Concurrency: parallel callers downloading the same model atomic-rename the
 * tarball through a unique temp path, so Windows file locks during extraction
 * never collide. The final model dir is the synchronization point.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { x as tarExtract } from 'tar';

const GCS_BASE_URL = 'https://storage.googleapis.com/qdrant-fastembed';

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

/**
 * Stream the tarball to a unique temp path, then atomic-rename to the final
 * tarball path before extracting. The temp suffix prevents two concurrent
 * downloads from clobbering each other's write stream — extraction itself is
 * the slow step on Windows where file-lock contention shows up.
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

  const res = await fetchFn(url);
  if (!res.ok || !res.body) {
    throw new Error(`Model download failed: GET ${url} → ${res.status} ${res.statusText}`);
  }

  if (showProgress) {
    const total = Number(res.headers.get('content-length') ?? 0);
    const totalMb = (total / (1024 * 1024)).toFixed(1);
    process.stderr.write(`fastembed: downloading ${totalMb} MB from ${url}\n`);
  }

  await pipeline(
    Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
    createWriteStream(tmpPath),
  );
  renameSync(tmpPath, destPath);
}

/**
 * Ensure the per-model directory exists in the cache. Returns the absolute
 * path. If already present, no network/disk work happens — this is the hot
 * path for every embed call after first run.
 */
export async function retrieveModel(
  model: string,
  cacheDir: string,
  showProgress: boolean,
  deps: DownloadDeps = {},
): Promise<string> {
  const modelDir = join(cacheDir, model);
  if (existsSync(modelDir)) return modelDir;

  mkdirSync(cacheDir, { recursive: true });
  const tarballPath = join(cacheDir, `${model}.tar.gz`);
  const url = `${GCS_BASE_URL}/${gcsSlugFor(model)}.tar.gz`;

  await downloadTarball(url, tarballPath, showProgress, deps);
  const extract = deps.extract ?? tarExtract;
  await extract({ file: tarballPath, cwd: cacheDir });
  rmSync(tarballPath, { force: true });

  if (!existsSync(modelDir)) {
    throw new Error(`Model archive extracted but ${modelDir} is missing — corrupt tarball?`);
  }
  return modelDir;
}
