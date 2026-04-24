/**
 * Regression tests for issue #556.
 *
 * The previous hand-built `../../../../modules/swarm/dist/...` string walked
 * up past `src/modules/` and then re-appended `modules/`, producing
 * `src/modules/modules/swarm/...` — which fails to resolve on every platform.
 * These tests pin the fix so the broken shape can't come back.
 */

import { describe, it, expect } from 'vitest';
import { locateSwarmArtifact } from '../src/swarm/index.js';

describe('hooks/swarm locateSwarmArtifact (regression #556)', () => {
  it('resolves @moflo/swarm MessageBus from inside the hooks package', () => {
    const url = locateSwarmArtifact('message-bus/message-bus.js');
    expect(url).not.toBeNull();
    expect(url).toMatch(/^file:\/\//);
  });

  it('never emits a path containing "modules/modules"', () => {
    const url = locateSwarmArtifact('message-bus/message-bus.js');
    expect(url).not.toBeNull();
    // Platform-agnostic: both separators covered.
    expect(url!).not.toMatch(/[\\/]modules[\\/]modules[\\/]/);
    expect(url!).not.toMatch(/\/modules\/modules\//);
  });

  it('returns null when the artifact is missing (no silent success)', () => {
    const url = locateSwarmArtifact('does-not-exist/definitely-not.js');
    expect(url).toBeNull();
  });
});
