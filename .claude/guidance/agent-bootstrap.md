# MoFlo Agent Bootstrap Guide

**Purpose:** Quick-start reference for subagents spawned by coordinators. Every subagent should follow this protocol before doing any work.

---

## 1. Search Memory FIRST

**Before reading any files or exploring code, search memory for guidance relevant to your task.**

### Two namespaces to search:

| Namespace | When to search | What it returns |
|-----------|---------------|-----------------|
| `guidance` | Understanding patterns, rules, conventions | Guidance docs, coding rules, domain context |
| `code-map` | Finding where code lives (files, types, services) | Project overviews, directory contents, type locations |

**Search `code-map` BEFORE using Glob/Grep for navigation.** It's faster and returns structured results.

### Option A: MCP Tools (Preferred)

If you have MCP tools available (check for `mcp__claude-flow__*`), use them directly:

| Tool | Purpose |
|------|---------|
| `mcp__claude-flow__memory_search` | Semantic search with domain-aware embeddings |
| `mcp__claude-flow__memory_store` | Store patterns with auto-vectorization |
| `mcp__claude-flow__hooks_route` | Get agent routing suggestions |

### Option B: CLI via Bash

```bash
npx moflo memory search --query "[describe your task]" --namespace guidance --limit 5
```

| Your task involves... | Search namespace | Example query |
|-----------------------|------------------|---------------|
| Database/entities | `guidance` | `"database entity migration"` |
| Frontend components | `guidance` | `"React frontend component"` |
| API endpoints | `guidance` | `"API route endpoint pattern"` |
| Authentication | `guidance` | `"auth middleware JWT"` |
| Unit tests | `guidance` | `"test mock vitest"` |
| Where is a file/type? | `code-map` | `"service entity location"` |
| What's in a directory? | `code-map` | `"back-office api routes"` |

Use results with score > 0.3. If no good results, fall back to reading project guidance docs.

---

## 2. Check Project Guidance

If memory search doesn't return useful results, look for project-level guidance:

```bash
# Check if project has guidance docs
ls .claude/guidance/ 2>/dev/null

# Check if project has a core index
cat .claude/guidance/core.md 2>/dev/null | head -50
```

Project guidance takes precedence over generic patterns.

---

## 3. Universal Rules

### Memory Protocol
- Search memory before exploring files
- Store discoveries back to memory when done
- Use `patterns` namespace for solutions and gotchas
- Use `decisions` namespace for architectural choices

### Git/Branches
- Use conventional commit prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `chore:`
- Use branch prefixes: `feature/`, `fix/`, `refactor/`
- Use kebab-case for branch names

### File Organization
- Never save working files to repository root
- Keep changes focused (3-10 files)
- Stay within feature scope

### Build & Test
- Build and test after code changes
- Never leave failing tests

---

## 4. Store Discoveries

If you discover something new (pattern, solution, gotcha), store it:

### MCP (Preferred):
```
mcp__claude-flow__memory_store
  namespace: "patterns"
  key: "brief-descriptive-key"
  value: "1-2 sentence insight"
```

### CLI Fallback:
```bash
npx moflo memory store --namespace patterns --key "brief-descriptive-key" --value "1-2 sentence insight"
```

**Store:** Solutions to tricky bugs, patterns that worked, gotchas, workarounds
**Skip:** Summaries of retrieved guidance, general rules, file locations

---

## 5. When Complete

1. Report findings to coordinator
2. Store learnings if you discovered something new
3. Coordinator will mark your task as completed
