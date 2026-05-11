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
4. **Question the test, not just the code.** What invariant does the failing test actually encode? Does that invariant match the runtime contract, or is the test stricter? A test stricter than the contract will produce flakes that look like bugs but aren't. (See #1017 case study.)
5. **Identify the structural cause** — the place where the bug becomes possible, not the place where it becomes visible.
6. **Now consider fixes.** The cheapest fix at the structural cause beats the cleverest fix at the symptom every time. If the cause is "test asserts X, runtime contract is Y, X is stricter," the fix is in the test.

If step 6 yields a fix smaller and simpler than the existing patches, **delete the existing patches** as part of the same change. Do not stack.

---

## Code Serves the Specification, Not the Test

**Periodically ask: "Am I solving an actual problem, or am I flailing to satisfy a flawed test?"** When several attempted fixes haven't moved the needle, the test framework is a likely suspect — but the response is never to degrade production code to make the test pass.

**Never introduce substandard code to satisfy shortcomings of the testing infrastructure.** Production code expresses the runtime contract. Tests verify the contract. When they disagree:

| Disagreement | Correct response | Wrong response |
|--------------|------------------|----------------|
| Test asserts behavior the runtime never promised | Fix the test to match the contract | Add code to satisfy the test's stricter assertion |
| Test uses an unrealistic environment (mocks the wrong layer, races a SIGKILL'd daemon, single-session asserts on a multi-session contract) | Fix the test environment | Add retry / sleep / workaround in production code |
| Test framework can't observe a legitimate runtime path | Add a test hook (`_resetForTest`, `getStateForTest`) that doesn't change runtime behavior | Restructure runtime to make the test framework's observation easier |
| Test is flaky on one platform but the runtime works | Identify why the test, not the runtime, is sensitive | Bump timeouts / retries / sleeps in production paths |

**Code purity check before any "make the test pass" change:** would you ship this change if the test didn't exist? If no, you're degrading the code to satisfy the test. Stop. Fix the test.

**Signals you're flailing for the test, not solving the bug:**

| Signal | What it actually says |
|--------|----------------------|
| You've tried 3+ fixes and nothing has moved the needle | The diagnosis is wrong; investigate before patching again |
| Each fix gets narrower / more defensive without removing the prior layer | You're piling on, not solving |
| The runtime works fine in real-world usage but the test fails | The test's spec doesn't match the contract — that's the bug |
| You'd need to add a sleep, retry, lock, or platform-special-case to make the test happy | Production code is paying for a test-environment limitation |
| Removing the test makes the bug "go away" | The test was right but the fix is wrong, OR the test was the bug — diagnose which |

The user said it directly: **"we never want to introduce substandard code to satisfy shortcomings of our testing infrastructure."** Tests serve the code; the code does not serve the tests.

When you find that the test is the actual problem: change the test, document why in the commit message, and (if the change weakens an invariant) add a separate test that captures the invariant the original was *trying* to encode without the false strictness.

---

## Never Mask a Production Bug with Test-Side Workarounds

**When a test catches a real bug, fix the bug — never the test.** A test that passes by avoiding the broken path is a lie about coverage.

| Symptom test exposed | Right move | Wrong move (firing-offense pattern) |
|---------------------|-----------|-------------------------------------|
| Race between writers | Coordinate the writers | Reorder test so the race window closes before the assertion |
| Data corruption from a known writer | Find and fix the writer | Pre-seed the corrupted state so the assertion no longer fires |
| Stale cache served to readers | Invalidate the cache properly | Add `sleep` / `refresh()` in test to mask staleness |
| Cross-process clobber on a shared file | Single-writer ownership or atomic write | Order the test so only one writer runs |
| Missing precondition guard in prod | Add the guard | Have test setup satisfy the guard's precondition |

**Smell test:** read the test setup as a description of production behavior. If steps appear that production code does not perform, the test is mocking around a real bug.

### Case Study: #1053 Memory Traversal

> "Healer: probeMemoryGetNeighbors() runs first in checkMemoryAccessFunctional so the bridge instantiates after the seed lands (sql.js whole-DB writeback clobbers external file writes once the in-memory snapshot warms)." — PR #1053 commit

Diagnosis correct; fix wrong. The clobber stayed in production. `moflo@4.9.37` shipped two regressions to every consumer (migration-induced embedding loss + `memory_store` silent drop) because the suite was engineered around the failure it had just detected.

### Self-Check Before Merging Any Test-Only Change

1. **Did the test fail first?** Name the production bug it caught.
2. **Did my fix change only the test?** If yes, the runtime contract must be the bug — document why in the commit message.
3. **Would a real user still hit this in production?** If yes, fix the bug, not the test.
4. **Does test code comment *why* it sleeps / reorders / mocks?** That comment usually names a production bug — move the fix to production.

---

## Concrete Example: #1017 Hive-Mind Shutdown

This is the canonical case study for this guidance — and it has a second-order lesson that makes it even more useful.

| Attempt | Approach | Outcome |
|---------|----------|---------|
| #1017 first try | Loop list+delete in `clearNamespace` | Race window remained — broadcasts landed mid-loop |
| #1024 layer 1 | Detach adapter BEFORE `clearNamespace` (after `terminateAgent`) | Race narrowed but not eliminated |
| #1024 layer 2 | Add `purgeHiveNamespacesDirect` raw sql.js DELETE | Looked bulletproof; actually clobber-prone vs daemon's stale snapshot (#981 single-writer) |
| #1024 declared green | All 6 CI checks pass once | Same flake reappeared on next PR's CI |
| #1027 attempt 4 | Move `adapter.detach()` BEFORE `terminateAgent`; delete `purgeHiveNamespacesDirect` | Code simplified by -73 LOC. **Same flake on macos-latest CI.** |
| #1027 — actual fix | Run launcher a SECOND time after doctor in the populated harness | Test passes. Race is intrinsic to multi-process sql.js + daemon kill timing; the harness assertion was over-strict. |

The first three attempts kept asking "how do we delete this row harder?" The fourth attempt was a structural simplification that was correct on its own merits (-73 LOC, removed dead code, simpler shutdown ordering) but **did not fix the flake**.

The actual root cause was outside the surface every patch had touched: the populated harness was asserting "ephemerals purged after one launcher run" when the **runtime contract is "ephemerals purged at next session-start launcher"**. The doctor's hive-mind probe writes a row intentionally; that row is supposed to live until the NEXT session purges it. The test was conflating "purge mechanism works" with "purge happens within one session" — those are different invariants and only the first is the real product behavior.

**Two lessons stack here:**

1. **Don't pile layers** (the original lesson): four shutdown patches, each narrower than the last, none structurally sufficient.
2. **Question the test, not just the code** (the second-order lesson): if you've been fighting a race for four PRs and the simplest in-code fix doesn't move the needle, the spec encoded in the test may be wrong. A test that is stricter than the runtime contract WILL produce flakes that look like product bugs but aren't.

Together: when a fix isn't working, ask both "what writes the bad state?" AND "is this state actually bad in the runtime contract, or only in the test's expectation?"

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
| Commit message names a production bug, then describes test setup that avoids it | **Reject.** The bug stays live in production. Demand a fix at the production-code locus, not at the test. |

These questions are not pedantic. They are the difference between fixing a bug and growing the surface area of bugs.

---

## Scoping a Fix Issue — Kill the Class, Not the Instance

**When you file an issue for a bug, scope it to eliminate the bug class, not patch the visible instance.** Partial scope guarantees a follow-up epic.

| Posture | Right | Wrong |
|---------|-------|-------|
| Scope | Name the bug class; list every writer / caller / consumer that can produce it | Name only the surface where the symptom showed |
| Strategy | Commit to one approach in the body — "we will do X" | "Pick one of: option A or option B" |
| Audit | Enumerate every member of the class (every writer, every caller, every migration) | Patch the one path that broke today |
| Acceptance | Every original failure mode reproduces today and is gone after the epic; a new violator triggers a loud test | Symptom no longer reproduces |
| Tests | Mirror the production failure shape (multi-process, cross-writer, time-coupled) | In-process unit tests only |
| Follow-ups | None — anything that would be a follow-up is added to scope now | "We'll address this in a separate issue" |

If the epic body says "we'll figure out X in a follow-up", the scope is wrong — fold X in or explain why it cannot be in scope (e.g., depends on a release boundary).

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
