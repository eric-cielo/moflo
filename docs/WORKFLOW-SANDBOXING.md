# Workflow Step Sandboxing

MoFlo enforces **least-privilege access** for workflow steps. Every step command declares the capabilities it needs, and the runner blocks any undeclared access. Workflow authors can further restrict what a specific step instance is allowed to do.

This is defense-in-depth without containers — using capability declarations and runtime enforcement.

## Execution Constraint Principle

When executing within a workflow, Claude **only performs actions explicitly authorized by the workflow definition, step configuration, and declared capabilities**. This is the foundational security contract:

- **Only do what the step says.** A step's `config` defines the complete scope of work. A `bash` step with `command: "npm test"` runs `npm test` — nothing else.
- **Respect all capability restrictions.** If a step restricts `fs:read` to `["./config/"]`, files outside that path are off-limits.
- **Never escalate privileges.** A `CAPABILITY_DENIED` error is intentional — not a problem to work around.
- **No implicit side effects.** No creating files, making network requests, spawning agents, or modifying state unless a step explicitly authorizes it.
- **Scheduled workflows have the same restrictions as manual ones.** Automation does not grant additional permissions.
- **The workflow definition is the complete specification.** If it doesn't instruct an action, that action is not authorized.

This predictability is what makes automated and scheduled workflows safe to deploy.

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

## Runtime Enforcement via CapabilityGateway

Declaration-time checks validate that YAML restrictions don't exceed command defaults. But the actual security boundary is **runtime enforcement** — blocking unauthorized I/O at the point of execution.

The `CapabilityGateway` is a shared enforcement layer injected into every step's `WorkflowContext`. Step commands call the gateway before performing any I/O operation:

```typescript
// Gateway methods — each throws CapabilityDeniedError if the resource is outside scope
context.gateway.checkShell(command, context);    // Before spawning a process
context.gateway.checkNet(url, context);           // Before making HTTP/WebSocket requests
context.gateway.checkFs(path, 'read', context);   // Before reading a file
context.gateway.checkFs(path, 'write', context);  // Before writing a file
context.gateway.checkAgent(config, context);      // Before spawning a subagent
context.gateway.checkMemory(namespace, context);  // Before accessing memory store
```

This makes enforcement structural — commands cannot bypass it because all I/O goes through the gateway. Without the gateway, a step with `shell` scoped to `["cat", "jq"]` could still execute arbitrary commands if the command implementation forgot to check.

### Enforcement Status by Command

| Command | Gateway Enforcement | Status |
|---------|-------------------|--------|
| `bash` | `checkShell()`, `checkFs()` | **Enforced** |
| `browser` | `checkNet()` | **Enforced** |
| `memory` | `checkMemory()` | **Enforced** |
| `agent` | `checkAgent()` | **Planned** (#258) |
| `github` | `checkShell()` | **Planned** (#258) |
| `condition`, `loop`, `parallel`, `composite` | N/A | No I/O — child steps are individually checked |
| `wait`, `prompt` | N/A | No dangerous capabilities |

### Why This Matters

Without runtime enforcement, capabilities are advisory — a step declares what it *should* do, but nothing prevents it from doing more. The gateway closes this gap by ensuring every I/O operation is checked against the step's effective scope at the moment it happens.

## Sandboxing Tiers

MoFlo's sandboxing is graduated. The current implementation covers Tier 1:

| Tier | Mechanism | Status | Scope |
|------|-----------|--------|-------|
| 1 | Capability declaration + gateway enforcement | **Shipped** (partial — see above) | All step commands |
| 2 | Node `--experimental-permission` for bash | Planned | `bash` steps with path restrictions |
| 3 | V8 isolates (`isolated-vm`) for expressions | Planned | `condition`, `evaluate` |
| 4 | Linux namespaces (`unshare`) | Future | Untrusted steps on Linux |
| 5 | WASM sandbox | Future | Community step commands |

## See Also

- [Workflow Engine](WORKFLOWS.md) — Full workflow engine documentation, including the CapabilityGateway section
- [Build & Publish](BUILD.md) — Building and publishing MoFlo
