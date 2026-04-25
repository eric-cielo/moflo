# `bash` — Run a Shell Command

**Purpose:** Use this step to execute a shell command in a child process and capture its output. Choose this when you need to run CLI tools, build scripts, or any system command.

## Usage

```yaml
- id: build
  type: bash
  config:
    command: npm run build
    cwd: /home/user/my-project
    timeout: 60000
    failOnError: true
```

## Config

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `command` | Yes | — | Shell command to execute |
| `cwd` | No | spell working dir | Working directory for the command |
| `timeout` | No | `30000` | Kill the process after N milliseconds |
| `failOnError` | No | `true` | Fail the step on non-zero exit code |

## Outputs

| Field | Type | Description |
|-------|------|-------------|
| `stdout` | string | Captured standard output |
| `stderr` | string | Captured standard error |
| `exitCode` | number | Process exit code |

## Source

`src/modules/cli/src/spells/commands/bash-command.ts`
