/**
 * TTY Lock — coordinates exclusive TTY ownership for interactive steps.
 *
 * Interactive step commands (e.g. `prompt`) need uninterrupted access to
 * stdout so the user can read the question and stdin echo isn't scrambled
 * by concurrent output. Meanwhile, host CLIs commonly run animated
 * spinners while a spell is casting that also redraw on stdout.
 *
 * This module exposes a tiny register/acquire primitive:
 *   - Hosts (like the CLI) register a pauser that stops their spinner.
 *   - Steps (like prompt) acquire a lock before reading stdin and release
 *     it afterwards.
 *
 * When no pauser is registered (tests, subprocess, library use), acquire
 * returns a no-op handle so the primitive is safe to call unconditionally.
 */
export interface TTYLockHandle {
  release(): void;
}

export type TTYPauser = () => TTYLockHandle;

let activePauser: TTYPauser | null = null;

/**
 * Register the pauser responsible for yielding the TTY on demand.
 * Overwrites any previously registered pauser. Returns a function that
 * clears the registration (use in tests or when the host tears down).
 */
export function registerTTYPauser(pauser: TTYPauser): () => void {
  activePauser = pauser;
  return () => {
    if (activePauser === pauser) {
      activePauser = null;
    }
  };
}

/**
 * Acquire exclusive TTY access. Call `release()` on the returned handle
 * when finished. Safe to call when no pauser is registered — returns a
 * no-op handle in that case.
 */
export function acquireTTYLock(): TTYLockHandle {
  if (!activePauser) {
    return { release: () => {} };
  }
  try {
    return activePauser();
  } catch {
    return { release: () => {} };
  }
}

/** For tests — clear any registered pauser. */
export function _resetTTYLockForTest(): void {
  activePauser = null;
}
