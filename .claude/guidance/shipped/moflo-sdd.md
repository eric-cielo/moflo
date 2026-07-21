# MoFlo Spec-Driven Development (SDD) & Verify-Before-Done

**Purpose:** How to run and reason about the `spec → plan → implement → verify` cycle in `/flo`, the `flo sdd` artifact CLI, and the verify-before-done gate. Read this before using `-sd`/`-v`/`--no-verify`, editing `.moflo/specs/`, or tuning `sdd.default` / `gates.verify_before_done`.

---

## When to Use `-sd` vs `-v` vs Neither

Two independent modifiers on `/flo`, orthogonal to execution mode (`-n`/`-s`/`-h`) and `--worktree`. The **spec/plan ceremony (`-sd`) is opt-in**; **verify-before-done (`-v`) runs by default** (#1294) — separable from SDD by design.

| Situation | Flag | Effect |
|-----------|------|--------|
| Fuzzy or large unit of work; you want a reviewed spec/plan before code | `-sd` / `--sdd` | Full spec → plan → (review) → implement → verify. Implies `--verify`. Opt-in. |
| A default run already verifies before done | (none) | Verify-before-done runs automatically via the `/verify` skill. |
| Skip verification for one run | `--no-verify` | Drops the (default-on) verify step. |

`--sdd` **always implies** `--verify` — a spec/plan without an enforced verify step drifts. `--no-sdd` / `--no-verify` opt a single run out; `-v` only matters to force verify back on where a project set `verify_before_done: false`.

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

The `flo sdd` CLI is the single cross-platform entry point for every SDD artifact operation — scaffold, review, gate, and status. Drive the cycle through these commands; never hand-write a `.moflo/specs/...` path in a skill step.

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

- **On by default (#1294).** Enforced for every `/flo` run; disable per-project with `gates.verify_before_done: false` or per-run with `--no-verify`. On upgrade, consumers with no `verify_before_done` key start enforcing; an explicit value is preserved. Docs-only diffs are exempt, so a pure-docs PR is never blocked.
- **Satisfy it by running the `/verify` skill** — `/flo` delegates to it. It exercises the change against the plan's (or ticket's) acceptance criteria and records its own outcome to memory (`namespace: learnings, key: verify:<slug>`). It reuses the Tests-phase run rather than repeating it (no double verify).
- **A source edit invalidates a prior verification** — re-run `/verify` after editing. `/ward` and `/quicken` are targeted audits, not the completion gate.

---

## SDD & Verify moflo.yaml Defaults

`sdd.default` is off (opt-in); `verify_before_done` is **on** (#1294). Override per run with the flags.

```yaml
sdd:
  default: false              # true → every /flo run uses the SDD cycle unless --no-sdd
gates:
  verify_before_done: true    # on by default (#1294); false → skip /verify unless -v. Per-run: --no-verify
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
