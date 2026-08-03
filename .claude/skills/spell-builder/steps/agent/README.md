# `agent` — NOT EXECUTABLE

**Purpose:** Document that this step type does not work, so it is not offered when authoring a spell. It is registered but has never spawned a subagent — moflo has no agent spawner in the spell runner. Casting it always fails.

**Do not add `agent` steps to a spell.** Previously the step returned `success: true` with `result: "Agent task prepared: <type>"`, so spells containing one completed green and downstream steps consumed that string as though it were agent output. It now fails with an explanatory error instead.

The type stays registered on purpose: removing it would turn a silently-useless step into a hard parse error for any existing spell YAML that contains one.

## Use this instead

Run the Claude CLI from a `bash` step:

```yaml
- id: research
  type: bash
  config:
    command: 'claude -p "Find all REST API endpoints in src/ and list their HTTP methods and paths"'
    timeout: 300000
```

This is what moflo's own shipped spells do — see `src/cli/spells/definitions/epic-auto-merge.yaml`.

**Note on cost:** a `bash` step invoking `claude -p` has no spend ceiling, which matters most for daemon-scheduled spells. Set a `timeout` and prefer `failOnError: true`.

## If you are reading an older spell

| Old `agent` config | Replacement |
|---|---|
| `prompt` | the prompt text inside `claude -p "..."` |
| `agentType` | no equivalent — describe the role in the prompt |
| `background` | no equivalent — the bash step waits |

`model` and `systemPrompt` were documented here previously but were never implemented — the step's `configSchema` only ever accepted `prompt`, `agentType`, and `background`.

## Outputs

None. The step always fails. `agentType` and `prompt` are echoed in the failure data for diagnosis only; there is no `result`.

## Source

`src/cli/spells/commands/agent-command.ts`
