# Epic Handling

When `/flo <issue>` detects an epic it follows the same orchestration as `flo epic run`. Processing stays inline in the current Claude session — the skill does not shell out — so memory, guidance, and session state remain available throughout story processing.

Epic detection criteria are listed in `SKILL.md`. Detection uses `isEpicIssue()` from `src/cli/epic/detection.ts`.

Inline processing when an epic is detected:

1. Extract stories using detection from `src/cli/epic/detection.ts`.
2. Determine strategy from `moflo.yaml` config (`epic.default_strategy`), defaulting to `single-branch`.
3. For **single-branch**: create a shared `epic/<number>-<slug>` branch, process each story via `/flo --epic-branch <branch> <issue>`, then create one consolidated PR.
4. For **auto-merge**: process each story via `/flo <issue>`, merge its PR, then proceed to the next.

## Epic strategies

| Strategy | Default | Description |
|----------|---------|-------------|
| `single-branch` | yes | One shared branch, one commit per story, one PR at the end |
| `auto-merge` | no | Per-story branches and PRs, each auto-merged before the next story |

Strategy resolves in this order:
1. CLI flag `--strategy auto-merge`
2. Config `epic.default_strategy` in `moflo.yaml`
3. Default `single-branch`

## How `flo epic run` works

1. Fetches the epic issue and validates it.
2. Extracts stories from the body (checklists, numbered refs, `## Stories` / `## Tasks` sections) in document order.
3. Loads the appropriate spell YAML template.
4. Runs via the spell engine (SpellRunner).
5. The spell template handles branch creation, story iteration, PR creation, and checklist tracking.

Individual stories run via `/flo --epic-branch <branch> <issue>`, which the spell engine invokes automatically. The `--epic-branch` flag tells `/flo` to commit to the existing branch and skip both branch creation and PR creation.

## Checklist tracking

Spell templates check off stories in the epic body after each commit. The checklist state (`[ ]` vs `[x]`) is the single source of truth for epic progress.
