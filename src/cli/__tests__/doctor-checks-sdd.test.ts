/**
 * SDD + verify wiring healer check tests — Story #1276 (Epic #1269).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSddVerifyWiring } from '../commands/doctor-checks-sdd.js';

let root: string;
let prevEnv: string | undefined;

function wireProject(opts: {
  gateCases?: string[];
  settingsTokens?: string[];
  yaml?: string;
} = {}): void {
  const helpers = join(root, '.claude', 'helpers');
  mkdirSync(helpers, { recursive: true });
  const cases = opts.gateCases ?? ['check-before-done', 'record-verify-run'];
  writeFileSync(
    join(helpers, 'gate.cjs'),
    cases.map((c) => `case '${c}': { break; }`).join('\n'),
  );
  const tokens = opts.settingsTokens ?? ['check-before-done', 'record-verify-run'];
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { note: tokens.join(' ') } }),
  );
  if (opts.yaml !== undefined) writeFileSync(join(root, 'moflo.yaml'), opts.yaml);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'moflo-sdd-doctor-'));
  prevEnv = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = prevEnv;
  rmSync(root, { recursive: true, force: true });
});

describe('checkSddVerifyWiring', () => {
  it('warns when .claude/ is not initialised', async () => {
    const r = await checkSddVerifyWiring();
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/not initialised/);
  });

  it('passes with verify ENFORCED by default when wiring is present (no gates block)', async () => {
    // #1294 — verify_before_done defaults true, so an absent gates block still enforces.
    wireProject({ yaml: 'project:\n  name: t\n' });
    const r = await checkSddVerifyWiring();
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/sdd\.default=false/);
    expect(r.message).toMatch(/gates\.verify_before_done=true/);
    expect(r.message).toMatch(/ENFORCED/);
  });

  it('passes without ENFORCED when verify is opted out (verify_before_done: false)', async () => {
    wireProject({ yaml: 'project:\n  name: t\ngates:\n  verify_before_done: false\n' });
    const r = await checkSddVerifyWiring();
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/gates\.verify_before_done=false/);
    expect(r.message).not.toMatch(/ENFORCED/);
  });

  it('reports ENFORCED when verify_before_done is on', async () => {
    wireProject({ yaml: 'project:\n  name: t\ngates:\n  verify_before_done: true\n' });
    const r = await checkSddVerifyWiring();
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/ENFORCED/);
  });

  it('warns on missing gate case when verify is opted out (not enforced)', async () => {
    // Opted out → a missing case bites nobody yet, so warn (not fail).
    wireProject({ gateCases: ['record-verify-run'], yaml: 'project:\n  name: t\ngates:\n  verify_before_done: false\n' });
    const r = await checkSddVerifyWiring();
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/check-before-done/);
  });

  it('fails on missing gate case when verify is enforced', async () => {
    wireProject({
      gateCases: ['record-verify-run'],
      yaml: 'project:\n  name: t\ngates:\n  verify_before_done: true\n',
    });
    const r = await checkSddVerifyWiring();
    expect(r.status).toBe('fail');
    expect(r.fix).toMatch(/init --fix/);
  });

  it('fails when sdd.default is on but the settings hook is missing', async () => {
    wireProject({
      settingsTokens: ['record-verify-run'],
      yaml: 'project:\n  name: t\nsdd:\n  default: true\n',
    });
    const r = await checkSddVerifyWiring();
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/settings\.json missing/);
  });
});
