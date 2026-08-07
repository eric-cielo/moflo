# Inline Fixes — Resolve Small Defects in the PR You Are Already In

**Purpose:** Decide between "fix it here" and "file a follow-up" when a defect surfaces while you are working on something else. The default is **fix it here**. Opening a separate ticket for a small problem spends a full issue → branch → research → tests → review → PR → merge cycle on a change that a reviewer confirms in thirty seconds, and it is the single most common way agent work becomes slower than doing it by hand.

---

## 1. The Default Is Fix, Not File

**Fix a small defect in the PR you are already in.** Do not open a ticket, do not branch a new cycle, do not defer it to "follow-up".

Filing is the exception and must be earned. Before you file, name which threshold in the table below the defect crosses. If you cannot name one, fix it.

**Never file a ticket to record work you could have finished in the time it took to write the ticket.** A ticket that says "rename this variable" costs more to triage than the rename costs to do.

---

## 2. Trivial vs. Non-Trivial Decision Table

The split is about review burden and blast radius, not line count alone.

| Signal | Fix inline | File separately |
|--------|-----------|-----------------|
| Net production LOC | ≤ ~10 | > ~10 or spans multiple subsystems |
| New tests required | 0–1 small assertion | dedicated test file or several new tests |
| Public API surface | unchanged | adds, removes, or renames an export |
| Behaviour change | matches intent already documented | could surprise a consumer |
| Reviewer friction | confirmable in under 30 seconds | needs context this PR does not carry |
| Relationship to the main fix | same file or same subsystem | different subsystem entirely |
| Risk if shipped wrong | reverts cleanly in one commit | needs a coordinated migration |

**Any single row in the right column flips it to non-trivial.** A three-line fix in an unrelated subsystem is non-trivial, because the reviewer of your PR has no context for it.

---

## 3. Defects Your Own Work Surfaces Are Never Follow-Ups

A defect that your change **caused, unmasked, or invalidated** is part of the change. It is not a discovery to be logged.

| Situation | Action |
|-----------|--------|
| A test you just made red | Fix it now, in this PR |
| A lint, type, or build error your edit introduced | Fix it now |
| A stale bound, count, or snapshot your change invalidated | Update it now |
| A test that pinned the exact bug you are fixing | Update the test in the same commit |
| A reviewer comment on this PR | Address it in this PR |
| A neighbouring function with the same defect you just fixed | Fix it here if it clears the table above |

Treating any of these as a separate ticket ships a knowingly broken tree and asks a human to re-triage work that was already in your hands.

---

## 4. Batch Fixes; Do Not Serialise CI Rounds

**Group related fixes into one push.** Every push burns a full CI round, and reviewers re-read the diff each time.

- Fix everything you have found, then run the suite once, then push once.
- Do not push a one-line fix, wait for CI, then push the next one-line fix.
- When several small defects share a root cause, fix the cause and say so, rather than patching each symptom in its own commit.

Serialised single-fix rounds are slower than one careful pass, and they make the change history harder to read for no gain.

---

## 5. How to Surface Inline Fixes

Bundling is not hiding. Make every drive-by visible:

- **In the commit body** — one bullet under `Also fixed:`.
- **In the PR description** — the same bullets under a `## Drive-by fixes` heading.
- **Do not retitle the PR.** The main subject stays the original fix; drive-bys are footnotes.

```
fix(cli): drain stdout/stderr before exit to avoid a Windows async-pipe race

[main fix description]

Also fixed:
- Removed a redundant `stream.destroyed` check already covered by `!stream.writable`.
- Corrected the module-count lower bound this change invalidated.
```

---

## 6. When an Inline Fix Grows

If a fix expands past the trivial threshold mid-flight — the "one-line check" turns out to need three new tests and a migration — **stop and back out**. File it, and stay focused on the original PR.

The decision point is the moment you realise the fix is not trivial. Catching it there keeps the discipline without bloating the PR. An over-scoped PR is expensive; a deferred trivial fix is more expensive still.

**When you do file, finish the rest first.** Deliver every part of the current work that is not blocked, then state plainly what you left out and why. Never stop the whole task to file a ticket.

---

## See Also

- `.claude/guidance/moflo-agent-rules.md` — Git, branch, and PR conventions these fixes land through
- `.claude/guidance/moflo-root-cause-discipline.md` — Fixing the cause rather than the symptom, which is what makes a batch of small fixes collapse into one
- `.claude/guidance/moflo-guidance-rules.md` — Universal writing rules this doc follows
