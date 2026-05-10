# Memory Traversal Architecture

**Purpose:** Design rationale and touchpoint map for moflo's chunk-traversal protocol. Audience: moflo maintainers changing any of the 6 touchpoints (`subagent-bootstrap.json`, `moflo-agent-rules.md`, `moflo-subagents.md`, `claudemd-generator.ts`, `gate.cjs`, MCP tool descriptions). Source of truth for the protocol itself is `shipped/moflo-memory-protocol.md`. Tracking issue: #1053.

---

## 1. Problem Statement

The chunker (`bin/index-guidance.mjs:611-622`) computes 8+ navigation fields per chunk (`parentDoc`, `parentPath`, `prevChunk`, `nextChunk`, `siblings`, `hierarchicalParent`, `hierarchicalChildren`, `chunkIndex`, `totalChunks`). Pre-#1053:

- Neither `memory_search` nor `memory_retrieve` returned any of those fields.
- No traversal MCP tool existed.
- No shipped guidance taught Claude to traverse vs retrieve.
- `[Context from previous/next section:]` preambles in every chunk were a workaround for missing traversal.
- `doc-*` whole-document entries duplicated chunk semantic territory with zero production readers.

Result: search returned a 60-char snippet, Claude immediately retrieved the whole chunk because there was no way to navigate. The chunking architecture was decorative.

---

## 2. The 6-Touchpoint Topology

Effectiveness over deduplication. Each touchpoint carries the level of detail it can carry; canonical source is `shipped/moflo-memory-protocol.md`.

| # | Touchpoint | File | Audience | Payload |
|---|------------|------|----------|---------|
| 1 | Bootstrap directive | `.claude/helpers/subagent-bootstrap.json` | Every spawned subagent (verbatim via SubagentStart hook) | One sentence appended to existing directive |
| 2 | Universal agent rules | `.claude/guidance/shipped/moflo-agent-rules.md` | Both main agent and subagents (cited from CLAUDE.md and from subagents protocol Step 2) | One subsection, ≤10 lines, points to canonical doc |
| 3 | Subagents protocol | `.claude/guidance/shipped/moflo-subagents.md` | Subagents reading bootstrap chain | One Step, ≤8 lines |
| 4 | CLAUDE.md inline injection | `src/cli/init/claudemd-generator.ts` | Main agent on session start | Compact decision table inline |
| 5 | Gate hook messages | `.claude/helpers/gate.cjs:310, 379, 389` | Any agent that hits memory-search-first gate | One-line crumb appended to each existing message |
| 6 | MCP tool descriptions | `src/cli/mcp-tools/memory-tools.ts` | Schema-only callers | One phrase per `description` field |

**Canonical doc:** `.claude/guidance/shipped/moflo-memory-protocol.md` — hard cap 40 lines, Claude-targeted, decision-table-driven.

---

## 3. Verified Shipping Path for Touchpoint #1

`subagent-bootstrap.json` is the highest-leverage touchpoint per byte. Verified shipping:

| Stage | Mechanism | File:line |
|-------|-----------|-----------|
| Postinstall sync | Listed in `SOURCE_HELPER_FILES` | `scripts/post-install-bootstrap.mjs:86` |
| Session-start re-sync | Re-copied on every session start | `bin/session-start-launcher.mjs:674` |
| Hook handler | Reads JSON, falls back to inline literal if missing | `.claude/helpers/subagent-start.cjs` |
| Settings wiring | `SubagentStart` hook auto-injected on `flo init` | `src/cli/init/settings-generator.ts:367-377` |
| Drift parity test | Asserts JSON and inline fallback stay aligned | `tests/bin/subagent-start.test.ts` |

When changing the directive, update **both** `subagent-bootstrap.json` and the `FALLBACK_DIRECTIVE` literal in `subagent-start.cjs` — the parity test enforces this.

---

## 4. Story Dependency Graph

```
S1 (surface RAG metadata) ──┬──> S3 (6-touchpoint protocol wiring) ──┬──> S5 (drop preambles)
                            │                                         │
S2 (memory_get_neighbors) ──┘                                         │
                                                                      │
S4 (retire doc-*) ────────────────────────────────────────────────────┤
                                                                      │
                                                                      └──> S6 (cosmetic trims, last)
```

S1+S2 must land first — protocol references API that must exist. S3 lands once API surface is stable. S4 and S5 can land independently after S3 because they remove workarounds the protocol replaces.

---

## 5. Why These Tradeoffs

| Decision | Why |
|----------|-----|
| 6 touchpoints, not 1 | Single-channel injection is fragile — a subagent that doesn't load CLAUDE.md never sees the protocol. Six channels covers main agent, schema-only callers, gate-blocked callers, and bootstrap-injected subagents. |
| Canonical doc capped at 40 lines | Bloat is a defect. Claude-targeted; humans don't read this. Decision tables compress better than prose. |
| Subagent prompts (`src/cli/agents/*.yaml`) NOT updated | Established channel is the bootstrap → subagents.md → agent-rules.md chain. YAML changes would duplicate without adding reach (subagents already inherit via the chain). |
| Gate messages include crumb | The gate is the only mechanism that can interrupt mid-action. Catching agents about to retrieve when they should traverse is the highest-leverage nudge. |
| `doc-*` entries deleted (S4) | Audit found zero production readers. They duplicated chunk semantic territory and were ~13% of search noise. Storage savings minor; relevance signal improvement matters more. |
| Inline-context preambles dropped (S5) | They were a workaround for missing traversal. Once traversal is wired, they're redundant — and contribute ~25-30% bloat per chunk. |
| Search truncation (60 chars) NOT lifted | Search is for entry-point discovery, not content delivery. Lifting it defeats the chunking architecture and inflates per-call cost ~16x without proportionate utility. |

---

## 6. When to Update This Doc

- A new touchpoint added (or removed) → update §2 table and §4 dependency graph.
- The canonical doc's location or size cap changes → update §2 last paragraph and §5 row 2.
- Subagent-bootstrap shipping path changes → update §3 table.
- A new story added to the epic that affects topology → update §4 graph.

---

## See Also

- `.claude/guidance/shipped/moflo-memory-protocol.md` — Canonical Claude-facing protocol (≤40 lines)
- `.claude/guidance/shipped/moflo-memory-strategy.md` — Write-side: how to author guidance that indexes well
- `.claude/guidance/shipped/moflo-agent-rules.md` — Universal agent rules; touchpoint #2
- `.claude/guidance/shipped/moflo-subagents.md` — Subagent spawn protocol; touchpoint #3
- `.claude/guidance/internal/mcp-tool-authoring.md` — Sibling internal doc for adding new MCP tools
- Issue #1053 — Tracking epic for this work
