# `agent` — Spawn a Claude Subagent

**Purpose:** Use this step to delegate a task to a Claude subagent and capture its response. Choose this over `bash` when the task requires reasoning, code generation, or research rather than a deterministic command.

## Usage

```yaml
- id: research
  type: agent
  config:
    agentType: researcher
    prompt: "Find all REST API endpoints in src/ and list their HTTP methods and paths"
    model: claude-sonnet-4-20250514
    background: false
```

## Config

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `prompt` | Yes | — | Task prompt for the agent |
| `agentType` | No | `coder` | Agent specialization: `researcher`, `coder`, `tester`, `reviewer` |
| `model` | No | system default | Model override (e.g. `claude-sonnet-4-20250514`) |
| `systemPrompt` | No | — | Custom system prompt replacing the default |
| `background` | No | `false` | Run without waiting for the result |

## Outputs

| Field | Type | Description |
|-------|------|-------------|
| `result` | string | Agent response text |
| `agentType` | string | Agent type that was used |
| `prompt` | string | Prompt that was sent |

## Source

`src/modules/cli/src/spells/commands/agent-command.ts`
