/**
 * Unit tests for the pure curation passes behind `flo memory audit-learnings`
 * (#1466).
 *
 * The module is deliberately free of fs/db/spawn, so every one of these runs
 * against plain objects — which is the point: the ranking and clustering rules
 * are the part that decides what a model gets asked about, and they need to be
 * checkable without a store.
 */

import { describe, expect, it } from 'vitest';

import {
  AUDIT_VERDICTS,
  DEFAULT_UNUSED_MIN_AGE_MS,
  buildAuditPlan,
  buildJudgePrompt,
  findDuplicates,
  findSuperseded,
  findUnused,
  parseVerdicts,
  selectArchivable,
  selectManualActions,
  type AuditRow,
  type AuditVerdict,
} from '../../memory/learnings-audit.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function row(overrides: Partial<AuditRow> & { key: string }): AuditRow {
  return {
    id: `id-${overrides.key}`,
    content: `content for ${overrides.key}`,
    embedding: null,
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 10 * DAY,
    accessCount: 3,
    ...overrides,
  };
}

/** A unit vector rotated by `angle` — lets a test dial cosine similarity exactly. */
function vec(angle: number): number[] {
  return [Math.cos(angle), Math.sin(angle), 0, 0];
}

describe('findDuplicates', () => {
  it('nominates the older member and keeps the newest as representative', () => {
    const rows = [
      row({ key: 'older', embedding: vec(0), updatedAt: NOW - 5 * DAY }),
      row({ key: 'newest', embedding: vec(0.01), updatedAt: NOW }),
    ];

    const found = findDuplicates(rows, 0.9);

    expect(found).toHaveLength(1);
    expect(found[0].row.key).toBe('older');
    expect(found[0].duplicateOf).toBe('newest');
    expect(found[0].similarity).toBeGreaterThan(0.9);
  });

  it('leaves entries below the threshold alone', () => {
    const rows = [
      row({ key: 'a', embedding: vec(0), updatedAt: NOW }),
      row({ key: 'b', embedding: vec(Math.PI / 3), updatedAt: NOW - DAY }), // cos 60° = 0.5
    ];

    expect(findDuplicates(rows, 0.9)).toEqual([]);
  });

  it('never nominates every member of a cluster — one statement always survives', () => {
    const rows = [
      row({ key: 'a', embedding: vec(0), updatedAt: NOW }),
      row({ key: 'b', embedding: vec(0.01), updatedAt: NOW - DAY }),
      row({ key: 'c', embedding: vec(0.02), updatedAt: NOW - 2 * DAY }),
    ];

    const found = findDuplicates(rows, 0.9);

    expect(found.map((f) => f.row.key).sort()).toEqual(['b', 'c']);
    expect(new Set(found.map((f) => f.duplicateOf))).toEqual(new Set(['a']));
  });

  it('skips rows with no stored vector rather than re-embedding them', () => {
    // IDENTICAL content, no stored vectors. Anything that computed an embedding
    // here would score these at 1.0 and cluster them — finding nothing is the
    // proof that the pass reads the column and never calls the embedder.
    const rows = [
      row({ key: 'vectorless-1', content: 'exactly the same words', embedding: null }),
      row({ key: 'vectorless-2', content: 'exactly the same words', embedding: null }),
    ];

    expect(findDuplicates(rows, 0.9)).toEqual([]);
  });

  it('ignores a zero vector, which has no direction to compare', () => {
    const rows = [
      row({ key: 'zero-a', embedding: [0, 0, 0, 0], updatedAt: NOW }),
      row({ key: 'zero-b', embedding: [0, 0, 0, 0], updatedAt: NOW - DAY }),
    ];

    expect(findDuplicates(rows, 0.9)).toEqual([]);
  });
});

describe('findUnused', () => {
  it('nominates only never-used entries past the age floor', () => {
    const rows = [
      row({ key: 'old-unused', accessCount: 0, updatedAt: NOW - 200 * DAY }),
      row({ key: 'old-but-used', accessCount: 4, updatedAt: NOW - 200 * DAY }),
      row({ key: 'recent-unused', accessCount: 0, updatedAt: NOW - DAY }),
    ];

    const found = findUnused(rows, { now: NOW, minAgeMs: DEFAULT_UNUSED_MIN_AGE_MS });

    expect(found.map((r) => r.key)).toEqual(['old-unused']);
  });

  it('ranks least-recently-updated first and caps at the limit', () => {
    const rows = [
      row({ key: 'middle', accessCount: 0, updatedAt: NOW - 200 * DAY }),
      row({ key: 'oldest', accessCount: 0, updatedAt: NOW - 400 * DAY }),
      row({ key: 'newest', accessCount: 0, updatedAt: NOW - 100 * DAY }),
    ];

    const found = findUnused(rows, { now: NOW, minAgeMs: 90 * DAY, limit: 2 });

    expect(found.map((r) => r.key)).toEqual(['oldest', 'middle']);
  });
});

describe('findSuperseded', () => {
  it('returns nothing against the shipped (empty) vocabulary', () => {
    const rows = [row({ key: 'a', content: 'anything at all' })];

    expect(findSuperseded(rows)).toEqual([]);
  });

  it('matches a retired term on word boundaries, case-insensitively', () => {
    const vocabulary = [{ from: 'widget', to: 'gadget' }];
    const rows = [
      row({ key: 'hit', content: 'The Widget cache must be flushed first.' }),
      row({ key: 'substring-only', content: 'widgetfactory is unrelated' }),
    ];

    const found = findSuperseded(rows, vocabulary);

    expect(found.map((f) => f.row.key)).toEqual(['hit']);
    expect(found[0].terms[0].to).toBe('gadget');
  });

  it('does not treat a regex metacharacter in a term as a pattern', () => {
    const vocabulary = [{ from: 'a.b', to: 'a-b' }];
    const rows = [row({ key: 'literal-only', content: 'axb should not match' })];

    expect(findSuperseded(rows, vocabulary)).toEqual([]);
  });
});

describe('buildAuditPlan', () => {
  it('reports per-bucket counts and unions the buckets into one candidate set', () => {
    const rows = [
      row({ key: 'dup-old', embedding: vec(0), updatedAt: NOW - DAY }),
      row({ key: 'dup-new', embedding: vec(0.01), updatedAt: NOW }),
      row({ key: 'stale', accessCount: 0, updatedAt: NOW - 300 * DAY }),
    ];

    const plan = buildAuditPlan(rows, { now: NOW });

    expect(plan.examined).toBe(3);
    expect(plan.counts.duplicate).toBe(1);
    expect(plan.counts.unused).toBe(1);
    expect(plan.counts.superseded).toBe(0);
    expect(plan.candidates.map((c) => c.key).sort()).toEqual(['dup-old', 'stale']);
  });

  it('records both buckets on an entry two passes agree on, and ranks it first', () => {
    const rows = [
      row({ key: 'both', embedding: vec(0), accessCount: 0, updatedAt: NOW - 300 * DAY }),
      row({ key: 'representative', embedding: vec(0.01), updatedAt: NOW }),
      row({ key: 'only-unused', accessCount: 0, updatedAt: NOW - 200 * DAY }),
    ];

    const plan = buildAuditPlan(rows, { now: NOW });

    expect(plan.candidates[0].key).toBe('both');
    expect(plan.candidates[0].buckets.sort()).toEqual(['duplicate', 'unused']);
    expect(plan.candidates[0].duplicateOf).toBe('representative');
  });

  it('skips entries whose recorded verdict still matches their content', () => {
    const rows = [row({ key: 'stale', content: 'body', accessCount: 0, updatedAt: NOW - 300 * DAY })];
    const hashContent = (c: string): string => `h:${c}`;

    const plan = buildAuditPlan(rows, {
      now: NOW,
      hashContent,
      decided: new Map([['stale', { verdict: 'KEEP' as AuditVerdict, hash: 'h:body', at: NOW }]]),
    });

    expect(plan.alreadyDecided).toBe(1);
    expect(plan.candidates).toEqual([]);
    expect(plan.counts.unused).toBe(0);
  });

  it('re-nominates an entry that was rewritten since its verdict', () => {
    const rows = [row({ key: 'stale', content: 'rewritten', accessCount: 0, updatedAt: NOW - 300 * DAY })];
    const hashContent = (c: string): string => `h:${c}`;

    const plan = buildAuditPlan(rows, {
      now: NOW,
      hashContent,
      decided: new Map([['stale', { verdict: 'KEEP' as AuditVerdict, hash: 'h:body', at: NOW }]]),
    });

    expect(plan.alreadyDecided).toBe(0);
    expect(plan.candidates.map((c) => c.key)).toEqual(['stale']);
  });

  it('picks the cluster representative from every row, not just the undecided ones', () => {
    // The newest entry already carries a KEEP, so it drops out of the pending
    // set. Clustering over `pending` alone would promote the older restatement
    // to representative and nominate the NEWER entry — the inversion the
    // newest-first sort exists to prevent.
    const rows = [
      row({ key: 'newest-kept', content: 'body', embedding: vec(0), updatedAt: NOW }),
      row({ key: 'older-a', embedding: vec(0.01), updatedAt: NOW - 5 * DAY }),
      row({ key: 'older-b', embedding: vec(0.02), updatedAt: NOW - 6 * DAY }),
    ];
    const hashContent = (c: string): string => `h:${c}`;

    const plan = buildAuditPlan(rows, {
      now: NOW,
      hashContent,
      decided: new Map([['newest-kept', { verdict: 'KEEP' as AuditVerdict, hash: 'h:body', at: NOW }]]),
    });

    expect(plan.candidates.map((c) => c.key).sort()).toEqual(['older-a', 'older-b']);
    for (const candidate of plan.candidates) expect(candidate.duplicateOf).toBe('newest-kept');
  });

  it('reports what the unused pass matched, not only what its cap let through', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ key: `stale-${i}`, accessCount: 0, updatedAt: NOW - (300 + i) * DAY }),
    );

    const plan = buildAuditPlan(rows, { now: NOW, unusedLimit: 3 });

    // Printing only "3" on a store with 10 matches reads as full coverage.
    expect(plan.unusedCoverage).toEqual({ matched: 10, nominated: 3 });
    expect(plan.counts.unused).toBe(3);
  });

  it('caps the candidate set at the judge limit and reports the overflow', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ key: `stale-${i}`, accessCount: 0, updatedAt: NOW - (300 + i) * DAY }),
    );

    const plan = buildAuditPlan(rows, { now: NOW, judgeLimit: 2 });

    expect(plan.candidates).toHaveLength(2);
    expect(plan.overflow).toBe(3);
  });
});

describe('buildJudgePrompt', () => {
  it('carries the KEEP/RETIRE/COMPRESS/MERGE table and every candidate key', () => {
    const plan = buildAuditPlan(
      [
        row({ key: 'dup-old', embedding: vec(0), updatedAt: NOW - DAY }),
        row({ key: 'dup-new', embedding: vec(0.01), updatedAt: NOW }),
      ],
      { now: NOW },
    );

    const prompt = buildJudgePrompt(plan.candidates, NOW);

    for (const verdict of AUDIT_VERDICTS) expect(prompt).toContain(verdict);
    expect(prompt).toContain('dup-old');
    expect(prompt).toContain('near-duplicate of "dup-new"');
  });

  it('caps each body so one long entry cannot blow up the prompt', () => {
    const plan = buildAuditPlan(
      [row({ key: 'long', content: 'x'.repeat(5_000), accessCount: 0, updatedAt: NOW - 300 * DAY })],
      { now: NOW },
    );

    expect(buildJudgePrompt(plan.candidates, NOW).length).toBeLessThan(3_000);
  });
});

describe('parseVerdicts', () => {
  it('reads tab-separated verdict lines', () => {
    const text = 'alpha\tRETIRE\tmigration finished\nbeta\tKEEP\tstill bites';

    const verdicts = parseVerdicts(text, ['alpha', 'beta']);

    expect(verdicts.get('alpha')).toEqual({ verdict: 'RETIRE', reason: 'migration finished' });
    expect(verdicts.get('beta')?.verdict).toBe('KEEP');
  });

  it('survives a preamble, list markers, and pipe separators', () => {
    const text = [
      'Here are my verdicts:',
      '',
      '1. alpha | MERGE | restates beta',
      '- beta | KEEP | load-bearing',
    ].join('\n');

    const verdicts = parseVerdicts(text, ['alpha', 'beta']);

    expect(verdicts.get('alpha')?.verdict).toBe('MERGE');
    expect(verdicts.get('beta')?.verdict).toBe('KEEP');
  });

  it('keeps a key that starts with digits intact', () => {
    // A bare [-*\d.\s]+ strip eats the front of `1466-lesson`, the key then
    // fails the known-keys check, and the verdict is silently dropped.
    const verdicts = parseVerdicts('1466-lesson\tRETIRE\tsuperseded', ['1466-lesson']);

    expect(verdicts.get('1466-lesson')?.verdict).toBe('RETIRE');
  });

  it('ignores keys that were never sent, so a hallucination cannot cause an archive', () => {
    const verdicts = parseVerdicts('invented\tRETIRE\tnope', ['alpha']);

    expect(verdicts.size).toBe(0);
  });

  it('ignores a verdict word outside the vocabulary', () => {
    const verdicts = parseVerdicts('alpha\tDELETE\tnot a verdict', ['alpha']);

    expect(verdicts.size).toBe(0);
  });
});

describe('selectArchivable', () => {
  it('archives RETIRE only — never KEEP, COMPRESS, or MERGE', () => {
    const plan = buildAuditPlan(
      ['retire-me', 'merge-me', 'keep-me', 'compress-me'].map((key, i) =>
        row({ key, accessCount: 0, updatedAt: NOW - (300 + i) * DAY }),
      ),
      { now: NOW },
    );
    const verdicts = new Map<string, { verdict: AuditVerdict; reason: string }>([
      ['retire-me', { verdict: 'RETIRE', reason: '' }],
      ['merge-me', { verdict: 'MERGE', reason: '' }],
      ['keep-me', { verdict: 'KEEP', reason: '' }],
      ['compress-me', { verdict: 'COMPRESS', reason: '' }],
    ]);

    // MERGE means "fold these into one" and nothing here performs the fold, so
    // archiving on it deletes content the verdict said to preserve. Worse, both
    // members of a pair can honestly be answered MERGE.
    expect(selectArchivable(plan.candidates, verdicts).map((c) => c.key)).toEqual(['retire-me']);
    expect(selectManualActions(plan.candidates, verdicts).map((m) => m.candidate.key).sort()).toEqual([
      'compress-me',
      'merge-me',
    ]);
  });

  it('never archives the survivor of a cluster, even when another pass nominated it', () => {
    // The newest statement of the rule is old and never used, so `findUnused`
    // nominates it independently of the duplicate pass that was protecting it.
    const rows = [
      row({ key: 'survivor', embedding: vec(0), accessCount: 0, updatedAt: NOW - 300 * DAY }),
      row({ key: 'restatement', embedding: vec(0.01), accessCount: 0, updatedAt: NOW - 400 * DAY }),
    ];
    const plan = buildAuditPlan(rows, { now: NOW });
    const verdicts = new Map<string, { verdict: AuditVerdict; reason: string }>(
      plan.candidates.map((c) => [c.key, { verdict: 'RETIRE' as AuditVerdict, reason: '' }]),
    );

    expect(plan.candidates.map((c) => c.key).sort()).toEqual(['restatement', 'survivor']);

    const archivable = selectArchivable(plan.candidates, verdicts).map((c) => c.key);

    expect(archivable).toEqual(['restatement']);
    expect(archivable).not.toContain('survivor');
  });

  it('archives nothing when no verdict came back', () => {
    const plan = buildAuditPlan([row({ key: 'a', accessCount: 0, updatedAt: NOW - 300 * DAY })], { now: NOW });

    expect(selectArchivable(plan.candidates, new Map())).toEqual([]);
  });
});

describe('buildAuditPlan — dead-path bucket (#1479)', () => {
  const resolves = (known: string[]) => (p: string) => known.includes(p);

  it('nominates a citing entry and carries the unresolved paths as evidence', () => {
    const rows = [
      row({ key: 'cites-live', content: 'the check is in src/cli/output.ts' }),
      row({ key: 'cites-dead', content: 'the check was in src/cli/removed.ts' }),
    ];

    const plan = buildAuditPlan(rows, {
      now: NOW,
      deadPaths: { resolves: resolves(['src/cli/output.ts']) },
    });

    expect(plan.counts.deadPath).toBe(1);
    expect(plan.candidates.map((c) => c.key)).toEqual(['cites-dead']);
    expect(plan.candidates[0].buckets).toEqual(['dead-path']);
    expect(plan.candidates[0].deadPaths).toEqual(['src/cli/removed.ts']);
  });

  it('does not run the pass at all when no resolver is supplied', () => {
    // A caller with no tree to resolve against — a unit test, a store audited
    // away from its repo — must get no nominations rather than every cited path
    // read as dead.
    const plan = buildAuditPlan([row({ key: 'cites', content: 'see src/cli/anything.ts' })], { now: NOW });

    expect(plan.counts.deadPath).toBe(0);
    expect(plan.candidates).toEqual([]);
  });

  it('ranks an entry two passes agree on above one only the path pass flagged', () => {
    const rows = [
      row({ key: 'path-only', content: 'see src/cli/gone.ts', accessCount: 4, updatedAt: NOW }),
      row({
        key: 'path-and-unused',
        content: 'see src/cli/also-gone.ts',
        accessCount: 0,
        updatedAt: NOW - 300 * DAY,
      }),
    ];

    const plan = buildAuditPlan(rows, { now: NOW, deadPaths: { resolves: () => false } });

    expect(plan.counts.deadPath).toBe(2);
    expect(plan.counts.unused).toBe(1);
    expect(plan.candidates.map((c) => c.key)).toEqual(['path-and-unused', 'path-only']);
    expect(plan.candidates[0].buckets.sort()).toEqual(['dead-path', 'unused']);
  });

  it('skips entries a prior --apply already decided, like every other pass', () => {
    const decided = new Map([
      ['judged', { verdict: 'KEEP' as AuditVerdict, hash: 'h', at: NOW }],
    ]);
    const plan = buildAuditPlan(
      [row({ key: 'judged', content: 'see src/cli/gone.ts' })],
      { now: NOW, decided, hashContent: () => 'h', deadPaths: { resolves: () => false } },
    );

    expect(plan.alreadyDecided).toBe(1);
    expect(plan.counts.deadPath).toBe(0);
  });
});

describe('buildJudgePrompt — dead paths (#1479)', () => {
  function promptFor(content: string): string {
    const plan = buildAuditPlan([row({ key: 'cites-dead', content })], {
      now: NOW,
      deadPaths: { resolves: () => false },
    });
    return buildJudgePrompt(plan.candidates, NOW);
  }

  it('names the unresolved paths as the evidence', () => {
    const prompt = promptFor('the guard was in src/cli/old-home/guard.ts');

    expect(prompt).toContain('resolve nowhere in the tree');
    expect(prompt).toContain('src/cli/old-home/guard.ts');
  });

  it('tells the judge the moved-file case is COMPRESS, never RETIRE on sight', () => {
    // The whole reason this bucket nominates rather than decides: treating a
    // dead path as a deletion throws away lessons that are still entirely true.
    const prompt = promptFor('the guard was in src/cli/old-home/guard.ts');

    expect(prompt).toContain('FOUR possible causes');
    expect(prompt).toContain('Never read one as RETIRE on sight');
    expect(prompt).toMatch(/The file MOVED.*COMPRESS/);
    expect(prompt).toMatch(/historical record.*KEEP/);
  });
});
