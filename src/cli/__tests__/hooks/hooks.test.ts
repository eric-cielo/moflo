/**
 * moflo/cli/hooks — Package export verification tests
 *
 * Replaces the previous placeholder tests with real import/export checks
 * against the hooks package main entry point.
 */

import { describe, it, expect } from 'vitest';

// Import everything the package declares as public API
import {
  // Types (enums)
  HookEvent,
  HookPriority,

  // Registry
  HookRegistry,
  defaultRegistry,
  registerHook,
  unregisterHook,

  // Executor
  HookExecutor,
  defaultExecutor,
  executeHooks,

  // Bridge
  OfficialHooksBridge,
  V3_TO_OFFICIAL_HOOK_MAP,
  V3_TOOL_MATCHERS,

  // Workers
  WorkerManager,
  WorkerPriority,
  WORKER_CONFIGS,

  // Top-level helpers
  VERSION,
  initializeHooks,
  runHook,
  addHook,
} from '../../hooks/index.js';

// ---------------------------------------------------------------------------
// Enum exports
// ---------------------------------------------------------------------------
describe('HookEvent enum', () => {
  it('contains core lifecycle events', () => {
    expect(HookEvent.PreEdit).toBe('pre-edit');
    expect(HookEvent.PostEdit).toBe('post-edit');
    expect(HookEvent.PreCommand).toBe('pre-command');
    expect(HookEvent.PostCommand).toBe('post-command');
    expect(HookEvent.PreTask).toBe('pre-task');
    expect(HookEvent.PostTask).toBe('post-task');
    expect(HookEvent.SessionStart).toBe('session-start');
    expect(HookEvent.SessionEnd).toBe('session-end');
  });
});

describe('HookPriority enum', () => {
  it('defines ordered priority levels', () => {
    expect(HookPriority.Critical).toBeGreaterThan(HookPriority.High);
    expect(HookPriority.High).toBeGreaterThan(HookPriority.Normal);
    expect(HookPriority.Normal).toBeGreaterThan(HookPriority.Low);
    expect(HookPriority.Low).toBeGreaterThan(HookPriority.Background);
  });
});

// ---------------------------------------------------------------------------
// Registry exports
// ---------------------------------------------------------------------------
describe('HookRegistry exports', () => {
  it('exports HookRegistry class', () => {
    expect(HookRegistry).toBeDefined();
    expect(new HookRegistry()).toBeInstanceOf(HookRegistry);
  });

  it('exports defaultRegistry singleton', () => {
    expect(defaultRegistry).toBeInstanceOf(HookRegistry);
  });

  it('exports registerHook function', () => {
    expect(registerHook).toBeTypeOf('function');
  });

  it('exports unregisterHook function', () => {
    expect(unregisterHook).toBeTypeOf('function');
  });
});

// ---------------------------------------------------------------------------
// Executor exports
// ---------------------------------------------------------------------------
describe('HookExecutor exports', () => {
  it('exports HookExecutor class', () => {
    expect(HookExecutor).toBeDefined();
    expect(new HookExecutor()).toBeInstanceOf(HookExecutor);
  });

  it('exports defaultExecutor singleton', () => {
    expect(defaultExecutor).toBeInstanceOf(HookExecutor);
  });

  it('exports executeHooks function', () => {
    expect(executeHooks).toBeTypeOf('function');
  });
});

// ---------------------------------------------------------------------------
// Bridge exports
// ---------------------------------------------------------------------------
describe('Bridge exports', () => {
  it('exports OfficialHooksBridge', () => {
    expect(OfficialHooksBridge).toBeDefined();
  });

  it('exports V3_TO_OFFICIAL_HOOK_MAP covering all HookEvents', () => {
    const allEvents = Object.values(HookEvent);
    for (const evt of allEvents) {
      expect(evt in V3_TO_OFFICIAL_HOOK_MAP).toBe(true);
    }
  });

  it('exports V3_TOOL_MATCHERS', () => {
    expect(V3_TOOL_MATCHERS).toBeDefined();
    expect(V3_TOOL_MATCHERS[HookEvent.PreEdit]).toMatch(/Edit/);
  });
});

// ---------------------------------------------------------------------------
// Worker exports
// ---------------------------------------------------------------------------
describe('Worker exports', () => {
  it('exports WorkerManager class', () => {
    expect(WorkerManager).toBeDefined();
  });

  it('exports WorkerPriority enum', () => {
    expect(WorkerPriority).toBeDefined();
  });

  it('exports WORKER_CONFIGS', () => {
    expect(WORKER_CONFIGS).toBeDefined();
    expect(typeof WORKER_CONFIGS).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// Top-level helpers
// ---------------------------------------------------------------------------
describe('Top-level helpers', () => {
  it('exports VERSION string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exports initializeHooks async function', () => {
    expect(initializeHooks).toBeTypeOf('function');
  });

  it('exports runHook async function', () => {
    expect(runHook).toBeTypeOf('function');
  });

  it('exports addHook function', () => {
    expect(addHook).toBeTypeOf('function');
  });
});
