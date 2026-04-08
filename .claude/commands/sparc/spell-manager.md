# SPARC Spell Manager Mode

## Purpose
Spell orchestration and process automation with TodoWrite planning and Task execution.

## Activation

### Option 1: Using MCP Tools (Preferred in Claude Code)
```javascript
mcp__moflo__sparc_mode {
  mode: "spell-manager",
  task_description: "automate deployment",
  options: {
    pipeline: "ci-cd",
    rollback_enabled: true
  }
}
```

### Option 2: Using NPX CLI (Fallback when MCP not available)
```bash
# Use when running from terminal or MCP tools unavailable
npx claude-flow sparc run spell-manager "automate deployment"

# For alpha features
npx claude-flow@alpha sparc run spell-manager "automate deployment"
```

### Option 3: Local Installation
```bash
# If claude-flow is installed locally
./claude-flow sparc run spell-manager "automate deployment"
```

## Core Capabilities
- Spell design and composition
- Process automation
- Pipeline creation
- Event handling
- State management

## Spell Patterns
- Sequential flows
- Parallel branches
- Conditional logic
- Loop iterations
- Error handling

## Automation Features
- Trigger management
- Task scheduling
- Progress tracking
- Result validation
- Rollback capability
