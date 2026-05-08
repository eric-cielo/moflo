/**
 * Classify a spell's source path as 'shipped' (ships with moflo, read-only
 * from the consumer's perspective) or 'user' (project-local, writable).
 *
 * Story #1003 — used by the post-cast arg-writeback offer to skip the save
 * prompt for shipped YAMLs (mutating them inside `node_modules/moflo/...`
 * would be wiped on the next `npm install` and confuses provenance).
 */

const SHIPPED_MARKERS: readonly RegExp[] = [
  // Installed package — both bare 'moflo' and the legacy '@moflo/*' workspace.
  /\/node_modules\/moflo\//,
  /\/node_modules\/@moflo\//,
  // Source-tree shipped definitions (relevant when moflo dogfoods itself).
  /\/src\/cli\/spells\/definitions\//,
  /\/dist\/[^/]*\/?cli\/spells\/definitions\//,
];

export type SpellTier = 'shipped' | 'user';

export function inferSpellTier(sourceFile: string | undefined): SpellTier {
  if (!sourceFile) return 'user';
  const norm = sourceFile.replace(/\\/g, '/');
  return SHIPPED_MARKERS.some((re) => re.test(norm)) ? 'shipped' : 'user';
}
