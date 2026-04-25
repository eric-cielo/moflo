import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerTTYPauser,
  acquireTTYLock,
  _resetTTYLockForTest,
} from '../../src/spells/core/tty-lock.js';

describe('tty-lock', () => {
  beforeEach(() => {
    _resetTTYLockForTest();
  });

  it('returns a no-op handle when no pauser is registered', () => {
    const handle = acquireTTYLock();
    expect(typeof handle.release).toBe('function');
    // Should not throw.
    handle.release();
  });

  it('invokes the registered pauser and returns its handle', () => {
    const events: string[] = [];
    registerTTYPauser(() => {
      events.push('pause');
      return { release: () => events.push('resume') };
    });

    const handle = acquireTTYLock();
    handle.release();

    expect(events).toEqual(['pause', 'resume']);
  });

  it('replaces a previously registered pauser', () => {
    registerTTYPauser(() => ({ release: () => { throw new Error('stale'); } }));
    const events: string[] = [];
    registerTTYPauser(() => {
      events.push('pause2');
      return { release: () => events.push('resume2') };
    });

    const handle = acquireTTYLock();
    handle.release();

    expect(events).toEqual(['pause2', 'resume2']);
  });

  it('unregister function clears its own registration only', () => {
    const events: string[] = [];
    const unregisterA = registerTTYPauser(() => {
      events.push('A');
      return { release: () => {} };
    });
    const unregisterB = registerTTYPauser(() => {
      events.push('B');
      return { release: () => {} };
    });

    // Unregistering A (the stale one) should not remove B.
    unregisterA();
    acquireTTYLock().release();
    expect(events).toEqual(['B']);

    // Unregistering B clears everything; subsequent acquire is a no-op.
    unregisterB();
    acquireTTYLock().release();
    expect(events).toEqual(['B']);
  });

  it('swallows pauser errors and falls back to a no-op handle', () => {
    registerTTYPauser(() => { throw new Error('pauser exploded'); });
    const handle = acquireTTYLock();
    expect(() => handle.release()).not.toThrow();
  });
});
