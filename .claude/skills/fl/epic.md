# Epic Handling

## Unified Epic Processing

When `/flo <issue>` detects an epic, it follows the same orchestration logic as `flo epic run`.
The `/flo` skill does NOT shell out — it processes the epic inline within the current Claude session,
following the strategy steps below. This keeps the full context (memory, guidance, session state)
available throughout story processing.

Epic detection criteria are listed in `SKILL.md` under **Usage > Epic Handling**.
Detection uses `isEpicIssue()` from `src/modules/cli/src/epic/detection.ts`.

**Inline processing steps when `/flo <issue>` detects an epic:**
1. Extract stories using detection from `src/modules/cli/src/epic/detection.ts`
2. Determine strategy from `moflo.yaml` config (`epic.default_strategy`), defaulting to `single-branch`
3. For **single-branch**: create shared `epic/<number>-<slug>` branch, process each story via `/flo --epic-branch <branch> <issue>`, then create one consolidated PR
4. For **auto-merge**: process each story via `/flo <issue>`, merge its PR, then proceed to next

## Epic Strategies

| Strategy | Default | Description |
|----------|---------|-------------|
| `single-branch` | **Yes** | One shared branch, one commit per story, one PR at the end |
| `auto-merge` | No | Per-story branches and PRs, each auto-merged before the next story |

Strategy is determined by (in priority order):
1. CLI flag: `--strategy auto-merge`
2. Feature definition: `strategy` field in YAML
3. Config: `epic.default_strategy` in `moflo.yaml`
4. Default: `single-branch`

## How It Works

The `flo epic run` command:
1. Fetches the epic issue and validates it
2. Extracts and orders stories (topological sort for dependencies)
3. Loads the appropriate spell YAML template
4. Runs via the spell engine (SpellRunner)
5. The spell template handles branch creation, story iteration, PR creation, and checklist tracking

Individual stories within an epic are processed via `/flo --epic-branch <branch> <issue>`,
which the spell engine invokes automatically. The `--epic-branch` flag tells `/flo` to
commit to the existing branch and skip branch creation and PR creation.

## Epic Checklist Tracking

The spell templates automatically check off stories in the epic body after each commit.
The checklist state (`[ ]` vs `[x]`) is the **single source of truth** for epic progress.
