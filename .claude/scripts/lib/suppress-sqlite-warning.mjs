/**
 * Filter out Node's `(node:NNN) ExperimentalWarning: SQLite is an experimental
 * feature and might change at any time` line that fires once per process the
 * first time `node:sqlite` is loaded.
 *
 * Why we suppress: moflo committed to node:sqlite as the only backend in
 * Phase 5 (#1084). The warning is informational from Node's perspective but
 * actively harmful for us because:
 *   1. It lands on stderr → the consumer-smoke harness's 200-char stderr
 *      tails (`recordExit`) get filled with the warning prefix, hiding the
 *      real failure message behind it (#1098 — `Memory Access Functional`
 *      failures looked like ExperimentalWarning failures in CI logs).
 *   2. It appears in every consumer's `flo doctor` / `flo memory init` /
 *      `flo daemon start` invocation, polluting their terminal output for
 *      something they can't act on.
 *
 * Implementation: replace `process.emitWarning` with a thin filter ONLY for
 * the SQLite warning. Every other warning passes through unchanged — we
 * specifically don't want to broadly mute `--no-warnings`-style suppression
 * because that would also hide e.g. import-attributes ExperimentalWarning
 * which IS something we'd want to know about.
 *
 * The filter is idempotent: re-importing the module is a no-op. Must run
 * BEFORE the first `import 'node:sqlite'` anywhere in the process tree;
 * called from `bin/cli.js`, `bin/lib/get-backend.mjs`, and the daemon-
 * backend module loader.
 *
 * @module bin/lib/suppress-sqlite-warning
 */

const INSTALLED = Symbol.for('moflo.suppressSqliteWarning.installed');

function shouldSuppress(message) {
  if (typeof message === 'string') {
    return message.includes('SQLite is an experimental feature');
  }
  if (message && typeof message === 'object') {
    return typeof message.message === 'string' && message.message.includes('SQLite is an experimental feature');
  }
  return false;
}

if (!globalThis[INSTALLED]) {
  globalThis[INSTALLED] = true;
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...args) {
    // Two emit signatures: (message, type, code, ctor) and (message, options).
    // Inspect both `warning` and `args[0]` (which is `type` in the legacy
    // form or `options.type` in the new form) before deciding.
    if (shouldSuppress(warning)) return;
    const typeArg = typeof args[0] === 'string'
      ? args[0]
      : (args[0] && typeof args[0] === 'object' ? args[0].type : undefined);
    if (typeArg === 'ExperimentalWarning' && typeof warning === 'string' && warning.includes('SQLite')) return;
    return originalEmitWarning.apply(this, [warning, ...args]);
  };
}
