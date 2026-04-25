# `memory` — Read, Write, or Search Shared State

**Purpose:** Use this step to interact with MoFlo's memory database during spell execution. Choose this when you need to persist data between steps, across spell runs, or search for previously stored knowledge.

## Usage

```yaml
# Store a build result for later retrieval
- id: save-result
  type: memory
  config:
    action: write
    namespace: ci-pipeline
    key: last-build-sha
    value: "{build.stdout}"

# Retrieve the last stored value
- id: load-prev
  type: memory
  config:
    action: read
    namespace: ci-pipeline
    key: last-build-sha

# Semantic search across stored memories
- id: find-related
  type: memory
  config:
    action: search
    namespace: patterns
    query: "deployment failures in production"
```

## Config

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `action` | Yes | — | `read`, `write`, or `search` |
| `namespace` | Yes | — | Memory namespace to operate in |
| `key` | Yes (read/write) | — | Memory key to read or write |
| `value` | Yes (write) | — | Value to store |
| `query` | Yes (search) | — | Semantic search query |

## Outputs

| Field | Type | Description |
|-------|------|-------------|
| `value` | any | Retrieved value (read action) |
| `found` | boolean | Whether the key exists (read action) |
| `written` | boolean | Write confirmation (write action) |
| `results` | array | Search results (search action) |
| `count` | number | Number of results (search action) |

## Source

`src/modules/cli/src/spells/commands/memory-command.ts`
