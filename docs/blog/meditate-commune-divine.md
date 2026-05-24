# Go Deep with Claude — or Just Let MoFlo Learn on Its Own

**Purpose:** Introduce MoFlo's three "thinking" skills — `/commune`, `/divine`, and `/meditate` — that bookend the actual coding: shape a fuzzy idea into a spec *before* you build, research the world when one search isn't enough *during*, and distill durable lessons *after*. Plus auto-meditate, the always-on version of that last step that captures what you learned without you asking.

---

## The premise: most of the work isn't writing code

Spend a day pairing with Claude on a real project and you'll notice the actual typing of code is the easy part. The hard parts sit on either side of it. *Before* the work: figuring out what you actually want, when "I think I need an undo feature" is really "users keep losing drafts." *During* the work: needing a fact the codebase can't tell you — which library won, what the current best practice is, whether that API still works the way the old StackOverflow answer claims. *After* the work: noticing the lesson worth keeping, the gotcha that cost you two hours, the decision you'll regret re-litigating next month.

Claude is excellent at the middle. The edges are where sessions go sideways — you build the wrong thing because the spec was fuzzy, you ship on a stale assumption because you didn't dig, or you solve the same problem for the third time because nobody wrote down the answer.

MoFlo now ships three skills aimed squarely at those edges. They're deliberately *not* code-writing skills. Each one produces thinking — a spec, a cited answer, a durable lesson — and then hands the result somewhere useful.

---

## A note on the names

If you've used MoFlo for a while, you knew these as `/brainstorm`, `/deep-research`, and `/reflect`. They're now `/commune`, `/divine`, and `/meditate`. Same skills, sharper purpose, and names that finally fit the rest of the vocabulary — MoFlo already has spells you *cast*, the Eldar you *consult*, a Healer that mends your setup, and the Luminarium dashboard. The old names were generic verbs that could mean anything; the new ones say what the skill is *for*. You commune with the project to surface what it already knows. You divine an answer from the wider world. You meditate on a finished session to keep what mattered.

The rename is also a hint about how they relate. They're three modes of the same underlying thing — disciplined thinking — applied at three different moments.

---

## `/commune` — shape the idea before you build

Most "build me X" sessions fail at the first sentence, because the first sentence is a solution dressed up as a requirement. `/commune` is the pre-execution skill: it converges a fuzzy "I'm not sure exactly what I want yet" prompt into a concrete spec you can actually act on — through a short Socratic dialogue, not a form.

```
/commune a way for users to recover work they lost
```

Here's the flow:

1. **Memory first.** Before anything, it searches your `patterns` and `learnings` namespaces for the idea's keywords. The worst outcome in a brainstorm is specifying something that's already half-built — so if prior art exists, it surfaces that immediately. This might be "extend X," not "build X from scratch."
2. **Reframe as a problem.** It restates your idea back as a *goal*, not a solution: "You want users to recover a deleted draft" — not "you want an undo button." You confirm before any questions start.
3. **Elicit, Socratically.** It runs a handful of targeted rounds — problem and motivation, users and scenarios, scope and MVP, constraints, success criteria, risks — using interactive multiple-choice questions where there's a real branch, and open questions only where the answer is genuinely free-form. The rule it holds itself to: *every question must change the spec.* Three sharp questions beat ten that don't move anything.
4. **Synthesize.** Out comes a single markdown spec — problem, goal and non-goals, the chosen approach with rejected alternatives, scope, constraints, risks, and observable success criteria. You sign off (or do one round of edits) before it goes anywhere.
5. **Hand off.** This is the part that matters. `/commune` doesn't start a parallel track — it feeds MoFlo's existing surfaces. The spec's success criteria become a `/flo` ticket's acceptance criteria; an automatable pipeline becomes a spell; a decision-to-remember goes to memory; or you just keep the file.

Three speeds: `-q` for a small, well-bounded idea (1–2 rounds), the default for most ideas (3–5 rounds), and `--deep` for a risky architectural call, which adds a dedicated round comparing 2–3 candidate approaches side by side.

The point is to stop the most expensive failure mode in AI-assisted development: building the wrong thing, fast, because the prompt was a guess. It is far cheaper to fix the spec than the PR it becomes.

---

## `/divine` — research the world when one search isn't enough

Some questions a single `WebSearch` settles. "What's the latest stable Node version?" — done. But "which Rust async runtime should I use in 2026, and why?" isn't one lookup; it's a chain — find the contenders, read each one's tradeoffs, check what's current, weigh the disagreements. Do that ad hoc and you get a confident answer built on the first three blue links. `/divine` is the disciplined version of that loop.

```
/divine which embedding model gives the best quality-to-size ratio for local RAG
```

What makes it different from "just search a few times" is a **confidence gate**. After each hop, the skill scores its own confidence from 0.0 to 1.0 — honestly, weighing source quality, agreement across *independent* sources, and recency. Thin or single-source evidence scores low even when the snippet sounds definitive.

| Confidence after a hop | What it does |
|------------------------|--------------|
| `≥ 0.8` (target) | Stop — the answer is well-supported. Synthesize. |
| `0.6 – 0.8` | One more focused hop if budget remains; otherwise synthesize and flag the uncertainty. |
| `< 0.6` | Keep going — pick an expansion move and hop again. |

When it continues, it doesn't just search the same thing harder — it targets the *weakest* part of the current answer with a deliberate move: expand a named entity that needs its own lookup, deepen a claim from "what" to "how/why," check whether a time-sensitive answer has newer state, or follow a causal chain. It stops at the hop cap (default 5, override with `--hops N`) no matter what, and tells you the confidence it actually reached.

The output is a **cited synthesis** — the direct answer first, every material claim tied to its source URL, disagreements surfaced rather than smoothed over, and a closing confidence line like `Confidence 0.82 after 4 hops; weakest point: pricing may be stale (no 2026 source found)`. No factual claim without a source; the skill's own reasoning is marked as such.

And it learns. Every run stores a *case* to the `research` memory namespace — which sub-questions and expansion moves paid off, the confidence reached, the best sources. The next time you research a similar question, `/divine` retrieves that case first and starts from a strategy that already worked instead of from scratch. (`--offline` skips the web entirely and answers from memory and prior cases, clearly flagged and capped at low confidence.)

---

## `/meditate` — keep what the session taught you

You just spent three hours discovering that a daemon port resolves differently in local-dev versus CI, and that the fix has to live in the launcher because a long-lived process clobbers any file-level repair. That's a real lesson. Next week, on a different task, it would save you the three hours again — *if* it's written down somewhere Claude will find it. It usually isn't. The session ends, the insight evaporates, and you rediscover it the hard way.

`/meditate` is the deliberate retrospective that closes that loop. Run it at the end of a meaningful chunk of work:

```
/meditate the daemon port work
```

It reviews the session — what was attempted, what worked, what surprised you, what was decided and why — and then distills lessons against a single **durability bar**:

> *Would this help a future session working on a **different** task?*

| Keep (durable) | Skip (not durable) |
|----------------|--------------------|
| A reusable pattern: "for X, do Y because Z" | "Fixed bug X in file Y" — that's git history |
| A recurring gotcha: "W silently fails when V" | "Added a test for Z" — the test records itself |
| A decision + the rationale future work must respect | Session state ("on branch …, 3 files dirty") |
| A cross-platform or blast-radius constraint discovered | Restating a rule that's already written down |

It aims for a *handful* of high-signal items, not an exhaustive log — three lessons that change future behavior beat ten that restate the obvious. Crucially, it dedups before every write: it searches what's already in your `learnings` namespace and *updates* a near-match rather than spawning a duplicate, because a split, contradictory memory is worse than no memory at all. Then it reports a compact ledger of what was stored, updated, or skipped. (`--preview` runs the whole retrospective but writes nothing, so you can review before committing to memory.)

---

## ...or just let it learn on its own

Here's the part that makes all of this actually stick: you don't have to remember to run `/meditate`.

**Auto-meditate** is the always-on counterpart, and it ships on by default. A hook watches the live session for the *moment a durable lesson emerges* — a correction you made, an error followed by its fix, a decision with a rationale. It queues those, and at the next session start a brief background pass distills them into the same `learnings` namespace, applying the same durability bar and the same dedup-then-store discipline as the manual skill.

The two are complementary by design:

- **Auto-meditate is the safety net.** It runs without being asked and catches the lessons you'd otherwise forget to capture. No slash command, no prompting, no token cost in your active session.
- **`/meditate` is the deliberate, curated pass.** When you *know* a session was significant and want to shape exactly what's kept, you run it yourself.

Both dedup against existing `learnings`, so neither pollutes the other, and every lesson either of them stores gets embedded and surfaces in future memory searches. That's the whole bet: the project gets smarter about itself over time, whether or not you ever think about it.

Opt out with `auto_meditate.enabled: false` in `moflo.yaml` if you'd rather keep capture fully manual. Most people leave it on.

---

## How they fit together

These three aren't a random grab-bag. They map onto the lifecycle of a piece of work:

```
/commune   → shape a fuzzy idea into a spec        (before)
   ↓ hands off to /flo, a spell, or memory
[ build ]  → the actual work
   ↓
/meditate  → distill the durable lessons           (after)
   ↑ auto-meditate does this passively, always-on

/divine    → research the wider world when you're stuck   (any time)
```

`/commune` opens a unit of work; `/meditate` closes one. `/divine` sits orthogonal — reach for it any time the answer lives out on the web rather than in your repo or your head. And the same MoFlo memory substrate underneath all of them — node:sqlite plus HNSW vector search — is what lets `/divine` reuse winning research strategies and lets both flavors of meditate accumulate lessons that actually compound.

Each one also knows its lane. None of them write code. `/commune` produces a spec and hands it to `/flo` or a spell to *build*. `/divine` produces a cited answer, not an edit. `/meditate` writes memory, never source. That discipline is deliberate — these are the thinking steps, and keeping them separate from execution is what makes their output trustworthy.

---

## Why this matters

The pitch for MoFlo has always been that an AI assistant which remembers and learns beats one that starts cold every session. These three skills are that pitch applied to the *human* parts of the loop — the deciding, the researching, the reflecting that normally happens in your head and then vanishes.

`/commune` makes sure you build the right thing. `/divine` makes sure you build it on facts, not the first plausible search result. `/meditate` makes sure you only learn each lesson once. And auto-meditate makes sure that last part happens even on the days you're moving too fast to stop and reflect.

Go deep when the work calls for it. Let it learn on its own the rest of the time.

---

## See Also

- `.claude/skills/commune/SKILL.md` — Full `/commune` Socratic protocol and handoff matrix
- `.claude/skills/divine/SKILL.md` — Full `/divine` hop loop, confidence gate, and case storage
- `.claude/skills/meditate/SKILL.md` — Full `/meditate` retrospective protocol and durability bar
- `.claude/guidance/moflo-memory-protocol.md` — The `learnings`, `patterns`, and `research` namespaces these skills read and write
- `.claude/guidance/moflo-yaml-reference.md` — The `auto_meditate` block in `moflo.yaml`
