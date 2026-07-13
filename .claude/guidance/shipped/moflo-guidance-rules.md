# Guidance Rules — Writing Guidance Claude Will Actually Follow

**Purpose:** The universal rules for writing `.claude/guidance/**/*.md` documents that Claude parses, follows, and indexes most effectively. Reference this whenever you create or revise a guidance file in your project. The rules below are the same ones moflo follows for its own shipped guidance.

---

## 1. Structure for Scanability

Claude processes guidance as part of a large context window alongside code, tool results, and conversation history. Guidance competes for attention.

- **Lead with a `**Purpose:**` line** immediately after the H1. One sentence stating what this doc is for and when to use it. This is the single most important line — it determines whether Claude keeps reading or skips.
- **Use H2 sections as entry points.** Claude may land in the middle of a doc via RAG chunk retrieval. Each H2 should be independently understandable without reading prior sections.
- **Front-load the actionable rule, then explain.** Put the instruction first, rationale second. Claude acts on instructions; it uses rationale to resolve ambiguity.

```markdown
## Good
**Always search memory before Glob/Grep.** It returns domain-aware semantic matches
from a prebuilt index that Glob cannot — one lookup, not a fresh filesystem scan.

## Bad
Memory search uses HNSW indexing with domain-aware embeddings that provide much better
results than file-system search tools. Because of this, you should search memory first.
```

---

## 2. Be Imperative, Not Descriptive

Claude follows instructions better than it infers behavior from descriptions. Write rules as direct commands.

| Pattern | Example |
|---------|---------|
| Imperative (preferred) | **Use `mcp__moflo__memory_search` before Glob/Grep** |
| Descriptive (weaker) | The memory search tool can be used to find guidance |
| Passive (weakest) | Memory should be searched before file exploration |

---

## 3. Use Tables for Decision Logic

When guidance involves conditional behavior (if X then Y), tables are parsed faster and more reliably than prose or nested bullet lists.

```markdown
| Condition | Action |
|-----------|--------|
| Background agent | TaskCreate required |
| 2+ parallel agents | TaskCreate for each |
| Single foreground, simple task | Skip TaskCreate |
```

Avoid encoding decision trees in paragraph form. Claude frequently drops branches from prose-encoded conditionals.

---

## 4. Code Examples Must Be Concrete

Abstract examples get ignored. Concrete examples with realistic values get followed.

```markdown
## Good
TaskCreate({
  subject: "🔍 Investigate failing booking tests",
  activeForm: "🔍 Investigating test failures"
})

## Bad
TaskCreate({
  subject: "[icon] [description of task]",
  activeForm: "[icon] [present participle of task]"
})
```

---

## 5. Keep Files Under 500 Lines

**The 500-line cap applies to every `.claude/guidance/**/*.md` file AND every `.claude/skills/*/SKILL.md` entry file AND every `.claude/agents/**/*.md` entry file.** The same RAG/attention math applies to all three:

- RAG chunking splits long files, and chunks lose cross-section context
- Claude deprioritizes content deep in a long document
- Competing chunks from the same file dilute search relevance
- For SKILL.md and agent .md, the **entire file is loaded into context on every invocation** (or on every `Agent({subagent_type})` spawn) — every extra line is a per-invocation token cost across all consumers

If a doc exceeds 500 lines, split by concern. Two patterns:

| Pattern | Where it fits | Example |
|---------|---------------|---------|
| **Sibling files** (guidance) | Topical split — each file owns one concern | `moflo-spell-engine.md` + `moflo-spell-runner.md` + `moflo-spell-troubleshooting.md` |
| **Progressive disclosure** (skills, agents) | Entry SKILL.md or agent .md links to companions in the same directory | `spell-builder/SKILL.md` (entry) + `architecture.md` + `permissions.md` + `preflight.md` (companions); `agents/<cat>/<name>.md` (entry, has frontmatter) + `<name>-protocols.md` (companion, no frontmatter) |

Companion files are NOT auto-loaded — Claude reads them only when the entry directs it to. This keeps the per-invocation cost low while preserving the depth.

A gating test (`skill-and-guidance-size-drift.test.ts`) enforces the cap and will fail CI if a guidance doc, SKILL.md entry, or agent entry exceeds 500 lines. Companion files (agent .md without YAML frontmatter, or any .md inside a skill directory other than SKILL.md) are exempt because they only load on demand.

---

## 6. Headings Must Be Specific

RAG retrieval uses heading text as the primary signal for chunk relevance. Generic headings produce poor search results.

| Generic (bad) | Specific (good) |
|---------------|----------------|
| Overview | Architecture: Two-Layer Task + Swarm Model |
| Configuration | Anti-Drift Swarm Configuration |
| Examples | Non-Swarm TaskCreate Examples |
| Rules | Pull Request Target Repo Rules |

---

## 7. Anti-Patterns in Guidance

| Anti-pattern | Why it fails | Fix |
|-------------|-------------|-----|
| Repeating the same rule in multiple files | Claude encounters conflicting phrasings and picks arbitrarily | Single source of truth, cross-reference via See Also |
| Long preambles before the first rule | Claude may stop reading before reaching actionable content | Purpose line, then rules, then explanation |
| Embedding rules inside code comments | RAG indexes headings and prose, not code comments | State the rule in prose, then show the code |
| Using "should" / "consider" / "might want to" | Hedged language gets deprioritized vs. firm instructions | Use "must" / "always" / "never" for critical rules |
| Documenting what Claude already knows | Wastes context window and dilutes novel instructions | Only document project-specific rules and non-obvious constraints |

---

## 8. Optimize for RAG Chunking

Guidance files are chunked by heading boundaries and indexed with embeddings for semantic search. To maximize retrieval quality:

- **Every H2 section should have a self-contained opening sentence** summarizing the section's purpose. This becomes the chunk's embedding anchor.
- **Keep sections between 5–30 lines.** Shorter than 5 lines lacks context for useful embeddings. Longer than 30 lines gets truncated or split mid-thought.
- **Avoid orphan content** — text between the H1 and first H2 that isn't under any heading. It gets chunked with minimal heading context, producing poor embeddings.
- **Use `---` horizontal rules between major sections.** These are chunk boundary hints.

---

## 9. See Also Sections

End every guidance file with a `## See Also` section linking related docs. This helps Claude navigate between related concerns and helps RAG link related chunks.

```markdown
## See Also

- `.claude/guidance/<other-doc>.md` — One-line description of why this is related
- `.claude/guidance/<other-doc>.md` — Use Title Case "See Also" (not "See also")
```

Use relative names (not absolute paths) so the links work across project contexts.

---

## See Also

- `.claude/guidance/moflo-memory-strategy.md` — Companion rules on namespaces, RAG indexing, and search patterns the data feeds
- `.claude/guidance/moflo-task-icons.md` — UX rule for `TaskCreate` and `Agent` description fields (ICON + [Role])
- `.claude/guidance/moflo-user-facing-language.md` — How to phrase any text shown to end users (plain risk-level language, no jargon)
- `.claude/guidance/moflo-subagents.md` — Memory-first protocol any guidance you write should reinforce
- `.claude/skills/guidance/SKILL.md` — `/guidance` skill that helps you author or audit guidance against these rules
