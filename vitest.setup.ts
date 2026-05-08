/**
 * Global vitest setup.
 *
 * #981 — disable the storeEntry/deleteEntry daemon-routing preamble during
 * tests by default. Tests run in vitest workers with no real daemon, but the
 * isolation pass shares a single worker across many test files, so the
 * routing preamble's module-level health cache (5s TTL) and per-call HTTP
 * probe (100ms timeout) introduce timing variance that surfaces as flakes
 * (e.g. doctor-checks-memory-access cleanup race on Linux CI).
 *
 * Tests that explicitly want to exercise the routing path —
 * `tests/system/multi-process-write-visibility.test.ts` and the
 * store-entry-routing / daemon-write-client unit tests — set/unset this
 * env var inside their own `beforeEach` blocks. Setting it here as the
 * default keeps the rest of the suite unaffected by routing.
 */

import { beforeEach } from 'vitest';

// Set once at module load (every test file imports this setup).
process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';

// Re-set in `beforeEach` so a test that intentionally cleared it for a
// routing scenario doesn't bleed into the next test.
beforeEach(() => {
  if (process.env.MOFLO_DISABLE_DAEMON_ROUTING !== '1') {
    process.env.MOFLO_DISABLE_DAEMON_ROUTING = '1';
  }
});
