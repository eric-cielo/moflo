#!/usr/bin/env node
/**
 * /simplify diff classifier — issue #908.
 *
 * Decides which review tier the current diff warrants and returns a JSON
 * dispatch decision. The /simplify skill MUST call this first so routing is
 * deterministic and unit-testable instead of a prose decision Claude makes
 * over and over per run.
 *
 * Rule (per user direction): default to single-agent Sonnet review. Only
 * escalate to a 3-agent fan-out when diff signals genuinely warrant it.
 * Opus is never selected — the existing skill already documents that.
 *
 * Outputs JSON:
 *   {
 *     "tier": "TRIVIAL" | "SMALL" | "NORMAL",
 *     "model": "sonnet",
 *     "agentCount": 0 | 1 | 3,
 *     "reasoning": [string, ...],
 *     "stats": { added, deleted, fileCount, declAdded, declRemoved, ... }
 *   }
 *
 * Usage:
 *   node bin/simplify-classify.cjs [--base main]
 *   node bin/simplify-classify.cjs --diff <unified-diff-on-stdin>
 *
 * The --diff stdin form exists so unit tests can drive the classifier
 * with synthetic diffs (no git repo required).
 */
'use strict';

const { execSync } = require('child_process');

// Paths where new logic warrants the 3-agent fan-out (issue #908).
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

function safeExec(cmd) {
  try { return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { return ''; }
}

function readDiffFromGit(base) {
  // Combined diff: committed-since-base + working-tree
  const committed = safeExec(`git diff ${base}...HEAD`);
  const working = safeExec('git diff HEAD');
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
  for (const f of files.values()) {
    added += f.added;
    deleted += f.deleted;
    declAdded += f.declAdded;
    declRemoved += f.declRemoved;
    if (f.isNew) newFiles++;
    if (f.isRenamed) renamedFiles++;
    if (SECURITY_PATHS.some(rx => rx.test(f.filename))) securityHit = true;
  }

  return {
    added, deleted, declAdded, declRemoved,
    netDecls: declAdded - declRemoved,
    fileCount: files.size,
    newFiles, renamedFiles,
    securityHit,
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
    return { tier: 'TRIVIAL', model: 'sonnet', agentCount: 0, reasoning: ['empty diff — nothing to review'], stats };
  }

  // TRIVIAL: tiny diff, no declarations changed
  if (totalChange <= 10 && stats.fileCount <= 1 && stats.netDecls === 0 && stats.declAdded === 0 && stats.declRemoved === 0) {
    reasoning.push(`≤10 LOC in 1 file with no declaration changes`);
    return { tier: 'TRIVIAL', model: 'sonnet', agentCount: 0, reasoning, stats };
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
    return { tier: 'SMALL', model: 'sonnet', agentCount: 1, reasoning, stats };
  }

  // Escalation triggers — any one trips NORMAL (3 agents).
  // Always Sonnet — Opus is never the right model for /simplify per skill rule.
  const triggers = [];
  if (totalChange > 500) triggers.push(`>500 LOC changed (${totalChange})`);
  if (stats.fileCount >= 5 && stats.netDecls >= 3) triggers.push(`${stats.fileCount} files with ${stats.netDecls} net new declarations`);
  if (stats.securityHit && stats.netDecls > 0) triggers.push('security-sensitive path with new logic');
  if (stats.newFiles >= 3 && stats.declAdded >= 5) triggers.push(`${stats.newFiles} new files with ${stats.declAdded} new declarations`);

  if (triggers.length > 0) {
    return { tier: 'NORMAL', model: 'sonnet', agentCount: 3, reasoning: triggers, stats };
  }

  // Default: SMALL — single sonnet agent
  reasoning.push(`small/medium diff: ${totalChange} LOC across ${stats.fileCount} file(s), +${stats.declAdded}/-${stats.declRemoved} decls`);
  return { tier: 'SMALL', model: 'sonnet', agentCount: 1, reasoning, stats };
}

function classifyDiff(diffText) {
  return decide(parseDiff(diffText));
}

function classifyFromGit(base = 'main') {
  return classifyDiff(readDiffFromGit(base));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf('--base');
  const base = baseIdx >= 0 ? args[baseIdx + 1] : 'main';
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

module.exports = { parseDiff, decide, classifyDiff, classifyFromGit };
