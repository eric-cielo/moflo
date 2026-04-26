# `prompt` — Ask for User Input

**Purpose:** Use this step to pause the spell and ask the user a question. Choose this when the spell needs human confirmation, a choice between options, or freeform text input before proceeding.

## Usage

```yaml
- id: confirm-deploy
  type: prompt
  config:
    message: "Deploy build v{build.version} to production?"
    options: [yes, no]
    default: "no"
```

## Config

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `message` | Yes | — | Question to display to the user |
| `options` | No | — | Array of multiple choice options |
| `default` | No | — | Default answer if the user provides no input |

## Outputs

| Field | Type | Description |
|-------|------|-------------|
| `response` | string | The user's answer |
| `message` | string | The question that was asked |

## Source

`src/cli/spells/commands/prompt-command.ts`
