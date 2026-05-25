# Distill: The Same Code Review as `/simplify`, Sized to the Change

**Purpose:** Explain how MoFlo's `/distill` (aka `/flo-simplify`) compares to Claude Code's built-in `/simplify` skill. The two do nearly the same review — the difference is that `/simplify` runs its full three-agent pass on every diff, while distill measures the diff first and runs only as much review as the change warrants.

---

## Two tools that do almost the same thing

Claude Code ships a built-in `/simplify` skill. It's good. Point it at your working tree and it runs a parallel, multi-agent review of your recently changed code, then cleans up what it finds — duplicated logic, missed abstractions, the O(n²) loop that should be a hash lookup. The natural place for it is right after you've got something working, before you open a PR.

MoFlo has a skill that does the same job: `/distill` (its formal name is `/flo-simplify` — we renamed it from `/simplify` specifically to avoid colliding with the built-in). It reviews the same axes, fixes the same kinds of problems, and lives in the same pre-PR slot in your workflow.

So this isn't a "look how different we are" post. The two skills are deliberately close — close enough that the honest comparison is narrow and specific. This post is about that narrow difference, because it turns out to matter on every diff you'll ever run it against.

(One quick disambiguation, since it tripped me up while writing this: Claude Code *also* has a separate `/code-review` skill, which is a read-only correctness-bug review. That's a different tool with a different job. The head-to-head here is distill vs. `/simplify` — the code-cleanup skill, not the bug-finder.)

---

## What the built-in `/simplify` does

Credit first: `/simplify` is a well-designed skill, and distill shares its DNA. When you invoke it, it spins up **three specialized agents in parallel** over your changed files:

- **Code Reuse** — duplicated logic, missed abstractions, opportunities to consolidate.
- **Code Quality** — readability, structure, naming, conventions.
- **Efficiency** — performance issues and wasted work.

Then it does the part that makes it more than a linter: it **aggregates the findings, fixes each valid one directly in your code, and silently skips the ones it decides are false positives**. It operates at the architectural level, not on formatting; it focuses on what you recently changed rather than the whole repo; and it's careful — it won't strip code that looks redundant but is actually defensive, and it preserves external behavior.

If that description sounds like a tool you'd want before every PR, you're right. That's exactly why MoFlo has one too.

---

## Where distill is identical (no point pretending otherwise)

Being straight about the overlap makes the real difference legible:

- **Same three axes.** Distill reviews reuse, quality, and efficiency — the same orthogonal split.
- **Same fix-don't-just-flag behavior.** Distill aggregates findings, fixes each one directly, and notes-and-skips false positives without arguing. (Our skill's wording and the built-in's are nearly word-for-word — this is shared design philosophy, not coincidence.)
- **Same workflow slot.** Both are the "clean it up before humans review it" step, scoped to the diff.
- **Same safety instinct.** Distill re-runs your tests after fixing and reverts any fix that breaks them.

If the review quality were the whole story, you wouldn't need distill — the built-in is fine. The story is what each tool does *before* it decides how hard to look.

---

## Where distill differs: it sizes the review to the diff

The built-in `/simplify` runs a **fixed three-agent fan-out**. Every invocation, three parallel agents, regardless of whether you changed six lines or six hundred. There's no scope classifier deciding how much review the change deserves — the orchestration is constant.

Distill's one structural difference is that it **measures the diff first**, with a small, deterministic, unit-tested classifier, and then runs only as much review as the change warrants. The classifier parses the unified diff, counts added/removed declarations, detects structural moves, flags security-sensitive paths, and returns a tier, a model, and an agent count. Here's the real classifier deciding five representative diffs:

```
typo in 1 file (8 LOC)                     -> TRIVIAL  sonnet  agents:0  | ≤10 LOC, 1 file, no declaration changes
refactor one function (140 LOC, 2 files)   -> SMALL    sonnet  agents:1  | small/medium diff
decomposition: 6 files, 5 fns moved        -> SMALL    haiku   agents:1  | mostly relocation: 5 added, 5 removed, net +0
big new subsystem (620 LOC)                -> NORMAL   sonnet  agents:3  | >500 LOC changed
security path + new logic                  -> NORMAL   sonnet  agents:3  | security-sensitive path with new logic
architectural subsystem (1.8k LOC, +12)    -> DEEP     opus    agents:3  | net-new logic clears the architectural bar
```

That single difference cascades into several concrete advantages.

### 1. You don't pay for three agents on a small change

Most real diffs are small — a tweaked function, an extracted constant, an added early-return. The built-in fans out three parallel agents for those. Distill runs **one** focused agent that covers all three axes (this is its default tier), because on a single-file edit three agents duplicate each other's work rather than covering new ground. Same coverage, roughly a third of the token cost, on the diffs you run most often.

### 2. A typo gets zero agents, not three

When the classifier proves a change is below the threshold where review adds any value — a trimmed comment, a renamed private helper, a reformatted block — distill stamps the gate and exits in seconds with **no agent at all**. The built-in still fans out its three agents to conclude there's nothing to fix. Distill spends nothing to reach the same answer.

### 3. The heavy fan-out is reserved for changes that earn it — and steps up further for the ones that really do

Distill escalates to the full three-agent pass only when the diff is genuinely cross-cutting — 500+ lines of real volume, a broad new subsystem, security-sensitive code with new logic. At that point three agents *cover orthogonal ground* instead of overlapping, and the cost is justified. The built-in runs that same heavy pass for the cross-cutting change and the one-liner alike.

Calibration runs in *both* directions. For the rare **architectural** diff — a genuinely new subsystem, thousands of lines of net-new logic — distill steps *up* a rung to **DEEP**: the same three-agent fan-out, but on **Opus**, because judging whether a large refactor picked the right abstractions is depth-bound reasoning, not breadth-bound surveying. That runs automatically, with a one-line notice so the heavier cost is never silent. For the most extreme diffs, distill finishes its Opus pass and then *suggests* you hand off to Claude Code's built-in `/simplify` for an even deeper look — a prompt, never an automatic switch. Crucially, this upward escalation is gated on **net-new-logic evidence, never raw volume**: net-new declarations in TS/JS, net-new lines in other languages, measured net of churn with lockfiles, snapshots, generated files, and docs stripped out. A 2,000-line lockfile bump, a reformatting sweep, or a big rename never trips it — there's no new logic to reason about, so there's nothing for Opus to earn.

### 4. It tells a move apart from a rewrite

Look at the third row of the table. A 330-LOC decomposition across six files *looks* huge by line count, but it's a pure relocation — code that already worked, just moved. Distill judges by declaration *balance* (roughly equal additions and removals), recognizes the move, and drops to a single cheap agent checking for copy-paste divergence and dead-after-move code. The built-in's fixed fan-out has no concept of this — it runs the full three-agent review on code that didn't change behavior. (Distill learned this the hard way: we shipped the over-eager version first and watched it burn tokens on decompositions.)

### 5. It routes the model to the work

The built-in uses Claude Code's standard sub-agent model defaults. Distill picks the model from the diff shape: **Haiku** for mechanical relocations (~5× cheaper, and pattern-matching is all a move needs), **Sonnet** for ordinary logic changes, and **Opus** for the rare architectural diff where depth of reasoning earns its cost (see #3 — ordinary review is breadth-bound, so three Sonnet agents are the right tool; architectural review is depth-bound). Cheap model on cheap diffs, capable model on hard ones, the depth model only when the change is genuinely architectural — decided automatically.

### 6. A re-run doesn't re-pay

Run distill, let it fix a few things, run it again to confirm. Distill recognizes a **validation pass**: if the only changes since the last run are the fixes it drove, it self-reviews in one pass instead of re-fanning-out — the expensive survey already happened. The built-in has no memory of a prior run; every invocation starts cold and fans out again.

### 7. It's wired into the PR gate

Distill is part of MoFlo's pre-PR gate, and the gate uses the *same* classifier to get out of your way: a trivial diff, or a tiny review-fix tweak on an already-reviewed branch, auto-passes the "has this been reviewed?" check without even invoking the skill. The built-in `/simplify` is a standalone command — running it, and tracking whether it ran, is on you.

---

## Side by side

| | Built-in `/simplify` | MoFlo `/distill` (`/flo-simplify`) |
|---|---|---|
| **Review axes** | Reuse + quality + efficiency | Reuse + quality + efficiency (same) |
| **Action** | Aggregates findings, fixes directly, skips false positives | Same — plus re-runs tests and reverts a fix that breaks them |
| **Effort model** | Fixed three-agent fan-out, every diff | Classifier sizes it: 0 / 1 / 3 agents by tier |
| **Tiny/trivial diffs** | Still fans out three agents | Zero agents — gate stamp and exit |
| **Typical small diffs** | Three agents | One focused agent, all three axes |
| **Move vs. rewrite** | No distinction — full pass either way | Detects relocation, drops to one cheap agent |
| **Architectural diffs** | Three agents, same as any diff | Steps up to three Opus agents; suggests built-in `/simplify` on extreme outliers |
| **Model** | Standard sub-agent defaults | Routed per diff: haiku → sonnet → opus (opus only for architectural diffs) |
| **Re-run after fixes** | Fans out again | Validation pass — self-review, no re-fan-out |
| **Workflow integration** | Standalone command | Wired into the PR gate; auto-skips trivial diffs |
| **Scope decision** | Prompt-driven, constant | Deterministic, unit-tested classifier |

---

## The irony, and why it matters

There's a small irony in a skill named `/simplify` that does the maximal thing — three parallel agents — on every change, including the changes that don't need it. Distill's whole premise is to apply the simplify ethos to the *review itself*: don't over-engineer the review of a six-line diff.

The expensive part of code review was never the reading. It's the *calibration* — knowing how hard to look. Review a trivial change with full machinery and you've burned tokens and time for no signal. The built-in pushes a good review through one fixed gear. Distill keeps the same review and adds a transmission: a deterministic classifier that reads the same diff you would, applies rules that are written down and tested, and engages exactly as many agents — on exactly as expensive a model — as the change calls for.

For occasional use, the difference is a rounding error. Run a cleanup pass before every PR, every day, across a team, and "the same review at a third of the cost on the common case, zero cost on the trivial case" compounds into real money and real latency.

---

## So which do you use?

If you have Claude Code and not MoFlo, `/simplify` is a genuinely good tool — use it. If you're already running MoFlo, `/distill` gives you the same review with the cost calibrated to each diff and folded into the issue-to-PR workflow (the `/flo` skill runs distill as a step automatically). They're not rivals so much as the same idea with one of them tuned for running constantly.

Write the code. Let distill keep it lean — without charging you a three-agent review to discover a typo was just a typo.

---

## See Also

- `.claude/skills/flo-simplify/SKILL.md` — Full `/flo-simplify` reference: tiers, validation pass, model selection, gate stamp
- `.claude/skills/distill/SKILL.md` — The `/distill` alias
- `bin/simplify-classify.cjs` — The deterministic diff classifier (parse → decide → dispatch)
- `docs/blog/writing-better-docs-for-claude.md` — Companion post on MoFlo's `/guidance` and `/eldar`
