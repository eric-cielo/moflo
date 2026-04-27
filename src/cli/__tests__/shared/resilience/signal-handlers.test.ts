/**
 * Tests for the shared signal-handler attach/detach utility (#667 follow-up).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SHUTDOWN_SIGNALS,
  attachSignalHandlers,
} from '../../../shared/resilience/signal-handlers.js';

function snapshot(): Record<typeof SHUTDOWN_SIGNALS[number], number> {
  return {
    SIGTERM: process.listenerCount('SIGTERM'),
    SIGINT: process.listenerCount('SIGINT'),
    SIGHUP: process.listenerCount('SIGHUP'),
  };
}

describe('attachSignalHandlers', () => {
  let baseline: ReturnType<typeof snapshot>;

  beforeEach(() => {
    baseline = snapshot();
  });

  it('registers the handler on the default SHUTDOWN_SIGNALS', () => {
    const detach = attachSignalHandlers(() => {});
    const after = snapshot();
    for (const sig of SHUTDOWN_SIGNALS) {
      expect(after[sig]).toBe(baseline[sig] + 1);
    }
    detach();
  });

  it('returned detach removes the listeners', () => {
    const detach = attachSignalHandlers(() => {});
    detach();
    const after = snapshot();
    for (const sig of SHUTDOWN_SIGNALS) {
      expect(after[sig]).toBe(baseline[sig]);
    }
  });

  it('detach is idempotent', () => {
    const detach = attachSignalHandlers(() => {});
    detach();
    expect(() => detach()).not.toThrow();
    const after = snapshot();
    for (const sig of SHUTDOWN_SIGNALS) {
      expect(after[sig]).toBe(baseline[sig]);
    }
  });

  it('honors a custom signals list', () => {
    const detach = attachSignalHandlers(() => {}, ['SIGINT']);
    const after = snapshot();
    expect(after.SIGINT).toBe(baseline.SIGINT + 1);
    expect(after.SIGTERM).toBe(baseline.SIGTERM);
    expect(after.SIGHUP).toBe(baseline.SIGHUP);
    detach();
  });

  it('many attach/detach cycles do not leak', () => {
    for (let i = 0; i < 25; i++) {
      const detach = attachSignalHandlers(() => {});
      detach();
    }
    const after = snapshot();
    for (const sig of SHUTDOWN_SIGNALS) {
      expect(after[sig]).toBe(baseline[sig]);
    }
  });

  it('registers the same handler reference on every signal', () => {
    const handler: NodeJS.SignalsListener = () => {};
    const detach = attachSignalHandlers(handler);
    for (const sig of SHUTDOWN_SIGNALS) {
      expect(process.listeners(sig)).toContain(handler);
    }
    detach();
    for (const sig of SHUTDOWN_SIGNALS) {
      expect(process.listeners(sig)).not.toContain(handler);
    }
  });
});
