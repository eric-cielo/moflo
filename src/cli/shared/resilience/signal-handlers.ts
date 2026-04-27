/**
 * Process signal handler attach/detach utility.
 *
 * Centralises the capture-handler-then-removeListener idiom that was
 * reimplemented across worker-daemon, hive-mind, headless runtime, daemon
 * command, upgrade coordinator, etc. — each subtly different, several missing
 * the detach side, which leaked listeners and tripped MaxListenersExceededWarning
 * across repeated test instantiations (#667).
 */

export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/**
 * Register the same handler on each of `signals`. Returns a detach function
 * that removes them; the detach is idempotent so callers can defensively call
 * it from multiple cleanup paths (e.g. both `try/finally` and a stop() method).
 */
export function attachSignalHandlers(
  handler: NodeJS.SignalsListener,
  signals: readonly NodeJS.Signals[] = SHUTDOWN_SIGNALS,
): () => void {
  for (const sig of signals) {
    process.on(sig, handler);
  }

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    for (const sig of signals) {
      process.removeListener(sig, handler);
    }
  };
}
