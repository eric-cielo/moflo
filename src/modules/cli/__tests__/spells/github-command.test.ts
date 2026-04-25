/**
 * GitHub Step Command Tests
 *
 * Story #194: Tests for the github step command.
 * Uses mocked `exec` to avoid real GitHub CLI calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { githubCommand } from '../../src/spells/commands/github-command.js';
import type { GitHubStepConfig } from '../../src/spells/commands/github-command.js';
import type { CastingContext, MemoryAccessor, CredentialAccessor } from '../../src/spells/types/step-command.types.js';
import { ALLOW_ALL_GATEWAY } from './helpers.js';

// ============================================================================
// Mock child_process (exec + execFile for prerequisite-checker)
// ============================================================================

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

let mockExecResult: { stdout: string; stderr: string; exitCode: number } = {
  stdout: '', stderr: '', exitCode: 0,
};

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    exec: (_cmd: string, _opts: unknown, callback: ExecCallback) => {
      const child = {
        exitCode: mockExecResult.exitCode,
        kill: vi.fn(),
      };
      process.nextTick(() => {
        callback(
          mockExecResult.exitCode !== 0 ? new Error('command failed') : null,
          mockExecResult.stdout,
          mockExecResult.stderr,
        );
      });
      return child;
    },
  };
});

// ============================================================================
// Helpers
// ============================================================================

function makeContext(overrides?: Partial<CastingContext>): CastingContext {
  return {
    variables: {},
    args: {},
    credentials: { get: async () => undefined, has: async () => false } as CredentialAccessor,
    memory: {
      read: async () => null,
      write: async () => {},
      search: async () => [],
    } as MemoryAccessor,
    taskId: 'test-task',
    spellId: 'test-wf',
    stepIndex: 0,
    gateway: ALLOW_ALL_GATEWAY,
    ...overrides,
  };
}

function setMockResult(stdout: string, exitCode = 0, stderr = '') {
  mockExecResult = { stdout, stderr, exitCode };
}

// ============================================================================
// Registration
// ============================================================================

describe('githubCommand — registration', () => {
  it('has type "github"', () => {
    expect(githubCommand.type).toBe('github');
  });

  it('declares shell and net capabilities', () => {
    expect(githubCommand.capabilities).toEqual([{ type: 'shell' }, { type: 'net' }]);
  });

  it('has gh and gh-auth prerequisites', () => {
    expect(githubCommand.prerequisites).toHaveLength(2);
    expect(githubCommand.prerequisites![0].name).toBe('gh');
    expect(githubCommand.prerequisites![1].name).toBe('gh-auth');
  });

  it('has rollback handler', () => {
    expect(githubCommand.rollback).toBeDefined();
  });
});

// ============================================================================
// Validation
// ============================================================================

describe('githubCommand — validation', () => {
  it('rejects missing action', () => {
    const result = githubCommand.validate({} as GitHubStepConfig, makeContext());
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('action must be one of');
  });

  it('rejects unknown action', () => {
    const result = githubCommand.validate(
      { action: 'destroy-repo' } as unknown as GitHubStepConfig,
      makeContext(),
    );
    expect(result.valid).toBe(false);
  });

  it('validates issue-fetch requires issue number', () => {
    const result = githubCommand.validate({ action: 'issue-fetch' } as GitHubStepConfig, makeContext());
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('issue number');
  });

  it('validates pr-create requires title', () => {
    const result = githubCommand.validate({ action: 'pr-create' } as GitHubStepConfig, makeContext());
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('title');
  });

  it('validates pr-merge requires pr number', () => {
    const result = githubCommand.validate({ action: 'pr-merge' } as GitHubStepConfig, makeContext());
    expect(result.valid).toBe(false);
  });

  it('validates pr-merge rejects invalid merge method', () => {
    const result = githubCommand.validate(
      { action: 'pr-merge', pr: 1, mergeMethod: 'fast-forward' } as unknown as GitHubStepConfig,
      makeContext(),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('mergeMethod');
  });

  it('validates pr-find requires head or search', () => {
    const result = githubCommand.validate({ action: 'pr-find' } as GitHubStepConfig, makeContext());
    expect(result.valid).toBe(false);
  });

  it('validates label requires issue and labels', () => {
    const result = githubCommand.validate({ action: 'label' } as GitHubStepConfig, makeContext());
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('validates comment requires body', () => {
    const result = githubCommand.validate({ action: 'comment', issue: 1 } as GitHubStepConfig, makeContext());
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('body');
  });

  it('accepts valid issue-fetch config', () => {
    const result = githubCommand.validate({ action: 'issue-fetch', issue: 42 } as GitHubStepConfig, makeContext());
    expect(result.valid).toBe(true);
  });

  it('accepts valid pr-create config', () => {
    const result = githubCommand.validate(
      { action: 'pr-create', title: 'feat: new' } as GitHubStepConfig,
      makeContext(),
    );
    expect(result.valid).toBe(true);
  });

  it('accepts repo-info without extra fields', () => {
    const result = githubCommand.validate({ action: 'repo-info' } as GitHubStepConfig, makeContext());
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// Execution
// ============================================================================

describe('githubCommand — execution', () => {
  beforeEach(() => {
    setMockResult('', 0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('issue-fetch returns parsed JSON', async () => {
    setMockResult(JSON.stringify({ number: 42, title: 'Test', state: 'OPEN' }));
    const output = await githubCommand.execute(
      { action: 'issue-fetch', issue: 42 } as GitHubStepConfig,
      makeContext(),
    );
    expect(output.success).toBe(true);
    expect(output.data.number).toBe(42);
    expect(output.data.title).toBe('Test');
  });

  it('issue-edit returns success', async () => {
    setMockResult('');
    const output = await githubCommand.execute(
      { action: 'issue-edit', issue: 42, title: 'Updated' } as GitHubStepConfig,
      makeContext(),
    );
    expect(output.success).toBe(true);
    expect(output.data.updated).toBe(true);
  });

  it('pr-create returns prUrl and prNumber', async () => {
    setMockResult('https://github.com/org/repo/pull/99');
    const output = await githubCommand.execute(
      { action: 'pr-create', title: 'feat: new', body: 'desc' } as GitHubStepConfig,
      makeContext(),
    );
    expect(output.success).toBe(true);
    expect(output.data.prUrl).toBe('https://github.com/org/repo/pull/99');
    expect(output.data.prNumber).toBe(99);
  });

  it('pr-merge returns merge result', async () => {
    setMockResult('');
    const output = await githubCommand.execute(
      { action: 'pr-merge', pr: 99, mergeMethod: 'squash' } as GitHubStepConfig,
      makeContext(),
    );
    expect(output.success).toBe(true);
    expect(output.data.merged).toBe(true);
    expect(output.data.method).toBe('squash');
  });

  it('pr-find returns matching PRs', async () => {
    setMockResult(JSON.stringify([{ number: 5, title: 'fix' }]));
    const output = await githubCommand.execute(
      { action: 'pr-find', head: 'feature/test' } as GitHubStepConfig,
      makeContext(),
    );
    expect(output.success).toBe(true);
    expect(output.data.prs).toHaveLength(1);
    expect(output.data.count).toBe(1);
  });

  it('label adds and removes labels', async () => {
    setMockResult('');
    const output = await githubCommand.execute(
      { action: 'label', issue: 42, labels: { add: ['bug'], remove: ['wontfix'] } } as GitHubStepConfig,
      makeContext(),
    );
    expect(output.success).toBe(true);
    expect(output.data.labelsAdded).toEqual(['bug']);
    expect(output.data.labelsRemoved).toEqual(['wontfix']);
  });

  it('comment posts body', async () => {
    setMockResult('');
    const output = await githubCommand.execute(
      { action: 'comment', issue: 42, body: 'LGTM' } as GitHubStepConfig,
      makeContext(),
    );
    expect(output.success).toBe(true);
    expect(output.data.commented).toBe(true);
  });

  it('repo-info returns parsed JSON', async () => {
    setMockResult(JSON.stringify({ name: 'moflo', owner: { login: 'eric-cielo' } }));
    const output = await githubCommand.execute(
      { action: 'repo-info' } as GitHubStepConfig,
      makeContext(),
    );
    expect(output.success).toBe(true);
    expect(output.data.name).toBe('moflo');
  });

  it('returns error on CLI failure', async () => {
    setMockResult('', 1, 'GraphQL error');
    const output = await githubCommand.execute(
      { action: 'issue-fetch', issue: 999 } as GitHubStepConfig,
      makeContext(),
    );
    expect(output.success).toBe(false);
    expect(output.error).toContain('GraphQL error');
  });
});

// ============================================================================
// Rollback
// ============================================================================

describe('githubCommand — rollback', () => {
  it('attempts to close PR on pr-create rollback', async () => {
    setMockResult('');
    await githubCommand.rollback!(
      { action: 'pr-create', title: 'test', head: 'feature/test' } as GitHubStepConfig,
      makeContext(),
    );
    // Doesn't throw — rollback is best-effort
  });

  it('does nothing for non-pr-create actions', async () => {
    await githubCommand.rollback!(
      { action: 'issue-fetch', issue: 42 } as GitHubStepConfig,
      makeContext(),
    );
    // No error — rollback is a no-op for most actions
  });
});

// ============================================================================
// Variable interpolation
// ============================================================================

describe('githubCommand — interpolation', () => {
  it('interpolates variables in title and body', async () => {
    setMockResult('https://github.com/org/repo/pull/1');
    const ctx = makeContext({ variables: { version: '2.0' } });
    const output = await githubCommand.execute(
      { action: 'pr-create', title: 'Release ${version}', body: 'v${version} release' } as GitHubStepConfig,
      ctx,
    );
    expect(output.success).toBe(true);
  });
});
