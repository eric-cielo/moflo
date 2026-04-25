# `github` — GitHub CLI Operations

**Purpose:** Use this step to run GitHub CLI operations for issue and PR management. Choose this over `bash` + `gh` when you want structured inputs/outputs and automatic error handling.

## Usage

```yaml
- id: file-bug
  type: github
  config:
    action: create-issue
    repo: my-org/backend-api
    title: "Bug: login endpoint returns 500 on empty password"
    body: |
      ## Steps to reproduce
      1. POST /api/login with `{ "email": "test@example.com", "password": "" }`
      2. Observe 500 instead of 400 validation error
    labels:
      add: [bug, priority-high]
```

## Config

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `action` | Yes | — | GitHub operation (see Actions below) |
| `repo` | No | current repo | Target repository as `owner/repo` |
| `title` | Yes (create) | — | Issue or PR title |
| `body` | No | — | Body text (Markdown supported) |
| `issue` / `pr` | Yes (update/close) | — | Issue or PR number |
| `labels` | No | — | `{ add: [...], remove: [...] }` |
| `mergeMethod` | No | `squash` | `squash`, `merge`, or `rebase` |

## Actions

`create-issue`, `create-pr`, `add-label`, `remove-label`, `comment`, `close-issue`, `close-pr`, `merge-pr`, `pr-find`

## Outputs

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | URL of the created or modified resource |
| `number` | number | Issue or PR number |
| `action` | string | Action that was performed |

## Connector

Delegates to the `github-cli` connector. See `connectors/github-cli/README.md`.

## Source

`src/modules/cli/src/spells/commands/github-command.ts`
