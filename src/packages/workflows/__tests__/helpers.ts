/**
 * Shared test helpers for workflow tests.
 */

import type {
  WorkflowContext,
  CredentialAccessor,
  MemoryAccessor,
} from '../src/types/step-command.types.js';

export function createMockContext(overrides?: Partial<WorkflowContext>): WorkflowContext {
  const credentials: CredentialAccessor = {
    async get() { return undefined; },
    async has() { return false; },
  };
  const memory: MemoryAccessor = {
    async read() { return null; },
    async write() {},
    async search() { return []; },
  };
  return {
    variables: {},
    args: {},
    credentials,
    memory,
    taskId: 'test',
    workflowId: 'wf-1',
    stepIndex: 0,
    ...overrides,
  };
}
