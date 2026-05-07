# Execution Mode Details

The execution mode chooses how work is carried out across the phases. Pass `-s/--swarm`, `-h/--hive`, or `-n/--normal` (default).

## SWARM mode (`-s`, `--swarm`)

> **MANDATORY when `-s` is passed.** Your first Execute-phase action MUST be `mcp__moflo__swarm_init`, followed by `mcp__moflo__agent_spawn` for each role. Spawning subagents via `Agent` (or `Task`) without first registering the swarm is a violation of issue #952. The `Agent` PreToolUse gate will BLOCK the call until `swarm_init` runs. Even when you also use `Agent` for parallelism, the moflo swarm IS the registration surface — call it first. See CLAUDE.md "⛔ Protected functionality — swarm + hive-mind".

Swarm mode coordinates agents through the moflo swarm coordinator, then spawns workers via the `Agent` tool.

Roles:
- `researcher` — analyzes the issue, searches memory, finds patterns
- `coder` — implements changes following the plan
- `tester` — writes and runs tests
- `/flo-simplify` — moflo's adaptive code review skill (sized to diff, parallel agents on big changes)
- `reviewer` — reviews code before PR

Required pattern:
```javascript
// 1. Create the task list first
TaskCreate({ subject: "📋 [Researcher] Research issue", ... })
TaskCreate({ subject: "💻 [Coder] Implement changes", ... })
TaskCreate({ subject: "🧪 [Tester] Test implementation", ... })
TaskCreate({ subject: "🔍 [Reviewer] Run /flo-simplify on changed files", ... })

// 2. Init the swarm — MANDATORY, gate-enforced
mcp__moflo__swarm_init({ topology: "hierarchical", maxAgents: 8, strategy: "specialized" })

// 3. Register each agent with the coordinator — MANDATORY
mcp__moflo__agent_spawn({ type: "researcher", ... })
mcp__moflo__agent_spawn({ type: "coder", ... })
mcp__moflo__agent_spawn({ type: "tester", ... })
mcp__moflo__agent_spawn({ type: "reviewer", ... })

// 4. Now safe to dispatch via Agent tool for parallel execution
Agent({ prompt: "...", subagent_type: "researcher", run_in_background: true })
Agent({ prompt: "...", subagent_type: "coder", run_in_background: true })

// 5. Wait for results, synthesize, continue
```

## HIVE-MIND mode (`-h`, `--hive`)

> **MANDATORY when `-h` is passed.** Your first Execute-phase action MUST be `mcp__moflo__hive-mind_init`. The `Agent` PreToolUse gate will BLOCK any subagent spawn until hive-mind init has run. See CLAUDE.md "⛔ Protected functionality — swarm + hive-mind".

Use for consensus-based decisions:
- Architecture choices
- Approach tradeoffs
- Design decisions with multiple valid options

Required pattern:
```javascript
// 1. Init the hive — MANDATORY, gate-enforced
mcp__moflo__hive-mind_init({ ... })

// 2. Spawn workers + reach consensus via mcp__moflo__hive-mind_consensus
mcp__moflo__hive-mind_spawn({ ... })
mcp__moflo__hive-mind_consensus({ ... })
```

## NORMAL mode (default)

Single Claude execution without spawning sub-agents.
- Still uses TaskCreate for tracking
- Still creates tasks for visibility
- Post-task neural learning hooks still fire
- No agent spawning, no swarm/hive init required

## Why these are MANDATORY

Swarm and hive-mind are headline moflo product surface (CLAUDE.md "⛔ Protected functionality"). When the user explicitly opts in via `-s`/`-h`, the protected MCP surface MUST be exercised — falling back to "Claude-native parallelism" via `Agent` tool calls without coordinator registration is the failure mode that prompted issue #952. The PreToolUse gate enforces this; opt-out is `gates.swarm_invocation_gate: false` in `moflo.yaml`.
