# Workflow Connectors — Generalized I/O Wrappers

**Purpose:** When and how to use connectors in the workflow engine. Connectors are generalized I/O wrappers (HTTP, CLI, browser) that enforce security and sandboxing boundaries — not per-service adapters.

---

## Architecture: Generalized Wrappers, Not Per-Service Adapters

**Connectors are a small set of generalized I/O wrappers** — one for HTTP, one for CLI tools, one for browser automation. Service-specific logic (Slack, Jira, S3, etc.) is composed in workflow YAML using these generalized connectors, not by creating a new TypeScript connector for each service.

| Layer | Purpose | Examples |
|-------|---------|---------|
| **Connector** (generalized) | I/O channel with security enforcement | `http`, `github-cli`, `playwright` |
| **Workflow YAML** (service-specific) | Composes connectors into service operations | Slack posting via `http`, DB migration via `bash` |
| **CapabilityGateway** (enforcement) | Structural scope checks on all I/O | Blocks unauthorized URLs, commands, file paths |

**Do NOT create a connector for each external service.** Instead, compose the built-in connectors in workflow steps. A Slack integration is an `http` connector call with the Slack API URL and token — not a `slack` connector.

This design was established in issues #233–#259: the original per-service connector approach (Slack, OneDrive, Gmail, Google Drive — #234–#237) was superseded by generalized wrappers with capability enforcement (#254, #257, #258, #259).

---

## Connectors Enforce Security Boundaries

Connectors work with the CapabilityGateway to enforce scope restrictions:

| Concern | Handled By |
|---------|-----------|
| Blocking unauthorized I/O at runtime | **CapabilityGateway** (structural, all commands) |
| Checking declared vs effective capabilities | **capability-validator.ts** (pre-execution) |
| Scoped I/O channel with sandboxing | **Connectors** (generalized wrappers) |

The gateway blocks unauthorized operations; connectors provide the controlled I/O channels through which authorized operations flow.

---

## Connector Execution Constraints

**Connectors follow the same execution constraint principle as steps: only perform the specific action requested with the specific parameters provided.** A connector's `execute(action, params)` call defines the complete scope of the operation. Do not add extra API calls, modify request parameters, or perform side-effect operations beyond what the action specifies.

---

## When to Create a Connector vs Compose Existing Ones

| You want to... | Do this | Why |
|----------------|---------|-----|
| Call a REST API | Use `http` connector in workflow YAML | Already handles GET/POST/PUT/DELETE/GraphQL |
| Run CLI commands | Use `bash` step or `github-cli` connector | Already handles shell execution with scope enforcement |
| Automate a browser | Use `playwright` connector | Already handles navigation, clicks, fills, screenshots |
| Integrate a new external service (Slack, Jira, etc.) | **Compose existing connectors in YAML** | Service-specific logic belongs in workflow definitions |
| Add a fundamentally new I/O channel (e.g., WebSocket, gRPC) | **Create a new generalized connector** | Only when no existing connector covers the I/O type |

**Key rule: only create a new connector for a new I/O transport type.** Service-specific workflows compose existing connectors — they don't create new ones.

---

## The WorkflowConnector Interface

**Every connector MUST implement this interface.** The runner manages lifecycle; steps access connectors read-only via `ConnectorAccessor`.

```typescript
interface WorkflowConnector {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly capabilities: readonly ConnectorCapability[];  // 'read'|'write'|'search'|'subscribe'|'authenticate'

  initialize(config: Record<string, unknown>): Promise<void>;
  dispose(): Promise<void>;
  execute(action: string, params: Record<string, unknown>): Promise<ConnectorOutput>;
  listActions(): ConnectorAction[];
}
```

**Steps never call `initialize()` or `dispose()`.** They see only the `ConnectorAccessor` interface:

```typescript
const result = await context.tools.execute('github-cli', 'create-issue', {
  title: 'Bug report',
  body: 'Details here',
});
```

---

## Built-in Connectors

Three connectors ship with moflo. They are registered automatically by `createRunner()`.

| Connector | Name | Actions | Capabilities |
|-----------|------|---------|-------------|
| HTTP | `http` | `get`, `post`, `put`, `delete`, `graphql` | `read`, `write` |
| GitHub CLI | `github-cli` | `run` (arbitrary `gh` command) | `read`, `write` |
| Playwright | `playwright` | `goto`, `click`, `fill`, `screenshot`, `evaluate` | `read`, `write` |

---

## Connector Registry and Discovery

**Connectors are discovered from two sources with priority ordering.**

| Priority | Source | Location |
|----------|--------|----------|
| Highest | User connectors | `workflows/connectors/` or `.claude/workflows/connectors/` |
| Lower | Shipped connectors | Bundled with moflo |

**User connectors override shipped connectors by name.** A user `github-cli.js` replaces the built-in one.

---

## Writing a Custom Connector (Rare — New I/O Transports Only)

**You almost certainly don't need a new connector.** The three built-in connectors (HTTP, GitHub CLI, Playwright) cover web APIs, CLI tools, and browser automation. Service-specific integrations should be composed as workflow YAML using these existing connectors.

Only create a new connector when you need a fundamentally new I/O transport (e.g., WebSocket streams, gRPC, MQTT) that no existing connector supports.

If you do need one:

1. **Implement all four methods** — `initialize`, `dispose`, `execute`, `listActions`
2. **Keep it generalized** — wrap the transport, not a specific service
3. **Declare capabilities honestly** — only list what the connector actually does
4. **Provide JSON schemas in `listActions()`** — enables dry-run validation
5. **Handle errors in `execute()`** — return `{ success: false, data: { error: '...' } }`, never throw
6. **Clean up in `dispose()`** — close connections, pools
7. **Place the file in `workflows/connectors/`**

---

## See Also

- `.claude/guidance/shipped/moflo-workflow-sandboxing.md` — CapabilityGateway and enforcement rules
- `.claude/guidance/shipped/moflo-workflow-engine.md` — Running workflows, step command types
- `.claude/guidance/shipped/moflo-workflow-engine-architecture.md` — Architecture decisions
