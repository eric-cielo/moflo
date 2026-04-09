# `loop` — Iterate Over Items

**Purpose:** Use this step to run nested steps once per item in an array. Choose this over `parallel` when order matters or when each iteration depends on the previous one.

## Usage

```yaml
- id: process-files
  type: loop
  config:
    over: "{args.files}"
    itemVar: file
    indexVar: idx
    maxIterations: 50
  steps:
    - id: lint-one
      type: bash
      config:
        command: "eslint {file} --fix"
```

## Config

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `over` / `items` | Yes | — | Array expression to iterate over |
| `itemVar` | No | `"item"` | Variable name for the current item |
| `indexVar` | No | `"index"` | Variable name for the current index |
| `maxIterations` | No | `100` | Safety cap to prevent runaway loops |

Nested steps are defined on the step itself via the `steps` field, not inside `config`.

## Outputs

| Field | Type | Description |
|-------|------|-------------|
| `totalItems` | number | Length of the input array |
| `iterations` | number | Number of iterations actually executed |
| `truncated` | boolean | Whether `maxIterations` was reached |
| `items` | array | Per-iteration results |

## Source

`src/modules/spells/src/commands/loop-command.ts`
