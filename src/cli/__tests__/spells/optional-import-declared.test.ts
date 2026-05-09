/**
 * Static drift guard for `loadOptional()` specifiers (issue #1021).
 *
 * Every bare specifier passed to `loadOptional<T>(specifier, installMsg)` is a
 * runtime promise that the package is reachable on a fresh install. If the
 * specifier isn't declared anywhere in the root package.json, `npm install
 * moflo` doesn't pull it in and consumers hit the install-instruction error
 * on first use of the connector — exactly the failure mode of #1021.
 *
 * This test walks the shipped connector tree, extracts every `loadOptional()`
 * specifier, resolves subpath imports back to their package root, and asserts
 * each is declared in `dependencies`, `optionalDependencies`, or
 * `peerDependenciesMeta` (paired with a `peerDependencies` entry).
 *
 * Pinned inventory below — when you add a new `loadOptional()` call, you MUST
 * (a) declare the package in package.json AND (b) add the package name to
 * `KNOWN_OPTIONAL_SPECIFIERS`. The pinned inventory makes intentional changes
 * visible in code review instead of silently passing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot, walkSource } from '../_helpers/repo-walk.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
const CONNECTOR_TREE = join(REPO_ROOT, 'src/cli/spells/connectors');

// Pinned inventory — packages currently loaded via loadOptional().
// If you add or remove a loadOptional() call, update this list in the same PR.
const KNOWN_OPTIONAL_SPECIFIERS = [
  '@modelcontextprotocol/sdk',
  'imapflow',
  'mailparser',
] as const;

// loadOptional<...>('specifier', ...) — generic params are optional and may
// contain `{}` but never parentheses, so `[^()]*` is a safe inner match.
const LOAD_OPTIONAL_RE = /loadOptional\b\s*(?:<[^()]*>)?\s*\(\s*['"]([^'"]+)['"]/g;

function packageRoot(specifier: string): string {
  const parts = specifier.split('/');
  return parts[0]!.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

function collectSpecifiers(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walkSource(CONNECTOR_TREE)) {
    const text = readFileSync(file, 'utf8');
    LOAD_OPTIONAL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LOAD_OPTIONAL_RE.exec(text)) !== null) {
      const pkg = packageRoot(m[1]!);
      const list = found.get(pkg) ?? [];
      list.push(file);
      found.set(pkg, list);
    }
  }
  return found;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function loadPkg(): PackageJson {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as PackageJson;
}

function declarationSites(pkg: PackageJson, name: string): string[] {
  const sites: string[] = [];
  if (pkg.dependencies?.[name]) sites.push('dependencies');
  if (pkg.optionalDependencies?.[name]) sites.push('optionalDependencies');
  if (pkg.peerDependenciesMeta?.[name]) {
    if (!pkg.peerDependencies?.[name]) {
      sites.push('peerDependenciesMeta (MISSING peerDependencies entry)');
    } else {
      sites.push('peerDependenciesMeta');
    }
  }
  return sites;
}

describe('connector loadOptional() specifiers must be declared in package.json', () => {
  it('extracts at least the pinned inventory from the connector tree', () => {
    const found = collectSpecifiers();
    for (const expected of KNOWN_OPTIONAL_SPECIFIERS) {
      expect(
        found.has(expected),
        `Pinned inventory drift: '${expected}' is in KNOWN_OPTIONAL_SPECIFIERS but no loadOptional() call references it. Remove it from the inventory or add the call back.`,
      ).toBe(true);
    }
  });

  it('every loadOptional() specifier is in the pinned inventory', () => {
    const found = collectSpecifiers();
    const known = new Set<string>(KNOWN_OPTIONAL_SPECIFIERS);
    const undeclared = [...found.keys()].filter(p => !known.has(p));
    expect(
      undeclared,
      `New loadOptional() specifiers detected without inventory update. Add to KNOWN_OPTIONAL_SPECIFIERS in this file AND declare in package.json: ${undeclared.join(', ')}`,
    ).toEqual([]);
  });

  it('every pinned specifier is declared in package.json', () => {
    const pkg = loadPkg();
    const offenders: string[] = [];
    for (const name of KNOWN_OPTIONAL_SPECIFIERS) {
      const sites = declarationSites(pkg, name);
      if (sites.length === 0) {
        offenders.push(name);
      }
    }
    expect(
      offenders,
      `loadOptional() specifier(s) not declared in package.json: ${offenders.join(', ')}. Add to one of: dependencies, optionalDependencies, or peerDependencies + peerDependenciesMeta.`,
    ).toEqual([]);
  });
});
