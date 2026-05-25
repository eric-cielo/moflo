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

function safeExec(cmd, opts) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts && opts.cwd ? { cwd: opts.cwd } : {}),
    });
  } catch { return ''; }
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
  const symbolic = safeExec('git symbolic-ref --short refs/remotes/origin/HEAD', opts).trim();
  if (symbolic.startsWith('origin/')) {
    const v = symbolic.slice('origin/'.length);
    if (cwd === undefined) _cachedDefaultBranch = v;
    return v;
  }

  // Fallback: local init.defaultBranch (set by `git init -b <name>` or config).
  const configured = safeExec('git config --get init.defaultBranch', opts).trim();
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

function readDiffFromGit(base, cwd) {
  const opts = cwd ? { cwd } : undefined;
  // Combined diff: committed-since-base + working-tree
  const committed = safeExec(`git diff ${base}...HEAD`, opts);
  const working = safeExec('git diff HEAD', opts);
  return committed + (working ? '\n' + working : '');
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
 * Pure decision function. Takes parsed stats, returns dispatch decision.
 * No I/O. Easy to unit-test with synthetic stats.
 */
function decide(stats) {
  const reasoning = [];
  const totalChange = stats.added + stats.deleted;

  if (totalChange === 0) {
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

function classifyDiff(diffText) {
  return decide(parseDiff(diffText));
}

function classifyFromGit(base, cwd) {
  const resolved = base || detectDefaultBranch(cwd);
  return classifyDiff(readDiffFromGit(resolved, cwd));
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

module.exports = { parseDiff, decide, classifyDiff, classifyFromGit, detectDefaultBranch, _resetCacheForTest };
