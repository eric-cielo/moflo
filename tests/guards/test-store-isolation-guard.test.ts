/**
 * Guard: a test that drives the real spell engine must anchor its state at a
 * scratch directory, not the developer's project.
 *
 * `SpellRunner.storeProgress` writes a `tasklist` row on every terminal spell
 * run. Tests that call the real `spell_cast` / `spell_execute` MCP handlers
 * therefore persist into whatever `.moflo/moflo.db` `resolveStateRoot()` picks
 * — and with no override that is the repo you are working in. Measured on this
 * repo (#1333): 96 of 97 live `tasklist` rows were `execute-test` echo probes
 * emitted by `npm test`, against a `TASKLIST_RETENTION_CAP` of 200. Two days of
 * running the suite was enough to evict every genuine `/flo` run record, which
 * is the data the cap exists to retain.
 *
 * The fix is one line of setup: point `CLAUDE_PROJECT_DIR` at a temp dir before
 * the first handler call (`resolveStateRoot` treats an existing value as
 * authoritative) and restore it afterwards.
 *
 * If this goes red, do NOT add the file to an exemption list — give it the
 * scratch anchor. A test that mutates the developer's real store is a test that
 * corrupts the data another feature is measured against.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');

/** Roots that hold test files capable of reaching the real engine. */
const TEST_ROOTS = ['src/cli/__tests__', 'tests'] as const;

/**
 * Importing this module gets you the live MCP handlers, which construct a real
 * runner backed by `getSharedMemoryAccessor()`.
 */
const REAL_ENGINE_IMPORT = /from\s+['"][^'"]*mcp-tools\/spell-tools\.js['"]/;

/**
 * The handlers that actually RUN a spell, and so reach
 * `SpellRunner.storeProgress` → `memory.write('tasklist', …)`. The import alone
 * is not enough to require an anchor: `spell_list` and `spell_create` return
 * definitions without executing anything, and demanding a scratch dir from a
 * schema-only suite would be cargo-culted setup that future readers delete.
 */
const EXECUTES_A_SPELL = /\bspell_(cast|execute|resume)\b/;

/**
 * The anchor override. Any assignment counts — the guard checks that the file
 * takes responsibility for its state root, not how it phrases it.
 */
const ANCHORS_STATE_ROOT = /CLAUDE_PROJECT_DIR\s*=/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (name === 'node_modules' || name === 'fixtures') continue;
      walk(full, out);
    } else if (name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('guard: tests must not write to the real .moflo store', () => {
  const files = TEST_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)));

  it('finds test files to check (guard is not silently vacuous)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  /** Files this guard considers in scope — computed once, asserted non-empty below. */
  const engineDriving = files.filter((file) => {
    // The guard describes itself; skip so its own regexes don't trip it.
    if (file === __filename) return false;
    const source = readFileSync(file, 'utf-8');
    return REAL_ENGINE_IMPORT.test(source) && EXECUTES_A_SPELL.test(source);
  });

  it('still matches at least one engine-driving test (patterns have not gone stale)', () => {
    // Without this, a rename of `spell_cast` or of the tools module would make
    // the guard below pass by matching nothing at all — green, and worthless.
    expect(engineDriving.map((f) => relative(REPO_ROOT, f))).not.toEqual([]);
  });

  it('every test driving the real spell engine anchors CLAUDE_PROJECT_DIR at a scratch dir', () => {
    const offenders: string[] = [];

    for (const file of engineDriving) {
      if (ANCHORS_STATE_ROOT.test(readFileSync(file, 'utf-8'))) continue;
      offenders.push(relative(REPO_ROOT, file));
    }

    expect(
      offenders,
      `These tests import the real spell-tools handlers but never override ` +
        `CLAUDE_PROJECT_DIR, so their spell runs write tasklist rows into the ` +
        `developer's own .moflo/moflo.db (#1333). Give each a mkdtempSync anchor ` +
        `in beforeAll and restore it in afterAll — do not exempt them.`,
    ).toEqual([]);
  });
});
