# Execution Mode Details

The execution mode chooses how work is carried out across the phases. Pass `-s/--swarm`, `-h/--hive`, or `-n/--normal` (default).

## SWARM mode (`-s`, `--swarm`)

Swarm mode spawns agents via the Task tool.

Roles:
- `researcher` — analyzes the issue, searches memory, finds patterns
- `coder` — implements changes following the plan
- `tester` — writes and runs tests
- `/simplify` — built-in command that reviews changed code before PR
- `reviewer` — reviews code before PR

Pattern:
```javascript
// 1. Create the task list first
TaskCreate({ subject: "Research issue #123", ... })
TaskCreate({ subject: "Implement changes", ... })
TaskCreate({ subject: "Test implementation", ... })
TaskCreate({ subject: "Run /simplify on changed files", ... })
TaskCreate({ subject: "Review and PR", ... })

// 2. Init the swarm
Bash("flo swarm init --topology hierarchical --max-agents 8 --strategy specialized")

// 3. Spawn agents (run_in_background: true)
Task({ prompt: "...", subagent_type: "researcher", run_in_background: true })
Task({ prompt: "...", subagent_type: "coder", run_in_background: true })

// 4. Wait for results, synthesize, continue
```

## HIVE-MIND mode (`-h`, `--hive`)

Use for consensus-based decisions:
- Architecture choices
- Approach tradeoffs
- Design decisions with multiple valid options

## NORMAL mode (default)

Single Claude execution without spawning sub-agents.
- Still uses the Task tool for tracking
- Still creates tasks for visibility
- Post-task neural learning hooks still fire
- No agent spawning
