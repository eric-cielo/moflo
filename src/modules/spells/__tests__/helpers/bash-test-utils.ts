/**
 * Shared test helpers for bash command sandbox integration tests.
 *
 * Used by both bash-sandbox-exec.test.ts and bash-bwrap.test.ts.
 */

import { vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { CastingContext, StepCapability } from '../../src/types/step-command.types.js';
import type { EffectiveSandbox, SandboxCapability, SandboxConfig } from '../../src/core/platform-sandbox.js';
import { CapabilityGateway } from '../../src/core/capability-gateway.js';

export function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  proc.pid = 12345;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  (proc.stdout as EventEmitter & { destroy: () => void }).destroy = vi.fn();
  (proc.stderr as EventEmitter & { destroy: () => void }).destroy = vi.fn();
  return proc;
}

export function makeSandbox(
  useOsSandbox: boolean,
  platform: 'darwin' | 'linux',
  tool: string | null,
): EffectiveSandbox {
  const capability: SandboxCapability = {
    platform,
    available: useOsSandbox,
    tool: useOsSandbox ? tool : null,
    overhead: useOsSandbox ? 'low' : null,
  };
  const config: SandboxConfig = { enabled: true, tier: 'auto' };
  return {
    useOsSandbox,
    capability,
    config,
    displayStatus: useOsSandbox ? `OS sandbox: ${tool} (${platform})` : 'OS sandbox: disabled',
  };
}

export const DEFAULT_CAPS: StepCapability[] = [
  { type: 'shell' },
  { type: 'fs:read' },
];

export function makeContext(
  projectRoot: string,
  sandbox?: EffectiveSandbox,
  caps: StepCapability[] = DEFAULT_CAPS,
): CastingContext {
  const gateway = new CapabilityGateway(caps, 'test-step-0', 'bash');
  return {
    variables: { projectRoot },
    args: {},
    credentials: { get: async () => undefined },
    memory: {
      get: async () => undefined,
      set: async () => {},
      search: async () => [],
    },
    taskId: 'test-step-0',
    spellId: 'test-spell',
    stepIndex: 0,
    effectiveCaps: caps,
    gateway,
    sandbox,
  };
}
