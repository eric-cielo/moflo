/**
 * Structural guard against client / demo project identifiers leaking into the
 * repo.
 *
 * moflo is open source and installs into consumer projects, so any engagement's
 * project name, personal filesystem path, or contact domain that drifts in here
 * is a disclosure leak — not a style nit. It has happened: provenance notes from
 * demo engagements reached 38 tracked files, including runtime `output.writeln`
 * banners that printed a client domain into every consumer's terminal and the
 * `Co-Authored-By` trailer that `flo init` stamps into every consumer's
 * `.claude/settings.json`.
 *
 * This guard deliberately holds NO list of forbidden names. A denylist would
 * have to spell the client names out in an open-source repo and in git history
 * forever, recreating the leak it exists to prevent — and it could only ever
 * catch names someone already knew to add. Instead it matches the *shapes* those
 * identifiers take and allowlists the handful that are legitimately ours, so a
 * brand-new client name nobody has seen trips it on first use.
 *
 * Three shapes, each covering a surface that actually leaked:
 *   1. a project directory under someone's home dir  (fixture paths, repro notes)
 *   2. a contact domain in an email address          (the commit trailer)
 *   3. a domain on an attribution line               (the "Created with" banners)
 *
 * If a case here goes RED, do not add the name to an allowlist to silence it —
 * replace the identifier with a neutral placeholder (`consumer-app`,
 * `a consumer project`, `example.com`). The allowlists below are for moflo's own
 * identity and for generic placeholders, nothing else.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './_helpers/eslint-harness.js';
import { trackedFiles } from './_helpers/tracked-files.js';

/**
 * A project directory sitting under a user's home dir. Covers POSIX
 * (`/Users/…`, `/home/…`) and Windows (`C:\Users\…`, `C:/Users/…`), and both
 * single- and double-escaped separators so JSON/TS string literals match too.
 */
const HOME_PROJECT_PATH =
  /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2})[A-Za-z0-9._-]+[\\/]{1,2}(?:Projects|projects|Development|dev|repos|workspace|src)[\\/]{1,2}([A-Za-z0-9._-]+)/g;

const EMAIL_DOMAIN = /[A-Za-z0-9._%-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;

const ATTRIBUTION_LINE = /created with|built by|crafted by|made by/i;
const DOMAIN_TOKEN = /\b((?:[A-Za-z0-9-]+\.)+(?:com|net|org|io|dev|ai|co))\b/g;

/** moflo's own project dir, plus neutral placeholders used in fixtures. */
const ALLOWED_PROJECT_DIRS = new Set([
  'moflo',
  'consumer-app',
  'some_project',
  'some_project.v2',
  'project-a',
  'project-b',
  'my-project',
  'test-project',
  'example',
  'foo',
  'bar',
]);

/** moflo's own domains, plus RFC-style placeholder domains. */
const ALLOWED_DOMAINS = new Set([
  'cielolimitada.com',
  'github.com',
  'users.noreply.github.com',
  'anthropic.com',
  'npmjs.com',
  'example.com',
  'example.org',
  'test.com',
  'domain.com',
  'email.com',
  'vendor.com',
  'e.com',
  'moflo.test',
  'db.internal',
]);

/**
 * Lockfiles carry third-party maintainer emails, which are neither ours to
 * change nor a client leak. This guard's own source is skipped because it
 * describes the patterns it hunts for.
 */
const SKIP_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  join('tests', 'guards', 'client-name-leak-guard.test.ts').split(/[\\/]/).join('/'),
]);

export interface Leak {
  kind: 'project-dir' | 'email-domain' | 'attribution-domain';
  value: string;
}

/** Pure scanner so the shapes can be exercised without touching the tree. */
export function scanText(text: string): Leak[] {
  const leaks: Leak[] = [];

  for (const m of text.matchAll(HOME_PROJECT_PATH)) {
    if (!ALLOWED_PROJECT_DIRS.has(m[1])) leaks.push({ kind: 'project-dir', value: m[1] });
  }

  for (const m of text.matchAll(EMAIL_DOMAIN)) {
    if (!ALLOWED_DOMAINS.has(m[1])) leaks.push({ kind: 'email-domain', value: m[1] });
  }

  for (const line of text.split(/\r?\n/)) {
    if (!ATTRIBUTION_LINE.test(line)) continue;
    for (const m of line.matchAll(DOMAIN_TOKEN)) {
      if (!ALLOWED_DOMAINS.has(m[1])) leaks.push({ kind: 'attribution-domain', value: m[1] });
    }
  }

  return leaks;
}

function trackedTextFiles(): string[] {
  // The listing mechanics (no shell, NUL delimiting, explicit maxBuffer) and the
  // reasons each one matters live in the shared helper.
  return trackedFiles({ skip: SKIP_FILES });
}

describe('client-name leak guard — project dir under a home path', () => {
  it('flags an unknown project dir in a POSIX path', () => {
    expect(scanText("const root = '/Users/dev/Projects/acme-portal/code';")).toContainEqual({
      kind: 'project-dir',
      value: 'acme-portal',
    });
  });

  it('flags an unknown project dir in a Windows path, including escaped separators', () => {
    expect(scanText('"projectRoot": "C:\\\\Users\\\\dev\\\\Projects\\\\acme-portal\\\\code"'))
      .toContainEqual({ kind: 'project-dir', value: 'acme-portal' });
  });

  it('allows moflo and the neutral placeholder', () => {
    expect(scanText("'/Users/dev/Projects/moflo'")).toEqual([]);
    expect(scanText("'/Users/dev/Projects/consumer-app/code'")).toEqual([]);
  });
});

describe('client-name leak guard — contact domain', () => {
  it('flags a non-placeholder domain in an email address', () => {
    expect(scanText('Co-Authored-By: moflo <noreply@acme-portal.com>')).toContainEqual({
      kind: 'email-domain',
      value: 'acme-portal.com',
    });
  });

  it('allows the moflo trailer and placeholder domains', () => {
    expect(scanText('Co-Authored-By: moflo <noreply@cielolimitada.com>')).toEqual([]);
    expect(scanText('const user = "someone@example.com";')).toEqual([]);
  });
});

describe('client-name leak guard — attribution banner', () => {
  it('flags a foreign domain on an attribution line', () => {
    expect(scanText(' * Created with love by acme-portal.com')).toContainEqual({
      kind: 'attribution-domain',
      value: 'acme-portal.com',
    });
  });

  it('flags the runtime-banner form too', () => {
    expect(scanText("output.writeln(output.dim('Created with \u2764 by acme-portal.com'));"))
      .toContainEqual({ kind: 'attribution-domain', value: 'acme-portal.com' });
  });

  it('allows the moflo attribution', () => {
    expect(scanText(' * Created with \u2764 by cielolimitada.com')).toEqual([]);
  });

  it('ignores domains on non-attribution lines', () => {
    expect(scanText('See https://some-vendor-docs.io/guide for details')).toEqual([]);
  });
});

describe('client-name leak guard — live fire over tracked files', () => {
  it('finds no client identifiers anywhere in the tracked tree', () => {
    const offenders: string[] = [];

    for (const rel of trackedTextFiles()) {
      let text: string;
      try {
        text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      } catch {
        continue; // unreadable or removed between ls-files and read
      }
      if (text.includes('\u0000')) continue; // binary

      for (const leak of scanText(text)) {
        offenders.push(`${rel}: ${leak.kind} -> ${leak.value}`);
      }
    }

    // Printed in full so a failure names the file and the identifier directly.
    expect(offenders).toEqual([]);
  });
});
