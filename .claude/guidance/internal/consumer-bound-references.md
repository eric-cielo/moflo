# Consumer-Bound Cross-Reference Paths

**Purpose:** Rule for any text that Claude will read on a consumer's machine — guidance See Also sections, skill SKILL.md links, injected CLAUDE.md templates, runtime subagent directives, and anything else that ships in the npm package and tells Claude to read a file. The destination filesystem layout on a consumer is not the same as moflo's own dogfood tree, and using `shipped/` in cross-references silently produces ENOENT for every consumer.

---

## The Rule

**Consumer-bound references to a moflo guidance doc MUST use `.claude/guidance/<file>.md`. They MUST NOT use `.claude/guidance/shipped/<file>.md`.**

The `shipped/` segment is a SOURCE-tree artifact inside moflo's package. It is never created as a destination directory on a consumer project.

---

## Why

On a consumer machine after `npm install moflo` + first session-start, the on-disk layout is:

| Path | Exists? | Notes |
|------|---------|-------|
| `<consumer-root>/.claude/guidance/moflo-<file>.md` | yes | Mirror written by `bin/session-start-launcher.mjs` and `src/cli/init/moflo-init.ts`. Both write the auto-generated header at the top. |
| `<consumer-root>/.claude/guidance/shipped/` | **no** | Never created. The `shipped/` token only ever appears as a SOURCE segment inside `node_modules/moflo/.claude/guidance/shipped/`. |
| `<consumer-root>/node_modules/moflo/.claude/guidance/shipped/moflo-<file>.md` | yes | Read-only inside `node_modules`. Not what Claude resolves when the user's CLAUDE.md says `.claude/guidance/shipped/...`. |

A path written `.claude/guidance/shipped/<file>.md` resolves relative to the consumer's project root, not their `node_modules/moflo`. The Read tool returns ENOENT.

The bug is invisible inside moflo's own dogfooding repo because the source `shipped/` directory IS at the project root there. That mirror-vs-source asymmetry is exactly why this rule exists.

---

## Where the rule applies

| Surface | Ships to consumers? | Rule |
|---------|---------------------|------|
| `.claude/guidance/shipped/**/*.md` (See Also + inline refs) | yes (synced to `<root>/.claude/guidance/`) | use `.claude/guidance/<file>.md` |
| `.claude/skills/**/*.md` (any path-bearing string) | yes (synced to `<root>/.claude/skills/`) | use `.claude/guidance/<file>.md` |
| `.claude/agents/**/*.md` | yes | use `.claude/guidance/<file>.md` |
| `.claude/commands/**/*.md` | yes | use `.claude/guidance/<file>.md` |
| `.claude/helpers/subagent-bootstrap.json` (`directive` field) | yes (read at every subagent spawn on consumer) | use `.claude/guidance/<file>.md` |
| `src/cli/services/subagent-bootstrap.ts` (`FALLBACK_DIRECTIVE`) | runs on consumer | use `.claude/guidance/<file>.md` |
| `src/cli/init/claudemd-generator.ts` (injected template strings) | injected into consumer's CLAUDE.md | use `.claude/guidance/<file>.md` |
| `src/cli/init/moflo-init.ts` (`generateClaudeMd` template) | same | use `.claude/guidance/<file>.md` |
| `bin/setup-project.mjs` (CLAUDE.md template) | injected into consumer's CLAUDE.md | use `.claude/guidance/<file>.md` |
| `.claude/guidance/internal/**/*.md` | **no** (dev-only) | `shipped/<file>.md` is fine — only resolved inside moflo's repo |
| moflo's own `CLAUDE.md` (root, `src/cli/CLAUDE.md`, etc.) | no (not in npm package) | `shipped/<file>.md` is fine |
| `bin/*.mjs` log/error strings describing source paths | runs on consumer | OK to mention `node_modules/moflo/.claude/guidance/shipped/...` as descriptive context — that path exists |

---

## Exceptions (intentional `shipped/` references in shipped content)

A handful of shipped docs reference `shipped/` deliberately as descriptive context — they describe moflo's package layout to the consumer rather than telling Claude to read a file. Keep these:

- `shipped/moflo-settings-injection.md` — describes the read-only `.claude/guidance/shipped/**` directory inside `node_modules/moflo`.
- `shipped/moflo-session-start.md` — explains the launcher copies from `node_modules/moflo/.claude/guidance/shipped/` to the consumer's `.claude/guidance/`.
- `shipped/moflo-source-hygiene.md` — moflo-developer guidance about where to place new shipped files (debatable whether this should ship at all, but the path it references is correct as-is).

The distinguishing test: **does the path follow the word "see", "read", "reference", or appear in a See Also bullet?** Then it's a directive Claude will try to resolve, and it must be the consumer path. If it's inside descriptive prose explaining "moflo lays out its source tree this way", `shipped/` is fine.

---

## Anti-patterns

```markdown
<!-- WRONG — ENOENT on every consumer -->
- `.claude/guidance/shipped/moflo-core-guidance.md` — CLI reference

<!-- RIGHT -->
- `.claude/guidance/moflo-core-guidance.md` — CLI reference
```

```ts
// WRONG — injected into consumer's CLAUDE.md
const ref = '.claude/guidance/shipped/moflo-core-guidance.md';

// RIGHT
const ref = '.claude/guidance/moflo-core-guidance.md';
```

```json
// WRONG — every subagent on a consumer reads this string
{ "directive": "... follow `.claude/guidance/shipped/moflo-subagents.md` protocol." }

// RIGHT
{ "directive": "... follow `.claude/guidance/moflo-subagents.md` protocol." }
```

---

## Authoring checklist (applies to any change)

Before committing any change that touches a path-bearing string in shipped content:

1. Is the file under `.claude/guidance/shipped/`, `.claude/skills/`, `.claude/agents/`, `.claude/commands/`, `.claude/helpers/`, or a source file that injects into consumer CLAUDE.md / subagent context?
2. Does the change reference `.claude/guidance/shipped/`?
3. If both yes, is it descriptive context (an exception above) or a directive? If directive — strip the `shipped/`.

A periodic grep is the cheapest enforcement: `grep -rn '.claude/guidance/shipped/' .claude/guidance/shipped/ .claude/skills/ src/cli/init/ bin/ .claude/helpers/` should only return the documented exceptions.

---

## See Also

- `.claude/guidance/internal/guidance-rules.md` — Moflo-only extensions to universal guidance rules; rule 2 covers the ship-vs-local partition that this rule operationalizes for cross-references
- `.claude/guidance/internal/consumer-project-paths.md` — Sibling rule for `bin/*.mjs` script path resolution on consumer projects
- `.claude/guidance/internal/guidance-sync.md` — How shipped guidance moves from moflo's repo into a consumer's `.claude/guidance/`; the source of truth for what destination layout this rule assumes
- `.claude/guidance/shipped/moflo-settings-injection.md` — Consumer-facing description of what moflo writes into `.claude/`; one of the legitimate `shipped/` descriptive references
