# Guidance Rules — Writing Effective Guidance for Claude

**Purpose:** Rules for writing `.claude/guidance/` documents that Claude parses, follows, and indexes most effectively. Reference this document whenever you are asked to create or revise guidance.

---

## 1. Structure for Scanability

Claude processes guidance as part of a large context window alongside code, tool results, and conversation history. Guidance competes for attention.

- **Lead with a `**Purpose:**` line** immediately after the H1. One sentence stating what this doc is for and when to use it. This is the single most important line — it determines whether Claude keeps reading or skips.
- **Use H2 sections as entry points.** Claude may land in the middle of a doc via RAG chunk retrieval. Each H2 should be independently understandable without reading prior sections.
- **Front-load the actionable rule, then explain.** Put the instruction first, rationale second. Claude acts on instructions; it uses rationale to resolve ambiguity.

```markdown
## Good
**Always search memory before Glob/Grep.** Memory search is 150x faster and returns
domain-aware results that Glob cannot provide.

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

Long guidance files lose effectiveness because:
- RAG chunking splits them, and chunks lose cross-section context
- Claude deprioritizes content deep in a long document
- Competing chunks from the same file dilute search relevance

If a doc exceeds 500 lines, split by concern into separate files. Each file should cover one topic thoroughly rather than many topics shallowly.

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
- **Keep sections between 5-30 lines.** Shorter than 5 lines lacks context for useful embeddings. Longer than 30 lines gets truncated or split mid-thought.
- **Avoid orphan content** — text between the H1 and first H2 that isn't under any heading. It gets chunked with minimal heading context, producing poor embeddings.
- **Use `---` horizontal rules between major sections.** These are chunk boundary hints.

---

## 9. See Also Sections

End every guidance file with a `## See Also` section linking related docs. This helps Claude navigate between related concerns and helps RAG link related chunks.

```markdown
## See Also

- `.claude/guidance/moflo-subagents.md` — Subagents protocol
- `.claude/guidance/moflo-claude-swarm-cohesion.md` — Task & swarm coordination
- `.claude/guidance/moflo-core-guidance.md` — Full CLI/MCP reference
```

Use relative names (not absolute paths) so the links work across project contexts.

---

## 10. Shipped Guidance File Naming

**All shipped guidance files in `.claude/guidance/shipped/` MUST begin with the `moflo-` prefix** (e.g., `moflo-subagents.md`, `moflo-memory-strategy.md`). This prevents name collisions when these files are synced into a consumer project's `.claude/guidance/` directory, where the project may have its own guidance files with generic names like `subagents.md` or `memory-strategy.md`.

The prefix is applied statically at the source — the sync process copies files as-is without modifying names.

---

## 11. Ship-vs-Local Partitioning Contract

**Three buckets, one ship boundary.** `package.json` `files` includes only `.claude/guidance/shipped/**`; everything else stays local.

| Path | Tracked? | Ships? | Purpose |
|------|----------|--------|---------|
| `.claude/guidance/shipped/moflo-*.md` | yes | yes | Consumer-facing rules (CLI, swarm, memory, spells, sandboxing, icons, language, etc.) |
| `.claude/guidance/internal/*.md` | yes | no | Dev-only (this file, dogfooding, testing, coding-style, upgrade-contract) |
| `.claude/guidance/*.md` (top level) | no | no | Auto-generated mirror written by session-start launcher; consumers regenerate on install |

**Gitignore must target only the top-level mirror.** Use `/.claude/guidance/*.md` — a bare `.claude/guidance/` will silently swallow `shipped/` and `internal/` too, and the failure is invisible because `npm pack` ships from the working tree (not git), so a fresh CI clone publishes an incomplete `shipped/` set.

**CLAUDE.md cross-references should point to `shipped/` paths**, not the top-level mirror. The mirror only exists once session-start has run; `shipped/` is the durable source.

---

## See Also

- `.claude/guidance/internal/dogfooding.md` — The shipped-vs-internal partition this doc enforces, framed from the dogfood loop's perspective
- `.claude/guidance/internal/upgrade-contract.md` — Where the "user never re-runs init" invariant for guidance sync is defined
- `.claude/guidance/internal/coding-style.md` — Sibling style rules but for source code; both files share the imperative/concrete/specific posture
- `.claude/guidance/shipped/moflo-memory-strategy.md` — Companion shipped doc on writing guidance that indexes well for RAG (consumer audience)
- `.claude/guidance/shipped/moflo-session-start.md` — Where shipped guidance gets synced to consumer projects (and why the `moflo-` prefix matters there)
- `.claude/guidance/internal/guidance-sync.md` — Three-layer sync pipeline (filesystem → DB → HNSW); the chunking decisions in this doc shape Layer 2's behavior
