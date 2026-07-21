/**
 * SDD artifact model tests — Story #1273 (Epic #1269).
 *
 * Covers schema validation (accept well-formed / reject malformed), the on-disk
 * path convention (cross-platform via path.join), round-trip write/read, the
 * review checkpoint, and slug derivation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  slugify,
  specsRoot,
  specDir,
  artifactPath,
  serializeArtifact,
  parseArtifact,
  validateArtifact,
  writeArtifact,
  readArtifact,
  listSpecs,
  assertReviewed,
  newArtifact,
} from '../../sdd/index.js';
import { defaultSpecBody, defaultPlanBody } from '../../sdd/templates.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'moflo-sdd-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Add Rate Limiting')).toBe('add-rate-limiting');
  });
  it('collapses non-alnum runs and trims', () => {
    expect(slugify('  Foo:  Bar!! ')).toBe('foo-bar');
  });
  it('falls back to "untitled" for empty input', () => {
    expect(slugify('   ')).toBe('untitled');
    expect(slugify('!!!')).toBe('untitled');
  });
});

describe('paths (cross-platform)', () => {
  it('builds paths with the platform separator, never a hardcoded slash', () => {
    const p = artifactPath(root, 'my-slug', 'spec');
    expect(p).toBe(join(root, '.moflo', 'specs', 'my-slug', 'spec.md'));
    // The relative tail uses the OS separator.
    expect(p.endsWith(join('.moflo', 'specs', 'my-slug', 'spec.md'))).toBe(true);
    expect(p).toContain(sep);
  });
  it('specsRoot and specDir compose', () => {
    expect(specDir(root, 's')).toBe(join(specsRoot(root), 's'));
  });
});

describe('specsRoot honors sdd.specs_dir (#1294)', () => {
  const writeYaml = (body: string) => writeFileSync(join(root, 'moflo.yaml'), body);

  it('defaults to .moflo/specs with no config', () => {
    expect(specsRoot(root)).toBe(join(root, '.moflo', 'specs'));
  });

  it('honors a configured tracked path', () => {
    writeYaml('sdd:\n  specs_dir: docs/specs\n');
    expect(specsRoot(root)).toBe(join(root, 'docs', 'specs'));
  });

  it('resolves a /-written value cross-platform (split + join, never concatenate)', () => {
    writeYaml('sdd:\n  specs_dir: a/b/c\n');
    // Tail uses the OS separator — the yaml slash never leaks into the path.
    expect(specsRoot(root)).toBe(join(root, 'a', 'b', 'c'));
    expect(specsRoot(root).endsWith(join('a', 'b', 'c'))).toBe(true);
  });

  it('accepts camelCase specsDir', () => {
    writeYaml('sdd:\n  specsDir: .specs\n');
    expect(specsRoot(root)).toBe(join(root, '.specs'));
  });

  it('falls back to the default on a parent-escaping value', () => {
    writeYaml('sdd:\n  specs_dir: ../outside\n');
    expect(specsRoot(root)).toBe(join(root, '.moflo', 'specs'));
  });

  it('falls back to the default on an absolute value', () => {
    writeYaml('sdd:\n  specs_dir: /etc/moflo\n');
    expect(specsRoot(root)).toBe(join(root, '.moflo', 'specs'));
  });

  it('falls back to the default on an empty value', () => {
    writeYaml('sdd:\n  specs_dir: ""\n');
    expect(specsRoot(root)).toBe(join(root, '.moflo', 'specs'));
  });
});

describe('serialize / parse round-trip', () => {
  it('round-trips an artifact with a title containing a colon', () => {
    const artifact = newArtifact('spec', 'Feature: X', defaultSpecBody('Feature: X'), {
      now: '2026-07-18T00:00:00.000Z',
    });
    const md = serializeArtifact(artifact);
    const parsed = parseArtifact(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe('spec');
    expect(parsed!.title).toBe('Feature: X');
    expect(parsed!.slug).toBe('feature-x');
    expect(parsed!.status).toBe('draft');
    expect(parsed!.created).toBe('2026-07-18T00:00:00.000Z');
  });
  it('parses CRLF frontmatter', () => {
    const artifact = newArtifact('plan', 'Y', defaultPlanBody('Y'));
    const crlf = serializeArtifact(artifact).replace(/\n/g, '\r\n');
    const parsed = parseArtifact(crlf);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe('plan');
  });
  it('returns null on missing frontmatter', () => {
    expect(parseArtifact('# Just a heading\n\nno frontmatter')).toBeNull();
  });
  it('returns null on an unknown kind', () => {
    expect(parseArtifact('---\nkind: bogus\nslug: s\ntitle: t\n---\nbody')).toBeNull();
  });
});

describe('validateArtifact', () => {
  it('accepts a well-formed spec (has Acceptance Criteria list)', () => {
    const md = serializeArtifact(newArtifact('spec', 'Good', defaultSpecBody('Good')));
    const res = validateArtifact('spec', md);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });
  it('accepts a well-formed plan (has Steps list)', () => {
    const md = serializeArtifact(newArtifact('plan', 'Good', defaultPlanBody('Good')));
    expect(validateArtifact('plan', md).valid).toBe(true);
  });
  it('rejects a spec missing the Acceptance Criteria section', () => {
    const md = serializeArtifact(newArtifact('spec', 'Bad', '# Spec\n\n## Problem\nx\n'));
    const res = validateArtifact('spec', md);
    expect(res.valid).toBe(false);
    expect(res.errors.join(' ')).toMatch(/Acceptance Criteria/);
  });
  it('rejects a spec whose Acceptance Criteria section is empty', () => {
    const md = serializeArtifact(
      newArtifact('spec', 'Bad', '# Spec\n\n## Acceptance Criteria\n\n## Next\n'),
    );
    const res = validateArtifact('spec', md);
    expect(res.valid).toBe(false);
    expect(res.errors.join(' ')).toMatch(/no list items/);
  });
  it('rejects malformed frontmatter', () => {
    expect(validateArtifact('spec', 'no frontmatter here').valid).toBe(false);
  });
  it('rejects a kind mismatch', () => {
    const md = serializeArtifact(newArtifact('plan', 'P', defaultPlanBody('P')));
    const res = validateArtifact('spec', md);
    expect(res.valid).toBe(false);
    expect(res.errors.join(' ')).toMatch(/does not match/);
  });
});

describe('write / read / list', () => {
  it('writes to the conventional path and reads back', () => {
    const artifact = newArtifact('spec', 'Round Trip', defaultSpecBody('Round Trip'));
    const p = writeArtifact(root, artifact);
    expect(p).toBe(artifactPath(root, 'round-trip', 'spec'));
    expect(existsSync(p)).toBe(true);
    const back = readArtifact(root, 'round-trip', 'spec');
    expect(back?.title).toBe('Round Trip');
  });
  it('readArtifact returns null when absent', () => {
    expect(readArtifact(root, 'nope', 'spec')).toBeNull();
  });
  it('lists specs sorted with status summary', () => {
    writeArtifact(root, newArtifact('spec', 'Beta', defaultSpecBody('Beta')));
    writeArtifact(root, newArtifact('spec', 'Alpha', defaultSpecBody('Alpha')));
    const specs = listSpecs(root);
    expect(specs.map((s) => s.slug)).toEqual(['alpha', 'beta']);
    expect(specs[0].hasSpec).toBe(true);
    expect(specs[0].hasPlan).toBe(false);
    expect(specs[0].specStatus).toBe('draft');
  });
});

describe('review checkpoint', () => {
  it('blocks planning until the spec is reviewed', () => {
    writeArtifact(root, newArtifact('spec', 'Gate Me', defaultSpecBody('Gate Me')));
    const blocked = assertReviewed(root, 'gate-me', 'plan');
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/not "reviewed"/);
  });
  it('passes planning once the spec is reviewed', () => {
    const spec = newArtifact('spec', 'Gate Me', defaultSpecBody('Gate Me'), { status: 'reviewed' });
    writeArtifact(root, spec);
    expect(assertReviewed(root, 'gate-me', 'plan').ok).toBe(true);
  });
  it('blocks implement until the plan is reviewed', () => {
    writeArtifact(root, newArtifact('plan', 'Gate Me', defaultPlanBody('Gate Me')));
    expect(assertReviewed(root, 'gate-me', 'implement').ok).toBe(false);
  });
  it('reports a missing artifact', () => {
    const res = assertReviewed(root, 'ghost', 'plan');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no spec\.md found/);
  });
});

describe('memory-indexer discovery shape', () => {
  it('spec/plan files land under .moflo/specs/<slug>/ with expected basenames', () => {
    // The session-start guidance indexer walks .moflo/specs recursively and
    // filters on these basenames — assert the on-disk layout it depends on.
    const dir = specDir(root, 'discoverable');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'spec.md'), serializeArtifact(newArtifact('spec', 'D', defaultSpecBody('D'))));
    expect(existsSync(join(specsRoot(root), 'discoverable', 'spec.md'))).toBe(true);
  });
});
