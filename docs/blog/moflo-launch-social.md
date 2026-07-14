# MoFlo launch posts — Show HN + r/ClaudeAI

---

## 1. Show HN

### Title (77 chars — under HN's 80 limit, no hype words)

```
Show HN: MoFlo – local-first memory and orchestration for Claude Code
```

### URL field

```
https://github.com/eric-cielo/moflo
```

### Text field (optional but recommended — keep it short; the real story goes in your first comment)

```
MoFlo installs into a project as a devDependency and gives Claude Code a
persistent semantic memory (local node:sqlite + HNSW, nothing leaves your
machine), learned model routing, hook gates, and repeatable multi-step
workflows. `npm install --save-dev moflo && npx flo init` and it's wired up —
no API keys, no cloud account.

It started as a fork of Claude Flow, then narrowed hard toward one use case:
day-to-day local coding on a single project. Happy to answer anything.
```

### First comment (post this yourself, immediately — this is what drives HN threads)

```
Author here. I built this because every Claude Code session started from zero
for me — it would re-read the same files and re-derive the same conclusions
about my codebase, every time, with no memory across sessions.

MoFlo builds an incremental semantic index of your code, tests, and project
guidance into a local node:sqlite + HNSW vector store using an in-tree
embeddings runtime. So instead of grepping to rediscover where something lives,
the agent queries memory first ("where is X defined", "what tests cover Y",
"what's our pattern for Z"). First index takes a minute or two; after that it
only re-processes changed files at session start.

On top of the memory layer there's learned model routing (don't burn your most
expensive model on trivial steps, with per-agent overrides to pin the ones that
matter), hook-based gates, a spell engine for repeatable workflows, and a /flo
skill that takes a GitHub issue to a PR.

Honest origin: it's a fork of Claude Flow, which is a broad, powerful, very
configurable framework. My use case was one narrow corner of what it does —
local coding on a single project — and I kept re-tailoring the same defaults on
every update. So I baked those defaults in, made indexing/memory automatic, and
tuned the out-of-box experience so init gets you straight to coding. Over time
it grew its own architecture (the sqlite+HNSW memory layer, in-tree embeddings,
spell engine, daemon scheduling) and diverged.

Everything runs on Linux, macOS, and Windows (CI on all three). It's MIT.

Things I'd genuinely love feedback on: the memory-first protocol (does it
actually save you tokens/time in practice?), and whether the "opinionated, zero
config" trade is the right call vs. more knobs. Fire away.
```

### Timing / tactics
- Post **weekday, ~8–10am US Eastern** (best Show HN visibility window).
- Post the first comment within a minute of submitting.
- Reply to every early comment fast — engagement in the first hour decides whether it climbs.
- Don't ask for upvotes anywhere (HN auto-penalizes vote solicitation).

---

## 2. r/ClaudeAI

### Title

```
I built MoFlo — gives Claude Code a persistent memory + repeatable workflows (local, no API keys)
```

### Body

```
I love Claude Code but it forgets everything between sessions — it re-reads the
same files and re-figures-out my codebase every single time. So I built MoFlo to
fix that for my own daily work, and it's grown into something I think is worth
sharing.

**What it does**

- **Semantic memory over your codebase.** Builds a local searchable index of your
  code, tests, and guidance (node:sqlite + HNSW vector store, in-tree embeddings
  — nothing leaves your machine). Claude queries memory first instead of grepping
  around to rediscover where things live. Incremental after the first build.
- **Learned model routing** — routes steps across models so you're not paying top
  dollar for trivial work, with per-agent overrides when you want to pin one.
- **Hook gates** — lightweight checks at session start / before edits / before
  spawning agents, so you're not re-explaining your project's rules every time.
- **Spells** — repeatable, composable multi-step workflows you cast on demand.
- **A /flo skill** — point it at a GitHub issue, it analyzes and executes it.

**Setup is two commands, no config:**

    npm install --save-dev moflo
    npx flo init

No API keys, no cloud account, nothing phones home. Works on macOS, Linux, and
Windows.

**Honest background:** it started as a fork of Claude Flow (a much broader, more
configurable framework) and I narrowed it hard toward one thing — local coding on
a single project — baking in the defaults I kept setting by hand. It's since
diverged into its own architecture.

Repo (MIT): https://github.com/eric-cielo/moflo

Would genuinely love feedback from people using Claude Code seriously — does the
memory-first approach match how you work? What's missing? Happy to answer
anything in the comments.
```

### Tactics
- r/ClaudeAI is sensitive to spam — the honest "I built this for my own workflow, here's the tradeoff, what's missing?" framing is what keeps it from being removed.
- Check the subreddit's self-promo / Saturday-showcase rules before posting; some communities restrict tool posts to specific days or flairs. Use a "Project"/"Showcase" flair if one exists.
- Engage in comments the same way — answer questions, don't just drop and leave.
- Consider cross-posting to r/ClaudeCode and r/LocalLLaMA (the "local, nothing leaves your machine" angle lands well there) once this one goes okay.
