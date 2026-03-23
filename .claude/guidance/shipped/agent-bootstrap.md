# MoFlo Agent Bootstrap Guide

**Purpose:** Quick-start reference for subagents spawned by coordinators. Every subagent should follow this protocol before doing any work.

---

## 1. Search Memory FIRST

**Before reading any files or exploring code, search memory for guidance relevant to your task.**

### Three namespaces to search:

| Namespace | When to search | What it returns |
|-----------|---------------|-----------------|
| `guidance` | Understanding patterns, rules, conventions | Guidance docs, coding rules, domain context |
| `code-map` | Finding where code lives (files, types, services) | Project overviews, directory contents, type-to-file mappings |
| `patterns` | Prior solutions, gotchas, implementation patterns | Learned patterns from previous task execution |

**Always search `patterns` alongside `guidance`.** It contains solutions to problems already solved — skipping it means repeating past mistakes or re-discovering known approaches.

**Search `code-map` BEFORE using Glob/Grep for navigation.** It's faster and returns structured results including file-level type mappings.

### Option A: MCP Tools (Preferred)

If you have MCP tools available (check for `mcp__moflo__*`), use them directly:

| Tool | Purpose |
|------|---------|
| `mcp__moflo__memory_search` | Semantic search with domain-aware embeddings |
| `mcp__moflo__memory_store` | Store patterns with auto-vectorization |
| `mcp__moflo__hooks_route` | Get agent routing suggestions |

### Option B: CLI via Bash

```bash
npx flo memory search --query "[describe your task]" --namespace guidance --limit 5
```

| Your task involves... | Search namespace | Example query |
|-----------------------|------------------|---------------|
| Database/entities | `guidance` + `patterns` | `"database entity migration"` |
| Frontend components | `guidance` + `patterns` | `"React frontend component"` |
| API endpoints | `guidance` + `patterns` | `"API route endpoint pattern"` |
| Authentication | `guidance` + `patterns` | `"auth middleware JWT"` |
| Unit tests | `guidance` + `patterns` | `"test mock vitest"` |
| Prior solutions/gotchas | `patterns` | `"audit log service pattern"` |
| Where is a file/type? | `code-map` | `"CompanyEntity file location"` |
| What's in a directory? | `code-map` | `"back-office api routes"` |

Use results with score > 0.3. If no good results, fall back to reading project guidance docs.

---

## 2. Check Project-Specific Bootstrap

**After reading this file, check for a project-specific bootstrap:**

```bash
# Project-specific bootstrap (has domain rules, patterns, templates)
cat .claude/guidance/agent-bootstrap.md 2>/dev/null | head -10
```

If `.claude/guidance/agent-bootstrap.md` exists, **read it next**. It contains project-specific rules (entity patterns, multi-tenancy, tech stack conventions) that override generic guidance.

If no project bootstrap exists, look for general project guidance:

```bash
ls .claude/guidance/ 2>/dev/null
cat .claude/guidance/core.md 2>/dev/null | head -50
```

Project guidance always takes precedence over generic patterns.

---

## 3. Universal Rules

### Memory Protocol
- Search memory before exploring files
- Store discoveries back to memory when done
- Use `patterns` namespace for solutions and gotchas
- Use `knowledge` namespace for architectural choices and user-requested knowledge

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
mcp__moflo__memory_store
  namespace: "patterns"
  key: "brief-descriptive-key"
  value: "1-2 sentence insight"
```

### CLI Fallback:
```bash
npx flo memory store --namespace patterns --key "brief-descriptive-key" --value "1-2 sentence insight"
```

**Store:** Solutions to tricky bugs, patterns that worked, gotchas, workarounds
**Skip:** Summaries of retrieved guidance, general rules, file locations

---

## 5. When Complete

1. Report findings to coordinator
2. Store learnings if you discovered something new
3. Coordinator will mark your task as completed
