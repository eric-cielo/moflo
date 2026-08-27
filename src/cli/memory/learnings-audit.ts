/**
 * Curation pass over the `learnings` namespace (#1466).
 *
 * `flo memory cleanup` purges by age, which is the wrong instrument for durable
 * rows — a three-year-old lesson about a footgun that still exists is worth more
 * than last week's note about a migration that finished. #1464 made that
 * explicit by exempting durable namespaces from age-based cleanup, which left
 * `learnings` with no evaluation surface at all: a consumer store reached 1,582
 * entries with no way to tell which of them were still true.
 *
 * The shape that makes this affordable at that size is **mechanical filters
 * first, model judgement last**. The filters here do not decide anything — they
 * nominate. Four cheap passes (near-duplicate clustering over the embeddings
 * already stored on the row, least-used-and-old ranking, retired-vocabulary
 * matching, and dead-path resolution) narrow ~1,500 entries to a few dozen, and
 * only those go to a model. A full-store LLM sweep is the design this exists to
 * avoid.
 *
 * The dead-path pass (#1479) is the only one grounded in ground truth rather
 * than prose shape — a repo-relative path either resolves in the tree or it does
 * not. It is carved into `memory/learnings-dead-paths.ts` and re-exported from
 * here; its filesystem half is `memory/learnings-tree.ts`.
 *
 * This module is pure by construction: no filesystem, no database, no spawning.
 * Rows come in, a plan comes out. The command layer
 * (`commands/memory-audit-learnings.ts`) owns every side effect, which is what
 * makes the ranking and clustering testable without a store.
 *
 * @module memory/learnings-audit
 */

// The dead-path pass lives in its own module so this one stays the place the
// passes are ASSEMBLED. Re-exported here because `learnings-audit.js` is the
// audit's public surface — a caller configuring the pass should not have to
// know which file the detector was carved into.
import { findDeadPaths, type DeadPathScanOptions } from './learnings-dead-paths.js';

export {
  DEFAULT_DEAD_PATHS_PER_ENTRY,
  extractCandidatePaths,
  findDeadPaths,
  resolvesInTree,
  type DeadPathScanOptions,
} from './learnings-dead-paths.js';

/** The namespace this audit is scoped to. */
export const LEARNINGS_NAMESPACE = 'learnings';

/**
 * One row of the audit's input, already parsed out of `memory_entries`.
 *
 * `embedding` is the vector as stored — the default path never re-embeds, which
 * is what keeps the duplicate pass free.
 */
export interface AuditRow {
  id: string;
  key: string;
  content: string;
  /** Parsed embedding, or null when the row has none (unusable for clustering). */
  embedding: number[] | null;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
}

/** Why an entry was nominated. An entry can be nominated by more than one pass. */
export type AuditBucket = 'duplicate' | 'unused' | 'superseded' | 'dead-path';

/**
 * The verdict vocabulary, taken verbatim from the auto-memory decision table in
 * `.claude/guidance/internal/memory-hygiene.md`. Deliberately not reinvented:
 * the judgement being made here — "would removing this entry make a future
 * decision wrong?" — is the same judgement that table already encodes for `.md`
 * memories, and two vocabularies for one decision is how they drift apart.
 */
export type AuditVerdict = 'KEEP' | 'RETIRE' | 'COMPRESS' | 'MERGE';

export const AUDIT_VERDICTS: readonly AuditVerdict[] = ['KEEP', 'RETIRE', 'COMPRESS', 'MERGE'];

/**
 * A term that has been retired in favour of another, used to flag entries still
 * speaking the old language.
 */
export interface SupersededTerm {
  /** The retired term. Matched case-insensitively on word boundaries. */
  from: string;
  /** What replaced it — shown to the model as context, never applied automatically. */
  to: string;
  /** Optional one-line explanation of the rename. */
  note?: string;
}

/**
 * Retired vocabulary. **Ships empty, and a guard test keeps it that way.**
 *
 * A rename is always local to one project: the consumer that renamed `foo` to
 * `bar` is the only project where an entry saying `foo` is stale, and shipping
 * their row would flag innocent entries in every other consumer's store — while
 * also publishing that consumer's internal vocabulary to everyone who installs
 * moflo (Rule #3). The row shape is documented rather than demonstrated for the
 * same reason.
 *
 * A project that wants entries flagged fills this in downstream:
 *
 *     { from: 'old-term', to: 'new-term', note: 'renamed in <their ticket>' }
 */
export const SUPERSEDED_VOCABULARY: readonly SupersededTerm[] = [];

/** An entry nominated for a verdict, with the evidence that nominated it. */
export interface AuditCandidate {
  key: string;
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  /** Every pass that nominated this entry, in pass order. */
  buckets: AuditBucket[];
  /**
   * For a `duplicate` nomination, the key of the cluster representative this
   * entry is a near-copy of. The representative itself is never nominated.
   */
  duplicateOf?: string;
  /** Cosine similarity to {@link duplicateOf}. */
  similarity?: number;
  /** For a `superseded` nomination, the retired terms found in the content. */
  supersededTerms?: SupersededTerm[];
  /**
   * For a `dead-path` nomination, the cited paths that resolved nowhere — as
   * written and under every workspace prefix. Evidence for a reader, never a
   * verdict: see {@link findDeadPaths}.
   */
  deadPaths?: string[];
}

/** Per-bucket nomination counts, reported before any model is involved. */
export interface AuditBucketCounts {
  duplicate: number;
  unused: number;
  superseded: number;
  deadPath: number;
}

/**
 * How many rows the unused pass MATCHED, before its cap.
 *
 * Reported separately because the two numbers diverge by design: the cap exists
 * so a store written before usage recording began does not nominate its entire
 * contents, which means `counts.unused` is a sample. Printing only the capped
 * number would read as "25 unused entries" on a store with 800 of them — a
 * silent truncation presented as full coverage.
 */
export interface UnusedCoverage {
  matched: number;
  nominated: number;
}

export interface AuditPlan {
  /** Active learnings rows examined. */
  examined: number;
  /** Rows skipped because a prior `--apply` already recorded a verdict for them. */
  alreadyDecided: number;
  /** Rows with no stored vector — invisible to the duplicate pass. */
  withoutEmbedding: number;
  counts: AuditBucketCounts;
  /** What the unused pass matched vs. what its cap let through. */
  unusedCoverage: UnusedCoverage;
  /** The union of all three buckets, ranked, capped by `judgeLimit`. */
  candidates: AuditCandidate[];
  /** Nominations dropped by `judgeLimit`; they resurface on the next run. */
  overflow: number;
}

/** A verdict already recorded by a previous `--apply`, keyed by entry key. */
export interface DecidedEntry {
  verdict: AuditVerdict;
  /** Content hash at the time of the decision — a rewritten entry is re-judged. */
  hash: string;
  at: number;
}

export interface AuditPlanOptions {
  /**
   * Cosine similarity at or above which two entries are near-duplicates.
   * Higher than the 0.80 the memory protocol treats as a confident *search*
   * hit: retrieval wants topical neighbours, this wants restatements.
   */
  duplicateThreshold?: number;
  /** Minimum age (ms since last update) before an unused entry is nominated. */
  unusedMinAgeMs?: number;
  /**
   * Cap on `unused` nominations. This bucket needs a cap the other two do not:
   * usage recording only started with #1464, so every entry written before it
   * reads as zero-usage regardless of how load-bearing it is. Ranking least-used
   * first and taking the top N is what the ticket means by "a cheap way to rank
   * what deserves a model's attention" rather than a delete rule.
   */
  unusedLimit?: number;
  /** Hard cap on candidates sent for a verdict — bounds the prompt and its cost. */
  judgeLimit?: number;
  /** Retired vocabulary to match against. Defaults to the (empty) shipped table. */
  vocabulary?: readonly SupersededTerm[];
  /**
   * Enables the dead-path pass. Omitted, the pass does not run at all — this
   * module cannot reach a filesystem, so a caller with no tree to resolve
   * against (a unit test, a store audited away from its repo) gets no
   * nominations rather than every cited path read as dead.
   */
  deadPaths?: DeadPathScanOptions;
  /** Verdicts recorded by a previous `--apply`, keyed by entry key. */
  decided?: ReadonlyMap<string, DecidedEntry>;
  /** Stable content hash, injected so the module stays free of `node:crypto`. */
  hashContent?: (content: string) => string;
  /** Clock, injected for deterministic tests. */
  now?: number;
}

export const DEFAULT_DUPLICATE_THRESHOLD = 0.9;
export const DEFAULT_UNUSED_MIN_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const DEFAULT_UNUSED_LIMIT = 25;
export const DEFAULT_JUDGE_LIMIT = 60;

/**
 * Group near-duplicate rows, returning the non-representative members.
 *
 * Greedy single-pass clustering: rows are walked newest-first, so the entry that
 * survives a cluster is the most recently updated statement of the rule and the
 * older restatements are the ones nominated. That ordering is the whole point —
 * a duplicate pass that kept an arbitrary member would sometimes retire the
 * corrected version and keep the one it replaced.
 *
 * Pass the FULL row set, not a filtered one: representatives are chosen from
 * whatever is handed in, so clustering over a subset can promote an older
 * restatement to representative and nominate the newer entry instead — exactly
 * the inversion the newest-first sort exists to prevent. `buildAuditPlan`
 * therefore clusters over every row and filters the nominations afterwards.
 *
 * O(n²) in rows that carry a vector. At the ~1,500 entries this exists for that
 * is roughly a million comparisons — well under a second, and it costs no
 * embedding calls at all, which is the trade the ticket asks for. Vectors are
 * normalised once up front rather than through `cosineSim`, which would
 * recompute both magnitudes on every one of those comparisons.
 */
export function findDuplicates(
  rows: readonly AuditRow[],
  threshold: number = DEFAULT_DUPLICATE_THRESHOLD,
): Array<{ row: AuditRow; duplicateOf: string; similarity: number }> {
  const embedded = rows
    .filter((r): r is AuditRow & { embedding: number[] } => Array.isArray(r.embedding) && r.embedding.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((row) => {
      let sumSquares = 0;
      for (const component of row.embedding) sumSquares += component * component;
      const magnitude = Math.sqrt(sumSquares);
      // A zero vector has no direction, so it can neither match nor be matched.
      // `unit: null` keeps it in the walk without ever passing the threshold.
      const unit = magnitude === 0 ? null : row.embedding.map((component) => component / magnitude);
      return { row, unit };
    });

  const claimed = new Set<string>();
  const found: Array<{ row: AuditRow; duplicateOf: string; similarity: number }> = [];

  for (let i = 0; i < embedded.length; i++) {
    const representative = embedded[i];
    if (!representative.unit || claimed.has(representative.row.key)) continue;
    for (let j = i + 1; j < embedded.length; j++) {
      const other = embedded[j];
      if (!other.unit || claimed.has(other.row.key)) continue;

      // Both vectors are unit length, so the dot product IS the cosine.
      const length = Math.min(representative.unit.length, other.unit.length);
      let similarity = 0;
      for (let k = 0; k < length; k++) similarity += representative.unit[k] * other.unit[k];
      if (similarity < threshold) continue;

      // Claim the member, not the representative: a representative that stayed
      // claimable could be absorbed into a later cluster and nominated itself,
      // which would leave the rule with no surviving statement at all.
      claimed.add(other.row.key);
      found.push({ row: other.row, duplicateOf: representative.row.key, similarity });
    }
  }

  return found;
}

/**
 * Rank never-used entries older than `minAgeMs`, least-recently-updated first,
 * and return the top `limit`.
 *
 * Nomination only. Zero recorded usage is weak evidence — usage recording is
 * newer than most of the rows it is being read against — which is exactly why
 * this feeds a model rather than a DELETE.
 */
export function findUnused(
  rows: readonly AuditRow[],
  options: { now: number; minAgeMs?: number; limit?: number },
): AuditRow[] {
  const minAgeMs = options.minAgeMs ?? DEFAULT_UNUSED_MIN_AGE_MS;
  const limit = options.limit ?? DEFAULT_UNUSED_LIMIT;
  const cutoff = options.now - minAgeMs;

  return rows
    .filter((r) => r.accessCount <= 0 && r.updatedAt <= cutoff)
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, Math.max(0, limit));
}

/** Escape a vocabulary term for use inside a RegExp. */
function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find entries still using retired vocabulary.
 *
 * Matched on word boundaries so a retired `db` does not fire on `dbPath`, and
 * case-insensitively so a rename survives the entry's own capitalisation. With
 * the shipped table empty this returns nothing, which is the intended default.
 */
export function findSuperseded(
  rows: readonly AuditRow[],
  vocabulary: readonly SupersededTerm[] = SUPERSEDED_VOCABULARY,
): Array<{ row: AuditRow; terms: SupersededTerm[] }> {
  if (vocabulary.length === 0) return [];

  const matchers = vocabulary.map((term) => ({
    term,
    re: new RegExp(`\\b${escapeRegExp(term.from)}\\b`, 'i'),
  }));

  const found: Array<{ row: AuditRow; terms: SupersededTerm[] }> = [];
  for (const row of rows) {
    const terms = matchers.filter((m) => m.re.test(row.content)).map((m) => m.term);
    if (terms.length > 0) found.push({ row, terms });
  }
  return found;
}

/**
 * Run the mechanical passes and assemble the candidate set.
 *
 * Entries with a recorded verdict whose content has not changed since are
 * dropped before any pass runs — that is what makes a second run immediately
 * after `--apply` report nothing (the audit is idempotent), and it is also why
 * the hash is part of the record: a rewritten entry is a new claim and gets
 * judged again.
 */
export function buildAuditPlan(
  rows: readonly AuditRow[],
  options: AuditPlanOptions = {},
): AuditPlan {
  const now = options.now ?? Date.now();
  const decided = options.decided ?? new Map<string, DecidedEntry>();
  const hash = options.hashContent;
  const judgeLimit = options.judgeLimit ?? DEFAULT_JUDGE_LIMIT;

  const pending: AuditRow[] = [];
  let alreadyDecided = 0;
  for (const row of rows) {
    const record = decided.get(row.key);
    // No hash function means we cannot tell a rewrite from the entry we judged;
    // re-judging is the safe side of that, so the record is ignored.
    if (record && hash && record.hash === hash(row.content)) {
      alreadyDecided++;
      continue;
    }
    pending.push(row);
  }

  const byKey = new Map<string, AuditCandidate>();
  const nominate = (row: AuditRow, bucket: AuditBucket): AuditCandidate => {
    let candidate = byKey.get(row.key);
    if (!candidate) {
      candidate = {
        key: row.key,
        id: row.id,
        content: row.content,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        accessCount: row.accessCount,
        buckets: [],
      };
      byKey.set(row.key, candidate);
    }
    if (!candidate.buckets.includes(bucket)) candidate.buckets.push(bucket);
    return candidate;
  };

  const pendingKeys = new Set(pending.map((r) => r.key));

  // Cluster over EVERY row, then keep only the pending nominations. Clustering
  // over `pending` alone would let a previously-kept newest entry drop out of
  // the candidate pool and promote an older restatement to representative,
  // nominating the newer entry instead.
  const duplicates = findDuplicates(rows, options.duplicateThreshold)
    .filter((hit) => pendingKeys.has(hit.row.key));
  for (const hit of duplicates) {
    const candidate = nominate(hit.row, 'duplicate');
    candidate.duplicateOf = hit.duplicateOf;
    candidate.similarity = hit.similarity;
  }

  const unusedMatched = findUnused(pending, {
    now,
    minAgeMs: options.unusedMinAgeMs,
    limit: Number.POSITIVE_INFINITY,
  });
  const unused = unusedMatched.slice(0, Math.max(0, options.unusedLimit ?? DEFAULT_UNUSED_LIMIT));
  for (const row of unused) nominate(row, 'unused');

  const superseded = findSuperseded(pending, options.vocabulary);
  for (const hit of superseded) {
    const candidate = nominate(hit.row, 'superseded');
    candidate.supersededTerms = hit.terms;
  }

  // Runs over `pending` rather than every row: unlike clustering, this pass
  // reads one entry at a time and has no representative to protect, so a
  // previously-judged entry contributes nothing to another entry's nomination.
  const deadPaths = options.deadPaths ? findDeadPaths(pending, options.deadPaths) : [];
  for (const hit of deadPaths) {
    const candidate = nominate(hit.row, 'dead-path');
    candidate.deadPaths = hit.deadPaths;
  }

  const counts: AuditBucketCounts = {
    duplicate: duplicates.length,
    unused: unused.length,
    superseded: superseded.length,
    deadPath: deadPaths.length,
  };

  // Most-nominated first, then oldest — an entry three passes agree on is the
  // one a bounded prompt should spend its budget on.
  const ranked = [...byKey.values()].sort(
    (a, b) => b.buckets.length - a.buckets.length || a.updatedAt - b.updatedAt,
  );
  const candidates = ranked.slice(0, Math.max(0, judgeLimit));

  return {
    examined: rows.length,
    alreadyDecided,
    // Counted over every examined row, matching `examined`'s denominator.
    withoutEmbedding: rows.filter((r) => !r.embedding || r.embedding.length === 0).length,
    counts,
    unusedCoverage: { matched: unusedMatched.length, nominated: unused.length },
    candidates,
    overflow: ranked.length - candidates.length,
  };
}

/** Per-candidate body cap in the judge prompt — bounds cost, keeps the claim readable. */
export const JUDGE_CONTENT_CAP = 400;

function describeBuckets(candidate: AuditCandidate): string {
  const parts: string[] = [];
  for (const bucket of candidate.buckets) {
    if (bucket === 'duplicate') {
      parts.push(
        `near-duplicate of "${candidate.duplicateOf}" (similarity ${(candidate.similarity ?? 0).toFixed(3)})`,
      );
    } else if (bucket === 'unused') {
      parts.push('never returned by a search since usage recording began');
    } else if (bucket === 'dead-path') {
      parts.push(`cites path(s) that resolve nowhere in the tree: ${(candidate.deadPaths ?? []).join(', ')}`);
    } else {
      const terms = (candidate.supersededTerms ?? [])
        .map((t) => `"${t.from}" → "${t.to}"`)
        .join(', ');
      parts.push(`uses retired vocabulary: ${terms}`);
    }
  }
  return parts.join('; ');
}

/**
 * Build the judgement prompt for the nominated entries.
 *
 * The decision table is restated inline rather than referenced by path: the
 * model answering this runs headless in a consumer's project, where
 * `.claude/guidance/internal/memory-hygiene.md` does not exist.
 */
export function buildJudgePrompt(candidates: readonly AuditCandidate[], now: number = Date.now()): string {
  const dayMs = 24 * 60 * 60 * 1000;
  const entries = candidates
    .map((candidate, index) => {
      const ageDays = Math.max(0, Math.round((now - candidate.createdAt) / dayMs));
      const body = candidate.content.length > JUDGE_CONTENT_CAP
        ? `${candidate.content.slice(0, JUDGE_CONTENT_CAP)}…`
        : candidate.content;
      return [
        `### ${index + 1}. ${candidate.key}`,
        `- flagged because: ${describeBuckets(candidate)}`,
        `- age: ${ageDays} day(s); recorded uses: ${candidate.accessCount}`,
        `- content: ${body.replace(/\s+/g, ' ').trim()}`,
      ].join('\n');
    })
    .join('\n\n');

  return [
    'You are auditing durable engineering learnings stored in a project memory.',
    'Each entry below was flagged by a mechanical filter. The filters nominate; you decide.',
    '',
    'Classify every entry into exactly one bucket:',
    '',
    '| Verdict | When to apply |',
    '|---|---|',
    '| KEEP | The entry still drives a decision someone might make today. |',
    '| RETIRE | Resolved incident, completed migration, or a rule now enforced by a lint/test/CI gate. |',
    '| COMPRESS | Load-bearing but verbose; the durable signal fits in 1-3 sentences. |',
    '| MERGE | Restates another entry listed here; the two should become one. |',
    '',
    'Only RETIRE removes an entry. MERGE and COMPRESS are reported to a human to act on,',
    'so use them when the content still needs to survive in some form somewhere.',
    '',
    'The test: "if this entry were removed today, would any future decision be wrong?"',
    'If no — because the situation no longer arises, or a machine gate already prevents the',
    'failure — it is RETIRE. When genuinely unsure, answer KEEP: a wrongly kept entry costs',
    'a little search budget, a wrongly retired one costs the lesson.',
    '',
    'A near-duplicate flag is evidence, not a verdict: two entries can restate one rule',
    '(MERGE) or cover genuinely different cases that merely read alike (KEEP).',
    '',
    'A dead-path flag is evidence with FOUR possible causes, and only reading the entry tells',
    'them apart. Never read one as RETIRE on sight — the moved-file case is the common one:',
    '',
    '| Why the cited path does not resolve | Verdict |',
    '|---|---|',
    '| The file MOVED; the lesson still holds | COMPRESS — keep the rule, correct or drop the path |',
    '| Deleted, and the lesson was about that code | RETIRE |',
    '| Deleted, but the lesson generalises past it | COMPRESS — drop the path, keep the rule |',
    '| The entry is a historical record, correct as written | KEEP |',
    '',
    `Answer with exactly ${candidates.length} line(s), nothing else. One line per entry:`,
    '',
    '<key><TAB><VERDICT><TAB><reason in under 15 words>',
    '',
    '---',
    '',
    entries,
  ].join('\n');
}

/**
 * Parse the model's verdict lines, keyed by entry key.
 *
 * Deliberately lenient about separators and surrounding prose — the cost of a
 * strict parser here is discarding a whole batch of correct verdicts over a
 * stray preamble. Keys not present in `expected` are ignored, so a hallucinated
 * entry cannot cause an archive.
 */
export function parseVerdicts(
  text: string,
  expected: readonly string[],
): Map<string, { verdict: AuditVerdict; reason: string }> {
  const known = new Set(expected);
  const out = new Map<string, { verdict: AuditVerdict; reason: string }>();

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    // Strip a list marker only — a bare `[-*\d.\s]+` class also eats the front
    // of a key like `1466-lesson`, which then fails the `known` check and
    // silently loses its verdict (and re-nominates on every future run).
    const line = rawLine.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '');
    if (!line) continue;
    const parts = line.split(/\t|\s*\|\s*|\s{2,}|\s+-\s+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;

    const key = parts[0].replace(/^["'`]|["'`]$/g, '');
    if (!known.has(key) || out.has(key)) continue;

    const verdict = parts[1].toUpperCase().replace(/[^A-Z]/g, '') as AuditVerdict;
    if (!AUDIT_VERDICTS.includes(verdict)) continue;

    out.set(key, { verdict, reason: parts.slice(2).join(' ') });
  }

  return out;
}

/**
 * The entries `--apply` archives.
 *
 * **RETIRE only.** MERGE and COMPRESS both describe work that preserves content
 * — fold this into that one, rewrite this shorter — and nothing here performs
 * either. Archiving on those verdicts would delete the very signal the verdict
 * said to keep, and MERGE is the more dangerous of the two: "restates another
 * entry listed here" is a true statement about BOTH members of a pair, so a
 * model answering MERGE twice would erase the rule entirely. They are reported
 * for an author to act on instead.
 *
 * A cluster's representative is excluded even when it is itself nominated. The
 * duplicate pass protects the newest statement of a rule from its own bucket,
 * but `findUnused` and `findSuperseded` walk the same rows and can nominate that
 * representative independently — and a RETIRE on it alongside RETIREs on its
 * duplicates takes every statement of the rule at once.
 */
export function selectArchivable(
  candidates: readonly AuditCandidate[],
  verdicts: ReadonlyMap<string, { verdict: AuditVerdict; reason: string }>,
): AuditCandidate[] {
  const survivors = new Set(
    candidates.map((candidate) => candidate.duplicateOf).filter((key): key is string => Boolean(key)),
  );

  return candidates.filter((candidate) => {
    if (survivors.has(candidate.key)) return false;
    return verdicts.get(candidate.key)?.verdict === 'RETIRE';
  });
}

/**
 * Entries whose verdict asks for an author's hand rather than an archive —
 * MERGE and COMPRESS. Reported so a verdict never silently evaporates.
 */
export function selectManualActions(
  candidates: readonly AuditCandidate[],
  verdicts: ReadonlyMap<string, { verdict: AuditVerdict; reason: string }>,
): Array<{ candidate: AuditCandidate; verdict: AuditVerdict }> {
  const out: Array<{ candidate: AuditCandidate; verdict: AuditVerdict }> = [];
  for (const candidate of candidates) {
    const verdict = verdicts.get(candidate.key)?.verdict;
    if (verdict === 'MERGE' || verdict === 'COMPRESS') out.push({ candidate, verdict });
  }
  return out;
}
