/**
 * Capability Gateway Tests
 *
 * Issue #258: Verifies CapabilityGateway enforcement, disclosure summaries,
 * and integration with all step commands (agent, github, bash, browser, memory).
 */
import { describe, it, expect } from 'vitest';

import {
  CapabilityGateway,
  CapabilityDeniedError,
  discloseStep,
  discloseSpell,
  formatStepDisclosure,
  formatSpellDisclosure,
} from '../src/modules/spells/src/core/capability-gateway.js';
import type { StepCapability, CastingContext } from '../src/modules/spells/src/types/step-command.types.js';
import { agentCommand } from '../src/modules/spells/src/commands/agent-command.js';
import { githubCommand } from '../src/modules/spells/src/commands/github-command.js';
import { memoryCommand } from '../src/modules/spells/src/commands/memory-command.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeContext(caps: StepCapability[], gateway?: CapabilityGateway): CastingContext {
  return {
    variables: {},
    args: {},
    credentials: { get: async () => undefined, has: async () => false },
    memory: {
      read: async () => null,
      write: async () => {},
      search: async () => [],
    },
    taskId: 'test-task',
    workflowId: 'test-wf',
    stepIndex: 0,
    effectiveCaps: caps,
    gateway,
  };
}

// ── CapabilityGateway Unit Tests ─────────────────────────────────────────

describe('CapabilityGateway', () => {
  it('allows operations within granted capabilities', () => {
    const gw = new CapabilityGateway(
      [{ type: 'shell' }, { type: 'agent' }, { type: 'net' }, { type: 'memory' }],
      'step-1', 'test',
    );
    expect(() => gw.checkShell('echo hello')).not.toThrow();
    expect(() => gw.checkAgent('researcher')).not.toThrow();
    expect(() => gw.checkNet('https://example.com')).not.toThrow();
    expect(() => gw.checkMemory('patterns')).not.toThrow();
  });

  it('throws CapabilityDeniedError for ungated capabilities', () => {
    const gw = new CapabilityGateway([{ type: 'shell' }], 'step-1', 'test');

    expect(() => gw.checkAgent('coder')).toThrow(CapabilityDeniedError);
    try {
      gw.checkAgent('coder');
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityDeniedError);
      expect((err as CapabilityDeniedError).violation.capability).toBe('agent');
      expect((err as CapabilityDeniedError).message).toMatch(/not granted/);
    }
  });

  it('enforces scope restrictions on agent type', () => {
    const gw = new CapabilityGateway(
      [{ type: 'agent', scope: ['researcher'] }],
      'step-1', 'test',
    );

    expect(() => gw.checkAgent('researcher')).not.toThrow();
    expect(() => gw.checkAgent('coder')).toThrow(CapabilityDeniedError);
  });

  it('enforces scope restrictions on shell commands', () => {
    const gw = new CapabilityGateway(
      [{ type: 'shell', scope: ['gh issue'] }],
      'step-1', 'test',
    );

    expect(() => gw.checkShell('gh issue view 123')).not.toThrow();
    expect(() => gw.checkShell('gh pr merge')).toThrow(CapabilityDeniedError);
  });

  it('enforces scope restrictions on memory namespaces', () => {
    const gw = new CapabilityGateway(
      [{ type: 'memory', scope: ['patterns', 'guidance'] }],
      'step-1', 'test',
    );

    expect(() => gw.checkMemory('patterns')).not.toThrow();
    expect(() => gw.checkMemory('guidance')).not.toThrow();
    expect(() => gw.checkMemory('secrets')).toThrow(CapabilityDeniedError);
  });

  it('enforces scope restrictions on net URLs', () => {
    const gw = new CapabilityGateway(
      [{ type: 'net', scope: ['https://api.github.com'] }],
      'step-1', 'test',
    );

    expect(() => gw.checkNet('https://api.github.com/repos')).not.toThrow();
    expect(() => gw.checkNet('https://evil.com')).toThrow(CapabilityDeniedError);
  });

  it('allows unrestricted access when scope is empty', () => {
    const gw = new CapabilityGateway(
      [{ type: 'agent' }, { type: 'shell' }],
      'step-1', 'test',
    );

    expect(() => gw.checkAgent('anything')).not.toThrow();
    expect(() => gw.checkShell('rm -rf /')).not.toThrow();
  });

  it('checks fs:read and fs:write separately', () => {
    const gw = new CapabilityGateway(
      [{ type: 'fs:read', scope: ['./src/'] }, { type: 'fs:write', scope: ['./dist/'] }],
      'step-1', 'test',
    );

    expect(() => gw.checkFsRead('./src/index.ts')).not.toThrow();
    expect(() => gw.checkFsWrite('./dist/index.js')).not.toThrow();
    expect(() => gw.checkFsRead('./dist/index.js')).toThrow(CapabilityDeniedError);
    expect(() => gw.checkFsWrite('./src/index.ts')).toThrow(CapabilityDeniedError);
  });

  it('checks browser and browser:evaluate', () => {
    const gw = new CapabilityGateway([{ type: 'browser' }], 'step-1', 'test');

    expect(() => gw.checkBrowser()).not.toThrow();
    expect(() => gw.checkBrowserEvaluate()).toThrow(CapabilityDeniedError);
  });
});

// ── Command Integration Tests ────────────────────────────────────────────

describe('agent-command gateway enforcement', () => {
  it('blocks agent spawning when agent type is outside scope', async () => {
    const caps: StepCapability[] = [{ type: 'agent', scope: ['researcher'] }];
    const gw = new CapabilityGateway(caps, 'test-task', 'agent');
    const ctx = makeContext(caps, gw);

    const result = await agentCommand.execute(
      { prompt: 'do something', agentType: 'coder' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside allowed scope/);
  });

  it('allows agent spawning when agent type matches scope', async () => {
    const caps: StepCapability[] = [{ type: 'agent', scope: ['researcher'] }];
    const gw = new CapabilityGateway(caps, 'test-task', 'agent');
    const ctx = makeContext(caps, gw);

    const result = await agentCommand.execute(
      { prompt: 'research this', agentType: 'researcher' },
      ctx,
    );

    expect(result.success).toBe(true);
  });

  it('allows any agent type when scope is unrestricted', async () => {
    const caps: StepCapability[] = [{ type: 'agent' }];
    const gw = new CapabilityGateway(caps, 'test-task', 'agent');
    const ctx = makeContext(caps, gw);

    const result = await agentCommand.execute(
      { prompt: 'code it', agentType: 'coder' },
      ctx,
    );

    expect(result.success).toBe(true);
  });
});

describe('github-command gateway enforcement', () => {
  it('blocks gh operations outside shell scope', async () => {
    const caps: StepCapability[] = [{ type: 'shell', scope: ['gh issue'] }];
    const gw = new CapabilityGateway(caps, 'test-task', 'github');
    const ctx = makeContext(caps, gw);

    const result = await githubCommand.execute(
      { action: 'pr-merge' as any, pr: 1 },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside allowed scope/);
  });

  it('allows gh operations within shell scope', async () => {
    const caps: StepCapability[] = [{ type: 'shell', scope: ['gh issue'] }];
    const gw = new CapabilityGateway(caps, 'test-task', 'github');
    const ctx = makeContext(caps, gw);

    const result = await githubCommand.execute(
      { action: 'issue-view' as any, issue: 1 },
      ctx,
    );

    // The command may fail (no gh CLI), but shouldn't be blocked by gateway
    if (!result.success) {
      expect(result.error).not.toMatch(/outside allowed scope/);
    }
  });
});

describe('memory-command gateway enforcement', () => {
  it('blocks memory access to restricted namespaces via gateway', async () => {
    const caps: StepCapability[] = [{ type: 'memory', scope: ['patterns'] }];
    const gw = new CapabilityGateway(caps, 'test-task', 'memory');
    const ctx = makeContext(caps, gw);

    const result = await memoryCommand.execute(
      { action: 'read', namespace: 'secrets', key: 'api-key' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside allowed scope/);
  });

  it('allows memory access within scope via gateway', async () => {
    const caps: StepCapability[] = [{ type: 'memory', scope: ['patterns'] }];
    const gw = new CapabilityGateway(caps, 'test-task', 'memory');
    const ctx = makeContext(caps, gw);

    const result = await memoryCommand.execute(
      { action: 'read', namespace: 'patterns', key: 'test-key' },
      ctx,
    );

    expect(result.success).toBe(true);
  });
});

// ── No Gateway Bypass Path ──────────────────────────────────────────────

describe('commands cannot bypass enforcement', () => {
  it('agent-command with no agent capability is denied', async () => {
    const caps: StepCapability[] = [{ type: 'shell' }];
    const gw = new CapabilityGateway(caps, 'test-task', 'agent');
    const ctx = makeContext(caps, gw);

    const result = await agentCommand.execute(
      { prompt: 'test', agentType: 'coder' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not granted/);
  });

  it('github-command with no shell capability is denied', async () => {
    const caps: StepCapability[] = [{ type: 'memory' }];
    const gw = new CapabilityGateway(caps, 'test-task', 'github');
    const ctx = makeContext(caps, gw);

    const result = await githubCommand.execute(
      { action: 'issue-view' as any, issue: 1 },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not granted/);
  });
});

// ── Disclosure Summary Tests ─────────────────────────────────────────────

describe('discloseStep', () => {
  it('separates granted and denied capabilities', () => {
    const caps: StepCapability[] = [
      { type: 'shell' },
      { type: 'fs:read', scope: ['./config/'] },
    ];
    const summary = discloseStep('db-migrate', caps);

    expect(summary.stepName).toBe('db-migrate');
    expect(summary.granted).toHaveLength(2);
    expect(summary.granted[0].type).toBe('shell');
    expect(summary.granted[1].type).toBe('fs:read');
    expect(summary.granted[1].scope).toEqual(['./config/']);

    expect(summary.denied).toContain('net');
    expect(summary.denied).toContain('agent');
    expect(summary.denied).toContain('memory');
    expect(summary.denied).not.toContain('shell');
    expect(summary.denied).not.toContain('fs:read');
  });
});

describe('discloseSpell', () => {
  it('aggregates capabilities across steps', () => {
    const steps = [
      { name: 'build', caps: [{ type: 'shell' as const }, { type: 'fs:read' as const }] },
      { name: 'deploy', caps: [{ type: 'shell' as const }, { type: 'net' as const }] },
    ];
    const summary = discloseSpell('deploy-staging', steps);

    expect(summary.spellName).toBe('deploy-staging');
    expect(summary.stepCount).toBe(2);
    expect(summary.aggregate.get('shell')).toEqual(['build', 'deploy']);
    expect(summary.aggregate.get('fs:read')).toEqual(['build']);
    expect(summary.aggregate.get('net')).toEqual(['deploy']);
    expect(summary.unused).toContain('agent');
    expect(summary.unused).toContain('memory');
  });
});

describe('formatStepDisclosure', () => {
  it('produces readable output with granted and denied sections', () => {
    const summary = discloseStep('test-step', [
      { type: 'shell' },
      { type: 'fs:read', scope: ['./src/'] },
    ]);
    const output = formatStepDisclosure(summary);

    expect(output).toMatch(/Capabilities:/);
    expect(output).toMatch(/shell/);
    expect(output).toMatch(/fs:read/);
    expect(output).toMatch(/scoped to: \.\/src\//);
    expect(output).toMatch(/This step cannot:/);
    expect(output).toMatch(/access the network/);
  });
});

describe('formatSpellDisclosure', () => {
  it('produces readable output with aggregate and unused sections', () => {
    const summary = discloseSpell('test-wf', [
      { name: 'step-a', caps: [{ type: 'shell' as const }] },
    ]);
    const output = formatSpellDisclosure(summary);

    expect(output).toMatch(/Aggregate capabilities:/);
    expect(output).toMatch(/shell/);
    expect(output).toMatch(/Steps: step-a/);
    expect(output).toMatch(/No steps use:/);
  });
});
