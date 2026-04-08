/**
 * Spell Sandboxing — Runtime Behavioral Tests
 *
 * Replaces the source-string assertions from tests/spell-sandboxing.test.ts
 * (Issue #187). Each test exercises actual runtime behavior rather than
 * scanning source code for string patterns.
 *
 * Covers:
 *   #155: CAPABILITY_DENIED in WorkflowErrorCode
 *   #156: enforceScope runtime enforcement
 *   #157: Credential interpolation bypass
 *   #159: Scoped credentials per-step
 *   #161: checkCapabilities in dry-run
 *   #162: Object.hasOwn in capability validator
 *   #164: Credential redaction hardening
 *   #165: CapabilityType keys in StepDefinition
 *   #166: Capability edge cases
 */

import { describe, it, expect } from 'vitest';
import {
  checkCapabilities,
  enforceScope,
  isValidCapabilityType,
  validateStepCapabilities,
} from '../src/core/capability-validator.js';
import {
  stepReferencesCredentials,
  stepHasCredentialCapability,
  buildCredentialPatterns,
  maskCredentials,
  MIN_REDACT_LENGTH,
} from '../src/core/credential-masker.js';
import { SpellCaster } from '../src/core/runner.js';
import { StepCommandRegistry } from '../src/core/step-command-registry.js';
import { bashCommand } from '../src/commands/bash-command.js';
import type { StepCapability } from '../src/types/step-command.types.js';
import type { SpellDefinition } from '../src/types/workflow-definition.types.js';
import type { WorkflowErrorCode } from '../src/types/runner.types.js';
import { makeStep, makeCommand, makeCredentials, makeMemory } from './helpers.js';

// ============================================================================
// #155 — CAPABILITY_DENIED is a valid WorkflowErrorCode
// ============================================================================

describe('#155 — CAPABILITY_DENIED error code', () => {
  it('runner returns CAPABILITY_DENIED when step has undeclared capabilities', async () => {
    const registry = new StepCommandRegistry();
    const cmd = makeCommand({
      type: 'limited',
      capabilities: [{ type: 'shell' }],
      execute: async () => ({ success: true, data: {} }),
    });
    registry.register(cmd);

    const runner = new SpellCaster(registry, makeCredentials(), makeMemory());
    const workflow: SpellDefinition = {
      name: 'cap-denied-test',
      steps: [{
        id: 'bad-step',
        type: 'limited',
        config: {},
        capabilities: { browser: ['http://example.com'] },
      }],
    };

    const result = await runner.run(workflow, {});
    expect(result.success).toBe(false);
    const failedStep = result.steps.find(s => s.stepId === 'bad-step');
    expect(failedStep?.errorCode).toBe('CAPABILITY_DENIED' satisfies WorkflowErrorCode);
  });
});

// ============================================================================
// #156 — enforceScope runtime behavior
// ============================================================================

describe('#156 — enforceScope runtime enforcement', () => {
  const caps: readonly StepCapability[] = [
    { type: 'fs:read', scope: ['./config/', './data/'] },
    { type: 'shell' },
  ];

  it('returns null for prefix-matched resource within scope', () => {
    const result = enforceScope(caps, 'fs:read', './config/app.json', 'step-1', 'bash');
    expect(result).toBeNull();
  });

  it('returns violation for resources outside scope', () => {
    const result = enforceScope(caps, 'fs:read', './secrets/key.pem', 'step-1', 'bash');
    expect(result).not.toBeNull();
    expect(result!.reason).toContain('outside allowed scope');
    expect(result!.capability).toBe('fs:read');
  });

  it('returns violation when capability type not granted', () => {
    const result = enforceScope(caps, 'net', 'http://example.com', 'step-1', 'bash');
    expect(result).not.toBeNull();
    expect(result!.reason).toContain('not granted');
  });

  it('allows unrestricted access when no scope defined', () => {
    const result = enforceScope(caps, 'shell', 'any-command-here', 'step-1', 'bash');
    expect(result).toBeNull();
  });

  it('normalizes backslashes for cross-platform scope matching', () => {
    const winCaps: readonly StepCapability[] = [
      { type: 'fs:read', scope: ['./config/'] },
    ];
    const result = enforceScope(winCaps, 'fs:read', '.\\config\\file.txt', 'step-1', 'bash');
    expect(result).toBeNull();
  });

  it('returns correct stepId and stepType in violation', () => {
    const result = enforceScope([], 'fs:read', './anything', 'my-step', 'bash');
    expect(result).not.toBeNull();
    expect(result!.stepId).toBe('my-step');
    expect(result!.stepType).toBe('bash');
  });
});

// ============================================================================
// #157 — Credential interpolation bypass closed
// ============================================================================

describe('#157 — Credential interpolation bypass', () => {
  it('runner blocks credential access when command lacks credentials capability', async () => {
    const registry = new StepCommandRegistry();
    const cmd = makeCommand({
      type: 'no-creds',
      capabilities: [{ type: 'shell' }],
    });
    registry.register(cmd);

    const runner = new SpellCaster(
      registry,
      makeCredentials({ API_KEY: 'secret-value' }),
      makeMemory(),
    );
    const workflow: SpellDefinition = {
      name: 'cred-bypass-test',
      steps: [{
        id: 'sneaky-step',
        type: 'no-creds',
        config: { command: 'echo {credentials.API_KEY}' },
      }],
    };

    const result = await runner.run(workflow, {});
    expect(result.success).toBe(false);
    const step = result.steps.find(s => s.stepId === 'sneaky-step');
    expect(step?.errorCode).toBe('CAPABILITY_DENIED');
  });

  it('runner allows credential access when command declares credentials capability', async () => {
    const registry = new StepCommandRegistry();
    const cmd = makeCommand({
      type: 'with-creds',
      capabilities: [{ type: 'credentials' }],
      execute: async (_config, ctx) => {
        const creds = (ctx.variables as Record<string, unknown>).credentials as Record<string, unknown>;
        return { success: true, data: { hasKey: creds?.API_KEY !== undefined } };
      },
    });
    registry.register(cmd);

    const runner = new SpellCaster(
      registry,
      makeCredentials({ API_KEY: 'secret-value' }),
      makeMemory(),
    );
    const workflow: SpellDefinition = {
      name: 'cred-allowed-test',
      steps: [{
        id: 'legit-step',
        type: 'with-creds',
        config: { token: '{credentials.API_KEY}' },
      }],
    };

    const result = await runner.run(workflow, {});
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// #159 — Scoped credentials per-step
// ============================================================================

describe('#159 — Scoped credential access per-step', () => {
  it('each step only receives the credentials it references', async () => {
    const registry = new StepCommandRegistry();
    const capturedCreds: Record<string, unknown>[] = [];
    const cmd = makeCommand({
      type: 'cred-cmd',
      capabilities: [{ type: 'credentials' }],
      execute: async (_config, ctx) => {
        const creds = (ctx.variables as Record<string, unknown>).credentials;
        capturedCreds.push({ ...creds as Record<string, unknown> });
        return { success: true, data: {} };
      },
    });
    registry.register(cmd);

    const runner = new SpellCaster(
      registry,
      makeCredentials({ KEY_A: 'val-a', KEY_B: 'val-b', KEY_C: 'val-c' }),
      makeMemory(),
    );
    const workflow: SpellDefinition = {
      name: 'scoped-creds-test',
      steps: [
        { id: 'step-a', type: 'cred-cmd', config: { x: '{credentials.KEY_A}' } },
        { id: 'step-b', type: 'cred-cmd', config: { y: '{credentials.KEY_B}' } },
      ],
    };

    const result = await runner.run(workflow, {});
    expect(result.success).toBe(true);
    expect(capturedCreds[0]).toHaveProperty('KEY_A');
    expect(capturedCreds[0]).not.toHaveProperty('KEY_B');
    expect(capturedCreds[1]).toHaveProperty('KEY_B');
    expect(capturedCreds[1]).not.toHaveProperty('KEY_A');
  });

  it('credentials are NOT placed in shared variables object', async () => {
    const registry = new StepCommandRegistry();
    const capturedVars: Record<string, unknown>[] = [];
    const cmd = makeCommand({
      type: 'var-spy',
      capabilities: [{ type: 'shell' }],
      execute: async (_config, ctx) => {
        capturedVars.push({ ...ctx.variables });
        return { success: true, data: { out: 'done' } };
      },
    });
    registry.register(cmd);

    const runner = new SpellCaster(
      registry,
      makeCredentials({ SECRET: 'hidden' }),
      makeMemory(),
    );
    const workflow: SpellDefinition = {
      name: 'no-shared-creds',
      steps: [
        { id: 'step-1', type: 'var-spy', config: { command: 'echo test' } },
      ],
    };

    const result = await runner.run(workflow, {});
    expect(result.success).toBe(true);
    expect(capturedVars[0]).not.toHaveProperty('credentials');
  });
});

// ============================================================================
// #161 — checkCapabilities in dry-run validation
// ============================================================================

describe('#161 — dry-run validates capabilities', () => {
  it('dry-run reports capability violations without executing', async () => {
    const registry = new StepCommandRegistry();
    const cmd = makeCommand({
      type: 'limited',
      capabilities: [{ type: 'shell' }],
    });
    registry.register(cmd);

    const runner = new SpellCaster(registry, makeCredentials(), makeMemory());
    const workflow: SpellDefinition = {
      name: 'dry-run-cap-test',
      steps: [{
        id: 'bad-step',
        type: 'limited',
        config: {},
        capabilities: { browser: ['http://evil.com'] },
      }],
    };

    const result = await runner.run(workflow, {}, { dryRun: true });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// #162 — Object.hasOwn protects against prototype pollution
// ============================================================================

describe('#162 — Object.hasOwn in capability validator', () => {
  it('prototype-polluted stepRestrictions do not cause false positives', () => {
    // Prototype has 'shell' but Object.hasOwn should ignore it
    const polluted = Object.create({ shell: ['echo'] });
    const step = makeStep({ capabilities: polluted });
    const result = checkCapabilities(step, bashCommand);
    expect(result.allowed).toBe(true);
    const shellCap = result.effectiveCaps.find(c => c.type === 'shell');
    expect(shellCap?.scope).toBeUndefined();
  });
});

// ============================================================================
// #164 — Credential redaction hardening
// ============================================================================

describe('#164 — Credential redaction', () => {
  it('skips redaction for short values (< MIN_REDACT_LENGTH)', () => {
    const patterns = buildCredentialPatterns(['ab']);
    expect(patterns).toHaveLength(0);
  });

  it('redacts values at or above MIN_REDACT_LENGTH', () => {
    const patterns = buildCredentialPatterns(['a'.repeat(MIN_REDACT_LENGTH)]);
    expect(patterns).toHaveLength(1);
  });

  it('handles JSON corruption from redaction gracefully', () => {
    const output = { success: true as const, data: { key: 'value' } };
    const corruptingPattern = new RegExp('":"', 'g');
    const masked = maskCredentials(output, [corruptingPattern]);
    expect(masked.data).toHaveProperty('_redacted', true);
  });
});

// ============================================================================
// #165 — StepDefinition.capabilities uses CapabilityType keys
// ============================================================================

describe('#165 — CapabilityType keys in step capabilities', () => {
  it('validateStepCapabilities rejects non-CapabilityType keys', () => {
    const step = makeStep({
      capabilities: { 'invalid-type': ['scope'] } as Record<string, readonly string[]>,
    });
    const errors = validateStepCapabilities(step, 'steps[0]');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('unknown capability type');
  });

  it('validateStepCapabilities accepts valid CapabilityType keys', () => {
    const step = makeStep({
      capabilities: { 'fs:read': ['./src/'], shell: ['echo'] },
    });
    const errors = validateStepCapabilities(step, 'steps[0]');
    expect(errors).toHaveLength(0);
  });

  it('checkCapabilities rejects unknown capability type at runtime', () => {
    const step = makeStep({
      capabilities: { 'teleport': ['anywhere'] } as Record<string, readonly string[]>,
    });
    const result = checkCapabilities(step, bashCommand);
    expect(result.allowed).toBe(false);
    expect(result.violations[0].reason).toContain('unknown capability type');
  });
});

// ============================================================================
// #166 — Additional capability edge cases
// ============================================================================

describe('#166 — Capability edge cases', () => {
  it('rejects granting capabilities the command does not declare', () => {
    const step = makeStep({ capabilities: { net: ['example.com'] } });
    const result = checkCapabilities(step, bashCommand);
    expect(result.allowed).toBe(false);
    expect(result.violations[0].reason).toContain('cannot grant new capabilities');
  });

  it('credentials is a valid capability type', () => {
    expect(isValidCapabilityType('credentials')).toBe(true);
  });

  it('stepHasCredentialCapability detects credentials in command capabilities', () => {
    const step = makeStep();
    const withCreds = makeCommand({ capabilities: [{ type: 'credentials' }] });
    const withoutCreds = makeCommand({ capabilities: [{ type: 'shell' }] });
    expect(stepHasCredentialCapability(step, withCreds)).toBe(true);
    expect(stepHasCredentialCapability(step, withoutCreds)).toBe(false);
  });

  it('stepReferencesCredentials detects {credentials.*} in config', () => {
    const withRef = makeStep({ config: { token: '{credentials.TOKEN}' } });
    const withoutRef = makeStep({ config: { command: 'echo hello' } });
    expect(stepReferencesCredentials(withRef)).toBe(true);
    expect(stepReferencesCredentials(withoutRef)).toBe(false);
  });
});
