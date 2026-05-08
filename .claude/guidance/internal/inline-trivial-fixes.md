# Inline Trivial Fixes — Don't Branch a New Cycle for Insignificant Bugs

**Purpose:** When a trivial bug surfaces while you're fixing something else, fix it in the same PR. Spinning a separate issue → branch → research → ticket → tests → simplify → PR → merge cycle for a one-line correction wastes tokens, time, and credibility. Use this rule to decide between "land it inline" and "file a follow-up" when an unrelated defect appears mid-task.

---

## 1. The Rule

**If you find an insignificant bug while fixing another issue, fix the bug in the same PR.** Do not open a new ticket, do not branch a new cycle, do not defer to "follow-up". The flo cycle is too expensive to amortize over a one-line change.

This is a refinement on the standing fix-or-file rule (`feedback_call_out_fix_or_file`): "fix-or-file" still applies for non-trivial bugs you discover. For trivial bugs, the answer is always **fix**, never **file**.

---

## 2. Trivial vs. Non-Trivial Decision Table

The split is about review burden and blast radius, not LOC count alone.

| Signal | Trivial (fix inline) | Non-trivial (file separately) |
|--------|----------------------|-------------------------------|
| Net production LOC | ≤ ~10 | > ~10 or spans multiple files |
| New tests required | 0–1 small assertion | dedicated test file or > 1 new test |
| Public API surface | unchanged | adds/removes/renames an export |
| Behavior change | matches user intent already | could surprise a consumer |
| Reviewer friction | reviewer can confirm in <30s | needs context the current PR doesn't carry |
| Relationship to the main fix | same file or same subsystem | different subsystem entirely |
| Risk if shipped wrong | reverts cleanly in one commit | needs a coordinated migration |

**ANY column flips it to non-trivial.** A 3-line fix that touches a different subsystem is non-trivial because the reviewer of your main PR has no context for it.

---

## 3. Concrete Examples

### Fix inline (trivial)

| Scenario | Action |
|----------|--------|
| You're fixing an exit-drain race in `index.ts` and notice a typo in the same function's comment | Edit the typo in the same commit. |
| You're adding a test and the existing fixture has a redundant `expect` that always passes | Drop the dead assertion in the same PR; mention it in the commit body. |
| The function you're touching has `Object.keys(x).length === 0` where `x.id == null` would be correct, and the buggy check is in the path you're testing | Fix the check in the same PR — it's the masked bug your fix just unmasked. |
| You added an `import` and the file's existing imports are misordered | Reorder them; one commit, no new ticket. |

### File separately (non-trivial)

| Scenario | Action |
|----------|--------|
| You're fixing an output bug and discover the storage layer returns synthetic data on miss | File a new issue — the storage bug is its own subsystem, needs its own tests, has its own blast radius. (#996 → #998 was correctly split.) |
| Mid-fix you find a security issue in unrelated code | File separately; don't bundle a security fix into an unrelated PR. |
| The fix you started turns out to require a schema migration | Stop, file an epic, scope it properly. |

---

## 4. How to Surface Inline Fixes

When you bundle a trivial fix into the main PR:

- **Mention it in the commit body** — one bullet under "Also fixed:" so the reviewer sees it.
- **Mention it in the PR description** — same bullet under a `## Drive-by fixes` heading.
- **Do not retitle the PR.** The PR's main subject stays the original fix; drive-bys are footnotes.

Example commit body:
```
fix(cli): drain stdout/stderr before exit to avoid Windows async-pipe race

[main fix description]

Also fixed:
- Removed redundant `stream.destroyed` check that's always covered by `!stream.writable`.
```

---

## 5. When the Inline Fix Grows

If you start an inline fix and it expands past the trivial threshold (e.g. you discover the "one-line check" needs three new tests and a schema migration), **stop and back out**. File the issue, leave a TODO referencing it, and stay focused on the original PR. The cost of an over-scoped PR is higher than the cost of a follow-up — but the cost of a deferred trivial fix is even higher than that.

The decision point is the moment you realize the fix isn't trivial. Catching it there preserves the inline-fix discipline without bloating the PR.

---

## See Also

- `.claude/guidance/internal/coding-style.md` — Sibling rule on scope discipline within a single PR
- `.claude/guidance/shipped/moflo-guidance-rules.md` — Universal writing rules this doc follows
- Auto-memory `feedback_call_out_fix_or_file.md` — The standing fix-or-file rule this doc refines for the trivial case
