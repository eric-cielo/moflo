/**
 * Pause/Resume Tests
 *
 * Story #140: Tests for spell pause/resume mechanism.
 */

import { describe, it, expect, vi } from 'vitest';
import type { MemoryAccessor } from '../../spells/types/step-command.types.js';
import type { StepResult } from '../../spells/types/runner.types.js';
import type { SpellDefinition } from '../../spells/types/spell-definition.types.js';
import {
  buildPausedState,
  persistPausedState,
  resumeSpell,
  cleanupStalePaused,
} from '../../spells/factory/pause-resume.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockMemory(): MemoryAccessor & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async read(ns: string, key: string) { return store.get(`${ns}:${key}`) ?? null; },
    async write(ns: string, key: string, value: unknown) {
      if (value === null) store.delete(`${ns}:${key}`);
      else store.set(`${ns}:${key}`, value);
    },
    async search(ns: string) {
      const results: Array<{ key: string; value: unknown; score: number }> = [];
      for (const [key, val] of store.entries()) {
        if (key.startsWith(`${ns}:`)) results.push({ key, value: val, score: 1.0 });
      }
      return results;
    },
  };
}

const TEST_DEFINITION: SpellDefinition = {
  name: 'test-spell',
  steps: [
    { id: 's1', type: 'wait', config: { duration: 0 } },
    { id: 's2', type: 'wait', config: { duration: 0 } },
    { id: 's3', type: 'wait', config: { duration: 0 } },
    { id: 's4', type: 'wait', config: { duration: 0 } },
    { id: 's5', type: 'wait', config: { duration: 0 } },
  ],
};

const COMPLETED_RESULTS: StepResult[] = [
  { stepId: 's1', stepType: 'wait', status: 'succeeded', duration: 1, output: { success: true, data: { done: true }, duration: 1 } },
  { stepId: 's2', stepType: 'wait', status: 'succeeded', duration: 1, output: { success: true, data: { done: true }, duration: 1 } },
];

// ============================================================================
// buildPausedState
// ============================================================================

describe('buildPausedState', () => {
  it('should create a serializable paused state', () => {
    const state = buildPausedState(
      'wf-123',
      TEST_DEFINITION,
      2, // next step index
      { s1: { done: true }, s2: { done: true } },
      COMPLETED_RESULTS,
      { target: 'production' },
    );

    expect(state.spellId).toBe('wf-123');
    expect(state.definitionName).toBe('test-spell');
    expect(state.nextStepIndex).toBe(2);
    expect(state.variables).toEqual({ s1: { done: true }, s2: { done: true } });
    expect(state.completedStepResults).toHaveLength(2);
    expect(state.args).toEqual({ target: 'production' });
    expect(state.pausedAt).toBeDefined();
    expect(JSON.parse(state.definition)).toEqual(TEST_DEFINITION);
  });
});

// ============================================================================
// persistPausedState + resumeSpell
// ============================================================================

describe('persistPausedState + resumeSpell', () => {
  it('should pause after step 2 and resume from step 3', async () => {
    const memory = createMockMemory();

    // Build and persist paused state (simulating pause after step 2 of 5)
    const state = buildPausedState(
      'wf-pause-test',
      TEST_DEFINITION,
      2,
      { s1: { done: true }, s2: { done: true } },
      COMPLETED_RESULTS,
      {},
    );
    await persistPausedState(state, memory);

    // Resume should continue from step 3
    const result = await resumeSpell('wf-pause-test', { memory });

    expect(result.success).toBe(true);
    // Total steps: 2 completed before pause + 3 from resume
    expect(result.steps).toHaveLength(5);
    expect(result.steps[0].stepId).toBe('s1');
    expect(result.steps[1].stepId).toBe('s2');
    expect(result.steps[2].stepId).toBe('s3');
    expect(result.steps[3].stepId).toBe('s4');
    expect(result.steps[4].stepId).toBe('s5');
  });

  it('should support modified variables on resume', async () => {
    const memory = createMockMemory();

    const state = buildPausedState(
      'wf-vars-test',
      TEST_DEFINITION,
      2,
      { s1: { value: 'original' } },
      COMPLETED_RESULTS,
      {},
    );
    await persistPausedState(state, memory);

    // Resume with user-injected variable overrides
    const result = await resumeSpell('wf-vars-test', {
      memory,
      variables: { userOverride: 'injected' },
    });

    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Serialization roundtrip
// ============================================================================

describe('Serialization roundtrip', () => {
  it('should survive memory persistence and reconstruction', async () => {
    const memory = createMockMemory();

    const originalState = buildPausedState(
      'wf-serial-test',
      TEST_DEFINITION,
      3,
      { s1: { nested: { deep: [1, 2, 3] } } },
      COMPLETED_RESULTS,
      { key: 'value' },
    );

    await persistPausedState(originalState, memory);

    // Read back
    const raw = await memory.read('spell-paused', 'wf-serial-test');
    const reconstructed = raw as typeof originalState;

    expect(reconstructed.spellId).toBe('wf-serial-test');
    expect(reconstructed.nextStepIndex).toBe(3);
    expect(reconstructed.variables).toEqual({ s1: { nested: { deep: [1, 2, 3] } } });
    expect(JSON.parse(reconstructed.definition).name).toBe('test-spell');
  });
});

// ============================================================================
// Error cases
// ============================================================================

describe('resumeSpell — errors', () => {
  it('should return error for nonexistent spell ID', async () => {
    const memory = createMockMemory();

    const result = await resumeSpell('nonexistent', { memory });

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('No paused state found');
  });

  it('should reject stale paused state', async () => {
    const memory = createMockMemory();

    const state = buildPausedState(
      'wf-stale-test',
      TEST_DEFINITION,
      1,
      {},
      [],
      {},
      1, // 1ms stale timeout
    );

    // Persist with already-expired timeout
    await persistPausedState(state, memory);

    // Wait just enough for it to expire
    await new Promise(r => setTimeout(r, 5));

    const result = await resumeSpell('wf-stale-test', { memory });

    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain('expired');
    // State should be cleaned up
    expect(await memory.read('spell-paused', 'wf-stale-test')).toBeNull();
  });
});

// ============================================================================
// Cleanup
// ============================================================================

describe('cleanupStalePaused', () => {
  it('should remove stale entries and keep fresh ones', async () => {
    const memory = createMockMemory();

    // Stale entry (1ms timeout)
    const stale = buildPausedState('wf-stale', TEST_DEFINITION, 0, {}, [], {}, 1);
    await persistPausedState(stale, memory);

    // Fresh entry (24h timeout)
    const fresh = buildPausedState('wf-fresh', TEST_DEFINITION, 0, {}, [], {});
    await persistPausedState(fresh, memory);

    await new Promise(r => setTimeout(r, 5));

    const cleaned = await cleanupStalePaused(memory);

    expect(cleaned).toBe(1);
    expect(await memory.read('spell-paused', 'wf-stale')).toBeNull();
    expect(await memory.read('spell-paused', 'wf-fresh')).not.toBeNull();
  });
});
