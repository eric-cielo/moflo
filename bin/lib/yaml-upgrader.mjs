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
];

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
 * - Non-destructive: user values are never read, parsed, or rewritten.
 * - Returns the list of section keys that were appended (empty if no change).
 */
export function ensureYamlSections(yamlPath, registry = REQUIRED_SECTIONS) {
  if (!existsSync(yamlPath)) return [];

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
