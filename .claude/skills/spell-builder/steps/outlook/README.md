# `outlook` — Outlook.com Email Automation

**Purpose:** Use this step to automate Outlook.com email via browser -- read inbox, download attachments, send email, and search. Choose this when you need email automation without API keys, OAuth, or Azure configuration.

## Usage

```yaml
# Read the 5 most recent emails
- id: check-mail
  type: outlook
  config:
    action: read-inbox
    limit: 5

# Read a specific email by index
- id: read-first
  type: outlook
  config:
    action: read-email
    emailIndex: 0

# Download attachments from the first email
- id: get-files
  type: outlook
  config:
    action: download-attachments
    emailIndex: 0
    downloadDir: "~/Downloads/invoice-attachments"

# Send a notification email
- id: notify-team
  type: outlook
  config:
    action: send-email
    to: "team-leads@example.com"
    subject: "Weekly build report - {args.week}"
    body: "Build succeeded. See attached logs."

# Search for specific emails
- id: find-invoices
  type: outlook
  config:
    action: search
    query: "invoice from:accounting@vendor.com"
    limit: 20
```

## Config

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `action` | Yes | — | `read-inbox`, `read-email`, `download-attachments`, `send-email`, `search` |
| `limit` | No | `10` | Max emails to return |
| `emailIndex` | Yes (read-email, download) | — | 0-based email index |
| `downloadDir` | No | `~/Downloads/attachments` | Directory to save attachments |
| `to` | Yes (send-email) | — | Recipient email address |
| `subject` | Yes (send-email) | — | Email subject line |
| `body` | Yes (send-email) | — | Email body text |
| `query` | Yes (search) | — | Search query string |
| `userDataDir` | No | `~/.moflo/browser-profiles/outlook` | Persistent browser profile path |
| `headless` | No | `true` | Run without a visible browser |
| `timeout` | No | `30000` | Action timeout in milliseconds |

## Outputs

| Field | Type | Description |
|-------|------|-------------|
| `totalEmails` | number | Email count (read-inbox) |
| `emails` | array | Email list (read-inbox, search) |
| `emailsWithAttachments` | number | Count with attachments (read-inbox) |
| `subject` | string | Email subject (read-email) |
| `from` | string | Sender address (read-email) |
| `date` | string | Email date (read-email) |
| `body` | string | Email body (read-email) |
| `attachments` | array | Attachment list (read-email) |
| `downloaded` | array | Saved file paths (download-attachments) |
| `count` | number | Download count (download-attachments) |
| `sent` | boolean | Send confirmation (send-email) |
| `totalResults` | number | Search result count (search) |

## First Run

Cast with `headless: false` to sign in visually. The session persists to `userDataDir` and all subsequent headless runs skip login.

## Connector

Delegates to the `local-outlook` connector. See `connectors/local-outlook/README.md`.

## Source

`src/cli/spells/commands/outlook-command.ts`
