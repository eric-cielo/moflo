/**
 * moflo.yaml section upgrader.
 *
 * Users must never be required to re-run `moflo init` after upgrading moflo.
 * When we ship a new top-level config section (e.g. `sandbox:`), this module
 * idempotently appends the missing block — with sensible defaults and inline
 * comments — to the user's existing moflo.yaml, without touching any values
 * they've already set.
 *
 * See: .claude/guidance/internal/upgrade-contract.md
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { hasMigrationRun, markMigrationDone } from './migrations.mjs';

/**
 * Registry of top-level config sections that moflo ships with default blocks.
 *
 * Each entry: { key, block } where `block` is the raw YAML snippet (including
 * its leading comment) to append when the top-level `<key>:` is absent.
 *
 * When adding a new top-level section to the init template in moflo-init.ts,
 * also add the same block here so existing users get it on their next session.
 */
export const REQUIRED_SECTIONS = [
  {
    key: 'session_continuity',
    block: `# Passive session-continuity — pick up where you left off across sessions.
# capture: silently record a compact "where you left off" digest at turn-end.
# inject:  surface the single most-relevant recent digest at session-start
#          (relevance-gated by branch / changed files / recency, so an unrelated
#          session shows nothing). Add "<private>" to a message to skip capturing
#          that session. Set either to false to opt out.
session_continuity:
  capture: true
  inject: true
  max_age_hours: 72            # ignore digests older than this when injecting
`,
  },
  {
    key: 'auto_meditate',
    block: `# Auto-meditate (#1198) — the automatic counterpart to /meditate. When enabled,
# moflo recognizes durable lessons in the LIVE session (a tiny answer-first note
# on course-corrections / errors / decisions) and distills them into long-term
# memory at the next session-start via a cheap headless Haiku pass — deduped.
# Ships ON; set false to opt out.
auto_meditate:
  enabled: true
`,
  },
  {
    key: 'sandbox',
    block: `# Spell step sandboxing (OS-level process isolation for bash steps)
# Platform support: macOS (sandbox-exec), Linux/WSL (bwrap). Windows has no OS sandbox.
# Tiers:
#   auto          — Use best available sandbox for this platform (recommended when enabled)
#   denylist-only — Layer 1 only: block catastrophic commands, no OS isolation
#   full          — Require full OS isolation; throws if the sandbox tool is unavailable
sandbox:
  enabled: false                 # Set to true to wrap bash steps in an OS sandbox
  tier: auto                     # auto | denylist-only | full
`,
  },
  {
    key: 'sdd',
    block: `# Spec-Driven Development (Epic #1269) — spec -> plan -> implement -> verify.
# When default is true, every /flo run uses the SDD cycle unless --no-sdd is passed.
# The separate verify-before-done gate lives under gates.verify_before_done.
sdd:
  default: false
`,
  },
  {
    key: 'merge',
    block: `# Auto-merge the PR at the end of a full /flo run once preconditions are met (#1285).
# When auto is true, a full /flo run awaits required checks + MERGEABLE state then
# merges and deletes the branch, instead of stopping at "PR opened". Opt-in;
# override per-run with --merge / --no-merge.
merge:
  auto: false
`,
  },
];

/**
 * Registry of top-level config sections RENAMED across a moflo version. On
 * upgrade, an existing `<from>:` block in the user's moflo.yaml is renamed in
 * place to `<to>:` — preserving the user's values (e.g. an opt-out) — so they
 * keep their setting under the new key instead of a fresh default block being
 * appended while the stale old one lingers.
 */
export const RENAMED_SECTIONS = [
  // Auto-meditate rebrand — feature #1198 was renamed from "auto-reflect".
  { from: 'auto_reflect', to: 'auto_meditate' },
];

/**
 * Registry of one-time in-place VALUE migrations — for when the polarity of a
 * shipped default changes and we want existing users carried onto the new
 * default. Unlike a rename or an appended block, these rewrite an existing
 * value line, so each entry is scoped to a narrowly-matched, AUTO-GENERATED
 * default and never a value the user deliberately hand-set. Each is idempotent:
 * once applied, the line no longer matches its own `match`.
 */
export const VALUE_MIGRATIONS = [
  {
    // #1294 — verify-before-done flipped to default-ON. `flo init` briefly (from
    // Epic #1269 until #1294) wrote `verify_before_done: false` into the template,
    // so a project created in that window is pinned OFF and would silently skip
    // verification on upgrade. Flip that auto-written default to true. We match it
    // by its generated "opt-in" comment: a hand-typed bare `false` (no such
    // comment) is a deliberate opt-out and is LEFT UNTOUCHED. Erring toward more
    // verification is safe (a spurious extra gate is a mild `--no-verify` away);
    // dropping verification silently is the dangerous direction.
    id: 'verify_before_done-default-on-1294',
    match: /^([ \t]*)verify_before_done:[ \t]*false\b[^\n]*\bopt-in\b[^\n]*$/m,
    replace: (_m, indent) =>
      `${indent}verify_before_done: true    # Epic #1269/#1294: on by default; opt out with false or per-run --no-verify`,
  },
];

/**
 * Apply registered one-time VALUE migrations to the yaml file in place.
 *
 * **Runs each migration at most once, ever** — gated on the `.moflo/migrations.json`
 * ledger (`hasMigrationRun`/`markMigrationDone`). This is the load-bearing
 * guarantee: after the first attempt the id is recorded permanently, so if the
 * user later flips the value back (e.g. turns verify off again), a future upgrade
 * will **not** silently re-apply the migration and overwrite their choice. The
 * ledger is marked whether or not the line actually matched, so a project that
 * was already on the new value — or that had a deliberate hand-set value we chose
 * not to touch — is likewise never reconsidered.
 *
 * Returns the ids that actually rewrote a line (empty if nothing changed).
 */
export function applyValueMigrations(yamlPath, registry = VALUE_MIGRATIONS) {
  if (!existsSync(yamlPath)) return [];
  const projectRoot = dirname(yamlPath);
  let text = readFileSync(yamlPath, 'utf-8');
  let changed = false;
  const applied = [];
  for (const mig of registry) {
    if (hasMigrationRun(projectRoot, mig.id)) continue; // already attempted once — never again
    const flipped = mig.match.test(text);
    if (flipped) {
      text = text.replace(mig.match, mig.replace);
      changed = true;
      applied.push(mig.id);
    }
    // Record the attempt regardless of whether it matched, so this migration is
    // considered exactly once for this project and can't fire on a later opt-out.
    markMigrationDone(projectRoot, mig.id, { flipped });
  }
  if (changed) writeFileSync(yamlPath, text, 'utf-8');
  return applied;
}

/**
 * Rename any registered top-level sections present under their OLD key to the
 * NEW key, in place. Only the top-level key line is rewritten; the block body
 * (the user's values) is preserved untouched. No-op when the old key is absent
 * or the new key already exists. Returns the list of `from→to` renames applied.
 */
export function renameYamlSections(yamlPath, registry = RENAMED_SECTIONS) {
  if (!existsSync(yamlPath)) return [];
  let text = readFileSync(yamlPath, 'utf-8');
  const applied = [];
  for (const { from, to } of registry) {
    if (hasTopLevelSection(text, from) && !hasTopLevelSection(text, to)) {
      text = text.replace(new RegExp(`^${from}(\\s*:)`, 'm'), `${to}$1`);
      applied.push(`${from}→${to}`);
    }
  }
  if (applied.length > 0) writeFileSync(yamlPath, text, 'utf-8');
  return applied;
}

/**
 * Return true if the YAML text already defines the given top-level key.
 * Matches `^<key>:` at column 0 on any line, which is how YAML roots look.
 */
export function hasTopLevelSection(yamlText, key) {
  const pattern = new RegExp(`^${key}\\s*:`, 'm');
  return pattern.test(yamlText);
}

/**
 * Compute what ensureYamlSections() would append, without writing anything.
 * Returns the list of section keys that are missing from the given yaml text.
 */
export function missingSections(yamlText, registry = REQUIRED_SECTIONS) {
  return registry
    .filter((entry) => !hasTopLevelSection(yamlText, entry.key))
    .map((entry) => entry.key);
}

/**
 * Append any missing registered sections to the yaml file at `yamlPath`.
 *
 * - Idempotent: sections already present are left alone.
 * - Appended values are never re-touched once present. The only in-place edits
 *   are the registered key renames (RENAMED_SECTIONS) and one-time value
 *   migrations (VALUE_MIGRATIONS), each narrowly scoped so a user's deliberate
 *   settings are preserved.
 * - Returns the list of section keys that were appended (empty if no change).
 */
export function ensureYamlSections(yamlPath, registry = REQUIRED_SECTIONS) {
  if (!existsSync(yamlPath)) return [];

  // Migrate any renamed sections in place BEFORE computing what's missing, so a
  // renamed key (e.g. auto_reflect → auto_meditate) is recognised as present and
  // not re-appended as a fresh default block alongside the stale old one.
  renameYamlSections(yamlPath);

  // One-time value migrations (e.g. #1294 verify-before-done default flip). Also
  // in place, also idempotent; scoped to auto-written defaults, never user values.
  applyValueMigrations(yamlPath);

  const original = readFileSync(yamlPath, 'utf-8');
  const toAppend = registry.filter((entry) => !hasTopLevelSection(original, entry.key));
  if (toAppend.length === 0) return [];

  const needsTrailingNewline = !original.endsWith('\n');
  const separator = needsTrailingNewline ? '\n\n' : original.endsWith('\n\n') ? '' : '\n';
  const appended = toAppend.map((entry) => entry.block.trimEnd()).join('\n\n');
  const next = `${original}${separator}${appended}\n`;

  writeFileSync(yamlPath, next, 'utf-8');
  return toAppend.map((entry) => entry.key);
}
