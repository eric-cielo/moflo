# Task Icon Convention

**Purpose:** Every `TaskCreate` call MUST use **ICON + [Role]** format in `subject` and `activeForm`. This displays agent identity in the spinner — a key UX signal for end users watching task progress.

---

## Format

```
subject:    "ICON [Role] Brief description"
activeForm: "ICON Verb-ing description"
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

**Wrong:** `subject: "Run infrastructure tests"` (no icon, no role)

**Right:** `subject: "🧪 [Tester] Run infrastructure tests"` (icon + role prefix)

## Why This Matters

The spinner is the primary visual feedback during agent execution. Without icons, all tasks look identical — a wall of plain text. With icons, users can instantly identify:
- What type of agent is working
- Whether the right specialist was chosen
- When agent types change during multi-step workflows
