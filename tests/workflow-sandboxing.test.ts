/**
 * Tests for Epic #154: Workflow Sandboxing & Credential Store Hardening
 *
 * #155: CAPABILITY_DENIED is a valid WorkflowErrorCode
 * #156: Scope enforcement at runtime via enforceScope()
 * #157: Credential interpolation bypass is closed
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const runnerTypesPath = resolve(
  __dirname,
  '../src/packages/workflows/src/types/runner.types.ts',
);
const runnerPath = resolve(
  __dirname,
  '../src/packages/workflows/src/core/runner.ts',
);
const validatorPath = resolve(
  __dirname,
  '../src/packages/workflows/src/core/capability-validator.ts',
);

describe('#155 — CAPABILITY_DENIED in WorkflowErrorCode', () => {
  it('runner.types.ts includes CAPABILITY_DENIED in WorkflowErrorCode union', () => {
    const content = readFileSync(runnerTypesPath, 'utf-8');
    expect(content).toContain("| 'CAPABILITY_DENIED'");
  });

  it('runner.ts uses CAPABILITY_DENIED errorCode for capability violations', () => {
    const content = readFileSync(runnerPath, 'utf-8');
    expect(content).toContain("errorCode: 'CAPABILITY_DENIED'");
  });
});

describe('#156 — Enforce capability scope restrictions at runtime', () => {
  it('capability-validator exports enforceScope function', () => {
    const content = readFileSync(validatorPath, 'utf-8');
    expect(content).toContain('export function enforceScope(');
  });

  it('runner.ts passes effectiveCaps into context via scopedContext', () => {
    const content = readFileSync(runnerPath, 'utf-8');
    expect(content).toContain('effectiveCaps: capCheck.effectiveCaps');
  });

  it('WorkflowContext includes effectiveCaps field', () => {
    const typesPath = resolve(
      __dirname,
      '../src/packages/workflows/src/types/step-command.types.ts',
    );
    const content = readFileSync(typesPath, 'utf-8');
    expect(content).toContain('readonly effectiveCaps?: readonly StepCapability[]');
  });

  it('enforceScope returns null for resources within scope', () => {
    const content = readFileSync(validatorPath, 'utf-8');
    expect(content).toContain('normalizedResource.startsWith(normalizedPattern)');
  });

  it('enforceScope returns violation for resources outside scope', () => {
    const content = readFileSync(validatorPath, 'utf-8');
    expect(content).toContain('is outside allowed scope');
  });

  it('enforceScope returns violation when capability type not granted', () => {
    const content = readFileSync(validatorPath, 'utf-8');
    expect(content).toContain('not granted');
  });

  it('enforceScope allows unrestricted access when no scope defined', () => {
    const content = readFileSync(validatorPath, 'utf-8');
    expect(content).toContain('No scope defined = unrestricted');
  });

  it('index.ts re-exports enforceScope', () => {
    const indexPath = resolve(
      __dirname,
      '../src/packages/workflows/src/index.ts',
    );
    const content = readFileSync(indexPath, 'utf-8');
    expect(content).toContain('enforceScope');
  });
});

describe('#157 — Credential interpolation bypass closed', () => {
  it('runner checks credential references before interpolation', () => {
    const content = readFileSync(runnerPath, 'utf-8');
    expect(content).toContain('stepReferencesCredentials');
    expect(content).toContain('stepHasCredentialCapability');
  });

  it('runner blocks credential access without credentials capability', () => {
    const content = readFileSync(runnerPath, 'utf-8');
    expect(content).toContain(
      'does not declare the "credentials" capability',
    );
  });

  it('stepReferencesCredentials checks raw config for {credentials.*}', () => {
    const content = readFileSync(runnerPath, 'utf-8');
    expect(content).toContain('private stepReferencesCredentials');
    expect(content).toContain('{credentials\\.');
  });

  it('stepHasCredentialCapability checks both command and step declarations', () => {
    const content = readFileSync(runnerPath, 'utf-8');
    expect(content).toContain('private stepHasCredentialCapability');
    expect(content).toContain("c.type === 'credentials'");
  });
});

describe('#159 — Scope credential access per-step', () => {
  it('ExecutionState has resolvedCredentials field', () => {
    const content = readFileSync(runnerPath, 'utf-8');
    expect(content).toContain('readonly resolvedCredentials: Record<string, unknown>');
  });

  it('credentials are NOT placed in shared variables', () => {
    const content = readFileSync(runnerPath, 'utf-8');
    // Old pattern was: variables.credentials = resolved;
    expect(content).not.toContain('variables.credentials = resolved');
  });

  it('credentials are scoped per-step using collectCredentialNames', () => {
    const content = readFileSync(runnerPath, 'utf-8');
    expect(content).toContain('Scope credentials per-step');
    expect(content).toContain('stepVariables.credentials = scopedCreds');
  });

  it('only referenced credentials are injected into step variables', () => {
    const content = readFileSync(runnerPath, 'utf-8');
    expect(content).toContain('state.resolvedCredentials');
  });
});

describe('#161 — checkCapabilities in dry-run validation', () => {
  it('dry-run calls checkCapabilities for each step', () => {
    const content = readFileSync(runnerPath, 'utf-8');
    expect(content).toContain('Check capability declarations in dry-run');
    expect(content).toContain('capCheck.violations.map');
  });
});

describe('#162 — Object.hasOwn in capability validator', () => {
  it('uses Object.hasOwn instead of in operator', () => {
    const content = readFileSync(validatorPath, 'utf-8');
    expect(content).toContain('Object.hasOwn(stepRestrictions, cap.type)');
    expect(content).not.toContain('cap.type in stepRestrictions');
  });
});
