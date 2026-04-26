# `parallel` — Run Steps Concurrently

**Purpose:** Use this step to execute multiple steps simultaneously and collect all results. Choose this over `loop` when the steps are independent and order does not matter.

## Usage

```yaml
- id: ci-checks
  type: parallel
  config:
    maxConcurrency: 3
  steps:
    - id: lint
      type: bash
      config:
        command: npm run lint
    - id: test
      type: bash
      config:
        command: npm test
    - id: typecheck
      type: bash
      config:
        command: npx tsc --noEmit
```

## Config

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `maxConcurrency` | No | unlimited | Maximum number of steps to run at the same time |

Nested steps are defined on the step itself via the `steps` field, not inside `config`.

## Outputs

| Field | Type | Description |
|-------|------|-------------|
| `results` | array | Per-step results in declaration order |
| `succeeded` | number | Count of steps that completed successfully |
| `failed` | number | Count of steps that failed |

## Source

`src/cli/spells/commands/parallel-command.ts`
