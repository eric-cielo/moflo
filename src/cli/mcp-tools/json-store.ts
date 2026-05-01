/**
 * Tiny JSON-on-disk store shared by the trimmed MCP-tool surfaces
 * (`coordination-tools`, `system-tools`, `performance-tools`).
 *
 * Anchors files at `<projectRoot>/.moflo/<subdir>/<file>` via {@link mofloDir},
 * with the root resolved by {@link findProjectRoot} so an MCP server launched
 * from a subdirectory still writes inside the consumer project. On a missing
 * file or syntactically-malformed JSON, `load()` falls back to `defaults()` so
 * first-run callers never crash. Any other I/O failure (EACCES, EISDIR, etc.)
 * is surfaced — silent recovery there would masquerade as a clean first-run
 * and discard real on-disk state.
 *
 * Intentionally minimal: no locking, no caching, no schema validation.
 * Each consumer keeps its own typed shape; this is just persistence.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mofloDir } from '../services/moflo-paths.js';
import { findProjectRoot } from '../services/project-root.js';

export interface JsonStoreOptions<T> {
  subdir: string;
  file: string;
  defaults: () => T;
}

export interface JsonStore<T> {
  load(): T;
  save(value: T): void;
}

export function createJsonStore<T>(opts: JsonStoreOptions<T>): JsonStore<T> {
  const path = (): string => join(mofloDir(findProjectRoot()), opts.subdir, opts.file);

  return {
    load(): T {
      let raw: string;
      try {
        raw = readFileSync(path(), 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return opts.defaults();
        throw err;
      }
      try {
        return JSON.parse(raw) as T;
      } catch (err) {
        if (err instanceof SyntaxError) return opts.defaults();
        throw err;
      }
    },
    save(value: T): void {
      const p = path();
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(value, null, 2), 'utf-8');
    },
  };
}
