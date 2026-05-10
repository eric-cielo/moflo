# MoFlo Subagents — Spawn Protocol

**Purpose:** Steps every subagent MUST run when spawned by a coordinator. The single-sentence directive injected by `SubagentStart` (see `.claude/helpers/subagent-bootstrap.json`) tells every subagent to memory-search first, then follow this protocol. Universal coding/coordination rules every agent (coordinator OR subagent) shares live in `.claude/guidance/moflo-agent-rules.md` — read those after Step 1.

---

## Step 1: Search Memory FIRST

**Before reading any files or exploring code, search memory.** This is the bootstrap action — moflo's gates will block your `Glob`/`Grep`/`Read` calls until you do.

```
mcp__moflo__memory_search   query: "[describe your task]"   namespace: "guidance"
```

Run the search **at least three times** — once each against `guidance`, `patterns`, and `learnings`. Patterns hold prior solutions; learnings hold standing decisions and post-mortem insights. Skipping either repeats past mistakes. Add `code-map` when navigating code, `tests` when looking for test coverage.

CLI fallback when MCP is unavailable: `npx flo memory search --query "..." --namespace guidance --limit 5`.

The full namespace reference, query examples by domain, and tool catalog live in `.claude/guidance/moflo-agent-rules.md` § Memory-First Protocol — read that next.

### Traverse, don't bulk-retrieve

Search hits carry a compact `navigation` crumb. For adjacent/sibling/hierarchical context, call `mcp__moflo__memory_get_neighbors` (one round-trip) instead of retrieving every hit. Full protocol: `.claude/guidance/moflo-memory-protocol.md`.

---

## Step 2: Apply Universal Agent Rules

Every moflo agent — coordinator or subagent — must follow `.claude/guidance/moflo-agent-rules.md`. The most load-bearing rules for subagents specifically:

| Rule | Detail |
|------|--------|
| **Task Icons** | `TaskCreate` MUST use **ICON + [Role]** in `subject` and `activeForm` — see `.claude/guidance/moflo-task-icons.md`. Example: `🧪 [Tester] Run unit tests` / activeForm: `🧪 Running unit tests` |
| **PR target repo (CRITICAL)** | Never run bare `gh pr create` in a forked repo — it defaults to upstream. Always pass `--repo "$REPO"`. Full workflow in `moflo-agent-rules.md` |
| **MCP-first tool selection** | Prefer `mcp__moflo__*` tools over `npx flo` CLI. CLI is fallback only |
| **Build & test after changes** | Never leave failing tests; fix red signals at the source |

The full set (git/branch conventions, file organization, build/test discipline, storing discoveries) is in `.claude/guidance/moflo-agent-rules.md`.

---

## Step 3: Check for Project-Specific Overrides

Claude Code automatically loads all `.claude/guidance/*.md` files into your context. If the consuming project has its own guidance files (domain rules, entity patterns, tech-stack conventions), they're already available — no need to read them manually.

**Project-specific guidance always takes precedence over generic MoFlo guidance.**

---

## Step 4: Store Discoveries Before Reporting

Before signing off your work, store anything useful you discovered during the task. Future agents shouldn't have to re-discover what you already learned.

| Namespace | What to store |
|-----------|---------------|
| `patterns` | Solutions to tricky bugs, gotchas, workarounds |
| `learnings` | Architectural choices, user-stated decisions, post-mortem insights |

**Store:** Patterns that worked, gotchas you hit, workarounds for limitations.
**Skip:** Generic summaries of retrieved guidance, restated rules, trivial file-location notes.

See `.claude/guidance/moflo-agent-rules.md` § Storing Discoveries for the full MCP/CLI invocation patterns.

---

## Step 5: When Complete

1. Report findings to the coordinator
2. Confirm any discoveries are stored (Step 4)
3. The coordinator will mark your task `completed` via `TaskUpdate`

Do not mark your own task completed — that's the coordinator's responsibility.

---

## See Also

- `.claude/guidance/moflo-agent-rules.md` — Universal rules every agent (coordinator OR subagent) shares
- `.claude/guidance/moflo-task-icons.md` — Mandatory ICON + [Role] format for every `TaskCreate` and `Agent` description
- `.claude/guidance/moflo-claude-swarm-cohesion.md` — How task lists and swarm coordinators cooperate when subagents are spawned in batches
- `.claude/guidance/moflo-memory-strategy.md` — Memory architecture, namespaces, search patterns
- `.claude/guidance/moflo-memorydb-maintenance.md` — How memory namespaces are populated and refreshed
- `.claude/guidance/moflo-core-guidance.md` — Full CLI/MCP reference including the spell gates that block subagent spawn before memory is searched
