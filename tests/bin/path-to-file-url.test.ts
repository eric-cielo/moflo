/**
 * Regression guard for #890 — every dynamic `import()` of a path-resolved
 * module in `bin/` MUST use Node's `pathToFileURL` primitive instead of the
 * hand-rolled `file://${path.replace(/\\/g, '/')}` pattern.
 *
 * The hand-rolled pattern misbehaves for paths containing `%`, `#`, `?`,
 * spaces, UNC prefixes, or non-Latin-1 components — silently importing the
 * wrong module or throwing at parse time. `pathToFileURL` percent-encodes
 * correctly and round-trips through Node's URL machinery.
 *
 * Scope: every file under `bin/` (mjs, cjs, js). Lib helpers are included —
 * the rule is uniform.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join, extname } from 'path';

const BIN_DIR = resolve(__dirname, '../../bin');

function listScripts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listScripts(full));
    } else if (['.mjs', '.cjs', '.js'].includes(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

const scripts = listScripts(BIN_DIR);

describe('bin/ scripts must use pathToFileURL for dynamic import (#890)', () => {
  it('no `file://${path.replace(/\\\\/g, "/")}` template literals', () => {
    const offenders: string[] = [];
    for (const file of scripts) {
      const src = readFileSync(file, 'utf-8');
      // Match: `file://${...replace(/\\/g, '/')...}` template literal
      if (/`file:\/\/\$\{[^}]*replace\s*\(\s*\/\\\\\/g[^}]*\}/.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders, 'use pathToFileURL(p).href instead').toEqual([]);
  });

  it('no `"file://" + path.replace(...)` string concatenation', () => {
    const offenders: string[] = [];
    for (const file of scripts) {
      const src = readFileSync(file, 'utf-8');
      // Match: 'file://' + something.replace(/\\/g, '/')
      if (/['"]file:\/\/['"]\s*\+\s*[^;]*\.replace\s*\(\s*\/\\\\\/g/.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders, 'use pathToFileURL(p).href instead').toEqual([]);
  });
});
