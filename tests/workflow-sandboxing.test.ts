/**
 * Tests for Epic #154: Workflow Sandboxing & Credential Store Hardening
 *
 * #155: CAPABILITY_DENIED is a valid WorkflowErrorCode
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const runnerTypesPath = resolve(
  __dirname,
  '../src/packages/workflows/src/types/runner.types.ts',
);

describe('#155 — CAPABILITY_DENIED in WorkflowErrorCode', () => {
  it('runner.types.ts includes CAPABILITY_DENIED in WorkflowErrorCode union', () => {
    const content = readFileSync(runnerTypesPath, 'utf-8');
    expect(content).toContain("| 'CAPABILITY_DENIED'");
  });

  it('runner.ts uses CAPABILITY_DENIED errorCode for capability violations', () => {
    const runnerPath = resolve(
      __dirname,
      '../src/packages/workflows/src/core/runner.ts',
    );
    const content = readFileSync(runnerPath, 'utf-8');
    expect(content).toContain("errorCode: 'CAPABILITY_DENIED'");
  });
});
