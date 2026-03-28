# Workflow Step Sandboxing

MoFlo enforces **least-privilege access** for workflow steps. Every step command declares the capabilities it needs, and the runner blocks any undeclared access. Workflow authors can further restrict what a specific step instance is allowed to do.

This is defense-in-depth without containers — using capability declarations and runtime enforcement.

## Capability Types

| Capability | What It Grants | Commands That Use It |
|-----------|----------------|---------------------|
| `fs:read` | Read files from disk | `bash`, `browser` |
| `fs:write` | Write files to disk | `bash`, `browser` |
| `net` | Network access (HTTP, WebSocket, etc.) | `browser` |
| `shell` | Execute shell commands via child process | `bash` |
| `memory` | Read/write/search the workflow memory store | `memory` |
| `credentials` | Access the encrypted credential store | Any step using `{credentials.X}` |
| `browser` | Launch and control Playwright browser sessions | `browser` |
| `agent` | Spawn Claude subagents | `agent` |

Control-flow commands (`condition`, `loop`, `wait`, `prompt`) perform no I/O and require no capabilities.

## How It Works

Each built-in step command declares its capabilities in code:

```typescript
export const bashCommand: StepCommand = {
  type: 'bash',
  capabilities: [
    { type: 'shell' },
    { type: 'fs:read' },
    { type: 'fs:write' },
  ],
  // ...
};
```

The runner checks these before executing any step:

```
1. Parse and validate workflow definition
2. For each step:
   a. Interpolate config variables
   b. Validate config (command.validate)
   c. ✅ Check capabilities ← enforcement point
   d. Execute step (command.execute)
```

If a step's YAML `capabilities` field declares a capability the command doesn't support, execution is blocked:

```
Capability violation: [browser] step type "bash" does not declare
capability "browser" — cannot grant new capabilities
```

## Restricting Capabilities in YAML

Workflow authors can **restrict** (but never expand) a command's default capabilities on a per-step basis:

```yaml
steps:
  - id: read-config
    type: bash
    capabilities:
      fs:read: ["./config/"]      # only allow reading from ./config/
      shell: ["cat", "jq"]        # only allow these commands
    config:
      command: "cat config/settings.json | jq '.database'"
```

### Restriction Rules

| Scenario | Behavior |
|----------|----------|
| YAML restricts an existing capability | Scope is narrowed to the YAML-declared values |
| YAML omits a capability the command declares | Command's default is inherited (unrestricted) |
| YAML declares a capability the command doesn't have | **Blocked** — cannot grant new capabilities |
| No `capabilities` in YAML | All command defaults are used (no restrictions) |

### Example: Restricting a Bash Step

The `bash` command declares `shell`, `fs:read`, and `fs:write` by default. A workflow can narrow these:

```yaml
steps:
  # Full access (command defaults)
  - id: build
    type: bash
    config:
      command: "npm run build"

  # Restricted: read-only, specific commands
  - id: check-config
    type: bash
    capabilities:
      fs:read: ["./config/", "./package.json"]
      shell: ["cat", "jq", "grep"]
      # fs:write intentionally omitted — inherited as unrestricted
    config:
      command: "cat config/settings.json | jq '.version'"
```

## Writing Custom Step Commands

When creating a new step command, declare its capabilities:

1. **List every resource the command accesses** — files, network, subprocesses, memory, credentials
2. **Map each resource to a capability type** from the table above
3. **Add `capabilities` to your StepCommand**:

```typescript
export const myCommand: StepCommand = {
  type: 'my-command',
  capabilities: [
    { type: 'net', scope: ['api.example.com'] },
    { type: 'fs:write', scope: ['./output/'] },
  ],
  // ...
};
```

4. **Use `scope`** to limit defaults when a command only needs specific paths or hosts

## Schema Validation

The schema validator checks `capabilities` syntax when a workflow definition is loaded:

| Error | Cause |
|-------|-------|
| `unknown capability type: "teleport"` | Typo or invalid capability name |
| `scope must be an array of strings` | Scope value is not an array |
| `capabilities must be an object` | Capabilities declared as array instead of object |

Validation errors are caught before the workflow starts — no steps execute if the definition is invalid.

## Sandboxing Tiers

MoFlo's sandboxing is graduated. The current implementation covers Tiers 1-2:

| Tier | Mechanism | Status | Scope |
|------|-----------|--------|-------|
| 1 | Capability declaration + enforcement | **Shipped** | All step commands |
| 2 | Node `--experimental-permission` for bash | Planned | `bash` steps with path restrictions |
| 3 | V8 isolates (`isolated-vm`) for expressions | Planned | `condition`, `evaluate` |
| 4 | Linux namespaces (`unshare`) | Future | Untrusted steps on Linux |
| 5 | WASM sandbox | Future | Community step commands |

## See Also

- [Workflow Engine](WORKFLOWS.md) — Full workflow engine documentation
- [Build & Publish](BUILD.md) — Building and publishing MoFlo
