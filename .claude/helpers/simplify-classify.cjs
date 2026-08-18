#!/usr/bin/env node
/**
 * /flo-simplify diff classifier.
 *
 * Decides which review tier the current diff warrants and returns a JSON
 * dispatch decision. The /flo-simplify skill MUST call this first so routing is
 * deterministic and unit-testable instead of a prose decision Claude makes
 * over and over per run.
 *
 * Rule: default to single-agent Sonnet review. Escalate to a 3-agent Sonnet
 * fan-out (NORMAL) when diff signals warrant it, and to a 3-agent Opus fan-out
 * (DEEP) only for genuinely architectural diffs — ordinary review is
 * breadth-bound (Sonnet wins), but architectural review is depth-bound (Opus
 * earns its cost). The most extreme diffs additionally suggest handing off to
 * Claude Code's built-in /simplify via escalate.suggested. (#1222 follow-up)
 *
 * Opus escalation is gated on genuine new-logic evidence, NEVER raw volume:
 * TS/JS uses net-new declarations; other languages use net-new lines
 * (added − deleted, aggregate → relocation/churn cancels out). Noise
 * (lockfiles, snapshots, generated/vendored) and docs/data never count toward
 * the opus bar. So a lockfile bump, a reformatting sweep, or a big rename can
 * never reach Opus.
 *
 * Outputs JSON:
 *   {
 *     "tier": "TRIVIAL" | "SMALL" | "NORMAL" | "DEEP",
 *     "model": "sonnet" | "haiku" | "opus",
 *     "agentCount": 0 | 1 | 3,
 *     "escalate": { suggested: bool, target: "builtin-simplify"|null, reason: string|null },
 *     "reasoning": [string, ...],
 *     "stats": { added, deleted, fileCount, declAdded, declRemoved, tsjsLOC, tsjsNetDecls, otherNetAdded, ... }
 *   }
 *
 * The diff it measures spans committed-since-base, working-tree, AND untracked
 * non-ignored files — an untracked file is a change the branch will carry, and
 * omitting it undercounts the diff exactly as a swallowed read error does.
 * When a read it needed did not happen, `stats.diffUnavailable` is set and the
 * decision routes to a review tier: the classifier cannot distinguish "no
 * changes" from "I could not read the changes", and only the first is safe to
 * call TRIVIAL (#1451).
 *
 * Usage:
 *   node bin/simplify-classify.cjs                  # auto-detects default branch
 *   node bin/simplify-classify.cjs --base develop   # explicit override
 *   node bin/simplify-classify.cjs --diff <unified-diff-on-stdin>
 *
 * The --diff stdin form exists so unit tests can drive the classifier
 * with synthetic diffs (no git repo required).
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// execSync defaults to a 1 MiB stdout buffer and a real branch diff clears that
// routinely (#1451 measured 2,113,712 bytes). Overflow throws ENOBUFS, which
// used to be swallowed into an empty diff — "TRIVIAL, nothing to review" on a
// branch with plenty to review. 64 MiB puts the cliff well past any diff a
// human opens a PR for; past it, the classifier now says so instead of
// reporting zero.
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;

// Cap on how much of an untracked file is slurped to synthesize its new-file
// diff. Well past any hand-written source file; anything larger is treated like
// a binary (counted as a new file with no added lines) rather than read.
const UNTRACKED_MAX_BYTES = 8 * 1024 * 1024;

// Total budget for synthesized untracked-file content. A repo with a huge
// un-ignored directory must not be slurped into memory wholesale — past this
// the remaining files are recorded as new files and the result is flagged
// unmeasurable, which forces review rather than quietly undercounting.
const UNTRACKED_TOTAL_BUDGET = 32 * 1024 * 1024;

// Paths where new logic warrants the 3-agent fan-out.
// Mechanical edits inside these paths are still SMALL; only adding/removing
// declarations triggers escalation.
const SECURITY_PATHS = [
  /(?:^|[\\\/])aidefence[\\\/]/i,
  /(?:^|[\\\/])swarm[\\\/]consensus[\\\/]/i,
  /(?:^|[\\\/])hooks?[\\\/](?:handlers?|gate|wiring)/i,
  /(?:^|[\\\/])services[\\\/]daemon-lock\.ts$/i,
  /(?:^|[\\\/])bin[\\\/]gate\./i,
  /(?:^|[\\\/])bin[\\\/]session-start-launcher\./i,
  /(?:^|[\\\/])\.claude[\\\/]helpers[\\\/]gate/i,
];

// ── File-family classification for the opus-escalation gate (#1222) ───────────
// Opus is gated on genuine new-logic evidence, never raw volume — so generated
// noise and docs/data are stripped before measuring, and TS/JS (where the decl
// parser is accurate) is measured by net-new declarations while other languages
// fall back to net-new lines.

// Generated / vendored noise — inflates LOC without adding reviewable logic.
const NOISE_FILE = [
  /(?:^|[\\\/])(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum)$/i,
  /\.snap$/i,
  /(?:^|[\\\/])__snapshots__[\\\/]/i,
  /(?:^|[\\\/])(?:dist|build|out|coverage|node_modules)[\\\/]/i,
  /\.min\.(?:js|css)$/i,
  /\.(?:map|bundle\.js)$/i,
  /(?:^|[\\\/])vendor[\\\/]/i,
];

// Docs / data — reviewed at normal tiers, but never counted toward the opus bar.
const DOCDATA_FILE = /\.(?:md|mdx|markdown|txt|rst|json|json5|ya?ml|toml|ini|cfg|conf|xml|csv|tsv|svg|properties|env)$/i;

// TS/JS source — the declaration parser is accurate here, so the opus gate uses
// net-new declarations for these files.
const TSJS_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;

/**
 * Bucket a file path into the family the opus-escalation gate cares about:
 * 'noise' / 'docdata' (both excluded from the opus bar), 'tsjs' (decl-gated),
 * or 'othercode' (net-line-gated). Pure function over the path string.
 */
function fileFamily(filename) {
  if (NOISE_FILE.some((rx) => rx.test(filename))) return 'noise';
  if (TSJS_FILE.test(filename)) return 'tsjs';
  if (DOCDATA_FILE.test(filename)) return 'docdata';
  return 'othercode';
}

// Default "no escalation" marker attached to every non-DEEP decision so the
// output shape (decision.escalate) is stable for every consumer.
function noEscalate() {
  return { suggested: false, target: null, reason: null };
}

/**
 * Run a git command, returning its stdout — or `null` if the command failed.
 *
 * `null` rather than `''` is load-bearing: a caller that cannot tell "git said
 * nothing" from "git never answered" will report an unreadable diff as an empty
 * one, and an empty diff is the one thing it is safe to call TRIVIAL (#1451).
 */
function safeExec(cmd, opts) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: EXEC_MAX_BUFFER,
      ...(opts && opts.cwd ? { cwd: opts.cwd } : {}),
    });
  } catch { return null; }
}

/**
 * Is there a repo with at least one commit here? A git failure only means
 * "there was something we could not measure" when there is history to read —
 * outside a repo, or in a fresh `git init` before the first commit, there is
 * genuinely no diff to miss, and forcing a review fan-out over nothing would be
 * its own defect.
 */
function hasGitHistory(cwd) {
  return safeExec('git rev-parse --verify HEAD', cwd ? { cwd } : undefined) !== null;
}

/**
 * One `git rev-parse` per classification, shared by both diff readers. They
 * consult it only on their failure paths — and a directory that is not a repo
 * makes every read fail, so without sharing, the cheapest case pays twice.
 */
function makeHistoryProbe(cwd) {
  let answer;
  return () => (answer === undefined ? (answer = hasGitHistory(cwd)) : answer);
}

// Detect the consumer's default branch. Hardcoding 'main' silently miscalibrates
// classification on repos that use 'master', 'develop', etc. — empty diff →
// TRIVIAL → gate stamps clean without any real review.
let _cachedDefaultBranch = null;
function detectDefaultBranch(cwd) {
  // Cache by cwd so tests probing multiple repos in-process don't return a
  // single stale value; CLI use passes no cwd and benefits from the cache.
  if (cwd === undefined && _cachedDefaultBranch !== null) return _cachedDefaultBranch;
  const opts = cwd ? { cwd } : undefined;

  // Preferred: origin/HEAD points to whatever the remote considers default.
  const symbolic = (safeExec('git symbolic-ref --short refs/remotes/origin/HEAD', opts) || '').trim();
  if (symbolic.startsWith('origin/')) {
    const v = symbolic.slice('origin/'.length);
    if (cwd === undefined) _cachedDefaultBranch = v;
    return v;
  }

  // Fallback: local init.defaultBranch (set by `git init -b <name>` or config).
  const configured = (safeExec('git config --get init.defaultBranch', opts) || '').trim();
  if (configured) {
    if (cwd === undefined) _cachedDefaultBranch = configured;
    return configured;
  }

  // Last resort: 'main' (most common modern default).
  if (cwd === undefined) _cachedDefaultBranch = 'main';
  return 'main';
}

function _resetCacheForTest() {
  _cachedDefaultBranch = null;
}

/**
 * Read the tracked half of the diff: committed-since-base + working-tree.
 * Returns `{ text, unreadable, reason }` — `unreadable` means a read we needed
 * did not happen, so `text` is an undercount and must not be trusted as zero.
 */
function readDiffFromGit(base, cwd, historyProbe) {
  const opts = cwd ? { cwd } : undefined;
  const committed = safeExec(`git diff ${base}...HEAD`, opts);
  const working = safeExec('git diff HEAD', opts);
  const text = (committed || '') + (working ? '\n' + working : '');

  if (committed !== null && working !== null) return { text, unreadable: false };
  if (!(historyProbe ? historyProbe() : hasGitHistory(cwd))) return { text, unreadable: false };

  const failed = [];
  if (committed === null) failed.push(`git diff ${base}...HEAD`);
  if (working === null) failed.push('git diff HEAD');
  return { text, unreadable: true, reason: `${failed.join(' and ')} failed` };
}

/**
 * Read the untracked half of the diff.
 *
 * Untracked files appear in no `git diff` output at all, so a branch of
 * brand-new files reads as a far smaller change than it is — 12 new CRUD files
 * classified SMALL until someone staged them (#1451). Synthesize a new-file
 * entry per untracked, non-ignored file so `parseDiff` counts it exactly as it
 * would once staged.
 *
 * Built from Node file reads rather than `git diff --no-index` against a null
 * device, which would need `/dev/null` vs `NUL` branching (Rule #1). The index
 * is never touched.
 */
function readUntrackedDiff(cwd, historyProbe) {
  const root = cwd || process.cwd();
  const out = safeExec('git ls-files --others --exclude-standard -z', cwd ? { cwd } : undefined);
  if (out === null) {
    return (historyProbe ? historyProbe() : hasGitHistory(cwd))
      ? { text: '', unreadable: true, reason: 'git ls-files --others failed' }
      : { text: '', unreadable: false };
  }

  const parts = [];
  let budgetSpent = 0;
  let overBudget = false;
  // -z keeps paths raw (no shell quoting of unusual characters). git emits them
  // POSIX-separated on every platform, so they need no separator translation —
  // only path.resolve to reach the file on disk.
  for (const rel of out.split('\0')) {
    if (!rel) continue;
    const header = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n`;

    let body = null;
    try {
      const abs = path.resolve(root, rel);
      // lstat, not stat: following an untracked symlink would read and count
      // the TARGET's content — mismeasuring the diff, and pulling bytes from
      // wherever the link points, which may be outside the working tree.
      const stat = fs.lstatSync(abs);
      if (stat.isFile() && stat.size <= UNTRACKED_MAX_BYTES && budgetSpent + stat.size <= UNTRACKED_TOTAL_BUDGET) {
        const buf = fs.readFileSync(abs);
        budgetSpent += stat.size;
        if (!buf.includes(0)) body = buf.toString('utf-8');
      } else if (stat.isFile()) {
        overBudget = overBudget || budgetSpent + stat.size > UNTRACKED_TOTAL_BUDGET;
      }
    } catch { /* vanished or unreadable — header only */ }

    if (body === null) {
      // Binary, symlink, oversized, or unreadable. git emits no `+` lines for
      // these either, so the file still counts toward fileCount/newFiles with
      // zero added lines — the honest measurement, not a swallowed one.
      parts.push(`${header}Binary files /dev/null and b/${rel} differ\n`);
      continue;
    }

    // Split on \n and drop the trailing empty element from a final newline;
    // CRLF files keep their \r on each line, which parseDiff trims before
    // testing for declarations.
    const lines = body.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    parts.push(`${header}--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n`);
    for (const ln of lines) parts.push(`+${ln}\n`);
  }

  const text = parts.join('');
  return overBudget
    ? { text, unreadable: true, reason: 'untracked files exceeded the diff-synthesis budget' }
    : { text, unreadable: false };
}

/**
 * Parse a unified-diff string into per-file stats and aggregate signals.
 * No git/I/O — pure function over the diff text. Test-friendly.
 */
function parseDiff(diff) {
  const lines = diff.split('\n');
  const files = new Map(); // filename → { added, deleted, declAdded, declRemoved, isNew, isRenamed }
  let current = null;

  // Match function/class/export-const-arrow/method declarations being
  // added or removed. Conservative — biased toward false negatives so we
  // don't over-escalate.
  const DECL_RE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type)\s+\w/;
  const ARROW_DECL_RE = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*[:=].*=>\s*\{?$/;

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    // File header: `diff --git a/path b/path`
    let m = ln.match(/^diff --git (?:a\/)?(.+?) (?:b\/)?(.+)$/);
    if (m) {
      const filename = m[2];
      current = { filename, added: 0, deleted: 0, declAdded: 0, declRemoved: 0, isNew: false, isRenamed: false };
      files.set(filename, current);
      continue;
    }
    if (!current) continue;

    if (ln.startsWith('new file mode')) current.isNew = true;
    if (ln.startsWith('rename from') || ln.startsWith('rename to') || ln.startsWith('similarity index')) current.isRenamed = true;

    // Skip diff headers
    if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('@@') || ln.startsWith('index ')) continue;

    if (ln.startsWith('+') && !ln.startsWith('+++')) {
      current.added++;
      const body = ln.slice(1).trim();
      if (DECL_RE.test(body) || ARROW_DECL_RE.test(body)) current.declAdded++;
    } else if (ln.startsWith('-') && !ln.startsWith('---')) {
      current.deleted++;
      const body = ln.slice(1).trim();
      if (DECL_RE.test(body) || ARROW_DECL_RE.test(body)) current.declRemoved++;
    }
  }

  // Aggregate
  let added = 0, deleted = 0, declAdded = 0, declRemoved = 0;
  let newFiles = 0, renamedFiles = 0;
  let securityHit = false;
  // Family-segregated signals for the opus-escalation gate (#1222). Noise +
  // docs/data still contribute to the global totals (so existing
  // TRIVIAL/SMALL/NORMAL routing is unchanged) but never to the opus bar.
  let tsjsAdded = 0, tsjsDeleted = 0, tsjsDeclAdded = 0, tsjsDeclRemoved = 0;
  let otherAdded = 0, otherDeleted = 0;
  for (const f of files.values()) {
    added += f.added;
    deleted += f.deleted;
    declAdded += f.declAdded;
    declRemoved += f.declRemoved;
    if (f.isNew) newFiles++;
    if (f.isRenamed) renamedFiles++;
    if (SECURITY_PATHS.some(rx => rx.test(f.filename))) securityHit = true;

    const fam = fileFamily(f.filename);
    if (fam === 'tsjs') {
      tsjsAdded += f.added; tsjsDeleted += f.deleted;
      tsjsDeclAdded += f.declAdded; tsjsDeclRemoved += f.declRemoved;
    } else if (fam === 'othercode') {
      otherAdded += f.added; otherDeleted += f.deleted;
    }
  }

  return {
    added, deleted, declAdded, declRemoved,
    netDecls: declAdded - declRemoved,
    fileCount: files.size,
    newFiles, renamedFiles,
    securityHit,
    // Opus-gate signals (#1222): net-new declarations for TS/JS, net-new lines
    // for other code. Aggregate net → relocation/churn cancels to ~0.
    tsjsLOC: tsjsAdded + tsjsDeleted,
    tsjsNetDecls: tsjsDeclAdded - tsjsDeclRemoved,
    tsjsDeclAdded,
    otherNetAdded: otherAdded - otherDeleted,
    otherLOC: otherAdded + otherDeleted,
    files: [...files.keys()],
  };
}

/**
 * Route a diff we actually managed to measure. Pure — no I/O. Callers reach
 * this through `decide`, which first handles the case where the measurement
 * itself failed.
 */
function decideMeasured(stats) {
  const reasoning = [];
  const totalChange = stats.added + stats.deleted;

  // Only a diff with no files at all is genuinely empty. A diff carrying files
  // but no +/- lines — binary assets, pure renames, mode changes, an untracked
  // binary — is a real change git simply does not express as lines, and calling
  // it "nothing to review" is the same undercount as swallowing a read error.
  if (totalChange === 0 && stats.fileCount === 0) {
    return { tier: 'TRIVIAL', model: 'sonnet', agentCount: 0, escalate: noEscalate(), reasoning: ['empty diff — nothing to review'], stats };
  }

  // TRIVIAL: tiny diff, no declarations changed
  if (totalChange <= 10 && stats.fileCount <= 1 && stats.netDecls === 0 && stats.declAdded === 0 && stats.declRemoved === 0) {
    reasoning.push(`≤10 LOC in 1 file with no declaration changes`);
    return { tier: 'TRIVIAL', model: 'sonnet', agentCount: 0, escalate: noEscalate(), reasoning, stats };
  }

  // Mechanical relocation detection — the #906 case.
  // If declarations were both ADDED and REMOVED at roughly matching rates,
  // it's a structural move, not net-new logic. Judge by declaration balance,
  // not raw LOC balance — formatting/blank-line differences between source
  // and destination files easily push raw LOC out of balance even when the
  // semantic change is purely "moved 5 functions across 5 new files".
  // Mechanical relocations are SMALL even when many files / many lines.
  const declTouched = stats.declAdded + stats.declRemoved;
  const isMostlyRelocation = stats.declAdded >= 2
    && stats.declRemoved >= 2
    && Math.abs(stats.netDecls) <= Math.max(2, Math.floor(declTouched * 0.30));

  if (isMostlyRelocation) {
    reasoning.push(
      `mostly relocation: ${stats.declAdded} decls added, ${stats.declRemoved} removed, net ${stats.netDecls >= 0 ? '+' : ''}${stats.netDecls}`,
    );
    // Haiku is sufficient for mechanical moves: code already existed and worked,
    // so review reduces to copy-paste-divergence / dead-after-move pattern checks
    // — exactly haiku's strength. ~5x cheaper than sonnet on relocation-shape diffs.
    return { tier: 'SMALL', model: 'haiku', agentCount: 1, escalate: noEscalate(), reasoning, stats };
  }

  // ── Architectural escalation to Opus (#1222) ────────────────────────────────
  // Two rungs above NORMAL, BOTH gated on genuine new-logic evidence so volume
  // alone never escalates: TS/JS by net-new declarations, other languages by
  // net-new lines. The relocation guard above already returned SMALL, so
  // mechanical moves never reach here, and noise/docs/data were stripped from
  // these signals in parseDiff.
  //
  //   • DEEP            → runs a 3-agent Opus pass automatically (depth-bound
  //                       architectural review; ordinary review stays Sonnet).
  //   • DEEP + handoff  → also suggests Claude Code's built-in /simplify for the
  //                       most extreme diffs (escalate.suggested = true). The
  //                       Opus pass still runs as the floor; the handoff is a
  //                       prompt, not an auto-switch.
  const tsjsLOC = stats.tsjsLOC || 0;
  const tsjsNetDecls = stats.tsjsNetDecls || 0;
  const tsjsDeclAdded = stats.tsjsDeclAdded || 0;
  const otherNetAdded = stats.otherNetAdded || 0;

  // The new-subsystem triggers count TS/JS declarations only (tsjs-scoped, not
  // global) so a docs/data file with a fenced `export function` code sample
  // can't leak into the opus gate — consistent with the net-new-logic contract.
  const handoffTriggers = [];
  if (tsjsLOC > 4000 && tsjsNetDecls >= 25) handoffTriggers.push(`${tsjsLOC} LOC of TS/JS with ${tsjsNetDecls} net-new declarations`);
  if (otherNetAdded > 3000) handoffTriggers.push(`${otherNetAdded} net-new lines of non-TS/JS source`);
  if (stats.newFiles >= 10 && tsjsDeclAdded >= 30 && tsjsNetDecls >= 20) handoffTriggers.push(`${stats.newFiles} new files with ${tsjsDeclAdded} new TS/JS declarations`);

  if (handoffTriggers.length > 0) {
    return {
      tier: 'DEEP', model: 'opus', agentCount: 3,
      escalate: { suggested: true, target: 'builtin-simplify', reason: handoffTriggers.join('; ') },
      reasoning: handoffTriggers, stats,
    };
  }

  const deepTriggers = [];
  if (tsjsLOC > 1500 && tsjsNetDecls >= 10) deepTriggers.push(`${tsjsLOC} LOC of TS/JS with ${tsjsNetDecls} net-new declarations`);
  if (otherNetAdded > 1200) deepTriggers.push(`${otherNetAdded} net-new lines of non-TS/JS source`);
  if (stats.newFiles >= 5 && tsjsDeclAdded >= 15 && tsjsNetDecls >= 10) deepTriggers.push(`${stats.newFiles} new files with ${tsjsDeclAdded} new TS/JS declarations`);
  if (stats.securityHit && stats.netDecls >= 8) deepTriggers.push(`security-sensitive path with ${stats.netDecls} net-new declarations`);

  if (deepTriggers.length > 0) {
    return {
      tier: 'DEEP', model: 'opus', agentCount: 3,
      escalate: noEscalate(),
      reasoning: deepTriggers, stats,
    };
  }

  // Escalation triggers — any one trips NORMAL (3 agents).
  // Sonnet — ordinary cross-cutting review is breadth-bound, so 3 Sonnet agents
  // are the right tool; Opus is reserved for the DEEP (architectural) tier above.
  const triggers = [];
  if (totalChange > 500) triggers.push(`>500 LOC changed (${totalChange})`);
  if (stats.fileCount >= 5 && stats.netDecls >= 3) triggers.push(`${stats.fileCount} files with ${stats.netDecls} net new declarations`);
  if (stats.securityHit && stats.netDecls > 0) triggers.push('security-sensitive path with new logic');
  if (stats.newFiles >= 3 && stats.declAdded >= 5) triggers.push(`${stats.newFiles} new files with ${stats.declAdded} new declarations`);

  if (triggers.length > 0) {
    return { tier: 'NORMAL', model: 'sonnet', agentCount: 3, escalate: noEscalate(), reasoning: triggers, stats };
  }

  // Default: SMALL — single sonnet agent
  reasoning.push(`small/medium diff: ${totalChange} LOC across ${stats.fileCount} file(s), +${stats.declAdded}/-${stats.declRemoved} decls`);
  return { tier: 'SMALL', model: 'sonnet', agentCount: 1, escalate: noEscalate(), reasoning, stats };
}

/**
 * Pure decision function. Takes parsed stats, returns dispatch decision.
 * No I/O. Easy to unit-test with synthetic stats.
 *
 * `stats.diffUnavailable` marks a diff the reader could not fully measure. The
 * classifier cannot tell "no changes" from "I could not read the changes", and
 * only the first is safe to call TRIVIAL — so an unmeasurable diff routes to a
 * review tier and says why, rather than stamping the gate clean (#1451).
 */
function decide(stats) {
  if (!stats.diffUnavailable) return decideMeasured(stats);

  const note = `diff could not be fully read (${stats.diffUnavailableReason || 'git read failed'})`
    + ' — a diff the classifier cannot measure is never TRIVIAL';
  // Whatever DID parse may already warrant more than the forced NORMAL floor;
  // an architectural diff whose working-tree half went missing stays DEEP.
  const measured = decideMeasured(stats);
  if (measured.agentCount >= 3) {
    return { ...measured, reasoning: [note].concat(measured.reasoning) };
  }
  return { tier: 'NORMAL', model: 'sonnet', agentCount: 3, escalate: noEscalate(), reasoning: [note], stats };
}

function classifyDiff(diffText) {
  return decide(parseDiff(diffText));
}

function classifyFromGit(base, cwd) {
  const resolved = base || detectDefaultBranch(cwd);
  const historyProbe = makeHistoryProbe(cwd);
  const tracked = readDiffFromGit(resolved, cwd, historyProbe);
  const untracked = readUntrackedDiff(cwd, historyProbe);
  const stats = parseDiff(tracked.text + (untracked.text ? '\n' + untracked.text : ''));
  if (tracked.unreadable || untracked.unreadable) {
    stats.diffUnavailable = true;
    // Both halves can fail independently; surface every reason, not just the
    // first, so the printed decision explains the whole gap.
    stats.diffUnavailableReason = [tracked.reason, untracked.reason].filter(Boolean).join('; ');
  }
  return decide(stats);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf('--base');
  const base = baseIdx >= 0 ? args[baseIdx + 1] : detectDefaultBranch();
  const stdinDiff = args.includes('--diff') || args.includes('--stdin');

  let result;
  if (stdinDiff) {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => {
      result = classifyDiff(buf);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    });
  } else {
    result = classifyFromGit(base);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
}

module.exports = {
  parseDiff, decide, classifyDiff, classifyFromGit,
  readUntrackedDiff, detectDefaultBranch, EXEC_MAX_BUFFER, _resetCacheForTest,
};
