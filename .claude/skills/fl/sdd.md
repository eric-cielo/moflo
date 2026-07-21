# SDD & Verification (`-sd` / `--sdd`, `-v` / `--verify`)

Spec-Driven Development for `/flo` — Epic #1269. Two independent modifiers:

- **`-sd` / `--sdd`** — run the full **spec → plan → (review) → implement → verify** cycle. Opt-in (`sdd.default` defaults false). Implies verify.
- **`-v` / `--verify`** — verify-before-done: a normal run plus the completion gate, no spec/plan front-half. **On by default** (`gates.verify_before_done` defaults true, #1294) — `-v` is explicit, `--no-verify` opts out for one run.

Defaults seed from `moflo.yaml` (`sdd.default` = false, `gates.verify_before_done` = true); per-run flags and `--no-sdd` / `--no-verify` override. Both are orthogonal to execution mode (`-n`/`-s`/`-h`) and `--worktree`, so `--sdd -s -wt 42` runs the SDD cycle in a swarm inside a worktree.

The artifact model, paths, and CLI live in `src/cli/sdd/` (`flo sdd …`). The constitution layer (CLAUDE.md + `.claude/guidance/`) is referenced by every stage — never restated in a spec.

## The `--sdd` cycle

Artifacts live at `<specs_dir>/<slug>/{spec,plan}.md` — default `.moflo/specs`, which is **gitignored** (local, not committed). By default (`sdd.embed_in_pr: true`) the spec + plan are appended to the PR body, so the reasoning is **reviewable in the PR even while specs stay local**. To source-control the artifacts instead (or as well), set `moflo.yaml sdd.specs_dir` to a tracked path (e.g. `docs/specs`) and commit them (#1294). Drive them with the `flo sdd` CLI; never hand-write the paths.

**The front half is enforced, not advisory (#1297).** When a run is armed for SDD (`-sd`/`--sdd` or `sdd.default`), the `check-before-implement` gate **blocks every source `Write`/`Edit`** until a spec exists for the active slug and its plan is `reviewed`. Skipping straight to implementation is not possible — do the spec→plan steps first. `flo sdd spec` stamps the active slug so the gate knows which unit this run is building. One-off escape hatch: re-run with `--no-sdd`; per-project off-switch: `gates: sdd_gate: false`.

1. **Spec** — capture the *what* + acceptance criteria:
   ```bash
   flo sdd spec "<issue title>"          # scaffolds .moflo/specs/<slug>/spec.md; arms the gate
   ```
   Fill Problem / Goal / Scope / **Acceptance Criteria** (the criteria verify checks against). For an issue, the ticket's Acceptance Criteria seed this section.
2. **Review checkpoint (spec → plan)** — the behavior depends on `sdd.human_checkpoints` (default **false**):
   - **false (autonomous, default):** self-advance — you author the spec, sanity-check it, then run `flo sdd review <slug>` yourself and continue. No stop.
   - **true (human in the loop):** present the spec to the user and **wait for approval** before running `flo sdd review <slug>`.
   ```bash
   flo sdd review <slug>                 # marks spec reviewed; unlocks the plan
   ```
3. **Plan** — capture the *steps* + how each criterion gets verified:
   ```bash
   flo sdd plan <slug>                   # requires the spec be reviewed
   ```
4. **Review checkpoint (plan → implement)** — same `human_checkpoints` rule as step 2 (self-advance when false; pause for approval when true):
   ```bash
   flo sdd review <slug> plan            # marks plan reviewed; unlocks implementation
   flo sdd check <slug> implement        # gate — exit 2 until the plan is reviewed
   ```
5. **Implement → test → simplify** — the normal `./phases.md` flow, honoring the plan. The implement gate now passes (spec + reviewed plan exist).
6. **Verify** — see below (always runs under `--sdd`).
7. **Embed in PR** — when `sdd.embed_in_pr` is true (default), append the spec+plan block to the PR body at `gh pr create` time:
   ```bash
   flo sdd embed <slug>                  # prints a collapsible spec+plan block; pipe into the PR body
   ```

Specs/plans are indexed into memory on session start, so `mcp__moflo__memory_search` surfaces prior specs across sessions — search before authoring a new one.

## The `--verify` step (verify-before-done)

Runs at step 8 of the full-mode flow, before the PR — **by default** and always under `--sdd`; `--no-verify` skips it for one run.

**Delegate to the `/verify` skill** — `Skill({ skill: "verify" })`, passing the issue number or spec slug. It owns the mechanics (single source of truth — don't restate them here): locate the acceptance criteria (plan, else ticket) → reuse the Tests-phase run (no double verify) → map each criterion to evidence → run only uncovered checks → record its own outcome to memory (`learnings`, `verify:<slug-or-issue>`) → return a per-criterion PASS/FAIL. *Invoking* it is the point — it trips `record-verify-run` and satisfies the `check-before-done` gate (describing verification in prose does not). A source edit after verifying invalidates it — re-run `/verify`. Full how-to: `.claude/skills/verify/SKILL.md`.

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
