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
    'optimize-learnings',
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
 * How far `parseSkillCategories` will look ahead for the `]` closing a
 * flow-style `categories: [...]` list. Bounded so an unterminated bracket costs
 * a fixed amount of work rather than a scan to end-of-file per candidate line.
 */
const FLOW_LOOKAHEAD_LINES = 50;

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
 * Scanned line by line rather than with one multi-line regex. The regex form
 * spanned the gap between `skills:` and `categories:` with
 * `(?:[ \t]+[^\r\n]*\r?\n)*?`, whose `[ \t]+` and `[^\r\n]*` overlap — every
 * indented line could be split many ways, so a `skills:` block with no
 * `categories:` key backtracked exponentially and hung the launcher at session
 * start on the consumer's own `moflo.yaml` (#1418). Line scanning is linear and
 * matches the same inputs.
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

  const lines = yamlContent.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    if (!/^[ \t]*skills:[ \t]*$/.test(lines[i])) continue;

    // Walk the indented block under `skills:`. A dedent (or a blank line) ends
    // it, exactly as the old `[ \t]+`-per-line repetition required.
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!/^[ \t]/.test(line)) break;

      // Flow style: categories: [a, b], possibly wrapped across lines — the old
      // regex accepted that because its `[^\]]*` spanned newlines, so dropping
      // it would be a silent behaviour regression.
      //
      // Lookahead is bounded and accumulates FORWARD rather than re-slicing the
      // remainder of the file. `lines.slice(j).join('\n')` on every candidate
      // line is O(n^2) on a file with many unterminated `categories: [` lines —
      // a smaller version of exactly the attacker-controlled-YAML blowup this
      // rewrite exists to close. A real flow list is one or two lines; 50 is
      // already far past any legitimate input.
      if (/^[ \t]+categories:[ \t]*\[/.test(line)) {
        let buffer = line;
        for (let k = j + 1; k < lines.length && k <= j + FLOW_LOOKAHEAD_LINES; k++) {
          if (buffer.includes(']')) break;
          buffer += '\n' + lines[k];
        }
        const flow = buffer.match(/^[ \t]+categories:[ \t]*\[([^\]]*)\]/);
        if (flow) {
          return flow[1]
            .split(',')
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
            .filter((s) => s.length > 0);
        }
      }

      // Block style: categories:\n  - a\n  - b
      if (/^[ \t]+categories:[ \t]*$/.test(line)) return parseBlockItems(lines, j + 1);
    }
  }

  return null;
}

/**
 * Collect `- item` lines following a bare `categories:` key.
 *
 * Returns `null` when there is not a single dash item, mirroring the old block
 * regex's `+` quantifier failing to match: a `categories:` key with nothing
 * under it is unconfigured ("sync everything"), NOT an empty selection ("sync
 * nothing"). Conflating those would strip every skill from a consumer who left
 * the key dangling (Rule #2).
 *
 * @param {string[]} lines
 * @param {number} start - index of the first candidate item line
 * @returns {string[]|null}
 */
function parseBlockItems(lines, start) {
  const items = [];
  let sawItem = false;

  for (let k = start; k < lines.length; k++) {
    const item = lines[k].match(/^[ \t]*-[ \t]*(.+?)[ \t]*$/);
    if (!item) break;
    sawItem = true;
    const value = item[1].replace(/^['"]|['"]$/g, '').trim();
    if (value.length > 0) items.push(value);
  }

  return sawItem ? items : null;
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
