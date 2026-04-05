/**
 * Timeout Executor
 *
 * Wraps step execution with timeout and cancellation support.
 * Extracted from WorkflowRunner (Issue #182).
 */

/**
 * Execute a function with a timeout and optional abort signal.
 * Rejects with 'Step timed out' on timeout, 'Step cancelled' on abort.
 */
export function executeWithTimeout<T>(
  fn: () => Promise<T>,
  timeout: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        reject(new Error('Step timed out'));
      }
    }, timeout);

    const onAbort = (): void => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('Step cancelled'));
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    fn().then(
      (result) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(result);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      },
    );
  });
}
