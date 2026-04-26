/**
 * Shared fixtures for the upgrade-UX test files.
 *
 * `BufferStream` + `makeClock` were duplicated verbatim between
 * `upgrade-coordinator.test.ts` and `upgrade-renderer.test.ts`; they live here
 * now so drift can't happen (e.g. one copy had `isTTY = false`, the other
 * didn't — the coordinator test exercises non-TTY mode so the missing flag in
 * the renderer copy was an untripped foot-gun).
 */
import { Writable } from 'node:stream';

import type { InMemoryItem } from '../../../embeddings/migration/index.js';

export class BufferStream extends Writable {
  public buffer = '';
  public isTTY = false;

  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error) => void): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
}

export interface TestClock {
  now(): number;
  advance(ms: number): void;
  set(ms: number): void;
}

export function makeClock(startMs = 1_000_000): TestClock {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
}

export function makeItems(prefix: string, count: number): InMemoryItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${String(i).padStart(4, '0')}`,
    sourceText: `${prefix}-content-${i}`,
  }));
}
