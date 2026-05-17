# MoFlo Memory Protocol — Pick Namespace, Query, Traverse

**Purpose:** How to use moflo's chunked memory effectively. Memory indexes far more than user-feedback narratives: per-directory symbol tables, test-to-source reverse indexes, RAG-chunked guidance docs, code patterns, and incident learnings. Querying the wrong namespace — or asking the wrong shape of question — wastes the gate-enforced first search. Pick the namespace, pivot on the symbol, read the similarity score, traverse via neighbors.

## Rule (MUST)

When a search hit carries a non-null `navigation` field, you MUST traverse via `mcp__moflo__memory_get_neighbors` — NOT bulk-retrieve every hit with `memory_retrieve`. The `navigation` crumb is the chunking architecture's contract; bulk-retrieving every search hit defeats it and is a protocol violation. Use `memory_retrieve` only for a single specific key you already hold, or for non-chunk entries where `navigation` is null.

---

## What's Actually in Each Namespace

The moflo index is large and dense. Sizing as of 2026-05-16 on the moflo repo (similar shape in any consumer project after first indexing pass):

| Namespace | Entries | What's indexed | Use for |
|-----------|---------|----------------|---------|
| `code-map` | ~1,400 | Per-directory symbol tables (`dir:src/cli/services` lists ~430 symbols → defining files), per-file type/function summaries | "where is X defined", "what's in directory Y", "what types live in file Z" |
| `guidance` | ~1,000 | RAG-chunked `.claude/guidance/**/*.md` — every chunk has nav crumbs (parent doc, prev/next/siblings) | Project rules, decision context, "how should I…" docs |
| `patterns` | ~970 | Per-file pattern entries, aggregate stats ("middleware: 16 occurrences"), narrative fix-patterns (`pattern:swarm-dir-recreation-fix-1168`) | "what's our pattern for X", recurring fix shapes, conventions |
| `tests` | ~850 | `test-file:` entries per test, plus `test-map:<production path>` reverse-index ("2 test files cover this") | "what tests cover module X", test inventory, coverage gaps |
| `learnings` | grows over time | Incident narratives keyed by issue/PR (`1145-daemon-port-collision-fix`) | Error → fix recall, "did we hit this before", post-mortems |

`code-map` and `tests` are auto-indexed from the source tree. `guidance` is auto-indexed from `.claude/guidance/**`. `patterns` mixes auto-mined heuristics with narratives stored via `memory_store`. `learnings` is curated — store with `mcp__moflo__memory_store` when you finish a non-trivial debug.

---

## Worked Examples — Real Queries Against the Live Store

Each example shows the query, namespace, top hit, similarity score, and why memory wins over the alternative.

### Example 1 — "Where is symbol X defined" → `code-map`

```
mcp__moflo__memory_search {
  query: "where is BashSafetyHook defined",
  namespace: "code-map"
}
```

Top hits:

```
file:src/cli/shared/hooks/safety/bash-safety.ts        similarity 0.86
dir:src/cli/shared/hooks/safety                        similarity 0.82
```

**Wins over Grep.** Grep returns every mention of the identifier across the tree; `code-map` returns the defining file plus the sibling-symbol context (the dir entry lists all 18 types in that directory) in one call.

### Example 2 — "Tests for module Y" → `tests`

```
mcp__moflo__memory_search {
  query: "tests for daemon port collision",
  namespace: "tests"
}
```

Top hits:

```
test-file:src/cli/__tests__/commands/daemon-port-resolution.test.ts   similarity 0.79
test-map:src/cli/commands/daemon                                       similarity 0.75
```

**Wins over Glob + Read.** The `test-map:` reverse-index answers "what tests cover this production path" directly — no need to Glob for filename matches and Read each candidate to confirm coverage.

### Example 3 — "Patterns for X" → `patterns`

```
mcp__moflo__memory_search {
  query: "vitest mocking patterns for middleware",
  namespace: "patterns"
}
```

Top hits:

```
pattern-import-module-e9oqfm        similarity 0.87
pattern-test-mocking-76mtme         similarity 0.81
pattern-api-middleware-q9gk50       similarity 0.78
```

**Competitive with Grep + multiple Reads.** Returns conceptual hits without needing to know file paths or naming conventions.

### Example 4 — "How does feature work" → `guidance`

```
mcp__moflo__memory_search {
  query: "how should subagents handle the memory search gate",
  namespace: "guidance"
}
```

Top hits — four chunks across four different docs, all 0.86+:

```
chunk-skill-eldar-2                                  (parent: doc-skill-eldar)
chunk-guidance-upgrade-contract-6                    (parent: doc-guidance-upgrade-contract)
chunk-guidance-memory-traversal-architecture-5       (parent: doc-guidance-memory-traversal-architecture)
chunk-guidance-moflo-subagents-0                     (parent: doc-guidance-moflo-subagents)
```

**Wins over Read.** Semantic recall across docs without knowing filenames. Each hit carries a `navigation` object — traverse to siblings/prev/next for adjacent context.

### Example 5 — "Did we hit this error before" → `learnings`

```
mcp__moflo__memory_search {
  query: "daemon port collision fix",
  namespace: "learnings"
}
```

Hits a curated incident narrative (e.g. `1145-daemon-port-collision-fix`) with the prior diagnosis + fix shape. **Wins over searching closed GitHub issues** — the narrative is the distilled fix, not the raw discussion.

---

## Querying Technique — Five Rules for High-Signal Searches

Five rules that turn ceremonial searches into high-signal ones. Each one fixes a real failure mode observed in long sessions.

| Rule | Why |
|------|-----|
| **Pivot on the symbol.** Include the bare identifier (`BashSafetyHook`, `findProjectRoot`) verbatim in the query | Embedding similarity is much higher on the literal token than on a natural-language paraphrase |
| **Always specify `namespace`** when you know the answer shape | Cross-namespace results dilute relevance — a `tests` query without namespace pulls noisy `code-map` and `patterns` hits |
| **Read the `similarity` score** | `≥ 0.80` is a confident hit; `0.60–0.79` is tangential; `< 0.60` is noise. Re-query with a sharper symbol/keyword rather than acting on weak hits |
| **Traverse, don't re-search** | When a chunk hit has `navigation`, use `mcp__moflo__memory_get_neighbors` for adjacent context — one round-trip, no re-embedding cost |
| **Don't bulk-retrieve search hits** | `memory_retrieve` is for one specific key you already hold. Calling it for every search hit defeats the chunking architecture |

### Query shape — do / don't

| Don't | Do |
|-------|-----|
| `memory_search { query: "where is the bash safety hook implemented in the project" }` | `memory_search { query: "BashSafetyHook", namespace: "code-map" }` |
| `memory_search { query: "find all tests for daemon stuff" }` | `memory_search { query: "daemon port collision", namespace: "tests" }` |
| `memory_search { query: "how do I do mocks" }` (no namespace, vague) | `memory_search { query: "vitest mocking middleware", namespace: "patterns" }` |
| `memory_retrieve` on each of 5 search hits | `memory_get_neighbors { key: <best hit>, include: ['prev','next','siblings'] }` |

---

## Tool Selection — Memory API

Once you have a search hit, pick the right follow-up call by what you need next. Bulk-retrieving every search hit is a protocol violation; the table below maps each follow-up shape to its single correct tool.

| You want | Use | Why |
|----------|-----|-----|
| Find an entry-point | `mcp__moflo__memory_search` | Returns chunk hits with `navigation` (parentDoc, prev/next, chunkTitle) |
| Adjacent context (1 chunk over) | `mcp__moflo__memory_get_neighbors` `{ key, include: ['prev','next'] }` | One round-trip, shaped entries with full nav |
| Same-section peers (h2/h3 family) | `memory_get_neighbors` `{ include: ['siblings'] }` or `['parent','children']` | Hierarchical traversal — cheaper than re-searching |
| Full content of one specific chunk | `mcp__moflo__memory_retrieve` `{ key }` | For a key you already hold — never for bulk-retrieving search hits |
| Whole source doc when truly needed | `Read` `parentPath` from any chunk's nav | Disk read is cheaper than re-indexed `doc-*` |

---

## Tool Selection — Memory vs. Filesystem Tools

Pick memory when the question is about indexed knowledge (symbols, tests, patterns, docs, incidents); pick filesystem/git when the question is about *current authoritative state* the index can't guarantee fresher than disk.

| Question shape | First call |
|----------------|-----------|
| "Where is symbol X defined" | `memory_search` namespace `code-map` (pivot on bare symbol) |
| "What tests cover module Y" | `memory_search` namespace `tests` |
| "What's our pattern for Z" | `memory_search` namespace `patterns` |
| "How / why / project rule for W" | `memory_search` namespace `guidance` |
| "Did we hit error V before" | `memory_search` namespace `learnings` |
| "Find files matching glob `**/*.test.ts`" | `Glob` — file-system metadata, not indexed content |
| "What's in the working tree right now / what did I just edit" | `Read` — memory is a snapshot, working-tree is authoritative |
| "What's in this commit / git history" | `git log` / `git diff` |

The first five rows pivot through memory because the index already knows the answer. The last three pivot through filesystem/git because they ask about *current authoritative state*, which memory cannot guarantee fresher than disk.

---

## Anti-Patterns — Common Memory Query Mistakes

These six failure modes account for almost every "memory returned noise" complaint. Each row pairs the antipattern with the corrective shape from the cheat sheet above.

| Don't | Do instead |
|-------|-----------|
| Search memory without a namespace, get noise, fall back to Grep | Specify the namespace that matches the question shape (table above) |
| Retrieve every search hit blindly | Traverse via `memory_get_neighbors` when `navigation` is present — bulk `memory_retrieve` per hit is a protocol violation |
| Open the source file when a chunk would do | Stay in the chunk graph; `Read` `parentPath` only for the rare full-doc case |
| Search again for a key you already have | `memory_retrieve` or `memory_get_neighbors` directly |
| Phrase queries as natural-language questions | Pivot on the bare symbol or keyword — embedding similarity is higher on the literal token |
| Act on a hit with similarity < 0.6 | Re-query with a sharper symbol/keyword; weak hits are noise, not signal |

---

## See Also

- `.claude/guidance/moflo-agent-rules.md` § Memory-First Protocol — gate enforcement, namespace selection rules
- `.claude/guidance/moflo-memory-strategy.md` — How chunking, embeddings, and the RAG index work under the hood
- `.claude/guidance/moflo-memorydb-maintenance.md` — How the underlying memory DB is kept healthy (indexing, vacuum, integrity)
