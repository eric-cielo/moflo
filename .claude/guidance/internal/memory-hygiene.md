# Memory Hygiene — Retiring Stale Auto-Memory Entries

**Purpose:** Rules for keeping a project's auto-memory (`MEMORY.md` + per-entry `*.md` files under `~/.claude/projects/<project>/memory/`) lean. Apply periodically — every memory entry is loaded into context every prompt, so stale entries are a recurring per-prompt token cost in every future session.

---

## When to Sweep

Sweep whenever any of the following is true:

| Trigger | Why |
|---------|-----|
| `MEMORY.md` exceeds ~50 entries | Index alone now costs >2K tokens per prompt |
| User pays unexpectedly high context cost across sessions | Stale entries are a likely contributor |
| User asks for a memory audit / says "clean up memory" | Direct request |
| You retired a major epic / closed a long-standing incident | Its supporting memories likely went stale in the same moment |
| You shipped a machine-enforced gate (lint, smoke, drift guard) for a rule | The matching memory entry can be retired — the gate carries the load now |

**Do NOT sweep mid-task.** A sweep is a focused activity. Mixing it into other work risks deleting an entry whose rule is actively informing the current change.

---

## Retire Decision Table

For each entry, classify into exactly one bucket:

| Classification | When to apply | Action |
|---------------|---------------|--------|
| **KEEP** | Entry still drives a decision you might make today | No change |
| **RETIRE** | Resolved incident, completed migration, or rule now enforced by lint/test/CI | Delete the `.md` file + drop the index line |
| **COMPRESS** | Entry is load-bearing but verbose; durable signal fits in 1–3 sentences | Rewrite to a one-paragraph version |
| **MERGE** | Two+ entries cover the same rule with overlapping examples | Pick the most specific, link the others' best phrasing into it, delete the duplicates |

**The retirement test:** "If I removed this entry today, would any future me-decision be wrong?" If the answer is no — because (a) the situation no longer arises, or (b) a machine gate already prevents the failure — retire it.

---

## Retire Criteria — Concrete Examples

### RETIRE: Status notes for resolved incidents

A memory entry whose body opens with "RESOLVED in vX.Y.Z" or "Closed epic #N (date)" is a status note, not a rule. Retire it once the durable enforcement (CI smoke, drift guard, ESLint rule, code fix) is in place. The fix itself is the source of truth — re-stating it in memory adds noise.

```markdown
## Retire example
project_docker_sandbox_root_bug.md says "RESOLVED in moflo@4.8.75"
→ The fix is in `docker-sandbox.ts`; the Dockerfile sets USER node.
→ Tests assert `/home/node/...` paths.
→ Memory entry adds zero behavioral signal. RETIRE.
```

### RETIRE: Rules superseded by machine gates

If a rule has been promoted into an ESLint check, a drift-guard test, a smoke-harness probe, or a pre-commit hook, the memory entry no longer prevents the failure — only the gate does. Retire the memory and let the gate carry the load.

```markdown
## Retire example
feedback_no_fixed_depth_paths.md and feedback_consumer_project_paths.md
both teach "don't count `../` segments across moflo packages."
→ ESLint rule in `.eslintrc.path-safety.cjs` now bans the patterns.
→ Consumer-smoke probe scans for `Cannot find module` / `MOFLO_BRIDGE_QUIET`.
→ Memory entries are advisory; the gate is enforcing. RETIRE the memories.
```

### RETIRE: Outdated targets, stale numbers

Memory bodies that reference specific version numbers, package sizes, file counts, or "next target is X" milestones decay fast. If the stated target has moved (e.g. the package was removed, the size threshold changed), retire it. Replace with a fresh entry only if the new target genuinely drives behavior.

### COMPRESS: Long incident retros

Multi-paragraph entries documenting "what we found in the audit" are useful as breadcrumbs but the durable signal is usually one sentence: which test, lint rule, or gate now blocks the regression. Compress everything else.

```markdown
## Compress example
Before (25 lines): a full audit retro listing five categories of residue.
After (3 lines):  "Post-collapse residue is now machine-blocked by 5 invariants
                   in `published-package-drift-guard.test.ts`. Sibling guards in
                   `.eslintrc.cjs` ban deep `../` paths + hash-embedding identifiers."
```

### KEEP: Standing rules with concrete cost the user paid

Entries that quote a real user incident ("$50 in tokens", "broke publish 4.8.62", "credibility with stakeholders") and pair it with a specific fix-or-avoidance pattern are load-bearing. They teach future-Claude how to recognize the failure mode before repeating it. Keep them as-is.

---

## Anti-Patterns

| Anti-pattern | Why it fails | Fix |
|-------------|-------------|-----|
| Sweeping during active work | Risk of deleting an entry whose rule is informing the current change | Sweep as its own focused session |
| Retiring entries because they're "old" | Age alone is not a signal — many durable rules are years old | Apply the retirement test, not the calendar |
| Merging distinct entries to shrink the index | Each entry has a distinct origin/cost; merging loses specificity | Only merge when the rules truly overlap (same fix, same trigger) |
| Retiring `feedback_*` entries en masse | These typically encode behavioral rules, not status notes; far less likely to be retire-eligible than `project_*` | Bias toward keeping `feedback_*`, retiring `project_*` |
| Deleting a memory file but leaving its `MEMORY.md` line | Leaves a dangling link that loads as broken context every prompt | Always update both atomically |

---

## Mechanics — Retiring an Entry

1. **Delete the per-entry file** under the memory directory: `rm <name>.md`.
2. **Remove the `MEMORY.md` line** that points to it.
3. **Verify no dangling links remain** — every `(file.md)` reference in `MEMORY.md` should resolve to a file on disk.
4. **No re-indexing needed** — auto-memory files are loaded directly into context by the system, not via the moflo memory DB. The retirement takes effect on the next session start.

```bash
## Quick verify
ls -1 *.md > /tmp/files.txt
grep -oE '\([a-z_]+\.md\)' MEMORY.md | tr -d '()' | sort -u > /tmp/indexed.txt
comm -23 /tmp/files.txt /tmp/indexed.txt   # orphans on disk
comm -13 /tmp/files.txt /tmp/indexed.txt   # dangling index lines
```

---

## Mechanics — Compressing an Entry

1. Read the existing entry.
2. Identify the **single durable signal** — usually a rule + a pointer to where the rule is enforced (test file, lint rule, code path).
3. Rewrite the body to that signal in 1–3 sentences. Keep the frontmatter (`name`, `description`, `type`).
4. Update the matching `MEMORY.md` line so the one-line description still summarizes the new body accurately.

---

## What NOT to Retire

The user's auto-memory system already documents what should never be saved (see the system instructions for memory). The flip side: the rules below are durable and should survive every sweep:

- `feedback_consumer_blast_radius` — the library posture itself
- `feedback_swarm_hive_never_regress` — protected product surface
- `feedback_broken_window_theory` — quality posture
- `feedback_dogfood_install_vs_source` — diagnostic posture
- `feedback_no_layered_workarounds` / `feedback_no_unverified_fix_claims` — fix-quality posture
- `feedback_call_out_fix_or_file` / `feedback_fix_all_bugs` — bug-discipline posture
- `project_identity` / `project_moflo_is_a_library` / `project_free_open_source` — identity invariants

These are non-negotiable framing rules. Even if their original incident is years old, the rule still drives every future change.

---

## See Also

- `.claude/guidance/shipped/moflo-memory-strategy.md` — Architecture of moflo's *project* memory system (different from the user's auto-memory, but related)
- `.claude/guidance/shipped/moflo-guidance-rules.md` — Universal rules for writing any guidance file; memory entries follow similar imperative-voice + concrete-example posture
- `.claude/guidance/internal/session-start.md` — Where the `auto-memory-hook.mjs` lives and how it loads MEMORY.md every prompt
- `.claude/guidance/shipped/moflo-core-guidance.md` — Hub doc consumers see for memory commands
