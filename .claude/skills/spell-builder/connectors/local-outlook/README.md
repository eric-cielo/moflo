# `local-outlook` — Outlook.com Email Connector

**Purpose:** Use this connector to automate Outlook.com via Playwright browser automation. Choose this when you need email operations without API keys or OAuth -- it uses a persistent browser session so you sign in once.

## Usage

```yaml
- id: check-for-invoices
  type: agent
  config:
    prompt: |
      Use the local-outlook connector to search for recent invoices.
      Call context.tools.execute('local-outlook', 'search', {
        query: 'invoice from:billing@vendor.com',
        limit: 5
      })
```

## Actions

| Action | Parameters | Description |
|--------|------------|-------------|
| `read-inbox` | `limit` | Fetch the most recent emails |
| `read-email` | `emailIndex` | Read a specific email by 0-based index |
| `download-attachments` | `emailIndex`, `downloadDir` | Save email attachments to disk |
| `send-email` | `to`, `subject`, `body` | Compose and send an email |
| `search` | `query`, `limit` | Search emails by query string |

## Direct Usage

```javascript
// Read the 10 most recent emails
const inbox = await context.tools.execute('local-outlook', 'read-inbox', {
  limit: 10
});

// Send a notification
await context.tools.execute('local-outlook', 'send-email', {
  to: 'team@example.com',
  subject: 'Daily build report',
  body: 'All checks passed. Deployment ready.'
});
```

## Session Persistence

Uses `~/.moflo/browser-profiles/outlook` by default. Sign in once with a visible browser (`headless: false`), and all subsequent headless runs reuse the session automatically.

## Capabilities

`read`, `write`, `search`

## Prerequisites

Requires `playwright` as a peer dependency.

## Source

`src/cli/spells/connectors/local-outlook.ts`
