/**
 * The healer's ghost-agent prune must delete only what it can justify (#1370).
 *
 * `flo doctor`'s swarm probe used to persist an agent per run and never remove
 * it. Once 15 rows accumulated, the coordinator's cap rejected the probe spawn
 * and the swarm check failed on every later run. The leak is fixed, but that
 * does nothing for an install already holding the backlog — hence a `--fix`.
 *
 * This is a DELETING repair, so the selection policy is what matters: a row it
 * cannot reason about must survive, and a recent row must survive, or the fix
 * for a stuck check becomes a way to lose live coordination state.
 */

import { describe, it, expect } from 'vitest';
import { selectStaleAgentRows } from '../../commands/doctor-fixes.js';

const NOW = new Date('2026-08-04T12:00:00Z').getTime();
const WINDOW = 5 * 60 * 1000;
const ago = (ms: number) => NOW - ms;

describe('selectStaleAgentRows', () => {
  it('selects a row older than the window', () => {
    const stale = selectStaleAgentRows([{ key: 'agent:old', updatedAt: ago(10 * 60 * 1000) }], NOW, WINDOW);
    expect(stale.map(r => r.key)).toEqual(['agent:old']);
  });

  it('spares a row inside the window — it may belong to a live coordinator', () => {
    const stale = selectStaleAgentRows([{ key: 'agent:fresh', updatedAt: ago(30 * 1000) }], NOW, WINDOW);
    expect(stale).toEqual([]);
  });

  it('reads epoch-ms and ISO timestamps alike, since the store emits both', () => {
    const stale = selectStaleAgentRows([
      { key: 'agent:ms', updatedAt: ago(60 * 60 * 1000) },
      { key: 'agent:iso', updatedAt: new Date(ago(60 * 60 * 1000)).toISOString() },
    ], NOW, WINDOW);
    expect(stale.map(r => r.key).sort()).toEqual(['agent:iso', 'agent:ms']);
  });

  it('KEEPS a row with no timestamp rather than guessing', () => {
    // The failure mode to avoid: treating "unknown age" as "old" and deleting
    // rows this cannot actually justify deleting.
    const stale = selectStaleAgentRows([{ key: 'agent:no-stamp' }], NOW, WINDOW);
    expect(stale).toEqual([]);
  });

  it('KEEPS a row whose timestamp does not parse', () => {
    const stale = selectStaleAgentRows([{ key: 'agent:garbage', updatedAt: 'not-a-date' }], NOW, WINDOW);
    expect(stale).toEqual([]);
  });

  it('keeps a future-dated row (clock skew is not staleness)', () => {
    const stale = selectStaleAgentRows([{ key: 'agent:future', updatedAt: NOW + 60_000 }], NOW, WINDOW);
    expect(stale).toEqual([]);
  });

  it('splits a realistic backlog — the 15 ghosts go, the working agents stay', () => {
    const entries = [
      ...Array.from({ length: 15 }, (_, i) => ({ key: `agent:ghost-${i}`, updatedAt: ago(60 * 60 * 1000) })),
      { key: 'agent:live-1', updatedAt: ago(10 * 1000) },
      { key: 'agent:live-2', updatedAt: ago(60 * 1000) },
    ];
    const stale = selectStaleAgentRows(entries, NOW, WINDOW);
    expect(stale).toHaveLength(15);
    expect(stale.every(r => r.key.startsWith('agent:ghost-'))).toBe(true);
  });
});
