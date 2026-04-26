# MoFlo Upgrade Contract

> **The rule: a user bumping their moflo version must never have to run `moflo init` again.** Every new capability we ship must auto-apply on the next session start after `npm install moflo@latest`. No manual action, no "re-run init to pick up the new thing," no "set this flag in your yaml." If a user has to do anything except restart their session, we've shipped a broken upgrade.

This is a CRITICAL invariant. Every PR that adds or changes a config surface MUST respect it.

## Scope — what auto-upgrades

| Artifact | Mechanism | Where wired |
|----------|-----------|-------------|
| `.claude/scripts/*.mjs`, `.claude/scripts/lib/*` | Static file sync on version change | `bin/session-start-launcher.mjs` scriptFiles list |
| `.claude/helpers/*` | Static file sync on version change | `bin/session-start-launcher.mjs` helper list |
| `.claude/guidance/**` (shipped) | `syncAllShippedGuidance()` on init; also session-start refresh | `src/cli/init/moflo-init.ts` |
| `.claude/settings.json` hooks | Merge on session-start / init | `src/cli/init/settings-generator.ts` |
| `moflo.yaml` top-level sections | **Idempotent append** of missing sections on session start | See §"Yaml upgrade pattern" |
| `CLAUDE.md` moflo block | Regenerated between marker comments | `src/cli/init/claudemd-generator.ts` |

If you add a new artifact class, wire it into one of these paths. Do **not** invent new upgrade mechanisms that require user intervention.

## Yaml upgrade pattern (the sandbox lesson)

When we added the `sandbox:` config block, the default was `enabled: false` and the block was invisible in user yaml files. Users couldn't discover the feature because:

1. `generateConfig()` in `moflo-init.ts` only writes `moflo.yaml` if it doesn't exist — existing projects never saw the new block
2. No session-start step appended missing sections

**The correct pattern for adding a new top-level config section:**

1. Add the block (with sensible defaults and inline comments) to the init template in `src/cli/init/moflo-init.ts`
2. Add the schema + defaults to `src/cli/config/moflo-config.ts` (`DEFAULT_CONFIG`, type, parser)
3. Register the section in the session-start yaml upgrader so that existing projects get the block appended idempotently on next version bump
4. Document in `docs/` — any setting that can't be discovered by reading `moflo.yaml` has failed the contract

The upgrader must:
- Parse existing yaml (section headers only; we don't rewrite user values)
- For each registered section, append `# <comment>\n<section-name>:\n  <defaults>` if the top-level key is absent
- Never modify user-set values
- Never reorder or reformat the file
- Log what was appended (visible in session-start output)

## Tension with "static files, not dynamic generation" (shipped core-guidance §Session Start Automation)

That rule applies to **static helper scripts** — files with no per-project content should ship as pre-built files in `bin/`, not be generated at runtime. It does **not** forbid yaml patches:

- Helper scripts: ship static, sync by copy. ✅
- User's yaml config: patch idempotently on version change, appending only missing sections. ✅
- Never: regenerate the user's yaml from a template on every start (would clobber user edits). ❌

The distinction is *user-owned files get additive patches; tool-owned files get replaced*.

## Pre-merge checklist for config-surface changes

Before merging any PR that touches config, ask:

- [ ] If a user upgrades moflo and does **nothing else**, does the new capability work?
- [ ] If the answer involves "they need to run `moflo init`" or "they need to add X to their yaml" — the PR is incomplete
- [ ] Are defaults chosen so the feature is discoverable (either on-by-default or clearly commented when off)?
- [ ] Is the yaml block documented in the relevant `docs/` page, including how to change it?

## Historical violations (don't repeat)

- **v4.x sandbox block** — shipped with `enabled: false` and no auto-append; users couldn't find the setting even though it existed in the schema. Fixed by (1) adding block to init template, (2) adding session-start yaml upgrader.
