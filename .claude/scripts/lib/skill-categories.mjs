/**
 * Skill-category selection for the session-start launcher (#1308).
 *
 * ## Why this leaf exists
 *
 * The launcher syncs every shipped skill into the consumer on each run
 * (`syncDirRecursive` in `file-sync.mjs`). Before #1308 that sync was
 * unconditional except for `INTERNAL_SKILLS`, which meant a consumer could not
 * narrow their installed skill set: whatever `flo init` selected, the next
 * session start put everything back. The category structure in `SKILLS_MAP` was
 * therefore dead config.
 *
 * To honour a selection the launcher has to know which skill belongs to which
 * category. The canonical map is `SKILLS_MAP` in `src/cli/init/executor.ts`,
 * but the launcher is a plain `.mjs` and cannot import that TS const across the
 * dist/source depth boundary — so this leaf mirrors it, exactly as
 * `internal-skills.mjs` mirrors `INTERNAL_SKILLS`.
 * `tests/bin/skill-categories-parity.test.ts` asserts the two never drift.
 *
 * ## Default is "everything"
 *
 * A consumer with no `skills:` block in `moflo.yaml` must keep getting every
 * skill — anything else would silently delete capability on upgrade for every
 * existing install (Rule #2). `parseSkillCategories` returns `null` for
 * "unconfigured", and `computeExcludedSkills(null, …)` excludes nothing beyond
 * the internal skills.
 *
 * @module bin/lib/skill-categories
 */

/**
 * Mirror of `SKILLS_MAP` in `src/cli/init/executor.ts`. Keep in sync — the
 * parity test fails otherwise.
 */
export const SKILL_CATEGORIES_MAP = {
  core: [
    'commune',
    'eldar',
    'guidance',
    'healer',
    'flo-simplify',
    'distill',
    'luminarium',
    'reasoningbank-intelligence',
    'meditate',
    'divine',
    'quicken',
    'perf-audit',
    'ward',
    'test-gaps',
    'verify',
  ],
  memory: [
    'memory-patterns',
    'memory-optimization',
    'vector-search',
    'memory-worktree',
    'memory-team',
  ],
  spells: [
    'spell-builder',
    'spell-schedule',
    'connector-builder',
  ],
};

/** Every category name, in declaration order. */
export const SKILL_CATEGORY_NAMES = Object.keys(SKILL_CATEGORIES_MAP);

/**
 * Skills installed by `moflo-init.ts` outside `SKILLS_MAP` (the `/flo` + `/fl`
 * ticket spell). They are the primary entry point and are never category-gated
 * — excluding them would break the headline workflow.
 */
export const ALWAYS_INSTALLED_SKILLS = ['flo', 'fl'];

/**
 * Extract the selected skill categories from raw `moflo.yaml` text.
 *
 * Regex-based on purpose: the launcher deliberately avoids a YAML dependency
 * (see the `auto_update` parsing it sits beside). Both YAML list styles are
 * accepted because either is what a hand-editing consumer will write:
 *
 *     skills:
 *       categories: [core, memory]
 *
 *     skills:
 *       categories:
 *         - core
 *         - memory
 *
 * @param {string} yamlContent
 * @returns {string[]|null} selected categories, or null when unconfigured
 *   (meaning "no restriction" — sync everything).
 *
 *   An explicitly empty list returns `[]`, which is a REAL selection and is not
 *   the same as `null`: it excludes every category, leaving only
 *   {@link ALWAYS_INSTALLED_SKILLS} (`/flo` + `/fl`). That is a legitimate
 *   "bare minimum" choice, but it is a much stronger statement than omitting
 *   the block, so the two must never be conflated.
 */
export function parseSkillCategories(yamlContent) {
  if (typeof yamlContent !== 'string' || yamlContent.length === 0) return null;

  // Flow style: categories: [a, b]
  const flow = yamlContent.match(/^[ \t]*skills:[ \t]*\r?\n(?:[ \t]+[^\r\n]*\r?\n)*?[ \t]+categories:[ \t]*\[([^\]]*)\]/m);
  if (flow) {
    return flow[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s.length > 0);
  }

  // Block style: categories:\n  - a\n  - b
  const block = yamlContent.match(/^[ \t]*skills:[ \t]*\r?\n(?:[ \t]+[^\r\n]*\r?\n)*?[ \t]+categories:[ \t]*\r?\n((?:[ \t]*-[ \t]*[^\r\n]+\r?\n?)+)/m);
  if (block) {
    return block[1]
      .split(/\r?\n/)
      .map((line) => line.match(/^[ \t]*-[ \t]*(.+?)[ \t]*$/))
      .filter(Boolean)
      .map((m) => m[1].replace(/^['"]|['"]$/g, '').trim())
      .filter((s) => s.length > 0);
  }

  return null;
}

/**
 * Resolve the set of top-level skill directory names the launcher must NOT
 * sync, given a selection.
 *
 * Unknown category names in the selection are ignored rather than treated as
 * "select nothing" — a typo in `moflo.yaml` should not silently strip a
 * consumer's skills. Skills that belong to no category at all are always kept
 * for the same reason: this function can only ever exclude a skill it can
 * positively attribute to an UNSELECTED category.
 *
 * @param {string[]|null} selected - from `parseSkillCategories`
 * @param {string[]} internalSkills - INTERNAL_SKILLS (never installed)
 * @returns {Set<string>} top-level names to exclude from the sync
 */
export function computeExcludedSkills(selected, internalSkills = []) {
  const excluded = new Set(internalSkills);
  if (!Array.isArray(selected)) return excluded; // unconfigured → no restriction

  const keep = new Set(ALWAYS_INSTALLED_SKILLS);
  for (const category of selected) {
    for (const skill of SKILL_CATEGORIES_MAP[category] || []) keep.add(skill);
  }

  for (const [category, skills] of Object.entries(SKILL_CATEGORIES_MAP)) {
    if (selected.includes(category)) continue;
    for (const skill of skills) {
      if (!keep.has(skill)) excluded.add(skill);
    }
  }
  return excluded;
}
