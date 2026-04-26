# `wait` — Pause Execution

**Purpose:** Use this step to delay spell execution for a specified duration. Choose this when you need a cooldown between API calls, a polling interval, or a deliberate pause before the next step.

## Usage

```yaml
- id: rate-limit-pause
  type: wait
  config:
    duration: 5000
```

## Config

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `duration` | Yes | — | Milliseconds to wait before continuing |

## Outputs

| Field | Type | Description |
|-------|------|-------------|
| `waited` | number | Actual elapsed milliseconds |

## Source

`src/cli/spells/commands/wait-command.ts`
