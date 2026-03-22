# @claude-flow/mcp — MCP Server Package

Root CLAUDE.md rules apply here. This package provides the MCP server for moflo.

## Structure

- `src/` — MCP server implementation
- `.claude/skills/` — Skill definitions for MCP tools
- `.claude/agents/` — Agent definitions

## Key Rules

- MCP tools use the `mcp__moflo__` prefix
- MCP handles coordination only — Claude Code's Task tool handles execution
- Transport: stdio (default)
