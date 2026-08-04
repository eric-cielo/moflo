# SDD & Verification (`-sd` / `--sdd`, `-v` / `--verify`)

Spec-Driven Development for `/flo` — Epic #1269. Two independent modifiers:

- **`-sd` / `--sdd`** — run the full **spec → plan → (review) → implement → verify** cycle. Opt-in *by built-in default* (`sdd.default` = false), but **a project can set `sdd.default: true` and turn it on for every run**. Implies verify.
- **`-v` / `--verify`** — verify-before-done: a normal run plus the completion gate, no spec/plan front-half. **On by default** (`gates.verify_before_done` defaults true, #1294) — `-v` is explicit, `--no-verify` opts out for one run.

⚠ **Never infer whether SDD is on from these built-in defaults.** They are project-configurable, so the effective value is only knowable at run time. Resolve it as `SKILL.md` § "Resolved run modes" describes — the `[moflo] /flo run modes` line injected into context, or `flo sdd mode --args="$ARGUMENTS"`. Assuming `sdd=off` on a project with `sdd.default: true` silently skips the whole spec/plan cycle and is invisible to the user until the PR lands without a spec.

Precedence: per-run flags and `--no-sdd` / `--no-verify` override `moflo.yaml`, which overrides the built-ins. Both are orthogonal to execution mode (`-n`/`-s`/`-h`) and `--worktree`, so `--sdd -s -wt 42` runs the SDD cycle in a swarm inside a worktree.

The artifact model, paths, and CLI live in `src/cli/sdd/` (`flo sdd …`). The constitution layer (CLAUDE.md + `.claude/guidance/`) is referenced by every stage — never restated in a spec.

> **Memory-first for SDD mechanics (do not bulk-read the guidance doc).** The authoritative SDD rules live in the **indexed** guidance doc `.claude/guidance/moflo-sdd.md`. Reach the slice you need via `mcp__moflo__memory_search { namespace: "guidance", query: "sdd <topic>" }` and traverse chunks with `mcp__moflo__memory_get_neighbors` — do **not** `Read` the whole `moflo-sdd.md` to find a rule (that is the anti-pattern #1292 fixes: with `-sd` enabled the operator read the entire doc instead of searching for the part it needed). **This file** (`./sdd.md`) is the skill's own companion runbook — it lives under `.claude/skills/`, is *not* indexed, and so is `Read` directly. See `SKILL.md` Step 0.

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

**Search memory before authoring (see `SKILL.md` Step 0).** Specs/plans are indexed into memory on session start, so `mcp__moflo__memory_search { namespace: "guidance" }` surfaces prior specs across sessions — search before authoring a new one rather than starting cold, and reach any SDD rule you need the same way instead of reading `.claude/guidance/moflo-sdd.md` end-to-end.

## The `--verify` step (verify-before-done)

Runs at step 8 of the full-mode flow, before the PR — **by default** and always under `--sdd`; `--no-verify` skips it for one run.

**Delegate to the `/verify` skill** — `Skill({ skill: "verify" })`, passing the issue number or spec slug. It owns the mechanics (single source of truth — don't restate them here): locate the acceptance criteria (plan, else ticket) → reuse the Tests-phase run (no double verify) → map each criterion to evidence → run only uncovered checks → record its own outcome to memory (`verify`, `verify:<slug-or-issue>`) → return a per-criterion PASS/FAIL. **The verdict is the point, not the invocation** (#1332). Invoking `/verify` trips `record-verify-run`, but that alone no longer opens `check-before-done` — the gate requires the recorded verdict to be `PASS`. A run returning FAIL leaves `gh pr create` blocked, which is the intended behaviour: the change did not meet its acceptance criteria. The verdict reaches the gate from the structured record `/verify` Step 5 writes to `memory_store` under `metadata.overall` (#1328), so a run that stores prose only is treated as *no verdict* and also blocks. Describing verification in prose has never satisfied the gate. A source edit after verifying invalidates both the flag and the verdict — re-run `/verify`. Full how-to: `.claude/skills/verify/SKILL.md`.

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
