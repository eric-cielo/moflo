// Statusline context-percentage sourcing tests (#1453).
//
// The statusline's context gauge must come from the ONE place that knows the
// answer: `context_window.used_percentage` on the session payload Claude Code
// pipes to a statusline command. Pre-#1453 it was computed from the stored
// session count (`sessions * 5`), so it climbed 5 points per session and pinned
// at 100% after 20 of them — an activity counter wearing a context gauge's
// label, reading "full" precisely when a real gauge would matter most.
//
// Two invariants are load-bearing here:
//   1. Unknown is reported as `null` and rendered as nothing — never as `0`,
//      which is indistinguishable from a genuinely empty window.
//   2. Nothing about `.moflo/metrics/learning.json` may move the number.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

const STATUSLINE = resolve(__dirname, '../../../.claude/helpers/statusline.cjs');
const REPO_ROOT = resolve(__dirname, '../../..');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function makeTempRoot(): string {
  const root = resolve(
    REPO_ROOT,
    '.testoutput',
    '.test-statusline-ctx-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sl-ctx-test', version: '0.0.0' }));
  return root;
}

function cleanTempRoot(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* non-fatal on Windows */
  }
}

/**
 * Drive the real statusline the way Claude Code does: a piped stdin payload.
 * `input` is always a string (never undefined) so stdin is a pipe rather than a
 * TTY on every platform — the script only parses the payload when `!isTTY`.
 */
function runStatusline(cwd: string, payload: unknown, args: string[] = ['--json-compact']): RunResult {
  const result = spawnSync('node', [STATUSLINE, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 25_000,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: cwd,
      CI: '1',
      GIT_CEILING_DIRECTORIES: dirname(cwd),
    },
    input: payload === undefined ? '' : JSON.stringify(payload),
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

function contextPctOf(cwd: string, payload: unknown): number | null {
  const { stdout, stderr, status } = runStatusline(cwd, payload);
  expect(stderr, `statusline wrote to stderr: ${stderr}`).toBe('');
  expect(status).toBe(0);
  return JSON.parse(stdout).system.contextPct;
}

function windowPayload(usedPercentage: number | null) {
  return {
    context_window: {
      total_input_tokens: 12345,
      total_output_tokens: 678,
      context_window_size: 200_000,
      current_usage: null,
      used_percentage: usedPercentage,
      remaining_percentage: usedPercentage === null ? null : 100 - usedPercentage,
    },
  };
}

/** Seed the file the old, wrong formula read from. */
function writeLearningMetrics(root: string, sessionsTotal: number) {
  const dir = join(root, '.moflo', 'metrics');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'learning.json'), JSON.stringify({ sessions: { total: sessionsTotal } }));
}

function writeMofloYaml(root: string, statusLineBlock: string) {
  writeFileSync(join(root, 'moflo.yaml'), `status_line:\n${statusLineBlock}\n`);
}

/** Strip ANSI SGR sequences so assertions read against visible text only. */
const ANSI = new RegExp(String.fromCharCode(0x1b) + '\\[[0-9;]*m', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}

describe('statusline context % (#1453)', () => {
  let root: string;
  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { cleanTempRoot(root); });

  describe('sourcing', () => {
    it('reports the rounded used_percentage from the stdin payload', () => {
      expect(contextPctOf(root, windowPayload(42.6))).toBe(43);
    });

    it('reports null when used_percentage is null (no API response yet)', () => {
      expect(contextPctOf(root, windowPayload(null))).toBeNull();
    });

    it('reports null when the payload carries no context_window at all', () => {
      expect(contextPctOf(root, { model: { display_name: 'Opus 5' } })).toBeNull();
    });

    it('reports null when there is no stdin payload', () => {
      expect(contextPctOf(root, undefined)).toBeNull();
    });

    it('reports null for a non-numeric used_percentage', () => {
      expect(contextPctOf(root, { context_window: { used_percentage: '77' } })).toBeNull();
    });

    it('clamps out-of-range values into 0-100', () => {
      expect(contextPctOf(root, windowPayload(130))).toBe(100);
      expect(contextPctOf(root, windowPayload(-5))).toBe(0);
    });

    // The regression itself: the number must not track stored session count.
    it('ignores learning.json session counts entirely', () => {
      writeLearningMetrics(root, 40); // old formula: 40 * 5 -> clamped to 100
      expect(contextPctOf(root, windowPayload(42.6))).toBe(43);
    });

    it('stays null with a high session count and no window payload', () => {
      writeLearningMetrics(root, 40);
      expect(contextPctOf(root, undefined)).toBeNull();
    });
  });

  describe('rendering', () => {
    it.each([['--single-line'], ['--compact'], ['--dashboard']])(
      'renders the gauge in %s mode when the value is known',
      (mode) => {
        const out = plain(runStatusline(root, windowPayload(88), [mode]).stdout);
        expect(out).toContain('88%');
      },
    );

    it.each([['--single-line'], ['--compact'], ['--dashboard']])(
      'renders no gauge in %s mode when the value is unknown',
      (mode) => {
        const out = plain(runStatusline(root, windowPayload(null), [mode]).stdout);
        expect(out).not.toMatch(/📂/u);
      },
    );

    it('hides the gauge when show_context is false', () => {
      writeMofloYaml(root, '  show_context: false');
      const out = plain(runStatusline(root, windowPayload(88), ['--compact']).stdout);
      expect(out).not.toMatch(/📂/u);
      expect(out).not.toContain('88%');
    });

    it('shows the gauge by default when moflo.yaml sets no show_context', () => {
      writeMofloYaml(root, '  show_swarm: true');
      const out = plain(runStatusline(root, windowPayload(88), ['--compact']).stdout);
      expect(out).toContain('88%');
    });
  });
});

// A source-level guard: the fabricated formula is easy to reintroduce because
// `sessions` sits right next to the real metrics in the same function. Assert on
// the shape of the mistake rather than on any one spelling of it.
describe('statusline context % has no session-count input (#1453)', () => {
  const SURFACES = [
    '.claude/helpers/statusline.cjs',
    'src/cli/commands/hooks.ts',
    'src/cli/hooks/statusline/index.ts',
  ];

  it.each(SURFACES)('%s never derives a context percentage from a session count', (rel) => {
    const src = readFileSync(resolve(REPO_ROOT, rel), 'utf-8');
    // Drop comments first: this file's own explanation of the old bug quotes the
    // formula, and so do the fix comments in the surfaces themselves.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    const offenders = code
      .split('\n')
      .filter((line) => /contextPct/.test(line) && /session/i.test(line));
    expect(offenders, `context % must not be computed from sessions in ${rel}`).toEqual([]);
  });
});
