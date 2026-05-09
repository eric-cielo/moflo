# Root-Cause Discipline — Measure Twice, Cut Once

**Purpose:** The MoFlo standard for fixing bugs. We do not "shoot first and ask questions later" — we measure twice and cut once. Apply this whenever you are about to write a fix, especially when a previous fix on the same surface didn't fully work.

---

## The Headline Rule

**Measure twice, cut once. Step back, understand the problem holistically, then make the simplest fix that eliminates the cause.** Do not pile patch onto patch onto patch.

This is the single most important engineering posture in this project. Layered patches have produced the worst regressions, the longest debugging sessions, and the most expensive token bills. When you find yourself reaching for "another layer" — stop.

---

## Before You Write Fix N+1

Before adding a new fix on top of an existing one, you MUST answer all four:

| Question | If you can't answer | Action |
|----------|---------------------|--------|
| What exactly is the failure mode at the lowest level? (Not the symptom — the actual mechanism.) | You don't understand the bug yet | Investigate further; do not fix |
| Why didn't fix N work? Is it wrong, or just incomplete? | You're guessing at the gap | Read fix N's code + history; reproduce the failure |
| Would removing fix N + replacing with one cleaner fix simplify the surface? | You haven't considered consolidation | Try the consolidation first |
| What's the SIMPLEST change that makes the bug structurally impossible? | You're patching symptoms, not causes | Step back further |

If three answers are vague, you're in patch-on-patch territory. Stop and re-think.

---

## Patch-on-Patch Smoke Alarms

Stop and reconsider when you see yourself doing any of these:

| Smoke alarm | What it usually means | The right move |
|-------------|----------------------|----------------|
| Adding a "belt-and-suspenders" cleanup | The first cleanup is racing something — find what | Eliminate the race, not double-cleanup |
| Adding `try/catch` around code that already has `try/catch` | Outer catch is masking inner failure | Surface the inner error, don't double-wrap |
| Adding a `setTimeout` retry loop on top of an existing retry | Retry won't fix a logic bug | Fix the logic |
| Bumping a timeout because tests fail intermittently | The op is slower than expected — find why | Fix the slowness or remove the op |
| Adding a flag/env-var to "skip the broken path" | You're hiding the bug, not fixing it | Fix the path or delete it |
| Adding a workaround "until we can fix this properly" | You won't come back; "later" never happens | Fix it now or file with full context |
| Touching three files to fix one bug | Bug is misdiagnosed; one file usually suffices | Re-diagnose |

When **two or more** of these apply at once, the fix is almost certainly wrong. Throw it away and re-investigate.

---

## The Holistic Step-Back

When fix N didn't work, do these in order — not in parallel, not skipping steps:

1. **Read every prior fix on this surface in full.** Not the commit message — the code. Note what each one was trying to prevent and what it actually does.
2. **Reproduce the failure deterministically** before touching code. If you can't reproduce it, you don't understand it.
3. **Trace the data flow.** Where does the bad state originate? What writes it? What reads it? What invariant got violated?
4. **Identify the structural cause** — the place where the bug becomes possible, not the place where it becomes visible.
5. **Now consider fixes.** The cheapest fix at the structural cause beats the cleverest fix at the symptom every time.

If step 5 yields a fix smaller and simpler than the existing patches, **delete the existing patches** as part of the same change. Do not stack.

---

## Concrete Example: #1017 Hive-Mind Shutdown

This is the canonical case study for this guidance.

| Attempt | Approach | Outcome |
|---------|----------|---------|
| #1017 first try | Loop list+delete in `clearNamespace` | Race window remained — broadcasts landed mid-loop |
| #1024 layer 1 | Detach adapter BEFORE `clearNamespace` (after `terminateAgent`) | Race narrowed but not eliminated — terminate-broadcasts still went through the still-attached adapter |
| #1024 layer 2 | Add `purgeHiveNamespacesDirect` raw sql.js DELETE | Looked bulletproof; actually was clobber-prone vs daemon's stale snapshot (#981 single-writer) |
| #1024 declared green | All 6 CI checks pass once | Same flake reappeared on next PR's CI |
| #1017 reopened — actual fix | Move `adapter.detach()` to BEFORE `terminateAgent`, delete `purgeHiveNamespacesDirect` | -73 LOC, +22 LOC, race is structurally impossible |

The structural cause was always: `terminateAgent` broadcasts on a still-attached adapter. **Two lines of code reordered eliminated the race.** Three layers of patches narrowed it, masked it, and added new failure modes.

The lesson: every patch added between #1017's first attempt and the real fix was avoidable if anyone had asked "what writes the row that leaks?" before "how do we delete it harder?"

---

## When You Genuinely Need a Belt-and-Suspenders

Belts-and-suspenders are not always wrong. They are right when:

| Condition | Example |
|-----------|---------|
| The two layers protect against **different** failure modes | atomic-write tmp+fsync+rename: tmp protects partial writes; fsync protects OS cache; rename protects readers — three concerns, three mechanisms |
| The first layer's failure is **silent**, the second surfaces it | A retry that logs the first failure before re-attempting |
| Removing either layer has a **stated, documented reason** for keeping the other | A fallback path with a comment explaining when the primary doesn't reach |

They are wrong when both layers protect against the **same** failure mode and you're hoping at least one wins. That's hope, not engineering.

---

## What This Means for PR Reviews

Reviewers should reject — not just question — PRs that show patch-on-patch signatures:

| Signal | Reviewer action |
|--------|----------------|
| Same file/function touched in 3+ recent commits, same bug | Ask: "is the prior fix wrong? remove it" |
| New fix adds a layer without removing one | Ask: "what was wrong with the prior layer? why does it stay?" |
| Comment in new code says "for safety" or "just in case" | Ask: "what specific failure is this preventing? cite the line that produces it" |
| The PR description says "this should fix the flake" without a deterministic repro | Ask: "what was the actual root cause? the writeup doesn't name it" |

These questions are not pedantic. They are the difference between fixing a bug and growing the surface area of bugs.

---

## How to Apply When You Are Stuck

If you genuinely cannot find the root cause after stepping back:

1. **Stop fixing. Start measuring.** Add logging at every state transition. Reproduce. Read the log.
2. **Ask the user before patching.** A two-line confirmation question costs less than a wrong fix.
3. **File the issue with what you DO know.** Partial diagnosis with logs is more useful than a guessed fix.
4. **Never ship "I think this might work."** That phrasing is a self-warning that the diagnosis isn't done.

It is always cheaper to admit uncertainty than to ship a layered patch that creates two new bugs.

---

## See Also

- `.claude/guidance/moflo-error-handling.md` — Silent failures are the prerequisite condition for most patch-on-patch saga; fix those first
- `.claude/guidance/moflo-source-hygiene.md` — When you decide to delete redundant code, the canonical-location rules tell you what's safe to remove
- `feedback_no_layered_workarounds.md` (auto-memory) — The personal-feedback version of this rule, recorded from prior incidents
- `feedback_ci_flake_means_not_done.md` (auto-memory) — A flake that "passed on rerun" is not fixed; root-cause it under this discipline
