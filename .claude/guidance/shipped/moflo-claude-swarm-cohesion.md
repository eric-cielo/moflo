# MoFlo–Claude Swarm Cohesion

**Purpose:** Integrate native Claude Code tasks with MoFlo swarm coordination so that agent work is visible to the user, dependency-tracked, and routed through MoFlo's coordinator. Reference whenever you spawn an agent (with or without swarm).

---

## Architecture Overview

| Layer | System | Purpose |
|-------|--------|---------|
| **What** (user-visible) | Native Tasks (`TaskCreate`/`TaskList`/`TaskUpdate`/`TaskGet`) | Track work items, dependencies, status |
| **How** (orchestration) | MoFlo (swarm/hive-mind, memory, consensus, routing) | Spawn agents, coordinate, persist learnings |

Tasks let the user *see* what's happening; MoFlo is what coordinates. The two layers are independent — you can use TaskCreate without a swarm and a swarm without TaskCreate, but both together is the productive pattern.

---

## Agent Role Icons

Use these icons in `subject` and `activeForm` when creating tasks so the user can visually identify which agent is doing what. Required for all `TaskCreate` calls tied to agent work.

| Icon | Agent Role | activeForm Example |
|------|------------|-------------------|
| 🔍 | researcher | 🔍 Researching codebase |
| 🏗️ | system-architect | 🏗️ Designing architecture |
| 💻 | coder | 💻 Writing code |
| 🧪 | tester | 🧪 Writing tests |
| 👀 | reviewer | 👀 Reviewing code |
| 🛡️ | security-auditor | 🛡️ Security audit |
| 🔬 | analyst / code-analyzer | 🔬 Analyzing performance hotspots |
| 📚 | api-docs | 📚 Documenting API |
| 📋 | planner | 📋 Planning tasks |
| ⚙️ | backend-dev | ⚙️ Building REST endpoints |
| 🎨 | frontend-dev | 🎨 Building UI components |
| 🗄️ | database-dev | 🗄️ Designing schema |
| 🤝 | consensus (hive-mind) | 🤝 Evaluating tradeoffs |

See `.claude/guidance/moflo-task-icons.md` for the full ICON + [Role] format and how it applies to the `Agent` tool's `description` field.

---

## Integration Protocol

### Step 0: Pre-Swarm Validation

Before initializing swarm or hive-mind, verify tasks exist for the current work:

| `TaskList` Result | Action |
|-------------------|--------|
| Empty | Create task list (Step 1) before proceeding |
| Has unrelated/stale tasks | Create new tasks for current work |
| Has relevant tasks | Proceed to swarm init (Step 3) |

This is a soft reminder, not a hard blocker — the goal is user visibility into swarm progress.

### Step 1: Create Task List BEFORE Spawning Agents

Create a coordinator task plus one subtask per agent role, with role icons. Send all `TaskCreate` calls in a single message for parallel creation.

```javascript
TaskCreate({ subject: "Implement [feature]", activeForm: "Coordinating implementation" })
TaskCreate({ subject: "🔍 Research requirements", activeForm: "🔍 Researching codebase" })
TaskCreate({ subject: "🏗️ Design implementation", activeForm: "🏗️ Designing architecture" })
TaskCreate({ subject: "💻 Implement solution", activeForm: "💻 Writing code" })
TaskCreate({ subject: "🧪 Write tests", activeForm: "🧪 Writing tests" })
TaskCreate({ subject: "👀 Review code", activeForm: "👀 Reviewing code" })
```

### Step 2: Set Up Dependencies

After `TaskCreate`, establish execution order with `TaskUpdate(addBlockedBy: [...])`:

```javascript
TaskUpdate({ taskId: "2", addBlockedBy: ["1"] })  // Architect blocked by Researcher
TaskUpdate({ taskId: "3", addBlockedBy: ["2"] })  // Coder blocked by Architect
TaskUpdate({ taskId: "4", addBlockedBy: ["3"] })  // Tester blocked by Coder
TaskUpdate({ taskId: "5", addBlockedBy: ["3"] })  // Reviewer blocked by Coder
TaskUpdate({ taskId: "0", addBlockedBy: ["4", "5"] })  // Coordinator blocked by Tester + Reviewer
```

### Step 3: Initialize Coordination

**MCP (preferred):**
- Swarm: `mcp__moflo__swarm_init` — `topology: "hierarchical"`, `maxAgents: 8`, `strategy: "specialized"`
- Hive-mind: `mcp__moflo__hive-mind_init` — `topology: "hierarchical-mesh"`, `consensus: "byzantine"`

**CLI fallback:**
```bash
npx flo swarm init --topology hierarchical --max-agents 8 --strategy specialized
npx flo hive-mind init --topology hierarchical-mesh --consensus byzantine
```

### Step 4: Spawn Agents With Task References

Include task IDs in agent prompts. The `SubagentStart` hook automatically injects the subagent protocol directive — don't repeat it.

```javascript
TaskUpdate({ taskId: "1", status: "in_progress" })
Task({
  prompt: `YOUR TASK (ID: 1): Research requirements and codebase patterns
- Analyze feature requirements
- Search codebase for relevant patterns
- Document findings in memory

WHEN COMPLETE: Report findings. Coordinator will mark task completed.`,
  subagent_type: "researcher",
  description: "🔍 [Researcher] Research phase",
  run_in_background: true
})
```

### Step 5: Update Tasks as Agents Progress

```javascript
TaskUpdate({ taskId: "1", status: "completed" })
TaskList()  // Shows what's now unblocked
TaskUpdate({ taskId: "2", status: "in_progress" })  // Next agent starts
```

---

## Coordinator Responsibilities

| # | Responsibility |
|---|----------------|
| 1 | Create tasks before spawning agents (visible work breakdown) |
| 2 | Mark `in_progress` when spawning |
| 3 | Mark `completed` when results return |
| 4 | Use `TaskList` to monitor what's unblocked |
| 5 | Synthesize all agent outputs before proceeding |
| 6 | Store learnings in memory after completion |

---

## When to Use TaskCreate (With or Without Swarm)

### Decision Checklist

Before spawning any agent via `Task`, run through this checklist:

| # | Question | If YES |
|---|----------|--------|
| 1 | Is this a swarm / hive-mind? | **TaskCreate required** — full integration protocol (Steps 1-5 above) |
| 2 | Are you spawning 2+ background agents? | **TaskCreate required** — one per agent, with role icons |
| 3 | Is this a single background agent (`run_in_background: true`)? | **TaskCreate required** — user needs visibility while it runs |
| 4 | Will the agent touch 3+ files or take multiple steps? | **TaskCreate required** — even foreground, the user benefits from status tracking |
| 5 | Is this a single foreground agent for a focused task? | **TaskCreate optional** — user is already waiting inline for the result |
| 6 | Is this a quick research/exploration agent? | **Skip TaskCreate** — result returns fast, no tracking needed |

### Quick Rules

- **Background agent = always TaskCreate.** The user can't see what's happening otherwise.
- **Multiple agents = always TaskCreate for each.** Even without swarm coordination.
- **Foreground + simple = skip.** Don't add ceremony to a 10-second lookup.
- **When in doubt, create it.** A TaskCreate costs nothing; an invisible agent frustrates the user.

### Non-Swarm Example (2 background agents, no swarm init)

```javascript
TaskCreate({
  subject: "🔍 Investigate failing tests",
  description: "Research agent: find root cause of test failures",
  activeForm: "🔍 Investigating test failures"
})
TaskCreate({
  subject: "💻 Fix authentication endpoint",
  description: "Coder agent: implement the fix based on findings",
  activeForm: "💻 Fixing auth endpoint"
})

Task({
  prompt: "Investigate why booking-public-routes tests are failing...",
  subagent_type: "researcher",
  description: "🔍 [Researcher] Investigate test failures",
  run_in_background: true
})
Task({
  prompt: "Fix the authentication endpoint based on research findings...",
  subagent_type: "coder",
  description: "💻 [Coder] Fix auth endpoint",
  run_in_background: true
})
```

### Single Background Agent (still needs TaskCreate)

```javascript
TaskCreate({
  subject: "🧪 Write tests for booking routes",
  description: "Tester agent: comprehensive test coverage",
  activeForm: "🧪 Writing booking route tests"
})

Task({
  prompt: "Write comprehensive tests for booking-public-routes...",
  subagent_type: "tester",
  description: "🧪 [Tester] Write booking tests",
  run_in_background: true
})
```

### Foreground Agent (TaskCreate optional — skip for simple tasks)

```javascript
Task({
  prompt: "Find all files that import the AuthService",
  subagent_type: "Explore",
  description: "🔍 [Explorer] Find AuthService imports"
})
```

---

## Anti-Drift Configuration

Use these `swarm_init` settings to prevent agent drift:

| Team Size | Topology | maxAgents | Strategy |
|-----------|----------|-----------|----------|
| Small | `hierarchical` (queen → workers) | 6–8 | `specialized` |
| Large (10+) | `hierarchical-mesh` (queen + peer comms) | 15 | `specialized` |

Other valid topologies: `mesh` (fully connected peers), `ring`, `star`, `hybrid` (dynamic switching). For most work, prefer `hierarchical` — the coordinator catches divergence early. See `.claude/guidance/moflo-cli-reference.md` for the full topology catalog.

---

## Critical Execution Rules

### CLI + Task Tool in the Same Message

When spawning a swarm:

1. Call MCP/CLI to initialize coordination
2. **Immediately** in the same response, call the `Task` tool to spawn agents
3. Both calls go in **one** assistant message

CLI/MCP coordinates; the `Task` tool runs the agents that do the actual work.

### Spawn-and-Wait Pattern

After spawning background agents:

| Do | Don't |
|----|-------|
| Tell the user "I've spawned X agents working in parallel on: [list]" | Continuously poll swarm status |
| Stop further tool calls and let agents run | Repeatedly call `TaskOutput` |
| Wait for agent results to arrive (you'll be notified) | Add more tool calls after spawning |
| Synthesize results when they return | Ask "should I check on the agents?" |

---

## See Also

- `.claude/guidance/moflo-task-icons.md` — Full ICON + [Role] convention for `TaskCreate` and the `Agent` tool's `description` field
- `.claude/guidance/moflo-subagents.md` — Subagent memory-first protocol (auto-injected via the `SubagentStart` hook)
- `.claude/guidance/moflo-memory-strategy.md` — Memory architecture, namespaces, search patterns
- `.claude/guidance/moflo-core-guidance.md` — CLI/MCP reference and Auto-Learning protocol
- `.claude/guidance/moflo-cli-reference.md` — Topology catalog, consensus types, hive-mind details
