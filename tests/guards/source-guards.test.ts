/**
 * Live-fire coverage for every structural source guard in the ESLint config
 * (#1319).
 *
 * The config is not a style config — it has no `extends` and enables exactly
 * two rules, `no-restricted-syntax` and `no-restricted-imports`, built from
 * hand-written esquery selectors that lean on `:has()`, adjacent-sibling `+`,
 * and regex attribute matching. A selector that silently stops matching after
 * a toolchain bump leaves `npm run lint` green while the guard is dead, and
 * the regressions it exists to catch (#527, #564, #575, #781, #782, #785,
 * #787) start landing unnoticed.
 *
 * So each cluster gets a positive case (the banned shape errors) AND a
 * negative case (the sanctioned alternative does not), each per-file
 * exemption gets a case proving it still exempts, and the lint file-set gets
 * cases proving `.claude/scripts/**` is reached despite its leading dot.
 *
 * If a positive case goes GREEN, the guard regressed — fix the config, don't
 * mute the test. The hash-embedding cluster's own cases live in
 * `hash-fallback-guard.test.ts`; this file covers everything else.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';

import { ESLint } from 'eslint';

const REPO_ROOT = resolve(__dirname, '../..');

/**
 * `filePath` drives config/override resolution; the file itself is never
 * written or read. The real paths below are deliberate — the exemption
 * overrides key off those exact names.
 */
const FIXTURES = {
  srcTs: join(REPO_ROOT, 'src', '__guard_fixture__.ts'),
  binMjs: join(REPO_ROOT, 'bin', '__guard_fixture__.mjs'),
  claudeScript: join(REPO_ROOT, '.claude', 'scripts', '__guard_fixture__.mjs'),
  doctorHygiene: join(REPO_ROOT, 'src', 'cli', 'commands', 'doctor-embedding-hygiene.ts'),
  packageRoot: join(REPO_ROOT, 'src', 'cli', 'shared', 'core', 'moflo-package-root.ts'),
  srcTest: join(REPO_ROOT, 'src', 'cli', '__tests__', '__guard_fixture__.test.ts'),
  ignoredDocs: join(REPO_ROOT, 'docs', '__guard_fixture__.js'),
} as const;

let eslint: ESLint;

beforeAll(() => {
  // One instance reused across cases — constructing ESLint parses the full
  // config cascade (~300-700ms on Windows).
  eslint = new ESLint({ cwd: REPO_ROOT });
});

/**
 * True when linting `source` as `filePath` produces at least one error from
 * `ruleId`. An ignored path yields no results (eslint 8) or an ignore warning
 * (eslint 9+) — both correctly read as "no violation" here.
 */
async function violates(
  source: string,
  filePath: string,
  ruleId = 'no-restricted-syntax',
): Promise<boolean> {
  const results = await eslint.lintText(source, { filePath });
  return results.some(r =>
    r.messages.some(m => m.ruleId === ruleId && m.severity === 2),
  );
}

describe('raw non-atomic DB write guard (#564)', () => {
  it('rejects fs.writeFileSync(path, db.export())', async () => {
    expect(
      await violates(
        `export function save(db: any, p: string) {
           fs.writeFileSync(p, db.export());
         }`,
        FIXTURES.srcTs,
      ),
    ).toBe(true);
  });

  it('rejects the Buffer.from(db.export()) variant', async () => {
    expect(
      await violates(
        `export function save(db: any, p: string) {
           fs.writeFileSync(p, Buffer.from(db.export()));
         }`,
        FIXTURES.srcTs,
      ),
    ).toBe(true);
  });

  it('allows a writeFileSync that is not a DB export', async () => {
    expect(
      await violates(
        `export function save(data: unknown, p: string) {
           fs.writeFileSync(p, JSON.stringify(data));
         }`,
        FIXTURES.srcTs,
      ),
    ).toBe(false);
  });
});

describe('fixed-depth modules path guard (#575)', () => {
  it('rejects a 4-deep ../modules/ string literal', async () => {
    expect(
      await violates(
        `export const P = '../../../../modules/spells/dist/index.js';`,
        FIXTURES.srcTs,
      ),
    ).toBe(true);
  });

  it('rejects the same depth inside a template literal', async () => {
    expect(
      await violates(
        'export const P = (pkg: string) => `../../../../modules/${pkg}/dist/index.js`;',
        FIXTURES.srcTs,
      ),
    ).toBe(true);
  });

  it('allows a shallow relative path', async () => {
    expect(
      await violates(`export const P = '../../modules/spells';`, FIXTURES.srcTs),
    ).toBe(false);
  });
});

describe('fixed-depth `..` traversal guard (#781 / #782)', () => {
  it('rejects path.resolve with adjacent .. literals', async () => {
    expect(
      await violates(
        `export const P = path.resolve(__dirname, '..', '..', 'bin');`,
        FIXTURES.srcTs,
      ),
    ).toBe(true);
  });

  it('rejects path.posix.join with adjacent .. literals', async () => {
    expect(
      await violates(
        `export const P = path.posix.join(dir, '..', '..');`,
        FIXTURES.srcTs,
      ),
    ).toBe(true);
  });

  it('rejects a bare resolve() imported from node:path', async () => {
    expect(
      await violates(
        `import { resolve } from 'node:path';
         export const P = resolve(dir, '..', '..', 'lib');`,
        FIXTURES.srcTs,
      ),
    ).toBe(true);
  });

  it('allows a single .. (sibling lookup)', async () => {
    expect(
      await violates(
        `export const P = path.resolve(__dirname, '..', 'lib');`,
        FIXTURES.srcTs,
      ),
    ).toBe(false);
  });
});

describe('silent warn-catch guard (#781 / #785)', () => {
  const SILENT = `export function check() {
      try {
        probe();
      } catch {
        return { name: 'x', status: 'warn', message: 'Unable to detect' };
      }
      return { name: 'x', status: 'pass', message: 'ok' };
    }`;

  it('rejects a catch that returns status:"warn" with no cause', async () => {
    expect(await violates(SILENT, FIXTURES.srcTs)).toBe(true);
  });

  it('allows the same catch when the error is formatted into the message', async () => {
    expect(
      await violates(
        `export function check() {
           try {
             probe();
           } catch (e) {
             return { name: 'x', status: 'warn', message: \`Unable to detect: \${e}\` };
           }
           return { name: 'x', status: 'pass', message: 'ok' };
         }`,
        FIXTURES.srcTs,
      ),
    ).toBe(false);
  });

  it('allows the same catch when the error is logged', async () => {
    expect(
      await violates(
        `export function check() {
           try {
             probe();
           } catch (e) {
             console.error('probe failed:', e);
             return { name: 'x', status: 'warn', message: 'Unable to detect' };
           }
           return { name: 'x', status: 'pass', message: 'ok' };
         }`,
        FIXTURES.srcTs,
      ),
    ).toBe(false);
  });
});

describe('kebab-case flag read guard (#787)', () => {
  it('rejects ctx.flags["kebab-case"]', async () => {
    expect(
      await violates(
        `export const v = (ctx: any) => ctx.flags['allow-warn'];`,
        FIXTURES.srcTs,
      ),
    ).toBe(true);
  });

  it('rejects a destructured flags["kebab-case"]', async () => {
    expect(
      await violates(
        `export const v = (flags: any) => flags['allow-warn'];`,
        FIXTURES.srcTs,
      ),
    ).toBe(true);
  });

  it('allows the camelCase key the parser actually stores', async () => {
    expect(
      await violates(
        `export const v = (ctx: any) => ctx.flags['allowWarn'];`,
        FIXTURES.srcTs,
      ),
    ).toBe(false);
  });
});

describe('per-file exemptions still exempt', () => {
  it('doctor-embedding-hygiene.ts may reference the banned model literal', async () => {
    expect(
      await violates(
        `export const BANNED = 'domain-aware-hash';`,
        FIXTURES.doctorHygiene,
      ),
    ).toBe(false);
  });

  it('doctor-embedding-hygiene.ts is still bound by the identifier ban', async () => {
    expect(
      await violates(
        `export function hashEmbed(t: string) { return [t.length]; }`,
        FIXTURES.doctorHygiene,
      ),
    ).toBe(true);
  });

  it('moflo-package-root.ts may use adjacent .. traversal', async () => {
    expect(
      await violates(
        `export const P = path.resolve(here, '..', '..');`,
        FIXTURES.packageRoot,
      ),
    ).toBe(false);
  });

  it('moflo-package-root.ts is still bound by the banned literal rule', async () => {
    expect(
      await violates(`export const M = 'domain-aware-hash-v1';`, FIXTURES.packageRoot),
    ).toBe(true);
  });

  it('test files are exempt from every guard', async () => {
    expect(
      await violates(
        `export const M = 'domain-aware-hash-v1';
         export const P = path.resolve(d, '..', '..');`,
        FIXTURES.srcTest,
      ),
    ).toBe(false);
  });
});

describe('lint file-set coverage', () => {
  it('guards bin/**/*.mjs', async () => {
    expect(
      await violates(`export const P = path.resolve(d, '..', '..');`, FIXTURES.binMjs),
    ).toBe(true);
  });

  it('guards .claude/scripts/**/*.mjs despite the leading dot', async () => {
    // ESLint ignores dot-prefixed paths by default; the config un-ignores this
    // subtree because those helpers ride into consumer installs (#545). If
    // this case goes green the shipped helpers left the guard silently.
    expect(
      await violates(`export const P = path.resolve(d, '..', '..');`, FIXTURES.claudeScript),
    ).toBe(true);
  });

  it('does not lint ignored trees such as docs/', async () => {
    expect(
      await violates(`export const P = path.resolve(d, '..', '..');`, FIXTURES.ignoredDocs),
    ).toBe(false);
  });
});
