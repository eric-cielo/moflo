# `http` — HTTP Requests

**Purpose:** Use this connector to make HTTP requests to any URL from within agent steps. Choose this when you need to call REST APIs, fetch data, or post payloads during spell execution.

## Usage

```yaml
- id: fetch-status
  type: agent
  config:
    prompt: |
      Use the http connector to check the deployment status.
      Call context.tools.execute('http', 'request', {
        method: 'GET',
        url: 'https://api.myapp.com/deploy/status',
        headers: { 'Authorization': 'Bearer {credentials.API_TOKEN}' }
      })
```

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
