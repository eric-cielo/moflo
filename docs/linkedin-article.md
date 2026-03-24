# <img src="https://raw.githubusercontent.com/eric-cielo/moflo/main/docs/Moflo_md.png?v=6" alt="MoFlo" width="80" align="left" style="margin-right: 12px;" /> MoFlo: Teaching Claude Code to Remember What It Learns

---

If you use Claude Code regularly, you've probably noticed a pattern. You start a session, Claude explores your codebase, reads your docs, figures out where things live — then the session ends and all of that knowledge evaporates. Next session, it does the same exploration from scratch. Tokens burned, context window eaten, and you're sitting there watching it rediscover what it already knew yesterday.

That's the problem MoFlo solves.

## What is MoFlo?

[MoFlo](https://github.com/eric-cielo/moflo) is an open-source npm package that gives Claude Code persistent memory, automatic knowledge indexing, and a feedback loop that makes it get better at your project over time. It's a local-first tool — no cloud services, no API keys, no external dependencies. Everything runs on your machine.

It started as an opinionated fork of [Ruflo/Claude Flow](https://github.com/ruvnet/ruflo), streamlined for local development. The upstream project has a lot of ambition and a lot of moving parts. MoFlo took the pieces that matter most for day-to-day coding and made them work out of the box with zero configuration.

## The Core Idea: Memory-First Development

The central insight is simple: **an AI assistant that checks what it already knows before exploring is dramatically more efficient than one that starts from scratch every time.**

MoFlo indexes three things at the start of every session:

- **Your documentation** — markdown files, architecture docs, conventions. Chunked into semantic embeddings so Claude can search by meaning, not just keywords.
- **Your code structure** — exports, classes, functions, types. Claude can answer "where is X defined?" from the index instead of running Glob/Grep across your codebase.
- **Your test files** — mapped back to their source targets. Claude can answer "what tests cover this module?" without scanning directories.

All of this happens in the background when a session starts. Incremental, so after the first run it typically finishes in under a second. You don't wait for it and you don't think about it.

## Workflow Gates: Guardrails That Actually Work

Here's where it gets interesting. MoFlo doesn't just *provide* memory — it *enforces* memory-first behavior through Claude Code hooks.

Before Claude can use Glob or Grep to scan files, it has to search the memory database first. Before it can spawn a sub-agent, it has to register a task. These aren't suggestions in a system prompt that Claude might ignore. They're actual hooks that run on every tool call and block the action if the prerequisite hasn't been met.

The result is a tighter feedback loop:

1. Claude gets a task
2. It searches what it already knows (because it has to)
3. It fills in gaps from the actual codebase (now with context from step 2)
4. The outcome feeds back into routing for next time

This sounds small, but in practice it's the difference between Claude burning 30% of your context window on rediscovery versus jumping straight to the work.

## Learned Routing: It Gets Smarter Over Time

When Claude takes on a task, MoFlo analyzes the description and recommends an agent type — security reviewer, coder, tester, architect, and so on. That routing is powered by semantic similarity against a set of built-in patterns.

But here's the thing: MoFlo records what actually happens. If a task routed to `coder` succeeds, that outcome is stored. If a task routed to `researcher` fails and then succeeds when re-routed to `architect`, that gets recorded too. Over time, the routing adapts to *your project's* patterns, not just generic heuristics.

Under the hood this is built on a stack of lightweight ML components — SONA for trajectory learning, MicroLoRA for weight adaptation, EWC++ to prevent new learning from overwriting old patterns. All running locally via WASM and Rust/NAPI bindings. No GPU, no API calls.

## The `/flo` Workflow: Issues to PRs

One of the more practical features is the `/flo` skill. Inside Claude Code, you type:

```
/flo 42
```

...where 42 is a GitHub issue number. MoFlo then drives Claude through a full workflow: research the issue, enhance the ticket with findings, implement the fix, run tests, simplify the code, and open a PR. Each step feeds back into memory so the next issue benefits from what was learned.

It handles epics too — if the issue has child stories, it processes them sequentially, each getting the full workflow treatment. For more complex features with inter-story dependencies, `flo orc` adds persistent state tracking, resume-from-failure, and auto-merge between stories.

## Context Tracking: Know When to Stop

This is a small feature that saves a lot of frustration. MoFlo tracks your conversation length and classifies it: FRESH, MODERATE, DEPLETED, CRITICAL. As conversations grow, AI output quality degrades — that's just how context windows work. MoFlo warns you when it's time to commit your progress and start a fresh session, before the quality cliff hits.

## What It Looks Like in Practice

Setup is two commands:

```bash
npm install --save-dev moflo
npx flo init
```

`flo init` scans your project, finds your docs and source directories, writes the config, installs the hooks, and sets up the MCP server. Then you restart Claude Code and everything is live. There's a `flo doctor` command that verifies the setup and can auto-fix common issues.

After that, you just use Claude Code normally. The memory, gates, routing, and learning all happen behind the scenes. You'll notice Claude is faster at finding things, wastes less of the context window on exploration, and starts making better routing decisions as you use it.

## What It's Not

I want to be straightforward about scope:

- **It's tested with Claude Code.** The MCP tools and hooks are client-independent in principle and should work with any MCP-capable client, but Claude Code is the only one I've actually tested. If you try it with Cursor or another tool, your mileage may vary.
- **It's not magic.** Claude still makes mistakes, still sometimes ignores context, still runs into the limitations of LLMs. MoFlo makes those problems less frequent by giving Claude better starting information and enforcing better habits, but it doesn't eliminate them.
- **It's Node.js only.** The entire stack — hooks, embeddings, memory database — is JavaScript/TypeScript with WASM bindings. No Python, no native compilation. This is a deliberate choice for portability and simplicity, but it means you need Node.js 20+.

## Why I Built This

I spend most of my working hours inside Claude Code. It's remarkably capable, but the session-to-session amnesia is a real productivity drain. Every conversation starts cold. Claude re-reads files it read yesterday, re-discovers patterns it already identified, re-explores directory structures it mapped out last week.

MoFlo is the tool I wanted to exist: something that makes Claude Code accumulate knowledge over time instead of discarding it, that enforces the good habits (check what you know first) and eliminates the bad ones (explore everything from scratch), and that does all of this without requiring me to configure anything or depend on external services.

It's open source, it's free, and it runs entirely on your machine. If you use Claude Code and the cold-start problem bugs you as much as it bugged me, give it a try.

**GitHub:** [github.com/eric-cielo/moflo](https://github.com/eric-cielo/moflo)
**npm:** `npm install --save-dev moflo`

---

*MoFlo is a fork of [Ruflo/Claude Flow](https://github.com/ruvnet/ruflo) by ruvnet. Credit to the upstream project for the foundation — MoFlo takes a different direction with opinionated defaults and local-first design, but it wouldn't exist without that starting point.*
