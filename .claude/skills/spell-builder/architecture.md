# Spell Engine Architecture — Layers, Composition, and Extension Points

**Purpose:** Understand the layered architecture of the spell engine before creating or modifying spells, step commands, or connectors. This document defines how the pieces fit together — read it when you need to decide WHERE to put new functionality.

---

## The Three Layers

The spell engine has three distinct layers. Each layer has a specific job and should not take on the responsibilities of another.

| Layer | Job | Example |
|-------|-----|---------|
| **Spell definition** (YAML) | Declares WHAT to do — step sequence, data flow, arguments | `outlook-attachment-processor.yaml` |
| **Step command** (TypeScript) | Validates config, delegates to connectors, maps outputs | `outlook-command.ts` wraps `local-outlook` connector |
| **Connector** (TypeScript) | Knows HOW to talk to a platform — selectors, protocols, auth | `local-outlook.ts` knows Outlook.com's DOM structure |

### Layer responsibilities

**Spell definitions** are user-authored YAML. They compose step commands into workflows using `{stepId.outputKey}` data flow. They should NEVER contain platform-specific knowledge (DOM selectors, API endpoints, auth flows). If a spell needs to know how something works internally, that knowledge belongs in a connector.

**Step commands** are thin orchestrators. They:
1. Validate config (required fields, valid values)
2. Delegate to one or more connectors via `context.tools.execute()`
3. Map connector output to step output
4. Declare capabilities and prerequisites

Step commands should NOT contain platform interaction logic. If you find yourself writing HTTP calls, DOM queries, or CLI invocations directly in a step command, extract that into a connector.

**Connectors** encapsulate all platform-specific knowledge:
- DOM selectors and navigation patterns (browser connectors)
- API endpoints, headers, and response parsing (HTTP connectors)
- CLI flags and output parsing (CLI connectors)
- Auth flows and token management

Connectors are the only layer that should change when a platform updates its UI or API.

---

## How the Layers Connect

```
Spell YAML                Step Command              Connector
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ steps:       │     │ outlook-command   │     │ local-outlook   │
│  - type:     │────>│  validate()      │     │                 │
│    outlook   │     │  execute() ──────│────>│  read-inbox()   │
│    config:   │     │    delegates to   │     │  send-email()   │
│      action: │     │    connector via  │     │  download()     │
│      read-   │     │    context.tools  │     │                 │
│      inbox   │     │  describeOutputs()│     │  SELECTORS = {} │
└─────────────┘     └──────────────────┘     │  (DOM knowledge)│
                                              └─────────────────┘
```

**Key principle:** Connectors are reusable across step commands AND agent steps. An `agent` step can access the same connector via `context.tools.execute('local-outlook', 'read-inbox', {...})`. This means connector knowledge isn't locked behind a specific step type.

---

## When to Create What

| You need to... | Create a... | Example |
|----------------|-------------|---------|
| Automate a new workflow | Spell definition (YAML) | `outlook-attachment-processor.yaml` |
| Add a new step `type:` to spell YAML | Step command (TypeScript) | `outlook-command.ts` |
| Teach moflo how to talk to a new platform | Connector (TypeScript) | `local-outlook.ts` |
| Add an action to an existing platform | New action in the existing connector | Add `forward-email` to `local-outlook.ts` |
| Use an existing platform in a new way | Spell definition composing existing steps | New YAML using existing `outlook` steps |

### Decision tree for new integrations

1. **Does a connector already exist for this platform?**
   - Yes → Use the existing connector. Create a spell or step command.
   - No → Create a connector first, then a step command, then spells.

2. **Is this a new I/O transport type?** (WebSocket, gRPC, MQTT)
   - Yes → Use `/connector-builder` to scaffold a generalized connector.
   - No → Build a platform-specific connector using an existing transport (HTTP, browser, CLI).

3. **Is this a per-service wrapper?** (Slack, Jira, S3)
   - **Compose existing connectors in spell YAML** — do NOT create a per-service connector for every SaaS product. A Slack integration is just the `http` connector pointed at Slack's API.
   - Exception: If the service requires complex multi-step interaction (like Outlook.com's web UI), a dedicated connector is justified.

---

## Connector Types

Connectors fall into three categories based on how they interact with the platform:

| Type | How it works | Example |
|------|-------------|---------|
| **Browser-based** | Drives a real browser via Playwright persistent context | `local-outlook` (Outlook.com web UI) |
| **API-based** | Makes HTTP/REST/GraphQL calls | `http` (generic), future `graph-api` |
| **CLI-based** | Wraps a command-line tool | `github-cli` (wraps `gh`) |

Browser-based connectors are the "no-setup" option — they use the platform exactly as a human would, with no API keys or OAuth. They trade reliability (DOM changes break them) for accessibility (just sign in once).

---

## Connector Anatomy

Every connector implements the `SpellConnector` interface:

```typescript
interface SpellConnector {
  name: string;           // Unique identifier (e.g., 'local-outlook')
  description: string;    // What this connector does
  version: string;        // Semver
  capabilities: ('read' | 'write' | 'search' | 'subscribe' | 'authenticate')[];

  initialize(config): Promise<void>;    // Set up connections/auth
  dispose(): Promise<void>;             // Clean up
  execute(action, params): Promise<ConnectorOutput>;  // Run an action
  listActions(): ConnectorAction[];     // Self-describe available actions
}
```

**Key design rules for connectors:**
- **Stateless between execute() calls** — don't cache page state
- **Self-describing** — `listActions()` returns schemas so agents can discover capabilities
- **Platform knowledge centralized** — all selectors, endpoints, and interaction patterns in ONE file
- **Graceful degradation** — return `{ success: false, error: '...' }`, don't throw

---

## Data Flow in Spells

Steps communicate through output variables:

```yaml
steps:
  - id: read-inbox
    type: outlook
    config:
      action: read-inbox
      limit: 10
    output: inbox          # ← stores output as "inbox"

  - id: process
    type: agent
    config:
      prompt: |
        Emails: {inbox.emails}            # ← references inbox output
        Total: {inbox.totalEmails}
```

**Variable reference rules:**
- `{stepId.outputKey}` — output from a previous step (no forward references)
- `{args.name}` — spell argument
- `{credentials.NAME}` — runtime credential
- `{item.field}` — current loop iteration item

---

## Documentation Rules for New Components

**Every new step, connector, or spell MUST include a README.md.** Apply the rules in `.claude/guidance/internal/guidance-rules.md` automatically — do not wait for the user to ask. Use existing READMEs in `steps/` and `connectors/` as templates.

**Where to put the README:**
- Steps: `.claude/skills/spell-builder/steps/<name>/README.md`
- Connectors: `.claude/skills/spell-builder/connectors/<name>/README.md`

These files ship with moflo and are consumed by Claude to understand available spell components.

---

## File Locations

| What | Where |
|------|-------|
| Step commands | `src/cli/spells/commands/` |
| Connectors | `src/cli/spells/connectors/` |
| Type definitions | `src/cli/spells/types/` |
| Shipped spells | `spells/shipped/` |
| User spells | `spells/` or `.claude/spells/` |
| Step command registry | `src/cli/spells/core/step-command-registry.ts` |
| Connector registry | `src/cli/spells/core/connector-registry.ts` |

---

## See Also

- `steps/<name>/README.md` — self-contained reference per step command (scan with `Glob`)
- `connectors/<name>/README.md` — self-contained reference per connector (scan with `Glob`)
- `SKILL.md` — spell builder main skill file
- `src/cli/spells/types/spell-connector.types.ts` — connector interface
- `src/cli/spells/types/step-command.types.ts` — step command interface
