# `github-cli` — GitHub CLI Connector

**Purpose:** Use this connector to execute GitHub CLI operations from agent steps or as the backing connector for the `github` step command. Choose this when you need programmatic access to GitHub issues, PRs, and repos.

## Usage

```yaml
- id: list-open-bugs
  type: agent
  config:
    prompt: |
      Use the github-cli connector to find open bugs.
      Call context.tools.execute('github-cli', 'issue-list', {
        repo: 'my-org/backend-api',
        labels: ['bug'],
        state: 'open'
      })
```

## Actions

| Action | Description |
|--------|-------------|
| `issue-create` | Create a new GitHub issue |
| `issue-list` | List issues with optional filters |
| `pr-create` | Create a pull request |
| `pr-list` | List pull requests with optional filters |
| `repo-view` | View repository metadata |

## Direct Usage

```javascript
const result = await context.tools.execute('github-cli', 'issue-create', {
  repo: 'my-org/backend-api',
  title: 'Fix: null pointer in auth middleware',
  body: 'The auth middleware crashes when the token header is missing.',
  labels: ['bug']
});
```

## Capabilities

`read`, `write`, `search`

## Prerequisites

Requires `gh` CLI installed and authenticated (`gh auth login`).

## Source

`src/cli/spells/connectors/github-cli.ts`
