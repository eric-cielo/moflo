/**
 * GitHub CLI Workflow Tool Tests
 *
 * Issue #219: Tests for the extracted github-cli shipped tool.
 * Uses mocked `exec` to avoid real GitHub CLI calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { githubCliTool, validateGitHubAction, VALID_ACTIONS } from '../src/tools/github-cli.js';

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

function setMockResult(stdout: string, exitCode = 0, stderr = '') {
  mockExecResult = { stdout, stderr, exitCode };
}

// ============================================================================
// Interface compliance
// ============================================================================

describe('githubCliTool — interface', () => {
  it('has correct name and version', () => {
    expect(githubCliTool.name).toBe('github-cli');
    expect(githubCliTool.version).toBe('1.0.0');
    expect(githubCliTool.description).toBeTruthy();
  });

  it('declares read and write capabilities', () => {
    expect(githubCliTool.capabilities).toContain('read');
    expect(githubCliTool.capabilities).toContain('write');
  });

  it('listActions returns 8 actions', () => {
    const actions = githubCliTool.listActions();
    expect(actions).toHaveLength(8);
    const names = actions.map(a => a.name);
    expect(names).toEqual([...VALID_ACTIONS]);
  });

  it('each action has input and output schemas', () => {
    for (const action of githubCliTool.listActions()) {
      expect(action.inputSchema).toBeDefined();
      expect(action.inputSchema.type).toBe('object');
      expect(action.outputSchema).toBeDefined();
      expect(action.description).toBeTruthy();
    }
  });

  it('initialize checks for gh CLI', async () => {
    setMockResult('', 0);
    // With mock returning success, initialize should pass
    await expect(githubCliTool.initialize({})).resolves.toBeUndefined();
  });

  it('dispose is a no-op', async () => {
    await expect(githubCliTool.dispose()).resolves.toBeUndefined();
  });
});

// ============================================================================
// Validation
// ============================================================================

describe('githubCliTool — validateGitHubAction', () => {
  it('rejects missing action', () => {
    const errors = validateGitHubAction('', {});
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('action must be one of');
  });

  it('rejects unknown action', () => {
    const errors = validateGitHubAction('destroy-repo', {});
    expect(errors.length).toBeGreaterThan(0);
  });

  it('validates issue-fetch requires issue', () => {
    const errors = validateGitHubAction('issue-fetch', {});
    expect(errors[0]).toContain('issue number');
  });

  it('validates pr-create requires title', () => {
    const errors = validateGitHubAction('pr-create', {});
    expect(errors[0]).toContain('title');
  });

  it('validates pr-merge requires pr or issue', () => {
    const errors = validateGitHubAction('pr-merge', {});
    expect(errors.length).toBeGreaterThan(0);
  });

  it('validates pr-merge rejects invalid merge method', () => {
    const errors = validateGitHubAction('pr-merge', { pr: 1, mergeMethod: 'fast-forward' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes('mergeMethod'))).toBe(true);
  });

  it('validates pr-find requires head or search', () => {
    const errors = validateGitHubAction('pr-find', {});
    expect(errors.length).toBeGreaterThan(0);
  });

  it('validates label requires issue and labels', () => {
    const errors = validateGitHubAction('label', {});
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it('validates comment requires body', () => {
    const errors = validateGitHubAction('comment', { issue: 1 });
    expect(errors[0]).toContain('body');
  });

  it('accepts valid repo-info (no params)', () => {
    const errors = validateGitHubAction('repo-info', {});
    expect(errors).toHaveLength(0);
  });
});

// ============================================================================
// Execution
// ============================================================================

describe('githubCliTool — execute', () => {
  beforeEach(() => {
    setMockResult('', 0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('issue-fetch returns parsed JSON', async () => {
    setMockResult(JSON.stringify({ number: 42, title: 'Test', state: 'OPEN' }));
    const output = await githubCliTool.execute('issue-fetch', { issue: 42 });
    expect(output.success).toBe(true);
    expect(output.data.number).toBe(42);
    expect(output.data.title).toBe('Test');
    expect(output.duration).toBeGreaterThanOrEqual(0);
  });

  it('issue-edit returns success', async () => {
    setMockResult('');
    const output = await githubCliTool.execute('issue-edit', { issue: 42, title: 'Updated' });
    expect(output.success).toBe(true);
    expect(output.data.updated).toBe(true);
  });

  it('pr-create returns prUrl and prNumber', async () => {
    setMockResult('https://github.com/org/repo/pull/99');
    const output = await githubCliTool.execute('pr-create', { title: 'feat: new', body: 'desc' });
    expect(output.success).toBe(true);
    expect(output.data.prUrl).toBe('https://github.com/org/repo/pull/99');
    expect(output.data.prNumber).toBe(99);
  });

  it('pr-merge returns merge result', async () => {
    setMockResult('');
    const output = await githubCliTool.execute('pr-merge', { pr: 99, mergeMethod: 'squash' });
    expect(output.success).toBe(true);
    expect(output.data.merged).toBe(true);
    expect(output.data.method).toBe('squash');
  });

  it('pr-find returns matching PRs', async () => {
    setMockResult(JSON.stringify([{ number: 5, title: 'fix' }]));
    const output = await githubCliTool.execute('pr-find', { head: 'feature/test' });
    expect(output.success).toBe(true);
    expect(output.data.prs).toHaveLength(1);
    expect(output.data.count).toBe(1);
  });

  it('label adds and removes labels', async () => {
    setMockResult('');
    const output = await githubCliTool.execute('label', {
      issue: 42,
      labels: { add: ['bug'], remove: ['wontfix'] },
    });
    expect(output.success).toBe(true);
    expect(output.data.labelsAdded).toEqual(['bug']);
    expect(output.data.labelsRemoved).toEqual(['wontfix']);
  });

  it('comment posts body', async () => {
    setMockResult('');
    const output = await githubCliTool.execute('comment', { issue: 42, body: 'LGTM' });
    expect(output.success).toBe(true);
    expect(output.data.commented).toBe(true);
  });

  it('repo-info returns parsed JSON', async () => {
    setMockResult(JSON.stringify({ name: 'moflo', owner: { login: 'eric-cielo' } }));
    const output = await githubCliTool.execute('repo-info', {});
    expect(output.success).toBe(true);
    expect(output.data.name).toBe('moflo');
  });

  it('returns error on CLI failure', async () => {
    setMockResult('', 1, 'GraphQL error');
    const output = await githubCliTool.execute('issue-fetch', { issue: 999 });
    expect(output.success).toBe(false);
    expect(output.error).toContain('GraphQL error');
  });

  it('returns error for unknown action', async () => {
    const output = await githubCliTool.execute('destroy-repo', {});
    expect(output.success).toBe(false);
    expect(output.error).toContain('action must be one of');
  });

  it('returns validation error for missing required params', async () => {
    const output = await githubCliTool.execute('issue-fetch', {});
    expect(output.success).toBe(false);
    expect(output.error).toContain('issue number');
  });
});
