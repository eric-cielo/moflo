---
name: guidance
description: Add, edit, or audit guidance docs in this project's .claude/guidance/ directory following moflo's universal guidance rules. Default mode walks the user through one doc (creating or improving it); the -a flag audits every doc in the directory and offers per-file improvements.
arguments: "[-a] <topic-or-path>"
---

# /guidance — Author and audit project guidance

Help the user write, edit, or audit guidance files in their `.claude/guidance/` directory so Claude actually follows the rules they wrote. The skill applies the universal rules from `.claude/guidance/shipped/moflo-guidance-rules.md` — that doc is the single source of truth, do not paraphrase or duplicate it here.

**Arguments:** $ARGUMENTS

## Modes

| Mode | Trigger | What it does |
|------|---------|--------------|
| Single-doc | no flag, optional `<topic-or-path>` arg | Walk the user through creating one new doc OR improving one existing doc |
| Audit | `-a` flag | Scan every `.md` in `.claude/guidance/` (recursively), score each against the rules, present a triage report, then offer to fix per-file or in batch |

## Step 0 — Memory First

Before reading any files, run a memory search:

```
mcp__moflo__memory_search { query: "guidance rules writing project conventions", namespace: "guidance" }
```

This pulls the user's project-specific guidance conventions (if any) plus the moflo universal rules into context. The memory-first gate will block file reads otherwise.

## Step 1 — Pick the Mode and Target

Parse the argument:

| Input | Mode | Target |
|-------|------|--------|
| empty | single-doc | Ask the user for a topic; default destination is `.claude/guidance/<kebab-topic>.md` |
| `<topic>` (no slash) | single-doc | Use `.claude/guidance/<kebab-topic>.md`; if it exists, edit; else create |
| `<path>` (has `.claude/guidance/`) | single-doc | Edit that exact file; if it doesn't exist, create at that path |
| `-a` | audit | All `.md` files under `.claude/guidance/` recursively |
| `-a <subdir>` | audit | All `.md` files under `.claude/guidance/<subdir>/` recursively |

If single-doc and the file already exists, briefly summarize what it contains (one sentence) before walking the user through edits — confirm you have the right file.

## Step 2 — Single-Doc Mode

Apply the universal rules from `.claude/guidance/shipped/moflo-guidance-rules.md`. The rules cover (do not paraphrase — read the source):

1. Lead with `**Purpose:**` line after the H1
2. Be imperative, not descriptive
3. Use tables for decision logic
4. Code examples must be concrete
5. Keep files under 500 lines
6. Headings must be specific
7. Avoid the listed anti-patterns
8. Optimize for RAG chunking
9. End with a `## See Also` section

### Creating a new doc — scaffold this shape

```markdown
# <Specific Title — what this doc is and when to use>

**Purpose:** <one sentence on what this doc covers and when to reference it>

---

## <Specific H2 — first actionable rule or topic>

<Imperative rule, then rationale, then example.>

---

## <Specific H2 — second>

<Same shape.>

---

## See Also

- `.claude/guidance/<related-doc>.md` — One-line description of why related
- `.claude/guidance/<another>.md` — One-line description
```

After scaffolding, ask the user 2–4 targeted questions to populate the body — never auto-write opinionated content into the user's project. Their guidance must reflect their conventions, not Claude's.

### Editing an existing doc — checklist before proposing changes

For the loaded file, evaluate against the universal rules and report findings as a short table BEFORE editing:

| Check | Status |
|-------|--------|
| Has `**Purpose:**` line right after H1 | yes / no |
| Has `## See Also` section at end | yes / no |
| Under 500 lines | <count> lines |
| H2 headings are specific (not "Overview", "Configuration", "Examples") | list any generic ones |
| Uses imperative voice for rules ("must"/"always"/"never") not hedged ("should"/"might"/"consider") | list hedged phrases found |
| Has prose preamble before first rule | yes / no |

Then propose edits as concrete diffs — never rewrite the whole file unless the user asks.

## Step 3 — Audit Mode (`-a`)

When `-a` is passed, scan the guidance directory and produce a triage report. Walk the directory yourself with `Glob` and `Read`; do not delegate to a subagent for the audit itself unless the user has 30+ files.

For each `.md` file:

1. Count lines (`wc -l` via Bash, or read + split)
2. Check for `**Purpose:**` line right after H1
3. Check for `## See Also` (Title Case, capital A) at end
4. Look for generic headings: `^## (Overview|Configuration|Examples|Rules|Notes|Details|Information)$`
5. Look for hedged language: `\b(should|might|consider|may want to)\b` in rule contexts
6. Detect prose preambles (>3 paragraphs between H1 and first H2 rule)

Render the report as a sortable table with one row per file, columns: file, lines, has-purpose, has-see-also, generic-headings count, hedged count. Highlight the worst offenders first.

After the table, list the **top 3–5 priority fixes** in plain English (not table format). For each, explain WHY (rule citation) and propose either a per-file fix or a batch fix.

Ask the user which to apply, then walk through the chosen fixes one at a time. **Never apply audit fixes without explicit per-file confirmation** — guidance is high-leverage; silent edits are dangerous.

## Step 4 — After Editing

Once the user confirms the doc looks right:

1. Save the file via `Write` (new) or `Edit` (existing).
2. If you added a new doc, ask the user which existing doc should link to it via See Also (rule #9 needs bidirectional links to work).
3. Suggest re-indexing if the user runs moflo: `node bin/index-guidance.mjs` (or just wait for next session-start auto-reindex).

## Cheatsheet — Universal Rules Recap

The full rules live in `.claude/guidance/shipped/moflo-guidance-rules.md`. Quick recap:

| # | Rule | One-line |
|---|------|----------|
| 1 | Structure for scanability | Purpose line + specific H2s + rule-first ordering |
| 2 | Imperative voice | "Must" / "always" / "never", not "should" / "might" |
| 3 | Tables for decisions | Conditional logic in tables, not nested bullets |
| 4 | Concrete examples | Realistic values, not `[placeholder]` |
| 5 | <500 lines | Split by concern when over |
| 6 | Specific headings | Not "Overview" / "Configuration" |
| 7 | Anti-patterns | Single source of truth, no preambles, prose for rules (not code comments) |
| 8 | RAG chunking | 5–30 lines per H2, self-contained openings, `---` between sections |
| 9 | See Also | Title Case, end of every file, relative paths |

## Important

- **Memory-first is mandatory.** Always run `mcp__moflo__memory_search` in step 0 — the gate blocks reads otherwise.
- **Never duplicate the rules in this skill.** Reference `.claude/guidance/shipped/moflo-guidance-rules.md` and ask the user to read it if they want depth.
- **Never auto-write opinionated content.** Guidance is the user's project policy; ask before injecting your own opinions.
- **Confirm per file in audit mode.** Bulk edits to the user's guidance directory are high-blast-radius — confirm each one.
- **The `moflo-` filename prefix is moflo-only.** Consumer projects writing their own guidance do not need it; it exists to avoid collisions when moflo's shipped guidance syncs into a consumer's directory.

## See Also

- `.claude/guidance/shipped/moflo-guidance-rules.md` — Universal writing rules this skill enforces
- `.claude/guidance/shipped/moflo-memory-strategy.md` — How well-written guidance feeds the RAG index
- `.claude/guidance/shipped/moflo-task-icons.md` — UX rule the skill checks for any TaskCreate examples in the user's guidance
- `.claude/guidance/shipped/moflo-user-facing-language.md` — Companion rule for any user-visible text the user's guidance discusses
