/**
 * Side-effect module — installs a `process.emitWarning` filter that drops
 * Node's `ExperimentalWarning: SQLite is an experimental feature` line
 * before `node:sqlite` ever fires it.
 *
 * TS twin of `bin/lib/suppress-sqlite-warning.mjs`. Imported at the top of
 * `daemon-backend.ts` so any TS entry point (CLI command, MCP server, vitest
 * test) that pulls in the bridge transitively also gets the filter.
 *
 * See the JS twin for the full rationale; the two MUST stay in lockstep so
 * the symbol-based idempotency guard works whether the first import comes
 * from JS or TS.
 *
 * @module v3/memory/suppress-sqlite-warning
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const INSTALLED = Symbol.for('moflo.suppressSqliteWarning.installed');

function shouldSuppress(message: unknown): boolean {
  if (typeof message === 'string') {
    return message.includes('SQLite is an experimental feature');
  }
  if (message && typeof message === 'object') {
    const m = (message as { message?: unknown }).message;
    return typeof m === 'string' && m.includes('SQLite is an experimental feature');
  }
  return false;
}

const g = globalThis as Record<symbol, unknown>;
if (!g[INSTALLED]) {
  g[INSTALLED] = true;
  const originalEmitWarning = process.emitWarning.bind(process);
  // Cast through `any` so we can pass both emit signatures —
  // (message, type, code, ctor) and (message, options) — through unchanged.
  (process as any).emitWarning = function (warning: unknown, ...args: unknown[]): void {
    if (shouldSuppress(warning)) return;
    const arg0 = args[0];
    const typeArg =
      typeof arg0 === 'string'
        ? arg0
        : arg0 && typeof arg0 === 'object'
          ? (arg0 as { type?: string }).type
          : undefined;
    if (typeArg === 'ExperimentalWarning' && typeof warning === 'string' && warning.includes('SQLite')) return;
    (originalEmitWarning as any)(warning, ...args);
  };
}

// Side-effect-only module: `export {}` flags it as a module under
// `--isolatedModules` so consumers can `import './suppress-sqlite-warning.js'`
// for the side effect without a TS "not a module" error.
export {};
