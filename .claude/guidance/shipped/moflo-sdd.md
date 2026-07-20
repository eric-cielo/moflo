# MoFlo Spec-Driven Development (SDD) & Verify-Before-Done

**Purpose:** How to run and reason about the `spec → plan → implement → verify` cycle in `/flo`, the `flo sdd` artifact CLI, and the verify-before-done gate. Read this before using `-sd`/`-v`, editing `.moflo/specs/`, or turning on `sdd.default` / `gates.verify_before_done`.

---

## When to Use `-sd` vs `-v` vs Neither

Two independent, opt-in modifiers on `/flo` — orthogonal to execution mode (`-n`/`-s`/`-h`) and `--worktree`. Verify is separable from SDD by design.

| Situation | Flag | Effect |
|-----------|------|--------|
| Fuzzy or large unit of work; you want a reviewed spec/plan before code | `-sd` / `--sdd` | Full spec → plan → (review) → implement → verify. Implies `--verify`. |
| Well-scoped work, but you want "prove it works before done" enforced | `-v` / `--verify` | Normal run plus the verify-before-done gate; no spec/plan front-half. |
| Small, obvious change | (none) | Standard `/flo` run. |

`--sdd` **always implies** `--verify` — a spec/plan without an enforced verify step drifts. Use `--no-sdd` / `--no-verify` to opt a single run out of a `moflo.yaml` default.

---

## The Artifact Convention

Specs and plans persist as Markdown, one directory per unit of work, under the configured specs directory (default `.moflo/specs`):

```
<specs_dir>/<slug>/spec.md   # the "what" + acceptance criteria
<specs_dir>/<slug>/plan.md   # the "steps" + how each criterion is verified
```

They are indexed into memory on session start, so `mcp__moflo__memory_search` surfaces prior specs across sessions. **Always create and mutate them through the `flo sdd` CLI** — never hand-write the path in a skill step (cross-platform, Rule #1: the CLI builds every path with `path.join`).

**Where they live is configurable (`sdd.specs_dir`, #1294).** The default `.moflo/specs` is **gitignored** by `flo init` — specs stay local and do not bloat source control, but they also do **not** appear in PRs. To make specs reviewable, point `sdd.specs_dir` at a **tracked** path and commit them:

| `sdd.specs_dir` | Committed? | Use when |
|-----------------|------------|----------|
| `.moflo/specs` (default) | No (gitignored) | You want the SDD workflow but not spec artifacts in history |
| `docs/specs`, `.specs`, … (tracked) | Yes | You want specs reviewed in the PR alongside the code |

Set it once in `moflo.yaml`; the `flo sdd` CLI and the session-start indexer both honor it. If the path sits inside a `guidance.directories` entry, specs are indexed once (as guidance), not twice.

Each artifact carries a `status` of `draft` or `reviewed` in its frontmatter. The constitution layer (`CLAUDE.md` + `.claude/guidance/`) is referenced by every stage — never restate its invariants inside a spec.

---

## Driving the Cycle with `flo sdd`

| Command | Does |
|---------|------|
| `flo sdd spec "<title>"` | Scaffold `spec.md` (or show an existing one). `--from <file\|->` seeds the body. |
| `flo sdd review <slug>` | Mark the spec reviewed — unlocks the plan. |
| `flo sdd plan <slug>` | Scaffold `plan.md`; **requires the spec be reviewed**. |
| `flo sdd review <slug> plan` | Mark the plan reviewed — unlocks implementation. |
| `flo sdd check <slug> implement` | Review-checkpoint gate — exits non-zero until the plan is reviewed. |
| `flo sdd list` / `flo sdd status <slug>` | Enumerate specs / show one unit's spec+plan status. |

The two review checkpoints are the point: **a spec must be reviewed before its plan; a plan must be reviewed before implementation.** Pass `--force` only to deliberately skip a checkpoint.

---

## Verify-Before-Done Gate

When enforced, `gh pr create` is blocked until the change has been verified end-to-end since the last code edit.

- **Enforcement is opt-in.** Off by default; enable with `gates.verify_before_done: true` (or per-run `-v`). Existing installs see zero change on upgrade.
- **Satisfy it by running the native `/verify` skill** — it exercises the change against the plan's (or ticket's) acceptance criteria. Store the outcome to memory (`namespace: learnings, key: verify:<slug>`) so it feeds routing/learning.
- **A source edit invalidates a prior verification** — re-run `/verify` after editing. `/ward` and `/quicken` are targeted audits, not the completion gate.

---

## Configuration Defaults

Both defaults are off; turn either on to make it the project standard, then override per run.

```yaml
sdd:
  default: false              # true → every /flo run uses the SDD cycle unless --no-sdd
gates:
  verify_before_done: false   # true → require /verify before `gh pr create` unless --no-verify
```

Check wiring status with `/healer` (or `/eldar`) — the `SDD + Verify Wiring` check reports whether the gate cases and hooks are present and which toggles are on.

---

## From a Fuzzy Idea: `/commune` → Spec

When the unit of work is still fuzzy, start with `/commune`. It runs a short Socratic dialogue and synthesizes a spec, then can hand that spec straight into the SDD spine (`flo sdd spec "<title>" --from -`). Rename its **Success criteria** section to **`## Acceptance Criteria`** on the way in — the SDD validator requires it. `/commune` is the pre-execution counterpart to `/meditate`.

---

## See Also

- `.claude/skills/fl/sdd.md` — the `/flo` companion that drives `-sd`/`-v` end to end
- `.claude/guidance/moflo-core-guidance.md` — CLI, hooks, gates, and config hub
- `.claude/guidance/moflo-yaml-reference.md` — full `moflo.yaml` field reference, including `sdd` and `gates`
