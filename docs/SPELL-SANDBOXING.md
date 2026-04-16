# Spell Step Sandboxing

MoFlo enforces **least-privilege access** for spell steps. Every step command declares the capabilities it needs, and the runner blocks any undeclared access. Spell authors can further restrict what a specific step instance is allowed to do.

This is defense-in-depth without containers — using capability declarations and runtime enforcement.

## Execution Constraint Principle

When executing within a spell, Claude **only performs actions explicitly authorized by the spell definition, step configuration, and declared capabilities**. This is the foundational security contract:

- **Only do what the step says.** A step's `config` defines the complete scope of work. A `bash` step with `command: "npm test"` runs `npm test` — nothing else.
- **Respect all capability restrictions.** If a step restricts `fs:read` to `["./config/"]`, files outside that path are off-limits.
- **Never escalate privileges.** A `CAPABILITY_DENIED` error is intentional — not a problem to work around.
- **No implicit side effects.** No creating files, making network requests, spawning agents, or modifying state unless a step explicitly authorizes it.
- **Scheduled spells have the same restrictions as manual ones.** Automation does not grant additional permissions.
- **The spell definition is the complete specification.** If it doesn't instruct an action, that action is not authorized.

This predictability is what makes automated and scheduled spells safe to deploy.

## Capability Types

| Capability | What It Grants | Commands That Use It |
|-----------|----------------|---------------------|
| `fs:read` | Read files from disk | `bash`, `browser` |
| `fs:write` | Write files to disk | `bash`, `browser` |
| `net` | Network access (HTTP, WebSocket, etc.) | `browser` |
| `shell` | Execute shell commands via child process | `bash` |
| `memory` | Read/write/search the spell memory store | `memory` |
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
1. Parse and validate spell definition
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

Spell authors can **restrict** (but never expand) a command's default capabilities on a per-step basis:

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

The `bash` command declares `shell`, `fs:read`, and `fs:write` by default. A spell can narrow these:

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

The schema validator checks `capabilities` syntax when a spell definition is loaded:

| Error | Cause |
|-------|-------|
| `unknown capability type: "teleport"` | Typo or invalid capability name |
| `scope must be an array of strings` | Scope value is not an array |
| `capabilities must be an object` | Capabilities declared as array instead of object |

Validation errors are caught before the spell starts — no steps execute if the definition is invalid.

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

## Security Model — Defense in Depth

MoFlo uses three independent security layers. Each layer catches different threats, and they work together so that no single bypass compromises the whole system.

### Layer 1: Command Denylist (all platforms)

Before any bash step executes, MoFlo checks the command against a denylist of known-catastrophic patterns. This catches accidental destructive commands regardless of capabilities or sandbox status.

**Blocked patterns:**

| Pattern | Example | Why It's Blocked |
|---------|---------|-----------------|
| Recursive delete of root/home/system dirs | `rm -rf /`, `rm -rf ~` | Filesystem wipe |
| Force push to main/master | `git push --force main` | Overwrites shared git history |
| Hard reset | `git reset --hard` | Discards uncommitted work |
| DROP TABLE/DATABASE/SCHEMA | `DROP TABLE users` | Irreversible database destruction |
| chmod -R 777 | `chmod -R 777 /var` | Permission blowout |
| mkfs/format on device | `mkfs.ext4 /dev/sda` | Destroys all data on device |
| Fork bomb | `:(){ :|:& };:` | Exhausts system resources |
| curl/wget piped to shell | `curl url \| sh` | Remote code execution |

**Overriding:** If a spell step legitimately needs to run a blocked command, set `allowDestructive: true` in the step config. This should be rare and intentional.

```yaml
steps:
  - id: dangerous-but-necessary
    type: bash
    config:
      command: "git reset --hard origin/main"
      allowDestructive: true  # Bypasses denylist for this step only
```

### Layer 2: Capability Gateway (all platforms)

Every step command declares capabilities (`fs:read`, `fs:write`, `net`, `shell`, etc.) and the CapabilityGateway enforces them at runtime. See the sections above for full details.

This layer prevents steps from accessing resources they didn't declare — a step without `net` capability cannot make HTTP requests, a step without `fs:write` cannot create files.

### Layer 3: OS-Level Process Isolation (macOS and Linux)

On macOS and Linux, MoFlo automatically wraps bash steps in an OS-level sandbox that enforces capability restrictions at the process level. This is the strongest layer — even if a command finds a way around the gateway, the OS blocks the operation.

| Platform | Tool | How It Works | Overhead |
|----------|------|-------------|----------|
| **macOS** | `sandbox-exec` | Apple Seatbelt profiles restrict filesystem and network access | Low |
| **Linux** | `bwrap` (bubblewrap) | Linux namespaces with read-only root bind, PID isolation, network unsharing | Low |
| **Windows** | Docker Desktop | Runs each bash step inside a Linux container | Medium |

**What the OS sandbox enforces:**
- Filesystem is read-only by default — only paths granted via `fs:write` become writable
- Network access is blocked unless the step declares `net` capability
- PID namespace is isolated (Linux/Docker) — the step cannot see or signal other processes
- Graceful fallback — if the sandbox tool isn't installed or fails to start, the step runs unsandboxed with an info log

### Platform Security Comparison

| Protection | Windows (Docker) | macOS | Linux |
|-----------|---------|-------|-------|
| Command denylist | Yes | Yes | Yes |
| Capability gateway | Yes | Yes | Yes |
| OS filesystem isolation | Yes (container mounts) | Yes (sandbox-exec) | Yes (bwrap) |
| OS network isolation | Yes (`--network none`) | Yes (sandbox-exec) | Yes (bwrap) |
| OS process isolation | Yes (container PID ns) | No | Yes (bwrap --unshare-pid) |

**Windows users:** With Docker Desktop enabled, Windows gets full OS-level isolation. Without Docker, Layers 1 and 2 still provide meaningful protection — the denylist catches catastrophic mistakes, and the gateway enforces capability boundaries in code. Review spell permissions carefully, especially for spells from untrusted sources.

### Configuring Sandboxing in `moflo.yaml`

OS-level process isolation is controlled by the `sandbox:` block in your project's `moflo.yaml`:

```yaml
sandbox:
  enabled: false     # Set to true to wrap bash steps in an OS sandbox
  tier: auto         # auto | denylist-only | full
```

**Defaults:** `enabled: false`, `tier: auto`. When enabled is `false`, only Layers 1 and 2 (denylist + capability gateway) apply — bash steps run unwrapped.

**Tiers:**

| Tier | Behavior |
|------|----------|
| `auto` | Use the best available sandbox for the platform (`sandbox-exec` on macOS, `bwrap` on Linux/WSL, Docker on Windows). Falls back to denylist-only if unavailable. Recommended when `enabled: true`. |
| `denylist-only` | Skip OS sandboxing even if available — Layer 1 denylist still blocks catastrophic commands. |
| `full` | Require full OS isolation; `resolveEffectiveSandbox()` throws if the sandbox tool is not installed. Use this when a security policy requires OS isolation. |

**On upgrade:** If your `moflo.yaml` predates the `sandbox:` block, MoFlo appends it with default values + inline comments on the next session start. Your existing values in other sections are left untouched. You never need to re-run `moflo init`.

### Windows Docker Setup

On Windows, OS-level sandboxing runs each bash step inside a Docker container. This requires a one-time setup:

1. **Install Docker Desktop** (free): https://www.docker.com/products/docker-desktop/

2. **Start Docker Desktop** from the Start menu. Wait for the whale icon in the system tray to stop animating — that means Docker is ready.

3. **Pull an image.** Open PowerShell and run:
   ```
   docker pull node:20-bookworm-slim
   ```
   The recommended image (`node:20-bookworm-slim`) includes node, npm, bash, git, and curl. Any image with bash will work.

4. **Add to `moflo.yaml`:**
   ```yaml
   sandbox:
     enabled: true
     dockerImage: node:20-bookworm-slim
   ```

5. **Verify** with `flo doctor sandbox`. You should see:
   ```
   ✓ Sandbox Tier — docker ready (win32, node:20-bookworm-slim)
   ```

**How the Docker sandbox works:**

- Your project is mounted read-only at `/workspace` inside the container. Only paths granted via `fs:write` become writable (via overlay mounts on specific subdirectories).
- Network access is blocked (`--network none`) unless the step declares the `net` capability or uses `permissionLevel: elevated`/`autonomous`.
- Elevated/autonomous steps get writable mounts for tool config paths (`~/.claude`, `~/.config/gh`, `~/.gitconfig`, etc.) so spawned tools like `claude`, `gh`, and `git` can persist their state.
- Containers are removed automatically after each step (`--rm`).

### Checking Your Sandbox Tier

Run `flo doctor` to see which sandbox tier is active on your system:

```
flo doctor sandbox
```

This reports the detected sandbox tool and platform, or warns if only the denylist is available.

## See Also

- [Spell Engine](SPELLS.md) — Full spell engine documentation, including the CapabilityGateway section
- [Build & Publish](BUILD.md) — Building and publishing MoFlo
