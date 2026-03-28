# <img src="https://raw.githubusercontent.com/eric-cielo/moflo/main/docs/Moflo_md.png?v=6" alt="MoFlo" width="80" align="left" style="margin-right: 12px;" /> Level Up Claude Code for Free with MoFlo

---

MoFlo grew out of months of using [Claude Flow / Ruflo](https://github.com/ruvnet/ruflo) on my own projects — both professional work and side projects. Over that time I accumulated a long list of patterns that worked, patterns that didn't, and things I wished the tooling did differently. Which hooks actually prevent Claude from wasting tokens. How to structure memory so it's useful across sessions instead of just accumulating noise. What kind of gates keep Claude focused versus what just annoys you. Where the upstream project's ambition created complexity that got in the way of actually shipping code.

At some point I realized I wasn't tweaking settings anymore — I was redesigning how the whole system fit together. So rather than maintain an increasingly divergent config on top of someone else's project, I made a fork and got busy. MoFlo recomposes those lessons into a new core: same foundation, different priorities, built around what I learned works in daily use.

---

If you use Claude Code regularly, you've probably noticed a pattern. You start a session, Claude explores your codebase, reads your docs, figures out where things live — then the session ends and all of that knowledge evaporates. Next session, it does the same exploration from scratch. Tokens burned, context window eaten, and you're sitting there watching it rediscover what it already knew yesterday.

That's one of many problem MoFlo solves, but that's really only the start of what it does for your project.

## What is MoFlo?

[MoFlo](https://github.com/eric-cielo/moflo) is an open-source npm package that gives Claude Code persistent memory, automatic knowledge indexing, and a feedback loop that further optimizes both learning and tokens over time. It's a local-first tool — Everything runs on your machine other than Claude itself.

It builds on the foundation of [Ruflo/Claude Flow](https://github.com/ruvnet/ruflo), but recomposed around what actually matters for day-to-day coding. The upstream project has a lot of ambition and a lot of moving parts. MoFlo took the lessons learned from using it in real projects and distilled them into opinionated defaults that work out of the box with zero or minimal configuration.

## The Core Idea: Memory-First Development

The central insight is simple: **an AI assistant that checks what it already knows before exploring is dramatically more efficient than one that starts from scratch every time.**

MoFlo indexes three things at the start of every session:

- **Your documentation** — markdown files, architecture docs, conventions. Chunked into linked semantic embeddings so Claude can search by meaning, not just keywords.
- **Your code structure** — exports, classes, functions, types. Claude can answer "where is X defined?" from the index instead of running Glob/Grep across your codebase.
- **Your test files** — mapped back to their source targets. Claude can answer "what tests cover this module?" without scanning directories.

All of this happens in the background when a session starts. Indexing is incremental — unchanged files are skipped via hash checks — so after the first run subsequent sessions index quickly. You don't wait for it and you don't think about it.

## Workflow Gates: Guardrails That Actually Work

Here's where it gets interesting. MoFlo doesn't just *provide* memory — it *enforces* memory-first behavior through Claude Code hooks.

Before Claude can use Glob or Grep to scan files, it has to search the memory database first. Before it can spawn a sub-agent, it has to register a task. These aren't suggestions in a system prompt that Claude might ignore. They're actual hooks that run on every tool call and block the action if the prerequisite hasn't been met.

The result is a tighter feedback loop:

1. Claude gets a task
2. It searches what it already knows (because it has to)
3. It fills in gaps from the actual codebase (now with context from step 2)
4. The outcome feeds back into routing for next time

This sounds small, but in practice it means Claude spends far less of your context window on rediscovery and gets to the actual work faster.

## Learned Routing: It Gets Smarter Over Time

When Claude takes on a task, MoFlo analyzes the description and recommends an agent type — security reviewer, coder, tester, architect, and so on. That routing is powered by semantic similarity against a set of built-in patterns.

But here's the thing: MoFlo records what actually happens. If a task routed to `coder` succeeds, that outcome is stored. If a task routed to `researcher` fails and then succeeds when re-routed to `architect`, that gets recorded too. Over time, the routing adapts to *your project's* patterns, not just generic heuristics.

That same learning system also handles model selection. MoFlo can optionally choose between Opus, Sonnet, and Haiku for each task based on actual outcomes — not just a static config. A config change, a rename, a formatting fix? Haiku handles that fine and costs a fraction of what Opus does. A security audit or a complex architectural refactor? That gets routed to Opus. The model router learns from what succeeds and what doesn't, with a circuit breaker that escalates to a more capable model when a cheaper one fails. It's off by default — you can pin models manually if you prefer predictability — but when enabled, it can substantially reduce token usage by routing routine work to lighter models, saving the heavy lifting for tasks that actually need it.

Under the hood this is all built on a stack of lightweight ML components — SONA for trajectory learning, MicroLoRA for weight adaptation, EWC++ to prevent new learning from overwriting old patterns. All running locally via WASM and Rust/NAPI bindings. No GPU, no API calls.

## The `/flo` Workflow: Issues to PRs

One of the more practical features is the `/flo` skill. Inside Claude Code, you type:

```
/flo 42
```

...where 42 is a GitHub issue number. MoFlo then drives Claude through a full workflow: research the issue, enhance the ticket with findings, implement the fix, create and run tests, simplify the code, and open a PR. Each step feeds back into memory so the next issue benefits from what was learned.

**It handles epics too** — if the issue has child stories, it processes them sequentially, each getting the full workflow treatment. For more complex features with inter-story dependencies, `flo epic` adds persistent state tracking, resume-from-failure, and two configurable branching strategies: **single-branch** (default) commits all stories to one shared branch with a single PR at the end, while **auto-merge** creates per-story branches and PRs that are squash-merged sequentially.

Out of the box, `/flo` and `flo epic` are wired up for GitHub — issues, PRs, labels, the `gh` CLI. But the workflow logic is just structured prompts and shell commands, not a deep integration that's hard to swap out. If you use Jira, Linear, GitLab, or something else, a quick conversation with Claude is genuinely all it takes to adapt the skill and epic runner to your stack. The patterns are the same; only the API calls change.

## Context Tracking: Know When to Stop

This is a small feature that saves a lot of frustration. MoFlo tracks your conversation length and classifies it: FRESH, MODERATE, DEPLETED, CRITICAL. As conversations grow, AI output quality degrades — that's just how context windows work. MoFlo warns you when it's time to commit your progress and start a fresh session, before the quality cliff hits.

## Task System Integration: Keeping Claude on Task

If you've used Claude Code's sub-agent system, you know it can get enthusiastic. Ask it to fix a bug and it might spawn five agents — three of which are redundant — before you realize what happened. Tokens gone, context polluted, and you're untangling parallel work that didn't need to be parallel.

MoFlo addresses this with a simple gate: before Claude can spawn any sub-agent, it must first register the work via TaskCreate. No task registration, no agent. The hook literally blocks the tool call.

This does two things. First, it forces Claude to *think before acting*. The act of writing a task description — what needs to happen, why, and what the acceptance criteria are — naturally prevents the "let me just spin up a quick agent" impulse. Second, it gives you visibility. Every piece of delegated work shows up in a task list with status tracking, so you can see what Claude is doing, what's pending, and what finished.

The task system also structures how complex work gets decomposed. Rather than one sprawling agent that tries to do everything, MoFlo's patterns encourage breaking work into tracked units: a research task that feeds into an implementation task, which feeds into a test task. Each one registered, each one visible, each one with a clear outcome that feeds back into routing.

The practical effect is that Claude stays focused. It doesn't wander off on tangents, it doesn't spawn redundant agents, and when something goes wrong you can see exactly where and why — because every step was tracked.

## What It Looks Like in Practice

Setup is two commands:

```bash
npm install --save-dev moflo
npx flo init
```

`flo init` scans your project, finds your docs and source directories, writes the config, and installs the Claude Code hooks. Then you restart Claude Code and everything is live. There's a `flo doctor` command that verifies the setup and can auto-fix common issues.

After that, you just use Claude Code normally. The memory, gates, routing, and learning all happen behind the scenes. You'll notice Claude is faster at finding things, wastes less of the context window on exploration, and starts making better routing decisions as you use it.

## What It's Not

I want to be straightforward about scope:

- **It's tested with Claude Code.** The MCP tools and hooks are client-independent in principle and should work with any MCP-capable client, but Claude Code is the only one I've actually tested. If you try it with Codex or another tool, your mileage may vary.
- **It's not magic.** Claude still makes mistakes, still sometimes ignores context, still runs into the limitations of LLMs. MoFlo makes those problems less frequent by giving Claude better starting information and enforcing better habits, but it doesn't eliminate them, and the qualify of the guidance you feed in is key.
- **It's Node.js only.** The entire stack — hooks, embeddings, memory database — is JavaScript/TypeScript with WASM bindings. No Python, no native compilation. This is a deliberate choice for portability and simplicity, but it means you need Node.js 20+.

## Why I Built This

I spend most of my working hours inside Claude Code. It's remarkably capable, but the session-to-session amnesia is a real productivity drain. Every conversation starts cold. Claude re-reads files it read yesterday, re-discovers patterns it already identified, re-explores directory structures it mapped out last week.

MoFlo is the tool I wanted to exist: something that makes Claude Code accumulate knowledge over time instead of discarding it, that enforces the good habits (check what you know first) and eliminates the bad ones (explore everything from scratch), and that does all of this without requiring me to configure anything or depend on external services.

A big part of the work was cutting things out. Ruflo is an ambitious project with a lot of surface area, and in practice I found that significant chunks of it were unused in real coding scenarios, abandoned mid-implementation, or outdated. At the same time, there were areas I found myself manually patching with every upstream update — the same fixes, the same workarounds, every time. MoFlo strips out the dead weight and solidifies the parts that actually matter for day-to-day development.

Why not just patch upstream? I have, actually — I've submitted several fixes, and so have plenty of others. But what I wanted wasn't a patched version of someone else's vision. I wanted a more refined and curated experience, one that baked in all the practices I'd been layering on top across my own projects via patch scripts and a fair amount of hackery. At some point, wrapping duct tape around something is less productive than building the thing you actually want.

Will I keep pulling from Ruflo? Yes — it's an active project and good work continues to land there. But MoFlo has diverged significantly in many places, so upstream changes get analyzed and integrated individually, not wholesale merged. Cherry-picks, not rebases. And MoFlo has its own roadmap — I plan to keep adding features that reflect what I need in my own workflows, whether or not they align with upstream direction.

It's open source, it's free, and it runs entirely on your machine. If you use Claude Code and the cold-start problem bugs you as much as it bugged me, give it a try.

**GitHub:** [github.com/eric-cielo/moflo](https://github.com/eric-cielo/moflo)
**npm:** `npm install --save-dev moflo`

---

*MoFlo is a fork of [Ruflo/Claude Flow](https://github.com/ruvnet/ruflo) by ruvnet. Credit to the upstream project for the foundation — MoFlo takes a different direction with opinionated defaults and local-first design, but it wouldn't exist without that starting point.*
