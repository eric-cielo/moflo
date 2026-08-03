# `http` — HTTP Requests

**Purpose:** Use this connector to make HTTP requests to any URL. Choose this when you need to call REST APIs, fetch data, or post payloads during spell execution.

## Usage

Unlike `playwright`/`github-cli`/`local-outlook`, this connector has **no dedicated step type**. Reach it from a composite (YAML) step's `tool` action:

```yaml
name: fetch-status
inputs:
  token: { type: string }
actions:
  - tool: http
    action: request
    params:
      method: GET
      url: "https://api.myapp.com/deploy/status"
      headers:
        Authorization: "Bearer ${inputs.token}"
```

…or from a custom step command via the Direct Usage API below. See `.claude/guidance/moflo-spell-custom-steps.md`.

> Earlier revisions of this file showed an `agent` step calling `context.tools.execute(...)` from a prompt. The `agent` step type has never been executable.

## Actions

| Action | Parameters | Description |
|--------|------------|-------------|
| `request` | `method`, `url`, `headers`, `body` | Execute an HTTP request and return the response |

## Direct Usage

```javascript
const response = await context.tools.execute('http', 'request', {
  method: 'POST',
  url: 'https://hooks.slack.com/services/T00/B00/xxxx',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'Spell completed successfully' })
});
```

## Capabilities

`read`, `write`

## Source

`src/cli/spells/connectors/http-tool.ts`
