# `github-cli` — GitHub CLI Connector

**Purpose:** Use this connector as the backing connector for the `github` step command, or from a custom step command. Choose this when you need programmatic access to GitHub issues, PRs, and repos.

## Usage

From a spell, reach this connector through the `github` step, which delegates to it:

```yaml
- id: fetch-bug
  type: github
  config:
    action: issue-fetch
    issue: 42
    fields: ["number", "title", "labels", "state"]
```

> Earlier revisions of this file showed an `agent` step calling `context.tools.execute(...)` from a prompt. The `agent` step type has never been executable — use the `github` step, a composite step's `tool` action, or a custom step command.

## Actions

Taken from `VALID_ACTIONS` in `src/cli/spells/connectors/github-cli.ts`. `issue-create`, `issue-list`, `pr-list` and `repo-view` were listed here previously but have never existed.

| Action | Required params | Description |
|--------|-----------------|-------------|
| `issue-fetch` | `issue` | Fetch issue details as JSON (`fields` selects columns) |
| `issue-edit` | `issue` | Edit an existing issue |
| `pr-create` | `title` | Create a pull request |
| `pr-merge` | `pr` or `issue` | Merge a PR (`mergeMethod`: squash \| merge \| rebase) |
| `pr-find` | `head` or `search` | Find a PR by head branch or search query |
| `label` | (`issue` or `pr`) + `labels` | Add/remove labels |
| `comment` | (`issue` or `pr`) + `body` | Post a comment |
| `repo-info` | — | View repository metadata |

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
