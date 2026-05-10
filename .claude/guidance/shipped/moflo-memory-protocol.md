# MoFlo Memory Protocol — Search, Traverse, Retrieve

**Purpose:** How to use moflo's chunked memory effectively. Search returns navigable chunks — traverse the chunk graph, do not bulk-retrieve every hit.

---

## Decision Table

| You want | Use | Why |
|----------|-----|-----|
| Find an entry-point | `mcp__moflo__memory_search` | Returns chunk hits with compact `navigation` (parentDoc, prev/next, chunkTitle) |
| Adjacent context (1 chunk over) | `mcp__moflo__memory_get_neighbors` `{ key, include: ['prev','next'] }` | One round-trip, returns shaped entries with full nav |
| Same-section peers (h2/h3 family) | `memory_get_neighbors` `{ include: ['siblings'] }` or `['parent','children']` | Hierarchical traversal — cheaper than re-searching |
| Full content of one chunk | `mcp__moflo__memory_retrieve` `{ key }` | Returns full nav object for further traversal |
| Whole source doc when truly needed | `Read` `parentPath` from any chunk's nav | Disk read is cheaper than re-indexed `doc-*` |

## Anti-Patterns

| Don't | Do instead |
|-------|-----------|
| Retrieve every search hit blindly | Read the search snippet + `navigation`; retrieve or traverse only the chunks you need |
| Open the source file when a chunk would do | Stay in the chunk graph; `Read` `parentPath` only for the rare full-doc case |
| Search again for a key you already have | `memory_retrieve` or `memory_get_neighbors` directly |

---

## See Also

- `.claude/guidance/moflo-agent-rules.md` § Memory-First Protocol — namespaces, query examples, MCP-first tool selection
- `.claude/guidance/moflo-memory-strategy.md` — How chunking, embeddings, and the RAG index work
