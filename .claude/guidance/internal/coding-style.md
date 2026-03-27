# MoFlo Coding Style — Decomposition, Naming, DRY

**Purpose:** Enforce decomposition-first coding style, descriptive naming, DRY discipline, and meaningful comments in MoFlo. The legacy codebase has large monolithic files — new code MUST NOT follow that pattern.

---

## 1. Decomposition Is a Top Priority

**Always decompose modules into focused, single-responsibility files.** Despite what you see in the legacy codebase, large monolithic files are tech debt we are actively paying down. New code and refactored code must follow separation of concerns.

| Rule | Threshold | Action |
|------|-----------|--------|
| File line count | > 300 lines | Strongly consider splitting |
| File line count | > 500 lines | MUST split — no exceptions for new code |
| Class with 3+ concerns | Any size | Extract into separate files |
| Data structures + business logic | Same file | Separate data structures into their own module |

---

## 2. How to Decompose

**Split by concern, not by size.** A 200-line file with two unrelated concerns should still be split. A 400-line file with one cohesive concern is fine.

| Concern Type | Separate File | Example |
|-------------|---------------|---------|
| Data structures | `deque.ts`, `priority-queue.ts` | Generic containers used by domain code |
| Domain types | `types.ts` | Interfaces, type aliases, type guards |
| Core logic | `<module-name>.ts` | The main class/functions |
| Factory/barrel | `index.ts` | Re-exports, factory functions |
| Constants | `constants.ts` | Magic numbers, config defaults |

---

## 3. Directory Module Pattern

**When a single file grows, convert it to a directory module.** Replace `foo.ts` with `foo/index.ts` that re-exports from focused sub-files. This preserves the import path for consumers.

```
BEFORE:  src/message-bus.ts (700 lines)

AFTER:   src/message-bus.ts          (thin re-export, 5 lines)
         src/message-bus/index.ts    (barrel + factory)
         src/message-bus/deque.ts    (data structure)
         src/message-bus/priority-queue.ts (data structure)
         src/message-bus/message-bus.ts (core logic)
```

**Keep the original file as a re-export shim** so existing imports continue to work without changes.

---

## 4. Legacy Code

**Do not use legacy monolithic files as a template.** When you encounter a large file in the codebase:
- If your task touches it significantly, decompose it as part of the work
- If your task only touches a few lines, leave it but do not expand it further
- Never add new functionality to a file already over 500 lines without splitting first

---

## 5. DRY Is Critical

**Never duplicate logic that already exists in the codebase.** Before writing a new utility, search for existing implementations. Common violations:

| Violation | Fix |
|-----------|-----|
| Copy-pasting a helper into a new file | Extract to a shared module, import everywhere |
| Redefining a type that exists elsewhere | Import from the canonical location |
| Inline logic matching an existing utility | Use the existing utility |
| Near-duplicate functions with slight variation | Generalize into one parameterized function |

Search broadly — the codebase has utilities scattered across packages. Use `Grep` before writing anything that looks like it might already exist (ID generators, EMA calculations, filter logic, etc.).

---

## 6. Descriptive Naming Over Comments

**Name methods, variables, and types so they describe what they do.** Comments on complex or non-obvious logic are fine — comments that restate what the code already says are superfluous.

| Comment Style | Verdict |
|---------------|---------|
| `// Reap messages that exceeded their TTL` above `reapExpiredMessages()` | Superfluous — method name says this |
| `// O(n) scan needed because circular buffer lacks index` | Good — explains WHY, not WHAT |
| `// Processing Loop (push delivery)` section header | Superfluous — method names are clear |
| `// Map critical → urgent because legacy Message has 4 levels` | Good — explains non-obvious mapping |

**If you cannot name a method descriptively, it needs decomposition.** An unclear name is a signal that the method does too many things. Split it until each piece has an obvious name.

---

## See Also

- `.claude/guidance/internal/guidance-rules.md` — Rules for writing guidance docs
- `CLAUDE.md` — Project architecture and file organization rules
