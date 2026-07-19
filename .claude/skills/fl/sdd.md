# SDD & Verification (`-sd` / `--sdd`, `-v` / `--verify`)

Spec-Driven Development for `/flo` — Epic #1269. Two independent modifiers:

- **`-sd` / `--sdd`** — run the full **spec → plan → (review) → implement → verify** cycle. Implies `--verify`.
- **`-v` / `--verify`** — verify-before-done only: a normal run plus the completion gate, no spec/plan front-half.

Defaults seed from `moflo.yaml` (`sdd.default`, `gates.verify_before_done`); per-run flags and `--no-sdd` / `--no-verify` override. Both are orthogonal to execution mode (`-n`/`-s`/`-h`) and `--worktree`, so `--sdd -s -wt 42` runs the SDD cycle in a swarm inside a worktree.

The artifact model, paths, and CLI live in `src/cli/sdd/` (`flo sdd …`). The constitution layer (CLAUDE.md + `.claude/guidance/`) is referenced by every stage — never restated in a spec.

## The `--sdd` cycle

Artifacts live at `.moflo/specs/<slug>/{spec,plan}.md` (git-tracked in consumer repos → reviewable). Drive them with the `flo sdd` CLI; never hand-write the paths.

1. **Spec** — capture the *what* + acceptance criteria:
   ```bash
   flo sdd spec "<issue title>"          # scaffolds .moflo/specs/<slug>/spec.md
   ```
   Fill Problem / Goal / Scope / **Acceptance Criteria** (the criteria verify checks against). For an issue, the ticket's Acceptance Criteria seed this section.
2. **Review checkpoint (spec → plan)** — confirm the spec is right, then:
   ```bash
   flo sdd review <slug>                 # marks spec reviewed; unlocks the plan
   ```
3. **Plan** — capture the *steps* + how each criterion gets verified:
   ```bash
   flo sdd plan <slug>                   # requires the spec be reviewed
   ```
4. **Review checkpoint (plan → implement)**:
   ```bash
   flo sdd review <slug> plan            # marks plan reviewed; unlocks implementation
   flo sdd check <slug> implement        # gate — exit 2 until the plan is reviewed
   ```
5. **Implement → test → simplify** — the normal `./phases.md` flow, honoring the plan.
6. **Verify** — see below (always runs under `--sdd`).

Specs/plans are indexed into memory on session start, so `mcp__moflo__memory_search` surfaces prior specs across sessions — search before authoring a new one.

## The `--verify` step (verify-before-done)

Runs at step 8 of the full-mode flow, before the PR:

1. Run the native **`/verify`** skill to exercise the change end-to-end. Under `--sdd`, verify against the plan's acceptance criteria; without a plan, verify against the ticket's Acceptance Criteria.
2. Store the outcome to memory so it feeds routing/learning:
   ```
   mcp__moflo__memory_store { namespace: "learnings", key: "verify:<slug-or-issue>", value: "<what was verified, pass/fail>" }
   ```
3. The `/verify` run trips `record-verify-run`, satisfying the `check-before-done` gate — `gh pr create` unblocks. When `gates.verify_before_done: true`, this gate is enforced for every run whether or not `-v` was passed; `-v` makes the skill *do* the verification so the gate passes cleanly. A source edit after verifying invalidates it — re-run `/verify`.

`/ward` and `/quicken` stay targeted audits, not the completion gate.

## `-t` (ticket) and `-r` (research) modes

- **`-t --sdd`** — no implementation. Write the spec/plan **into the ticket body** (Description ← Scope+Approach, Acceptance Criteria ← spec criteria, Suggested Test Cases ← plan verification) instead of scaffolding `.moflo/specs/…`. Optionally also scaffold the artifacts if the user wants them tracked.
- **`-v` in `-t`/`-r`** — no-op; the parser emits `Note: --verify ignored — <mode> mode does not implement.`
- **`--sdd` in `-r`** — ignored (research produces no artifacts); the parser notes it.

## Cross-platform (Rule #1)

Every artifact path comes from `flo sdd` (built with `path.join`) — never string-concatenate `.moflo/specs/...` in skill steps. The `flo sdd` CLI is the single cross-platform entry point for creating, reviewing, and checking artifacts.

## See Also

- `./phases.md` — the implement/test/simplify/commit/PR phases the cycle wraps
- `./ticket.md` — how ticket Acceptance Criteria seed the spec
- `.claude/guidance/` + root `CLAUDE.md` — the constitution every stage respects
