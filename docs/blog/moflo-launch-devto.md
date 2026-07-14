---
title: "MoFlo: local-first agent orchestration for Claude Code"
published: false
description: "MoFlo gives Claude Code a memory, learned model routing, and repeatable workflows — local-first, no API keys, one npm install."
tags: claude, ai, productivity, opensource
canonical_url: https://cielolimitada.com/moflo-local-first-agent-orchestration-for-claude-code/
cover_image:
---

Claude Code is the best coding agent I've used. But every session starts from zero. It re-reads the same files, re-derives the same conclusions, and forgets everything the moment you close the terminal. There's no memory of what your codebase means, no learning from what worked last time, and no repeatable way to hand it a task and trust the same steps run every time.

**[MoFlo](https://github.com/eric-cielo/moflo)** is my attempt to fix that — a local-first orchestration toolkit that installs into your project and makes Claude Code stateful, faster to orient, and repeatable. No cloud, no API keys, no account. One install:

```bash
npm install --save-dev moflo
npx flo init
```

That's it. `flo init` wires up hooks, an MCP server, semantic indexing, and a `CLAUDE.md` section that teaches Claude how to use it. Next session, Claude opens with your project already searchable by *meaning*.

## What it actually does

**Semantic memory over your code.** MoFlo builds a searchable index of your codebase, tests, and guidance using a local `node:sqlite` + HNSW vector store and an in-tree embeddings runtime — nothing leaves your machine. Instead of Claude grepping around to rediscover where something lives, it queries memory first: "where is symbol X defined," "what tests cover Y," "what's our pattern for Z." The index is incremental — the first build takes a minute or two, every session after that only re-processes what changed.

**Learned model routing.** Not every step needs your most expensive model. MoFlo can route work across models based on the task, with per-agent overrides when you want to pin something (e.g. never downgrade security work). You keep the quality where it matters and stop burning tokens where it doesn't.

**Gates and hooks.** Lightweight checks that fire at the right moments — before edits, before spawning agents, at session start — to keep the agent on the rails your project cares about, without you re-explaining them every time.

**Spells.** Repeatable, composable workflows. Define a multi-step task once and cast it on demand, instead of re-typing the same prompt sequence and hoping it runs the same way twice.

**The `/flo` skill.** Point it at a GitHub issue and it analyzes and executes the work — the issue-to-PR loop as a single command.

**Swarm and hive-mind coordination.** When a task genuinely benefits from multiple agents, MoFlo has real coordination underneath — queen/worker hierarchies, consensus, shared memory — not just parallel prompts shouting past each other.

## Where it came from (and why it's opinionated)

MoFlo began as a fork of Claude Flow. That project is a broad, powerful, highly-configurable orchestration framework built to serve a huge range of scenarios — distributed systems, enterprise orchestration, research pipelines, and more. My use case was just one corner of that: day-to-day local coding on a single project. Every time I pulled in updates I found myself re-tailoring the same defaults for my setup.

So I narrowed the focus. I baked in the defaults I kept setting by hand, made indexing and memory automatic at session start, and tuned everything so that `npm install` and `flo init` gets you straight to coding with nothing to configure. Over time it grew its own architecture — a `node:sqlite` + HNSW memory layer, an in-tree embeddings runtime, a spell engine, daemon-driven scheduling — and the two projects fully diverged.

The trade is deliberate: MoFlo is *opinionated*. If you want maximum configurability, you'll want the broad frameworks. If you want a local-first setup that just works out of the box for real coding work, that's exactly the corner MoFlo is built for.

## Cross-platform and local by default

Everything runs on Linux, macOS, and Windows — that's a hard requirement, not an aspiration, and CI proves it on all three. And "local-first" is literal: your code, your embeddings, and your memory stay on your machine. There's no external service to sign up for and nothing phones home.

## Try it

```bash
npm install --save-dev moflo
npx flo init
# open Claude Code — it's already wired up
```

- **GitHub:** [github.com/eric-cielo/moflo](https://github.com/eric-cielo/moflo)
- **npm:** [npmjs.com/package/moflo](https://www.npmjs.com/package/moflo)

It's MIT-licensed and open to contributions — bug reports, docs, and code all welcome. If you try it, a GitHub star genuinely helps other people find it. And if you hit something rough, open an issue; I read all of them.

MoFlo is the setup I wish I'd had the day I started using Claude Code seriously. If that sounds like your situation too, give it a run — it takes about two minutes to find out.
