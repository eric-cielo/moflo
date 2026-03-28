# Task & Agent Icon Convention

**Purpose:** Every user-visible spinner text MUST use **ICON + [Role]** format. This applies to `TaskCreate` fields AND `Agent` tool `description`. Icons are a core MoFlo UX feature — they let users instantly identify which specialist is working.

---

## Where Icons Are Required

| Tool | Field(s) | Format |
|------|----------|--------|
| `TaskCreate` | `subject`, `activeForm` | `ICON [Role] Brief description` |
| `Agent` | `description` | `ICON [Role] Brief description` |

## TaskCreate Format

```
subject:    "ICON [Role] Brief description"
activeForm: "ICON Verb-ing description"
```

## Agent Tool Format

```
description: "ICON [Role] Brief description"
```

## Icon Map

| Agent Type | Icon | Example subject |
|------------|------|----------------|
| Explore | 🔍 | `🔍 [Explorer] Find entity files` |
| coder / sparc-coder | 💻 | `💻 [Coder] Implement auth service` |
| tester | 🧪 | `🧪 [Tester] Run unit test suite` |
| reviewer | 📋 | `📋 [Reviewer] Review PR changes` |
| researcher | 🔬 | `🔬 [Researcher] Analyze dependencies` |
| planner / Plan | 📐 | `📐 [Planner] Design migration plan` |
| security-architect / security-* | 🛡️ | `🛡️ [Security] Audit auth middleware` |
| architect / system-architect | 🏗️ | `🏗️ [Architect] Design API structure` |
| backend-dev | ⚙️ | `⚙️ [Backend] Build REST endpoints` |
| mobile-dev | 📱 | `📱 [Mobile] Fix React Native layout` |
| performance-* | ⚡ | `⚡ [Perf] Profile query bottleneck` |
| general-purpose | 🤖 | `🤖 [Agent] Execute multi-step task` |

## Examples

### TaskCreate

**Wrong:** `Run infrastructure tests` ← no icon, no role

**Right:** `🧪 [Tester] Run infrastructure tests` ← icon + role prefix

### Agent Tool

**Wrong:** `description: "Find entity files"` (no icon, no role)

**Right:** `description: "🔍 [Explorer] Find entity files"` (icon + role prefix)

## Why This Matters

The spinner is the primary visual feedback during agent execution. Without icons, all tasks look identical — a wall of plain text. With icons, users can instantly identify:
- What type of agent is working
- Whether the right specialist was chosen
- When agent types change during multi-step workflows
