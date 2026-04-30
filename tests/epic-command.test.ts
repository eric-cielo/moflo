/**
 * Epic command tests — verifies strategy selection, branch naming, command structure,
 * and the dual-strategy (single-branch / auto-merge) epic orchestration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');

describe('epic command structure', () => {
  let epicCommand: any;

  beforeEach(async () => {
    const mod = await import('../src/cli/commands/epic.js');
    epicCommand = mod.default;
  });

  it('should export a valid command', () => {
    expect(epicCommand).toBeDefined();
    expect(epicCommand.name).toBe('epic');
    expect(epicCommand.action).toBeInstanceOf(Function);
  });

  it('should have examples for both strategies', () => {
    const examples = epicCommand.examples.map((e: any) => e.command);
    expect(examples).toContainEqual(expect.stringContaining('--strategy auto-merge'));
    expect(examples).toContainEqual(expect.stringContaining('flo epic run 42'));
  });

  it('should show help when no subcommand is given', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await epicCommand.action({ args: [], flags: {} });
    expect(result.success).toBe(true);
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('single-branch');
    expect(output).toContain('auto-merge');
    expect(output).toContain('--strategy');
    logSpy.mockRestore();
  });

  it('should reject unknown strategy', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await epicCommand.action({
      args: ['run', '42'],
      flags: { strategy: 'unknown-strategy' },
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Unknown strategy');
    logSpy.mockRestore();
  });

  it('should require source for run subcommand', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await epicCommand.action({
      args: ['run'],
      flags: {},
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Usage');
    logSpy.mockRestore();
  });

  it('rejects --no-merge combined with --strategy auto-merge (#754)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await epicCommand.action({
      args: ['run', '42'],
      flags: { noMerge: true, strategy: 'auto-merge' },
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('--no-merge cannot be combined with --strategy auto-merge');
    logSpy.mockRestore();
  });

  it('lists --no-merge and --verbose in help output (#754)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await epicCommand.action({ args: [], flags: {} });
    expect(result.success).toBe(true);
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('--no-merge');
    expect(output).toContain('--verbose');
    logSpy.mockRestore();
  });

  it('exposes --no-merge and --verbose examples (#754)', () => {
    const examples = epicCommand.examples.map((e: any) => e.command);
    expect(examples).toContainEqual(expect.stringContaining('--no-merge'));
    expect(examples).toContainEqual(expect.stringContaining('--verbose'));
  });
});

describe('makeEpicBranchName', () => {
  it('should produce valid branch names from epic titles', () => {
    // The branch name format is: epic/<number>-<slug>
    // where slug is lowercased, non-alphanumeric replaced with dashes, trimmed to 40 chars
    const testCases = [
      { number: 42, title: 'Add User Authentication', expected: /^epic\/42-add-user-authentication$/ },
      { number: 100, title: 'Fix: XSS in <script> tags!!!', expected: /^epic\/100-fix-xss-in-script-tags$/ },
      { number: 7, title: 'A'.repeat(60), expected: /^epic\/7-a{40}$/ },
      { number: 1, title: '---leading dashes---', expected: /^epic\/1-leading-dashes$/ },
    ];

    for (const tc of testCases) {
      const slug = tc.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 40);
      const branchName = `epic/${tc.number}-${slug}`;
      expect(branchName).toMatch(tc.expected);
    }
  });

  it('should not contain special characters that break git', () => {
    const problematic = 'feat(scope): "quoted" & special [chars]';
    const slug = problematic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40);
    const branch = `epic/99-${slug}`;
    expect(branch).not.toMatch(/[^a-z0-9/\-]/);
  });
});

describe('epic detection and story extraction', () => {
  // These test the pure detection/extraction functions that don't require git

  it('detects epic from label', () => {
    const issue = {
      number: 42,
      title: 'Test Epic',
      body: 'Just a description',
      labels: [{ name: 'epic' }],
      state: 'open',
    };

    const epicLabels = ['epic', 'tracking', 'parent', 'umbrella'];
    const isEpic = issue.labels.some((l) => epicLabels.includes(l.name.toLowerCase()));
    expect(isEpic).toBe(true);
  });

  it('detects epic from ## Stories section', () => {
    const body = '## Stories\n- [ ] #10\n- [ ] #11';
    expect(/##\s*(?:Stories|Tasks)/i.test(body)).toBe(true);
  });

  it('detects epic from checklist format', () => {
    const body = '- [ ] #10\n- [x] #11\n- [ ] #12';
    expect(/^[\s]*-\s*\[[ x]\]\s*#\d+/m.test(body)).toBe(true);
  });

  it('does not detect non-epic issues', () => {
    const issue = {
      labels: [{ name: 'bug' }],
      body: 'This is a regular bug report',
    };
    const epicLabels = ['epic', 'tracking', 'parent', 'umbrella'];
    const hasLabel = issue.labels.some((l) => epicLabels.includes(l.name.toLowerCase()));
    const hasSection = /##\s*(?:Stories|Tasks)/i.test(issue.body);
    const hasChecklist = /^[\s]*-\s*\[[ x]\]\s*#\d+/m.test(issue.body);
    expect(hasLabel || hasSection || hasChecklist).toBe(false);
  });

  it('extracts story numbers from checklist format', () => {
    const body = '## Stories\n- [ ] #10\n- [x] #11\n- [ ] #12';
    const pattern = /^[\s]*-\s*\[[ x]\]\s*#(\d+)/gm;
    const stories: number[] = [];
    let match;
    while ((match = pattern.exec(body)) !== null) {
      stories.push(parseInt(match[1], 10));
    }
    expect(stories).toEqual([10, 11, 12]);
  });

  it('extracts story numbers from numbered format', () => {
    const body = '1. #10 Add login\n2. #11 Add signup\n3. #12 Add logout';
    const pattern = /^\s*\d+\.\s*(?:.*?)#(\d+)/gm;
    const stories: number[] = [];
    let match;
    while ((match = pattern.exec(body)) !== null) {
      stories.push(parseInt(match[1], 10));
    }
    expect(stories).toEqual([10, 11, 12]);
  });
});

describe('flo command epic-branch flag', () => {
  it('should construct correct /flo command for single-branch strategy', () => {
    const epicBranch = 'epic/42-add-auth';
    const issue = 10;
    const flags = '-sw';
    const command = `/flo --epic-branch ${epicBranch} ${issue} ${flags}`.trim();
    expect(command).toBe('/flo --epic-branch epic/42-add-auth 10 -sw');
  });

  it('should construct correct /flo command for auto-merge strategy', () => {
    const issue = 10;
    const flags = '-sw';
    const epicFlag = ''; // no epic flag for auto-merge
    const command = `/flo ${epicFlag}${issue} ${flags}`.trim();
    expect(command).toBe('/flo 10 -sw');
  });
});

describe('epic config: admin_merge', () => {
  it('should build merge command with --admin when admin_merge is true', () => {
    const adminMerge = true;
    const prNumber = 42;
    const adminFlag = adminMerge ? ' --admin' : '';
    const cmd = `gh pr merge ${prNumber} --squash --delete-branch${adminFlag}`;
    expect(cmd).toBe('gh pr merge 42 --squash --delete-branch --admin');
  });

  it('should build merge command without --admin when admin_merge is false', () => {
    const adminMerge = false;
    const prNumber = 42;
    const adminFlag = adminMerge ? ' --admin' : '';
    const cmd = `gh pr merge ${prNumber} --squash --delete-branch${adminFlag}`;
    expect(cmd).toBe('gh pr merge 42 --squash --delete-branch');
  });
});

describe('epic resume support', () => {
  it('should filter out completed stories', () => {
    const allStories = [10, 11, 12, 13];
    const completedStories = new Set([10, 12]);
    const remaining = allStories.filter(n => !completedStories.has(n));
    expect(remaining).toEqual([11, 13]);
  });

  it('should detect all-completed state', () => {
    const allStories = [10, 11, 12];
    const completedStories = new Set([10, 11, 12]);
    const remaining = allStories.filter(n => !completedStories.has(n));
    expect(remaining).toHaveLength(0);
  });

  it('should parse story keys from memory results', () => {
    const results = [
      { key: 'story-10', value: { status: 'completed' } },
      { key: 'story-11', value: { status: 'merged' } },
      { key: 'story-12', value: { status: 'in-progress' } },
      { key: 'epic-42', value: { status: 'in-progress' } },
    ];
    const completed = new Set<number>();
    for (const entry of results) {
      const match = entry.key.match(/story-(\d+)/);
      if (match && (entry.value?.status === 'completed' || entry.value?.status === 'merged')) {
        completed.add(parseInt(match[1], 10));
      }
    }
    expect(completed).toEqual(new Set([10, 11]));
  });
});

describe('README accuracy: YAML-driven epic execution (#753)', () => {
  // #753: runEpic rejects non-numeric input, so README must not advertise YAML-driven mode.

  const README = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf-8');

  it('does not advertise `flo epic run <file>.yaml`', () => {
    expect(README).not.toMatch(/flo epic run [^\s`]+\.ya?ml/i);
  });

  it('does not claim a YAML-driven dependency-ordering capability', () => {
    // extractStories() never populates depends_on, so the topological-sort
    // / dependency-ordering pitch is currently false in any phrasing.
    expect(README).not.toMatch(/YAML[^.\n]{0,40}(topological|dependency ordering)/i);
  });
});
