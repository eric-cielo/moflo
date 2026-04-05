# Epic Processing

**Purpose:** Configuration and behavioral rules for `flo epic run` and `/flo` epic detection. Reference when processing epics, merging story PRs, or configuring epic behavior.

---

## Configuration (moflo.yaml)

**Add an `epic` section to `moflo.yaml` to control epic behavior.** All settings have sensible defaults.

```yaml
epic:
  admin_merge: true              # Use --admin on gh pr merge (bypasses branch protection)
  default_strategy: single-branch  # single-branch | auto-merge
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `admin_merge` | boolean | `true` | Pass `--admin` to `gh pr merge` in auto-merge strategy. Set `false` if the user lacks admin rights or wants branch protection enforced. |
| `default_strategy` | string | `single-branch` | Default branching strategy when `--strategy` flag is not passed. Overridden by `--strategy` CLI flag or YAML feature definition. |

---

## Branching Strategies

| Strategy | Branches | PRs | Merge behavior |
|----------|----------|-----|----------------|
| `single-branch` (default) | One shared `epic/<number>-<slug>` | One consolidated PR after all stories | No per-story merge |
| `auto-merge` | Per-story branches | Per-story PRs, each merged before next story | Squash merge with `--admin` (configurable) |

---

## Admin Merge Behavior

**In auto-merge strategy, use `--admin` on `gh pr merge` by default.** This bypasses branch protection rules that would otherwise block automated sequential processing.

| Condition | Action |
|-----------|--------|
| `epic.admin_merge: true` (default) | `gh pr merge <number> --squash --delete-branch --admin` |
| `epic.admin_merge: false` | `gh pr merge <number> --squash --delete-branch` (may fail on protected branches) |
| Single-branch strategy | No merge during processing; consolidated PR created at end |

**Never stop to ask whether a PR can be merged during epic auto-merge processing.** If the merge fails, log the error and halt the epic — do not prompt the user mid-sequence.

---

## Strategy Resolution Order

The strategy is resolved with this precedence (highest first):

1. `--strategy` CLI flag (`flo epic run 42 --strategy auto-merge`)
2. `strategy` field in YAML feature definition
3. `epic.default_strategy` in `moflo.yaml`
4. Hard-coded fallback: `single-branch`

---

## See Also

- `src/modules/cli/src/commands/epic.ts` — Epic command implementation
- `src/modules/cli/src/config/moflo-config.ts` — `MofloConfig.epic` interface and defaults
- `.claude/skills/fl/SKILL.md` — `/flo` skill epic handling section
