# Claude created a monster? MoFlo will simmer it down.

**Purpose:** Explain how MoFlo's `/distill` (aka `/flo-simplify`) compares to Claude Code's built-in `/simplify` skill. Both can clean up code before a PR; the difference is that `/simplify` runs the same fixed multi-agent pipeline on every diff, while distill measures the diff first and runs only as much review as the change warrants.

---

- **GitHub:** [github.com/eric-cielo/moflo](https://github.com/eric-cielo/moflo)
- **npm:** [npmjs.com/package/moflo](https://www.npmjs.com/package/moflo) — `npm install --save-dev moflo`

---

## Distill: a `/simplify` for every sized change

Claude Code ships a built-in `/simplify` skill. It's good. Point it at your working tree and it runs a parallel multi-agent review of your recently changed code, then cleans up what it finds — duplicated logic, missed abstractions, the O(n²) loop that should be a hash lookup. The natural place for it is right after you've got something working, before you open a PR.

So what's different about `/distill`? It reviews the same kinds of things, fixes the same kinds of problems, and lives in the same pre-PR slot in your workflow. The difference is that distill is designed to run on every PR, no matter the size. It adapts to the complexity of the work that was performed.

For me, this came about because in MoFlo's `/flo` skill we always end with a code review — and then if a test fails, perhaps a change and another review. I realized I was spending thousands upon thousands of tokens using `/simplify` as my reviewer. It always spawned the same heavy pipeline, no matter how trivial the change, and the heaviest agents in it ran on Opus.

I needed something that scaled the review to the size and complexity of the work performed — something I could run on every commit, every PR, every time, that gave valuable feedback and sized its effort and model appropriately. Distill is that.

---

## What `/simplify` actually runs

`/simplify` is a well-designed skill, and distill shares its DNA. It's worth being precise about what `/simplify` actually does today, because the skill has evolved fast.

Originally, `/simplify` was a three-axis cleanup pass — reuse, quality, efficiency — with three parallel agents. In Claude Code v2.1.147 the command was renamed to `/code-review` and re-pointed at correctness-bug review. Then in v2.1.152 `/simplify` was reintroduced as a thin alias: today it invokes `/code-review --fix` under the hood. The `--fix` flag is the part that applies findings to your working tree and surfaces "reuse, simplification, and efficiency suggestions" alongside the bug findings.

So what you actually get when you run `/simplify` is this pipeline (verbatim from the [code-review plugin source](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/commands/code-review.md)):

1. A **Haiku** agent screens whether the diff is worth reviewing (closed PR, draft, trivial, already-reviewed).
2. A **Haiku** agent discovers the relevant `CLAUDE.md` files.
3. A **Sonnet** agent summarizes the changes.
4. **Four agents run in parallel**: two **Sonnet** agents audit `CLAUDE.md` compliance, two **Opus** agents hunt for bugs and logic errors.
5. A validation pass of parallel subagents re-checks each flagged issue (**Opus** for bugs, **Sonnet** for compliance).
6. With `--fix`, findings are applied to your working tree, including reuse/simplification/efficiency suggestions.

It's careful — it won't strip code that looks redundant but is actually defensive, it preserves external behavior, and the validation step is there specifically to filter false positives. The signals it surfaces are good.

The problem isn't quality. Notice the shape of step 1: the built-in's only triage is a **binary** go/no-go — either the Haiku screener decides to skip the diff entirely (closed PR, draft, already reviewed, or judged "obviously correct"), or the full pipeline runs. There's no medium gear. Once the screener says "proceed," you pay the same Haiku + Sonnet + Opus orchestration whether you changed twelve lines or twelve hundred.

---

## Where distill is identical (no point pretending otherwise)

Being straight about the overlap makes the real difference legible:

- **Same focus on reuse, quality, and efficiency cleanup.** Distill targets exactly the axes `/simplify --fix` surfaces in its post-review suggestions. (The new `/simplify` adds bug-detection and `CLAUDE.md` compliance on top — distill doesn't try to compete on those; MoFlo has its own `/code-review` for that.)
- **Same fix-don't-just-flag behavior.** Distill aggregates findings, fixes each one directly, and notes-and-skips false positives without arguing. (Our skill's wording and the built-in's are nearly word-for-word — this is shared design philosophy, not coincidence.)
- **Same workflow slot.** Both are the "clean it up before humans review it" step, scoped to the diff.
- **Same safety instinct.** Distill re-runs your tests after fixing and reverts any fix that breaks them.

If the review quality were the whole story, you wouldn't need distill — the built-in is fine. The story is what each tool does *before* it decides how hard to look.

---

## Where distill differs: it sizes the review to the diff

The built-in `/simplify` has two settings: **skip the diff** (when its Haiku screener decides the PR isn't worth reviewing) or **run the full pipeline** (everything else). Once it decides to proceed, the same staging stages and the same four parallel review agents fire, regardless of whether you changed six lines or six hundred. There's no scope classifier deciding how much review the change deserves — once you're past the binary screen, the orchestration is constant.

Distill's one structural difference is that it **measures the diff first**, with a small, deterministic, unit-tested classifier, and then runs only as much review as the change warrants. The classifier parses the unified diff, counts added/removed declarations, detects structural moves, flags security-sensitive paths, and returns a tier, a model, and an agent count. Here's the real classifier deciding six representative diffs:

```
typo in 1 file (8 LOC)                     -> TRIVIAL  sonnet  agents:0  | ≤10 LOC, 1 file, no declaration changes
refactor one function (140 LOC, 2 files)   -> SMALL    sonnet  agents:1  | small/medium diff
decomposition: 2 files, 5 fns moved        -> SMALL    haiku   agents:1  | mostly relocation: 5 added, 5 removed, net +0
big new subsystem (620 LOC)                -> NORMAL   sonnet  agents:3  | >500 LOC changed
security path + new logic                  -> NORMAL   sonnet  agents:3  | security-sensitive path with new logic
architectural subsystem (1.8k LOC, +12)    -> DEEP     opus    agents:3  | net-new logic clears the architectural bar
```

That single difference cascades into several concrete advantages.

### 1. Triage is graded, not binary

The built-in *does* have a pre-flight gate — the Haiku screener in step 1. But its decision is binary: skip the diff, or run the full pipeline. There's no "small review" gear. Three of the screener's four stop conditions are about PR state (closed, draft, already reviewed by Claude); the fourth is a subjective Haiku judgment that the change "does not need code review." If that judgment doesn't fire, the full four-agent fan-out runs.

Distill replaces the binary with a graded choice: **zero / one / three agents**, on Haiku / Sonnet / Opus, decided by measurable diff metrics (LOC, declarations, balance of additions vs. removals, file count, security-sensitive paths). Same diff always lands on the same tier — it's deterministic and unit-tested — and the tier the change actually lands on usually has a smaller gear than "the full pipeline."

### 2. A typo gets zero agents

When the classifier proves a change is below the threshold where review adds any value — a trimmed comment, a renamed private helper, a reformatted block — distill stamps the gate and exits in seconds with **no agent at all**. The built-in's Haiku screener can also short-circuit on trivial changes (its "obviously correct" example covers this), but that's a Haiku judgment call rather than a measured rule, so the cut-off isn't deterministic. Distill's "trivial" detection runs against the diff metrics themselves, so the same trivial diff lands in the zero-agent gate every time.

### 3. The heavy fan-out is reserved for changes that earn it — and steps up further for the ones that really do

Distill escalates to a full three-agent pass only when the diff is genuinely cross-cutting — 500+ lines of real volume, a broad new subsystem, security-sensitive code with new logic. At that point three agents *cover orthogonal ground* instead of overlapping, and the cost is justified. The built-in runs that same heavy pipeline for the cross-cutting change and the one-liner alike.

Calibration runs in *both* directions. For the rare **architectural** diff — a genuinely new subsystem, thousands of lines of net-new logic — distill steps *up* a rung to **DEEP**: the same three-agent fan-out, but on **Opus**, because judging whether a large refactor picked the right abstractions is depth-bound reasoning, not breadth-bound surveying. That runs automatically, with a one-line notice so the heavier cost is never silent. For the most extreme diffs, distill finishes its Opus pass and then *suggests* you hand off to Claude Code's built-in `/simplify` for an even deeper look — a prompt, never an automatic switch. Crucially, this upward escalation is gated on **net-new-logic evidence, never raw volume**: net-new declarations in TS/JS, net-new lines in other languages, measured net of churn with lockfiles, snapshots, generated files, and docs stripped out. A 2,000-line lockfile bump, a reformatting sweep, or a big rename never trips it — there's no new logic to reason about, so there's nothing for Opus to earn.

### 4. It tells a move apart from a rewrite

Look at the third row of the table. A decomposition across two files with five functions moved *looks* bigger than a six-line tweak by line count, but it's a pure relocation — code that already worked, just moved. Distill judges by declaration *balance* (roughly equal additions and removals), recognizes the move, and drops to a single cheap Haiku agent checking for copy-paste divergence and dead-after-move code. The built-in's fixed pipeline has no concept of this — it runs the full review on code that didn't change behavior. (Distill learned this the hard way: we shipped the over-eager version first and watched it burn tokens on decompositions.)

### 5. It routes the model to the work

The built-in uses a **fixed model mix per agent role**: Haiku for screening/discovery, Sonnet for the change summary and CLAUDE.md compliance, Opus for bug detection and bug validation. Same mix, every diff. Distill picks the model from the *diff* itself: **Haiku** for mechanical relocations (~5× cheaper than Sonnet, and pattern-matching is all a move needs), **Sonnet** for ordinary logic changes, and **Opus** only for the rare architectural diff where depth of reasoning earns its cost (see #3 — ordinary review is breadth-bound, so Sonnet is the right tool; architectural review is depth-bound). Cheap model on cheap diffs, capable model on hard ones, the depth model only when the change is genuinely architectural — decided automatically.

### 6. A re-run doesn't re-pay

Run distill, let it fix a few things, run it again to confirm. Distill recognizes a **validation pass**: if the only changes since the last run are the fixes it drove, it self-reviews in one pass instead of re-fanning-out — the expensive survey already happened. The built-in has no memory of a prior run; every invocation starts cold and runs the full pipeline again.

### 7. It's wired into the PR gate

Distill is part of MoFlo's pre-PR gate, and the gate uses the *same* classifier to get out of your way: a trivial diff, or a tiny review-fix tweak on an already-reviewed branch, auto-passes the "has this been reviewed?" check without even invoking the skill. The built-in `/simplify` is a standalone command — running it, and tracking whether it ran, is on you.

---

## Side by side

| | Built-in `/simplify` (= `/code-review --fix`) | MoFlo `/distill` (`/flo-simplify`) |
|---|---|---|
| **Primary focus** | Correctness bugs + `CLAUDE.md` compliance, with reuse/simplification/efficiency suggestions layered via `--fix` | Reuse + quality + efficiency cleanup |
| **Action** | Aggregates findings, applies fixes via `--fix` | Same — plus re-runs tests and reverts a fix that breaks them |
| **Effort model** | Fixed pipeline: Haiku staging → Sonnet summary → 4 parallel review agents → validation subagents | Classifier sizes it: 0 / 1 / 3 agents by tier |
| **Tiny/trivial diffs** | Binary: either Haiku screener skips entirely, or the full pipeline runs | Zero agents — gate stamp and exit |
| **Typical small diffs** | Full pipeline | One focused Sonnet agent, all three cleanup axes |
| **Move vs. rewrite** | No distinction — full pipeline either way | Detects relocation, drops to one cheap Haiku agent |
| **Architectural diffs** | Same pipeline as any diff | Steps up to three Opus agents; suggests built-in `/simplify` on extreme outliers |
| **Model mix** | Fixed: Haiku staging + Sonnet compliance + Opus bug-hunt | Routed per diff: Haiku → Sonnet → Opus (Opus only for architectural diffs) |
| **Re-run after fixes** | Runs the pipeline again | Validation pass — self-review, no re-fan-out |
| **Workflow integration** | Standalone command | Wired into the PR gate; auto-skips trivial diffs |
| **Scope decision** | Prompt-driven, constant | Deterministic, unit-tested classifier |

---

## The irony, and why it matters

There's a small irony in a skill named `/simplify` whose only two settings are "skip" and "maximal" — a full multi-agent pipeline on Haiku + Sonnet + Opus the moment it decides a diff is worth looking at, including the diffs that don't need that much looking. Distill's whole premise is to apply the simplify ethos to the *review itself*: don't over-engineer the review of a six-line diff.

The expensive part of code review was never the reading. It's the *calibration* — knowing how hard to look. Review a trivial change with full machinery and you've burned tokens and time for no signal. The built-in pushes a good review through one fixed gear. Distill keeps the same review and adds a transmission: a deterministic classifier that reads the same diff you would, applies rules that are written down and tested, and engages exactly as many agents — on exactly as expensive a model — as the change calls for.

For occasional use, it's a wash. But run a cleanup pass before every PR (as you should with Claude), every day, across a team, and "the same review at a fraction of the cost on the common case, zero cost on the trivial case" compounds into real money and real latency.

---

## So which do you use?

If you have Claude Code and not MoFlo, `/simplify` is a genuinely good tool — use it. If you're already running MoFlo, `/distill` gives you the same cleanup review with the cost calibrated to each diff and folded into the issue-to-PR workflow (the `/flo` skill runs distill as a step automatically). They're not rivals so much as the same idea with one of them tuned for running constantly.

Write the code. Let distill keep it lean — without charging you the full pipeline to discover a typo was just a typo.
