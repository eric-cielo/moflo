/**
 * Unit tests for the dead-path nomination pass (#1479).
 *
 * The extraction rules are where every false positive would come from, so they
 * are driven directly at prose rather than inferred from a plan's counts: a
 * detector that flags more innocent entries than real ones gets ignored
 * wholesale, which costs the audit's other three buckets their audience too.
 *
 * Resolution is a predicate here, exactly as the module takes it — no temp
 * directories, no repo. `commands/memory-audit-learnings.test.ts` covers the
 * real-filesystem half.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEAD_PATHS_PER_ENTRY,
  extractCandidatePaths,
  findDeadPaths,
  resolvesInTree,
} from '../../memory/learnings-dead-paths.js';
import type { AuditRow } from '../../memory/learnings-audit.js';

const NOW = 1_800_000_000_000;

function row(key: string, content: string): AuditRow {
  return {
    id: `id-${key}`,
    key,
    content,
    embedding: null,
    createdAt: NOW,
    updatedAt: NOW,
    accessCount: 1,
  };
}

/** Resolution backed by a fixed set of paths — the tree, without a tree. */
function tree(...paths: string[]): (p: string) => boolean {
  const known = new Set(paths);
  return (p) => known.has(p);
}

describe('extractCandidatePaths', () => {
  it('pulls paths out of prose, backticks, and parentheses', () => {
    const found = extractCandidatePaths(
      'The guard lives in `src/cli/guards/leak.ts` and its fixture is '
      + 'tests/fixtures/leak.json (see docs/internal/leaks.md).',
    );

    expect(found).toEqual([
      'src/cli/guards/leak.ts',
      'tests/fixtures/leak.json',
      'docs/internal/leaks.md',
    ]);
  });

  it('drops sentence punctuation that rode along on the path', () => {
    expect(extractCandidatePaths('Fixed in src/cli/output.ts.')).toEqual(['src/cli/output.ts']);
    expect(extractCandidatePaths('Both src/a.ts, src/b.ts; and src/c.ts!')).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
  });

  it('keeps a file:line reference as the file', () => {
    expect(extractCandidatePaths('see src/cli/daemon-lock.ts:214 for the shape')).toEqual([
      'src/cli/daemon-lock.ts',
    ]);
  });

  it('accepts a Windows-authored path and normalises the separator', () => {
    // Rule #1: the entry's separator is whatever its author typed. The wire
    // format downstream is always forward-slash.
    expect(extractCandidatePaths('broke in src\\cli\\memory\\hnsw.ts on the CI box')).toEqual([
      'src/cli/memory/hnsw.ts',
    ]);
  });

  it('accepts a directory reference with a trailing separator', () => {
    expect(extractCandidatePaths('everything under .claude/guidance/shipped/ is indexed')).toEqual([
      '.claude/guidance/shipped/',
    ]);
  });

  it('never scores a URL, even one ending in a file extension', () => {
    // A URL's own tail tokenises perfectly well as `docs/spec.md`, which is why
    // URLs are blanked before tokenising rather than filtered afterwards.
    expect(extractCandidatePaths('per https://example.com/docs/spec.md the flag is required')).toEqual([]);
    expect(extractCandidatePaths('see http://localhost:3000/api/v1/health')).toEqual([]);
  });

  it('never scores a node_modules path', () => {
    // Whether it resolves says whether anyone ran an install, not whether the
    // entry is still true.
    expect(extractCandidatePaths('patched node_modules/moflo/dist/cli.js by hand')).toEqual([]);
    expect(extractCandidatePaths('lives at packages/api/node_modules/dep/index.js')).toEqual([]);
  });

  it('never scores a glob, which has nothing to look up', () => {
    expect(extractCandidatePaths('every .claude/guidance/**/*.md file is indexed')).toEqual([]);
    expect(extractCandidatePaths('matched by src/cli/*.ts')).toEqual([]);
  });

  it('never scores a path that is not repo-relative', () => {
    expect(extractCandidatePaths('wrote it to /tmp/moflo/scratch.json')).toEqual([]);
    expect(extractCandidatePaths('lives at ~/.claude/settings.json')).toEqual([]);
    expect(extractCandidatePaths('C:\\Users\\dev\\project\\src\\app.ts failed')).toEqual([]);
    expect(extractCandidatePaths('imported ../../shared/util.ts')).toEqual([]);
  });

  it('ignores prose that merely contains a slash', () => {
    expect(extractCandidatePaths('the KEEP/RETIRE call is the readers, and/or the judges')).toEqual([]);
    expect(extractCandidatePaths('roughly 20/30 entries were stale')).toEqual([]);
  });

  it('ignores a bare filename — one segment is too ambiguous to score', () => {
    expect(extractCandidatePaths('bumped package.json and tsconfig.json')).toEqual([]);
  });

  it('deduplicates repeats, preserving first-seen order', () => {
    expect(extractCandidatePaths('src/b.ts then src/a.ts then src/b.ts again')).toEqual([
      'src/b.ts',
      'src/a.ts',
    ]);
  });
});

describe('resolvesInTree', () => {
  it('resolves a path that exists as written', () => {
    expect(resolvesInTree('src/app.ts', tree('src/app.ts'))).toBe(true);
  });

  it('retries under each workspace prefix before declaring a path dead', () => {
    // The load-bearing case: learnings are authored from inside a workspace and
    // cite `src/routes/foo.ts` meaning `packages/api/src/routes/foo.ts`. Without
    // this retry every such citation reads as dead.
    const resolves = tree('packages/api/src/routes/foo.ts');

    expect(resolvesInTree('src/routes/foo.ts', resolves)).toBe(false);
    expect(resolvesInTree('src/routes/foo.ts', resolves, ['apps/web', 'packages/api'])).toBe(true);
  });

  it('does not re-prefix a path that already carries the prefix', () => {
    const asked: string[] = [];
    const resolves = (p: string): boolean => {
      asked.push(p);
      return false;
    };

    resolvesInTree('packages/api/src/gone.ts', resolves, ['packages/api']);

    // `packages/api/packages/api/src/gone.ts` is never a real question.
    expect(asked).toEqual(['packages/api/src/gone.ts']);
  });

  it('tolerates prefixes written with a trailing or leading marker', () => {
    const resolves = tree('packages/api/src/foo.ts');

    expect(resolvesInTree('src/foo.ts', resolves, ['packages/api/'])).toBe(true);
    expect(resolvesInTree('src/foo.ts', resolves, ['./packages/api'])).toBe(true);
    expect(resolvesInTree('src/foo.ts', resolves, ['packages\\api'])).toBe(true);
    expect(resolvesInTree('src/foo.ts', resolves, [''])).toBe(false);
  });

  it('reports a path that resolves nowhere', () => {
    expect(resolvesInTree('src/gone.ts', tree('src/here.ts'), ['packages/api'])).toBe(false);
  });
});

describe('findDeadPaths', () => {
  it('nominates only the entries whose citations resolve nowhere', () => {
    const rows = [
      row('alive', 'the check is in src/cli/output.ts'),
      row('dead', 'the check was in src/cli/removed.ts'),
      row('no-paths', 'always realpath both sides before comparing'),
    ];

    const found = findDeadPaths(rows, { resolves: tree('src/cli/output.ts') });

    expect(found.map((f) => f.row.key)).toEqual(['dead']);
    expect(found[0].deadPaths).toEqual(['src/cli/removed.ts']);
  });

  it('does NOT nominate a workspace-relative citation — the file did not move', () => {
    // The expensive false positive this pass has to avoid: the entry is correct
    // as written from inside its workspace, and nothing has been deleted.
    const rows = [row('workspace-relative', 'the handler is src/routes/foo.ts')];

    const found = findDeadPaths(rows, {
      resolves: tree('packages/api/src/routes/foo.ts'),
      workspacePrefixes: ['packages/api'],
    });

    expect(found).toEqual([]);
  });

  it('DOES nominate a genuinely moved file, so a reader can correct the path', () => {
    // The file exists at a new path, which no prefix retry reaches. Nominating
    // is right; RETIRING would be wrong, and `buildJudgePrompt` is what says so.
    const rows = [row('moved', 'the guard is in src/cli/old-home/guard.ts')];

    const found = findDeadPaths(rows, {
      resolves: tree('src/cli/new-home/guard.ts'),
      workspacePrefixes: ['packages/api'],
    });

    expect(found.map((f) => f.row.key)).toEqual(['moved']);
    expect(found[0].deadPaths).toEqual(['src/cli/old-home/guard.ts']);
  });

  it('records several dead paths from one entry, deduplicated', () => {
    const rows = [row('multi', 'both src/a.ts and src/b.ts went away; src/a.ts especially')];

    const found = findDeadPaths(rows, { resolves: () => false });

    expect(found[0].deadPaths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('caps the evidence recorded per entry', () => {
    const content = Array.from({ length: 12 }, (_, i) => `src/gone-${i}.ts`).join(' ');
    const rows = [row('many', content)];

    expect(findDeadPaths(rows, { resolves: () => false })[0].deadPaths).toHaveLength(
      DEFAULT_DEAD_PATHS_PER_ENTRY,
    );
    expect(findDeadPaths(rows, { resolves: () => false, maxPathsPerEntry: 2 })[0].deadPaths).toEqual([
      'src/gone-0.ts',
      'src/gone-1.ts',
    ]);
  });

  it('asks the filesystem about each distinct path once across the whole store', () => {
    // One lookup per prefix per miss, times a store where the same file is cited
    // by dozens of entries, is the difference between a pass and a sweep.
    const asked: string[] = [];
    const rows = [
      row('a', 'see src/gone.ts'),
      row('b', 'also src/gone.ts'),
      row('c', 'and src/gone.ts again'),
    ];

    findDeadPaths(rows, {
      resolves: (p) => {
        asked.push(p);
        return false;
      },
      workspacePrefixes: ['packages/api'],
    });

    expect(asked).toEqual(['src/gone.ts', 'packages/api/src/gone.ts']);
  });

  it('nominates nothing for an empty store', () => {
    expect(findDeadPaths([], { resolves: () => false })).toEqual([]);
  });
});

describe('extractCandidatePaths — environment-rooted paths (#1479)', () => {
  it('never scores a path rooted at an environment variable', () => {
    // It resolves to wherever the variable points, which is not this tree.
    expect(extractCandidatePaths('the hook reads CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs')).toEqual([]);
    expect(extractCandidatePaths('written to XDG_DATA_HOME/moflo/state.json')).toEqual([]);
  });

  it('still scores an ordinary shouted directory', () => {
    // The underscore is what marks a variable; a shouted directory has none.
    expect(extractCandidatePaths('documented in API/v1.json')).toEqual(['API/v1.json']);
  });
});

describe('extractCandidatePaths — degenerate input (#1479)', () => {
  it('rejects a single-segment token left behind by ./ stripping', () => {
    // `./foo` tokenises as a two-segment path and normalises to one segment,
    // which every downstream rule has to survive being handed.
    expect(extractCandidatePaths('wrote ./foo and ./bar/')).toEqual([]);
  });

  it('reads empty and whitespace-only content as citing nothing', () => {
    expect(extractCandidatePaths('')).toEqual([]);
    expect(extractCandidatePaths('   \n\t ')).toEqual([]);
  });
});
