# Writing Better Docs for Claude (and Humans) with MoFlo

**Purpose:** Show how MoFlo's `/guidance` skill helps you write project documentation that Claude actually uses well, how the same tool produces clean human-facing docs with `-h` and `--html`, and how `/eldar` ties it all together into a holistic audit of how Claude experiences your project.

---

## The premise: Claude is only as good as its context

If you've spent any time pairing with Claude on a real codebase, you've noticed something. Claude is extraordinarily capable at *general* software engineering. But the moment the work touches something *specific* about your project — your conventions, your gotchas, your "we tried that once and it bit us" history — capability stops mattering. Context starts mattering.

A senior engineer joining your team reads the README, skims the architecture docs, asks a teammate "what's the convention for X?", and absorbs the institutional memory before they touch a line of code. Claude can't do that on its own. It walks in cold every session. If your project doesn't have written-down conventions in a place Claude can find, Claude will either guess (sometimes well, often not) or do the generic thing (which is rarely what *you* want).

MoFlo's `/guidance` skill exists to make writing that context cheap, structured, and consistent. Not because writing docs is hard — it isn't — but because writing docs *that Claude reads efficiently* has a different shape than writing docs for humans, and most of us don't naturally produce that shape on the first pass.

---

## What "good for Claude" actually means

Claude reads your guidance docs in two different ways, and both reward a particular structure:

1. **Direct inclusion** — your top-level `CLAUDE.md` and any docs it links to land in Claude's context window at the start of every session.
2. **RAG retrieval** — MoFlo indexes everything in `.claude/guidance/` into a semantic search index. When Claude needs context mid-task, it queries that index and gets back the most relevant *chunks* — sections of your docs, not whole files.

The retrieval mode is the one that surprises people. Claude isn't reading your 400-line `database-conventions.md` end-to-end every time it writes a query. It's pulling the most relevant H2 section based on a similarity search. Which means your `## Migration patterns` section needs to *stand alone* — if a reader (human or otherwise) lands on that section with no preamble, it should still be useful.

That's why `/guidance` enforces things like:

- **One H1, then a `**Purpose:**` line.** A future chunk that pulls in the H1 area has immediate context.
- **Specific H2 headings.** `## Migration patterns` is searchable; `## Examples` isn't.
- **Imperative voice for rules.** "Always use `path.join` for cross-platform paths" retrieves better than "you should probably consider using path.join".
- **Tables for decision logic.** Conditional rules in a table compress better than nested bullets.
- **A `## See Also` section.** Bidirectional links so Claude can traverse to related guidance instead of guessing.
- **Under 500 lines.** Long docs chunk worse and overwhelm the context window.

These aren't arbitrary rules. They're the difference between Claude finding your convention and Claude inventing one.

---

## The `/guidance` skill — one shape, three audiences

Run `/guidance <topic>` and the skill walks you through writing a doc to Claude's preferred shape: scaffold first, then 2-4 targeted questions to populate the body with *your* conventions (not generic opinions). It checks the file against the universal rules before saving. Default destination is `.claude/guidance/<topic>.md`.

That's the Claude path. But the skill knows that not every doc is for Claude. Two flags switch the audience:

### `-h` — write for humans

Pass `-h` and the skill switches to a lighter ruleset designed for human readers and writes to `docs/<topic>.md` instead.

| Rule | For Claude | For Humans |
|------|-----------|------------|
| `**Purpose:**` line after H1 | Required | Kept — orients any reader fast |
| Imperative voice (must/always/never) | Required | Dropped — narrative prose is fine |
| Tables for decision logic | Required | Kept where applicable |
| Concrete examples (no `[placeholder]`) | Required | Kept — always |
| Under 500 lines | Required | Kept |
| Specific H2 headings | Required | Kept |
| RAG-friendly chunking | Required | Dropped — humans don't query a vector index |
| `## See Also` | Required | Kept — humans like to traverse too |

The result reads more like a normal technical doc — a short prose preamble before the first rule is fine, hedged language is fine, you don't have to bark "MUST" at the reader. But it still has the bones that make it scannable.

### `--html` — emit standalone HTML

Pass `--html` (composable with `-h`) and the skill renders the doc to HTML with a minimal default stylesheet baked in. No external CSS, no JS, no web fonts — just clean light/dark-aware typography that works in any browser. Good for publishing to a static site, sharing a single file with a stakeholder, or dropping into a wiki that accepts raw HTML.

The skill authors the Markdown first, shows it to you for sign-off, *then* renders to HTML. Iterating on the Markdown is cheaper than iterating on markup.

The combination is genuinely useful: one tool, one ruleset family, three outputs depending on who's reading.

---

## Audit existing docs — `/guidance -a`

Writing new docs is one half of the job. The other half is the docs you already have — the ones that have drifted, the ones with `## Overview` headings, the ones missing a Purpose line, the ones over 800 lines because nobody split them.

`/guidance -a` is a two-pass audit:

**Pass 1 — Structural conformance.** Score every `.md` under `.claude/guidance/` against the universal rules. Render a sortable table: file, lines, has-purpose, has-see-also, generic-headings count, hedged-language count. The worst offenders surface first.

**Pass 2 — Gap analysis.** Look at what *isn't* there. Read `package.json` (and `pyproject.toml`, `Cargo.toml`, `go.mod`, whatever you have), scan the source layout, check for MCP tools and hooks, look at recent git activity. Cross-reference against your existing guidance. If your project uses Drizzle ORM in 30 files and you have no `database-conventions.md`, that's a high-leverage gap — Claude is winging it every time it touches your data layer.

The audit doesn't write anything. It surfaces the top 3-5 priority items across both passes, explains *why* (rule citation for structural; concern + evidence for gaps), and proposes the fix. You confirm per-file before any change. Guidance is high-leverage; silent edits are dangerous.

---

## Where `/eldar` comes in

Even with great guidance docs, there's a broader question: **is Claude set up to find them at all?**

You can write the world's best `database-conventions.md`, but if your `CLAUDE.md` doesn't reference it, the MoFlo daemon isn't running, the memory index is empty, or the session-start hook never fires, Claude has no idea it exists. The doc is invisible.

`/eldar` is the holistic audit — the Eldar consult on whether your *entire* moflo + Claude Code setup is configured to give Claude the best shot. It's read-only by default; pass `--fix` and it walks you through remediation interactively.

What it checks:

- **Setup health.** Calls `flo healer` (the alias for `flo doctor`) and surfaces every failure or warning.
- **Index freshness.** Is `.moflo/moflo.db` present? Are the guidance and code-map namespaces populated? An empty guidance namespace means semantic search is degraded — Claude can't *find* your docs even if you wrote them.
- **Version skew.** Are you behind on `moflo`? Several minor versions of drift means missing fixes you don't know about.
- **CLAUDE.md.** Does it exist? Is it the right shape? Do the relative paths it cites actually resolve?
- **Guidance content.** How many docs do you have? Zero is a warning. One or two is sparse.
- **Guidance structure.** This is the key tie-in: `/eldar` invokes `/guidance -a` *inline*, during the audit, and folds the structural + gap findings into its own report. Single source of truth — `/guidance` owns the writing rules, `/eldar` surfaces them in the broader context.
- **Memory health.** Are your `guidance`, `patterns`, and `learnings` namespaces populated? An empty `learnings` namespace is fine for new projects; an empty `guidance` namespace means RAG isn't going to help Claude.
- **Hooks & MCP wiring.** Is the session-start hook configured? Is the MoFlo MCP server in `.claude/settings.json`? Without these, every other piece of MoFlo is dark.
- **Spell inventory and subagent fleet.** Have you registered any spells or project-specific subagents, or are you relying entirely on built-ins?

The output is a single ranked table with severities (`error` → `warn` → `info`) and a top-3 recommendations list with rationale. Pass `--fix` and you get an interactive triage menu: pick which findings to address, and the Eldar walks you through each — scaffolding CLAUDE.md, handing off to `/guidance` for any new docs, running `flo healer --fix`, seeding empty namespaces.

The neat part is the handoff to `/guidance`. When `/eldar` finds you're missing a guidance doc for Drizzle, it doesn't reimplement doc-writing logic — it routes you into `/guidance`, which already knows the rules, the audience-switching flags, and the question-driven scaffolding flow. One source of truth for "how do I write a good doc"; one source of truth for "is my project set up well". They compose.

---

## How they fit together

The pattern is the same one MoFlo uses everywhere: focused tools that compose.

```
/guidance <topic>          → write one doc for Claude
/guidance -h <topic>       → write one doc for humans (docs/)
/guidance -h --html <topic> → write one doc for humans, as HTML
/guidance -a               → audit all guidance for structure + gaps
/eldar                     → audit the whole moflo + Claude Code setup
/eldar --fix               → audit + interactive fix walk-through
```

You don't need to remember which tool does which check. You start at the level that matches what you're doing:

- **New project, Claude feels lost?** `/eldar` — see the full picture.
- **Know you need a doc on X?** `/guidance <X>`.
- **Existing docs feel rotten?** `/guidance -a`.
- **Need to publish something for non-Claude readers?** `/guidance -h` or `/guidance -h --html`.

Each one knows when to hand off to another. The Eldar invoke `/guidance -a` inline. `/guidance -a` proposes new docs and routes you to single-doc mode to write them. Single-doc mode knows the universal rules so the audit doesn't catch a doc you just wrote.

---

## Why this matters

Documentation is the lowest-cost, highest-leverage way to make Claude better at *your* project. Models keep getting better at general code. They will never, on their own, get better at *your* conventions — that information lives in your head, your wiki, your Slack channel, your PR review comments. Until it's written down somewhere Claude can find, every session pays the cost of you re-explaining it.

MoFlo's `/guidance` and `/eldar` skills exist to make that writing easy enough that you'll actually do it. Not because the skills do the writing for you — they don't, and they explicitly refuse to auto-write opinionated content into your project — but because they handle the *shape*. They ask you the right questions. They check the result against rules that make Claude's retrieval work. They surface what you're missing.

Write the docs. Audit them. Audit the whole setup. Then watch Claude stop guessing.

---

## See Also

- `.claude/skills/guidance/SKILL.md` — Full `/guidance` reference, including all flags and the audit two-pass
- `.claude/skills/eldar/SKILL.md` — Full `/eldar` reference, audit checklist and fix flow
- `.claude/guidance/moflo-guidance-rules.md` — The universal writing rules `/guidance` enforces
- `.claude/guidance/moflo-memory-strategy.md` — How well-written guidance feeds the RAG index
