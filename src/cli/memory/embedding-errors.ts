/**
 * Friendly formatting for neural-embedding load/inference failures.
 *
 * Classifies the raw error surfaced by `fastembed` (network,
 * cache-permission, corrupted download, generic) and renders a plain-English
 * message with a concrete next step. Stack + raw text are withheld unless
 * verbose output is enabled via `--verbose` or `DEBUG=moflo` /
 * `DEBUG=moflo:*` / `DEBUG=*`.
 *
 * Failure still propagates — this is formatting, not recovery (#553, AC #6).
 */

export type EmbeddingErrorCode =
  | 'network'
  | 'cache-permission'
  | 'cache-corrupted'
  | 'generic';

export interface EmbeddingErrorDetails {
  code: EmbeddingErrorCode;
  message: string;
  nextStep: string;
  rawMessage: string;
  stack?: string;
}

const CACHE_HINT = '`~/.cache/fastembed` (or `$FASTEMBED_CACHE` if set)';

const NETWORK_RE =
  /\b(ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EHOSTDOWN|getaddrinfo|failed to (?:fetch|download)|network\s+(?:is\s+)?unreachable)\b/i;
const PERMISSION_RE = /\b(EACCES|EPERM|EROFS|permission denied|read[- ]only file system)\b/i;
const CORRUPTED_RE =
  /(corrupt(?:ed)?|checksum|size[ _]?mismatch|unexpected (?:byte|end)|truncat(?:ed|ion)|invalid (?:gzip|zip|onnx|model))/i;

function getErrnoCode(err: unknown, depth = 0): string | undefined {
  if (!err || typeof err !== 'object' || depth > 5) return undefined;
  const e = err as { code?: unknown; cause?: unknown };
  if (typeof e.code === 'string') return e.code;
  if (e.cause) return getErrnoCode(e.cause, depth + 1);
  return undefined;
}

function getRawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function getStack(err: unknown): string | undefined {
  if (err instanceof Error && typeof err.stack === 'string') return err.stack;
  return undefined;
}

export function classifyEmbeddingError(err: unknown): EmbeddingErrorDetails {
  const rawMessage = getRawMessage(err);
  const stack = getStack(err);
  const code = getErrnoCode(err) ?? '';

  if (NETWORK_RE.test(code) || NETWORK_RE.test(rawMessage)) {
    return {
      code: 'network',
      message: "Couldn't reach the model server to download the embedding model.",
      nextStep: 'Check your network connection, or run `flo doctor` to diagnose.',
      rawMessage,
      stack,
    };
  }

  if (PERMISSION_RE.test(code) || PERMISSION_RE.test(rawMessage)) {
    return {
      code: 'cache-permission',
      message: "Couldn't write the embedding model cache.",
      nextStep: `Check permissions on ${CACHE_HINT}.`,
      rawMessage,
      stack,
    };
  }

  if (CORRUPTED_RE.test(rawMessage)) {
    return {
      code: 'cache-corrupted',
      message: 'The embedding model cache looks corrupted.',
      nextStep: `Delete ${CACHE_HINT} and retry. \`flo doctor --fix\` can do this for you.`,
      rawMessage,
      stack,
    };
  }

  return {
    code: 'generic',
    message: "Couldn't load the neural embedding model.",
    nextStep: 'Run `flo doctor` to diagnose, or re-run with `--verbose` for the underlying error.',
    rawMessage,
    stack,
  };
}

/**
 * Verbose is on when the caller passes `verbose: true`, or when `DEBUG`
 * contains a standalone `*` or a `moflo` namespace (comma-separated, matching
 * the `debug` package convention).
 */
export function isVerboseEmbeddingErrors(opts?: { verbose?: boolean }): boolean {
  if (opts?.verbose) return true;
  const debug = process.env.DEBUG;
  if (!debug) return false;
  return debug.split(',').some(part => {
    const ns = part.trim();
    return ns === '*' || /^moflo(?::|$)/i.test(ns);
  });
}

export function formatEmbeddingError(
  err: unknown,
  opts?: { verbose?: boolean },
): string {
  const details = classifyEmbeddingError(err);
  const lines = [details.message, details.nextStep];

  if (isVerboseEmbeddingErrors(opts)) {
    lines.push('', `Underlying error: ${details.rawMessage}`);
    if (details.stack) lines.push(details.stack);
  }

  return lines.join('\n');
}
