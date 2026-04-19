# Execution Mode Details

Execution mode determines HOW work is carried out across all phases. Mode is chosen via flag: `-s/--swarm`, `-h/--hive`, or `-n/--normal` (default).

## SWARM Mode (-s, --swarm)

When swarm is requested, you MUST use the Task tool to spawn agents. No exceptions.

**Swarm spawns these agents via Task tool:**
- `researcher` - Analyzes issue, searches memory, finds patterns
- `coder` - Implements changes following plan
- `tester` - Writes and runs tests
- `/simplify` - Built-in command that reviews changed code before PR
- `reviewer` - Reviews code before PR

**Swarm execution pattern:**
```javascript
// 1. Create task list FIRST
TaskCreate({ subject: "Research issue #123", ... })
TaskCreate({ subject: "Implement changes", ... })
TaskCreate({ subject: "Test implementation", ... })
TaskCreate({ subject: "Run /simplify on changed files", ... })
TaskCreate({ subject: "Review and PR", ... })

// 2. Init swarm
Bash("flo swarm init --topology hierarchical --max-agents 8 --strategy specialized")

// 3. Spawn agents with Task tool (run_in_background: true)
Task({ prompt: "...", subagent_type: "researcher", run_in_background: true })
Task({ prompt: "...", subagent_type: "coder", run_in_background: true })

// 4. Wait for results, synthesize, continue
```

## HIVE-MIND Mode (-h, --hive)

Use for consensus-based decisions:
- Architecture choices
- Approach tradeoffs
- Design decisions with multiple valid options

## NORMAL Mode (Default)

Single Claude execution without spawning sub-agents.
- Still uses Task tool for tracking
- Still creates tasks for visibility
- Post-task neural learning hooks still fire
- Just doesn't spawn multiple agents
