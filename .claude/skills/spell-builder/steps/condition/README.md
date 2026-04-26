# `condition` — Branch the Spell

**Purpose:** Use this step to evaluate an expression and jump to a different step based on the result. Choose this when you need if/else control flow between spell steps.

## Usage

```yaml
- id: check-env
  type: condition
  config:
    if: "{args.environment} === 'production'"
    then: production-deploy
    else: staging-deploy
```

## Config

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `if` / `expression` | Yes | — | JavaScript-style comparison expression |
| `then` | Yes | — | Step ID to jump to when expression is true |
| `else` | No | next step | Step ID to jump to when expression is false |

## Outputs

| Field | Type | Description |
|-------|------|-------------|
| `result` | boolean | Whether the expression evaluated to true |
| `branch` | string | `"then"` or `"else"` |
| `nextStep` | string | Target step ID that execution jumps to |

## Notes

Infinite loop protection is built in: max iterations = total steps x 10.

## Source

`src/cli/spells/commands/condition-command.ts`
