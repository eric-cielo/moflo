/**
 * System lint: writer-audit enforcement (epic #1054 — story #1055).
 *
 * Every place in the codebase that mutates `.moflo/moflo.db` must appear in
 * `tests/system/fixtures/writer-audit-whitelist.json` with a classification of
 * `in-daemon`, `daemon-rpc`, `daemon-offline`, or `separate-db`. Adding a new
 * writer file without a whitelist entry fails the suite — that loud failure is
 * the regression gate that prevents the #1054 bug class from returning.
 *
 * See docs/internal/1054-writer-audit.md for the full audit and rationale.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sync as globSync } from 'glob';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WHITELIST_PATH = path.join(
  __dirname,
  'fixtures',
  'writer-audit-whitelist.json',
);

interface WriterEntry {
  file: string;
  classification: 'in-daemon' | 'daemon-rpc' | 'daemon-offline' | 'separate-db';
  notes?: string;
  pending_fix?: string;
}

interface Whitelist {
  patterns: { regex: string[] };
  scope: { include: string[]; exclude: string[] };
  writers: WriterEntry[];
}

function loadWhitelist(): Whitelist {
  const raw = fs.readFileSync(WHITELIST_PATH, 'utf8');
  return JSON.parse(raw) as Whitelist;
}

function toRepoRelative(absPath: string): string {
  return path
    .relative(REPO_ROOT, absPath)
    .split(path.sep)
    .join('/');
}

function collectScannedFiles(scope: Whitelist['scope']): string[] {
  const seen = new Set<string>();
  for (const pattern of scope.include) {
    const matches = globSync(pattern, {
      cwd: REPO_ROOT,
      ignore: scope.exclude,
      absolute: true,
      nodir: true,
    });
    for (const m of matches) seen.add(toRepoRelative(m));
  }
  return Array.from(seen).sort();
}

function hasWriterHit(content: string, patterns: RegExp[]): boolean {
  for (const re of patterns) {
    re.lastIndex = 0;
    if (re.test(content)) return true;
  }
  return false;
}

describe('moflo.db writer audit (epic #1054 / story #1055)', () => {
  it('every file that mutates moflo.db appears in the whitelist', () => {
    const whitelist = loadWhitelist();
    const whitelistFiles = new Set(whitelist.writers.map((w) => w.file));
    const regexes = whitelist.patterns.regex.map((p) => new RegExp(p));

    const scanned = collectScannedFiles(whitelist.scope);
    const unmatched: string[] = [];

    for (const rel of scanned) {
      const abs = path.join(REPO_ROOT, rel);
      let content: string;
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (!hasWriterHit(content, regexes)) continue;
      if (whitelistFiles.has(rel)) continue;
      unmatched.push(rel);
    }

    if (unmatched.length > 0) {
      const help = [
        '',
        'Files mutate moflo.db but are NOT in the writer-audit whitelist.',
        'Either add an entry to tests/system/fixtures/writer-audit-whitelist.json',
        'with the correct classification, or remove the writer.',
        '',
        'See docs/internal/1054-writer-audit.md for the three classifications.',
        '',
        'Unmatched files:',
        ...unmatched.map((f) => `  - ${f}`),
      ].join('\n');
      throw new Error(help);
    }

    expect(unmatched).toEqual([]);
  });

  it('every whitelist entry uses a recognized classification', () => {
    const whitelist = loadWhitelist();
    const valid = new Set(['in-daemon', 'daemon-rpc', 'daemon-offline', 'separate-db']);
    const invalid = whitelist.writers.filter((w) => !valid.has(w.classification));
    expect(invalid).toEqual([]);
  });

  it('every whitelisted file exists in the repo (no stale entries)', () => {
    const whitelist = loadWhitelist();
    const missing = whitelist.writers.filter(
      (w) => !fs.existsSync(path.join(REPO_ROOT, w.file)),
    );
    if (missing.length > 0) {
      throw new Error(
        'Whitelist entries reference files that no longer exist:\n' +
          missing.map((m) => `  - ${m.file}`).join('\n') +
          '\nRemove the stale entries from writer-audit-whitelist.json.',
      );
    }
    expect(missing).toEqual([]);
  });
});
