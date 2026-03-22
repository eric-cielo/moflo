# Claude Flow Plugin Integration

## Overview

This document describes how claude-flow integrates with the official Claude Code plugin system.

## Plugin Structure

```
plugin/
├── .claude-plugin/
│   └── plugin.json          # Official plugin manifest
├── .mcp.json                 # MCP server bundle
├── hooks/
│   └── hooks.json            # Hook configurations
├── skills -> ../.claude/skills     # 60+ skills
├── commands -> ../.claude/commands # 100+ commands
└── agents -> ../v2/.claude/agents  # 80+ agents
```

## Official Claude Code Integration Points

### 1. Plugin Manifest (`plugin.json`)

```json
{
  "name": "claude-flow",
  "version": "3.0.0",
  "capabilities": {
    "skills": true,
    "commands": true,
    "agents": true,
    "hooks": true,
    "mcpServers": true
  }
}
```

### 2. Hook Event Mapping

| V3 Internal Event | Official Claude Code Event | Tool Matcher |
|-------------------|---------------------------|--------------|
| `PreEdit` | `PreToolUse` | `^(Write\|Edit\|MultiEdit)$` |
| `PostEdit` | `PostToolUse` | `^(Write\|Edit\|MultiEdit)$` |
| `PreCommand` | `PreToolUse` | `^Bash$` |
| `PostCommand` | `PostToolUse` | `^Bash$` |
| `PreTask` | `UserPromptSubmit` | - |
| `PostTask` | `PostToolUse` | `^Task$` |
| `SessionStart` | `SessionStart` | - |
| `SessionEnd` | `Stop` | - |
| `AgentSpawn` | `PostToolUse` | `^Task$` |
| `AgentTerminate` | `SubagentStop` | - |
| `PreRoute` | `UserPromptSubmit` | - |

### 3. MCP Server Bundle

The plugin bundles three MCP servers:

1. **claude-flow** (required): Core swarm coordination
2. **ruv-swarm** (optional): Enhanced topology patterns
3. **flow-nexus** (optional): Cloud orchestration

### 4. Skills Integration

Skills follow the official SKILL.md format:

```yaml
---
name: skill-name
description: What this skill does
allowed-tools: Read, Write, Bash
---

# Skill Name

[Instructions for Claude]
```

## V3 Hooks Bridge

The `@claude-flow/hooks` package includes an official hooks bridge:

```typescript
import {
  OfficialHooksBridge,
  processOfficialHookInput,
  outputOfficialHookResult,
  executeWithBridge,
} from '@claude-flow/hooks';

// Process input from Claude Code
const input = await processOfficialHookInput();

// Convert to V3 context
const context = OfficialHooksBridge.toV3Context(input);

// Execute V3 handler
const result = await handler(context);

// Convert back to official output
const output = OfficialHooksBridge.toOfficialOutput(result, input.hook_event_name);
outputOfficialHookResult(output);
```

## Installation

### Via Plugin Command (Recommended)

```bash
# Add plugin marketplace
/plugin marketplace add claude-flow https://github.com/eric-cielo/moflo

# Install plugin
/plugin install claude-flow
```

### Manual Installation

```bash
# Clone and link
git clone https://github.com/eric-cielo/moflo
claude --plugin-dir ./claude-flow/plugin
```

### Via npx Init

```bash
npx claude-flow@alpha init --hooks
```

## Configuration

### Enable All Hooks

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [...],
    "PostToolUse": [...],
    "UserPromptSubmit": [...],
    "SessionStart": [...],
    "Stop": [...]
  }
}
```

### Selective Hooks

Enable only specific hooks by choosing matchers:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(Write|Edit)$",
        "hooks": [{ "type": "command", "command": "npx claude-flow@alpha hooks pre-edit" }]
      }
    ]
  }
}
```

## MCP Tool Access

After installation, MCP tools are available:

- `mcp__moflo__swarm_init`
- `mcp__moflo__agent_spawn`
- `mcp__moflo__task_orchestrate`
- `mcp__moflo__memory_usage`
- `mcp__moflo__hooks_route`
- `mcp__moflo__hooks_metrics`

## Marketplace Publishing

### Create Marketplace Entry

```json
{
  "name": "claude-flow-marketplace",
  "plugins": [
    {
      "name": "claude-flow",
      "description": "Multi-agent swarm coordination",
      "version": "3.0.0",
      "path": "plugin"
    }
  ]
}
```

### Host on GitHub

1. Push to repository
2. Add marketplace: `/plugin marketplace add name https://github.com/user/repo`
3. Users install: `/plugin install claude-flow@name`

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Claude Code                              │
├─────────────────────────────────────────────────────────────┤
│  Official Hooks API                                          │
│  ┌─────────────┬─────────────┬─────────────┬──────────────┐ │
│  │ PreToolUse  │ PostToolUse │ SessionStart│ UserPrompt   │ │
│  └──────┬──────┴──────┬──────┴──────┬──────┴──────┬───────┘ │
│         │             │             │             │          │
│         ▼             ▼             ▼             ▼          │
│  ┌──────────────────────────────────────────────────────────┐│
│  │              Official Hooks Bridge                        ││
│  │  (v3/@claude-flow/hooks/src/bridge/official-hooks-bridge)││
│  └──────────────────────────────────────────────────────────┘│
│         │             │             │             │          │
│         ▼             ▼             ▼             ▼          │
│  ┌─────────────┬─────────────┬─────────────┬──────────────┐ │
│  │ PreEdit     │ PostEdit    │ SessionStart│ PreTask      │ │
│  │ PreCommand  │ PostCommand │ SessionEnd  │ PostTask     │ │
│  └─────────────┴─────────────┴─────────────┴──────────────┘ │
│                     V3 Hooks System                          │
├─────────────────────────────────────────────────────────────┤
│                    @claude-flow/hooks                        │
│  ┌───────────┬───────────┬───────────┬───────────────────┐  │
│  │ Registry  │ Executor  │ Daemons   │ MCP Tools         │  │
│  └───────────┴───────────┴───────────┴───────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│              Skills │ Commands │ Agents │ MCP Servers       │
└─────────────────────────────────────────────────────────────┘
```

## Benefits

1. **Seamless Integration**: V3 hooks map directly to official events
2. **Full Feature Access**: 60+ skills, 100+ commands, 80+ agents
3. **MCP Bundling**: All servers configured in one file
4. **Marketplace Ready**: Standard plugin format for distribution
5. **Backward Compatible**: Works with existing `.claude/` configurations
