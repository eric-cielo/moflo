# Spell Step Sandboxing — Capability-Based Security

**Purpose:** Enforce least-privilege access for spell steps. Every step command declares its required capabilities; the runner blocks undeclared access. Follow these rules when writing, reviewing, or executing spell steps.

---

## Execution Constraint Principle

**When executing within a spell, Claude MUST only perform actions explicitly authorized by the spell definition, step configuration, and declared capabilities. No exceptions.**

This is the foundational security contract between moflo and the user:

| Rule | Detail |
|------|--------|
| **Only do what the step says** | A step's `config` defines the complete scope of work. Do not infer, extrapolate, or add actions beyond what `config` specifies. A `bash` step with `command: "npm test"` runs `npm test` — nothing else. |
| **Respect all capability restrictions** | If a step's capabilities restrict `fs:read` to `["./config/"]`, do not read files outside that path, even if doing so would "help" the spell succeed. |
| **Never escalate privileges** | Do not attempt to work around a `CAPABILITY_DENIED` error by using an alternative method. If a capability is denied, that denial is intentional. Report it and stop. |
| **No implicit side effects** | Do not perform actions that are not declared in the spell. No creating files, making network requests, spawning agents, or modifying state unless a step explicitly authorizes it. |
| **Scheduled spells are not trusted more than manual ones** | A spell triggered by the daemon on a cron schedule has the same restrictions as one run manually. Automation does not grant additional permissions. |
| **Treat the spell definition as the complete specification** | If the spell definition does not instruct an action, that action is not authorized. Silence means "no", not "use your judgment." |

**Why this matters:** Users must be able to trust that a spell does exactly what its definition says — no more, no less. This predictability is what makes automated and scheduled spells safe to deploy. If Claude improvises beyond the definition, the capability system becomes advisory rather than authoritative, and user confidence breaks.

---

## Capability Types

**Every step command MUST declare the capabilities it needs.** Steps without declared capabilities (condition, loop, wait) are pure computation and access nothing.

| Capability | Grants | Used By |
|-----------|--------|---------|
| `fs:read` | Read files from disk | bash, browser (screenshots) |
| `fs:write` | Write files to disk | bash, browser (screenshots) |
| `net` | Network access (HTTP, WebSocket) | browser |
| `shell` | Execute shell commands | bash |
| `memory` | Read/write/search spell memory | memory |
| `credentials` | Access encrypted credential store | (any step using `{credentials.X}`) |
| `browser` | Launch and control browser sessions | browser |
| `agent` | Spawn Claude subagents | agent |

---

## Declaring Capabilities on Step Commands

**Add `capabilities` to every new step command.** Control-flow commands (condition, loop, wait) that perform no I/O may omit it.

```typescript
export const myCommand: StepCommand = {
  type: 'my-command',
  description: '...',
  capabilities: [
    { type: 'fs:read' },
    { type: 'net', scope: ['api.example.com'] },
  ],
  // ...
};
```

| Rule | Detail |
|------|--------|
| Declare all capabilities the command uses | Missing declarations will block execution when YAML restricts them |
| Use `scope` to narrow defaults | `{ type: 'fs:read', scope: ['./config/'] }` limits reads to that directory |
| Never declare capabilities the command doesn't use | Extra declarations weaken the security boundary |

---

## Restricting Capabilities in Spell YAML

**Spell authors can restrict (never expand) a command's capabilities per step.** This is how operators limit what a specific step instance can do.

```yaml
steps:
  - id: read-config
    type: bash
    capabilities:
      fs:read: ["./config/"]
      shell: ["cat", "jq"]
    config:
      command: "cat config/settings.json | jq '.database'"
```

| Rule | Behavior |
|------|----------|
| Restriction narrows scope | `fs:read: ["./config/"]` limits to that directory, even if command allows all |
| Cannot grant new types | YAML `capabilities` listing `browser` on a `bash` step is a violation — runner blocks it |
| Omitted types inherit command defaults | If YAML only restricts `fs:read`, `shell` and `fs:write` are inherited as-is |

---

## Enforcement at Runtime — Two Layers

Capability enforcement happens at two distinct points:

### Layer 1: Declaration Check (Pre-Execution)

**The runner checks capabilities AFTER validation, BEFORE execution.** If any declared YAML capability is not in the command's defaults, execution is blocked with `CAPABILITY_DENIED`.

```
Step lifecycle:
  1. Get command from registry
  2. Interpolate config variables
  3. Validate config (command.validate)
  4. CHECK CAPABILITIES ← declaration enforcement
  5. Execute step via CapabilityGateway ← runtime enforcement
```

A declaration violation includes the specific error:
```
Capability violation: [browser] step type "bash" does not declare capability "browser" — cannot grant new capabilities
```

### Layer 2: CapabilityGateway (Runtime Enforcement)

**Declaration checks validate configuration. The CapabilityGateway enforces scope at the point of I/O.** This is the actual security boundary.

The gateway is injected into every step's `WorkflowContext`. Step commands MUST call the gateway before performing any I/O:

```typescript
context.gateway.checkShell(command, context);    // Before spawning a process
context.gateway.checkNet(url, context);           // Before HTTP/WebSocket requests
context.gateway.checkFs(path, 'read', context);   // Before reading a file
context.gateway.checkFs(path, 'write', context);  // Before writing a file
context.gateway.checkAgent(config, context);      // Before spawning a subagent
context.gateway.checkMemory(namespace, context);  // Before memory store access
```

Each method calls `enforceScope()` internally. If the resource is outside the step's effective scope, a `CapabilityDeniedError` is thrown and the I/O never happens.

**Why both layers?** Declaration checks catch YAML configuration mistakes early (before any step runs). The gateway catches actual scope violations at runtime (e.g., a `bash` step with `shell: ["cat"]` trying to run `rm`). Without the gateway, capabilities are advisory — a step declares what it should do, but nothing prevents it from doing more.

### Current Enforcement Status

| Command | Gateway Calls | Status |
|---------|--------------|--------|
| `bash` | `checkShell()` | **Enforced** |
| `browser` | `checkBrowserEvaluate()`, `checkNet()` | **Enforced** |
| `memory` | `checkMemory()` | **Enforced** |
| `agent` | `checkAgent()` | **Enforced** (#258) |
| `github` | `checkShell()` | **Enforced** (#258) |
| Connectors | `checkNet()` via `GatedConnectorAccessor` | **Enforced** (#265) |
| Credentials | `checkCredentials()` | **Enforced** (#268) |
| Control flow (`condition`, `loop`, `parallel`, `composite`) | N/A | No I/O — child steps individually checked |
| `wait`, `prompt` | N/A | No dangerous capabilities |

**Gateway is non-optional** (#266): `WorkflowContext.gateway` is required. A `DenyAllGateway` is the default — any code path that reaches a gateway check without going through `step-executor` (which installs a properly-scoped gateway) will fail loudly rather than silently skipping enforcement.

---

## Writing New Step Commands: Capability Checklist

1. **List every OS/runtime resource the command accesses** — files, network, subprocesses, memory store
2. **Map each resource to a capability type** from the table above
3. **Add `capabilities` array to the StepCommand object**
4. **Use `scope` for commands that access specific paths or hosts** by default
5. **Call the CapabilityGateway before every I/O operation** — `context.gateway.checkX()` must precede the actual call
6. **Test that restricting capabilities in YAML produces the expected effective caps**
7. **Test that granting undeclared capabilities is blocked**
8. **Test that scope violations at runtime are blocked by the gateway**

---

## Schema Validation

**The schema validator checks `capabilities` syntax at definition load time.** Invalid capability types or non-array scopes produce validation errors before the spell even starts.

| Check | Error |
|-------|-------|
| Unknown capability type | `unknown capability type: "teleport". Valid types: fs:read, fs:write, ...` |
| Scope is not an array | `scope must be an array of strings` |
| Scope contains non-strings | `all scope values must be strings` |
| Capabilities is not an object | `capabilities must be an object mapping capability types to scope arrays` |

---

## Permission Levels (Least-Privilege Escalation)

When a spell step spawns Claude via `claude -p`, the engine applies **least-privilege permission escalation**. The `--dangerously-skip-permissions` flag is always passed (required for non-interactive mode), but `--allowedTools` restricts what Claude can actually do.

| Level | `--allowedTools` | Derived When |
|-------|-----------------|--------------|
| `readonly` | `Read,Glob,Grep` | Step has no shell/write/agent capabilities |
| `standard` | `Edit,Write,Read,Glob,Grep` | Step has `fs:write` or `agent` capability |
| `elevated` | `Edit,Write,Bash,Read,Glob,Grep` | Step has `shell` or `browser` capability |
| `autonomous` | *(no restriction)* | **Explicit opt-in only** via `permissionLevel: autonomous` |

Steps can override with `permissionLevel` in YAML:

```yaml
- id: implement-story
  type: bash
  permissionLevel: elevated
  config:
    command: "claude -p 'Implement the feature'"
```

The engine **automatically rewrites** `claude -p` commands in bash steps — stripping any hardcoded permission flags and injecting the resolver's output. YAML authors write clean commands; the engine handles permission flags.

### Permission Disclosure and Acceptance

- **Dry runs** always show a full permission report: per-step permission level, risk classification (safe/sensitive/destructive), and specific warnings for dangerous capabilities.
- **New spells** require user acceptance of the permission profile before first real run.
- **Acceptance is stored** (`.moflo/accepted-permissions/`) as a hash of the permission profile. It persists until a permission-affecting edit changes the hash.
- **Regular runs** skip verbose permission output — the acceptance gate checks the stored hash silently.

### Risk Classification

| Classification | Capabilities | Meaning |
|---------------|-------------|---------|
| **[SAFE]** | `fs:read`, `memory` | No side effects — analysis only |
| **[SENSITIVE]** | `agent`, `net`, `browser` | Can read external data or spawn processes |
| **[DESTRUCTIVE]** | `shell`, `fs:write`, `browser:evaluate`, `credentials` | Can permanently modify/delete data |

## OS-Level Sandbox Configuration (`moflo.yaml`)

Capabilities and the gateway always apply. An **additional** OS-level process sandbox (Layer 3) wraps bash steps on macOS (`sandbox-exec`) and Linux/WSL (`bwrap`). It is controlled by the `sandbox:` block in `moflo.yaml`:

```yaml
sandbox:
  enabled: false   # Master toggle — false = OS sandbox off (denylist + gateway still apply)
  tier: auto       # auto | denylist-only | full
```

Semantics (from `resolveEffectiveSandbox()` in `src/modules/spells/src/core/platform-sandbox.ts`):

| `enabled` | `tier` | Tool available | OS sandbox runs? | Notes |
|-----------|--------|----------------|------------------|-------|
| `false` | (any) | (any) | No | **Absolute disable** — master toggle wins |
| `true` | `auto` | Yes | Yes | Use detected tool (bwrap/sandbox-exec) |
| `true` | `auto` | No | No | Graceful fallback; logs "not available" |
| `true` | `denylist-only` | (any) | No | Layer 1 only, skip OS isolation |
| `true` | `full` | Yes | Yes | Require OS sandbox |
| `true` | `full` | No | — | **Throws** at spell start |

Existing projects that predate this block get it auto-appended on session start — never require `moflo init` to re-run after a version bump.

## Authoring Checklist — Always Double-Check Step Permissions

Before shipping any new or edited spell step, walk through every item. Silently-missing permissions don't fail with `CAPABILITY_DENIED` — they fail confusingly several steps later.

1. **What does the command actually do?** List every external effect — file reads/writes, git/gh calls, outbound HTTP, Claude subagents, credential use.
2. **Which capabilities map to those effects?** `fs:read`, `fs:write`, `shell`, `net`, `credentials`, `agent`, `browser`, `memory`.
3. **What is the minimum `permissionLevel`?**
   - Pure analysis (read only) → `readonly`
   - Edits project files but no shell/network → `standard`
   - Runs shell commands, **or needs network inside a bwrap-sandboxed step** → `elevated`
   - Spawns Claude subagents with unrestricted tools → `autonomous`
4. **Does this step need network?** If so, either give it `permissionLevel: elevated` or declare the `net` capability explicitly. See the Troubleshooting section — bwrap strips network from any bash step that has neither, and the failure surfaces as a DNS error, not a permission error.
5. **Does the command chain multiple statements (`;`, `&&`, `||`)?** Lead the command with `set -e`. A trailing tolerated-failure cleanup like `git stash pop ... || true` will otherwise return 0 for the whole step even when the real work (checkout, pull, push) failed.
6. **Does this step produce state that later steps rely on?** If this step silently no-ops, will the downstream symptom be understandable? If not, tighten the failure mode (`set -e`, explicit error, `failOnError: true`).

When reviewing a spell PR, scan every bash step for a missing `permissionLevel` and ask: *does this step touch the network, or does it depend on network state from earlier?* If yes, `elevated` (or an explicit `net` grant) is required.

## Troubleshooting

### Symptom: bash step fails with DNS / SSH resolution errors inside a spell

Typical error messages from inside a bash step:

- `ssh: Could not resolve hostname github.com: Temporary failure in name resolution`
- `fatal: Could not read from remote repository.`
- `curl: (6) Could not resolve host ...`
- `getaddrinfo ENOTFOUND ...`
- Any other DNS/connection failure, even though the **same command works in your normal shell**.

**Tell-tale clue:** the error mentions `Temporary failure in name resolution` (a glibc-specific wording). That means the step is running inside a Linux sandbox (`bwrap` on Linux / WSL), **not** your outer shell — Git Bash or PowerShell won't produce that exact message.

**Root cause:** `src/modules/spells/src/core/bwrap-sandbox.ts` isolates the network by default:

```ts
if (!hasNet && !needsToolHomeAccess(options.permissionLevel)) {
  args.push('--unshare-net');   // ← no network, no DNS
}
```

A bash step gets network access only when **one** of these is true:

1. The step declares a `net` capability, **or**
2. The step's `permissionLevel` is `elevated` or `autonomous`.

If neither applies, bwrap runs the command in a namespace with `--unshare-net`, and DNS silently fails. There is no log line announcing the network was taken away — you just see the command's own DNS error.

**Fix:** for any bash step that does `git pull`/`git push`/`git fetch`, `gh` API calls, `curl`, `npm install`, or any other outbound network:

```yaml
- id: create-branch
  type: bash
  permissionLevel: elevated       # ← grants network in bwrap
  config:
    command: "git pull origin main && ..."
```

Or declare the `net` capability explicitly if the step doesn't need the full `elevated` profile (note: `bash-command.ts` must include `net` in its declared capabilities for the engine to accept the grant — otherwise you'll see `Capability violation: step type "bash" does not declare capability "net"`).

**Quick diagnosis checklist** when a spell's bash step can't reach the network:

1. Does the same command work in your outer shell? If yes, it's sandbox-related, not config.
2. Is the error wording glibc-style (`Temporary failure in name resolution`)? → bwrap is involved.
3. Open the spell YAML — does the failing step have `permissionLevel: elevated`? If not, add it and retry.
4. If you use `set -e` in a multi-command bash step, **do it**. Without it, a trailing `... || true` (common for stash-pop cleanups) will mask the real network failure and you'll see a confusing error several steps later (e.g. "pathspec did not match" when a branch that was never pulled/created is later checked out).

## See Also

- `.claude/guidance/shipped/moflo-spell-engine.md` — Spell engine usage and YAML format
- `.claude/guidance/shipped/moflo-spell-connectors.md` — Optional resource adapters (not the enforcement layer)
- `.claude/guidance/shipped/moflo-spell-engine-architecture.md` — Engine architecture and messaging
- `.claude/guidance/shipped/moflo-core-guidance.md` — Full CLI/MCP reference
- `src/modules/spells/src/core/permission-resolver.ts` — Capability → permission level derivation
- `src/modules/spells/src/core/permission-disclosure.ts` — Risk classification and reporting
- `src/modules/spells/src/core/permission-acceptance.ts` — Acceptance storage and gate
