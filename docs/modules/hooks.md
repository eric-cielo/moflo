# cli/hooks

> **Inlined into `@moflo/cli` by [#599](https://github.com/eric-cielo/moflo/issues/599)** (epic [#586](https://github.com/eric-cielo/moflo/issues/586) / [ADR-0001](../adr/0001-collapse-moflo-workspace-packages.md)). The `@moflo/hooks` workspace package no longer exists — its contents live at `src/cli/hooks/` and ship inside the `moflo` tarball.

The V3 hooks system: lifecycle event registry + executor, ReasoningBank pattern learning, background daemons, statusline integration, and the cross-platform worker manager.

## Where things live

| Concern | Path |
|---------|------|
| Source | `src/cli/hooks/` |
| Public surface | `src/cli/hooks/index.ts` (re-exports registry, executor, daemons, statusline, workers, ReasoningBank, MCP tools, official-hooks bridge, swarm communication) |
| Types | `src/cli/hooks/types.ts` (HookEvent, HookPriority, HookContext, HookResult, …) |
| Registry | `src/cli/hooks/registry/` |
| Executor | `src/cli/hooks/executor/` |
| Daemons | `src/cli/hooks/daemons/` (DaemonManager, MetricsDaemon, SwarmMonitorDaemon, HooksLearningDaemon) |
| ReasoningBank | `src/cli/hooks/reasoningbank/` (vector-indexed pattern learning, GuidanceProvider) |
| Statusline | `src/cli/hooks/statusline/` |
| MCP tools | `src/cli/hooks/mcp/` |
| Bridge | `src/cli/hooks/bridge/official-hooks-bridge.ts` (V3 ↔ Claude Code official hook API) |
| Swarm comm | `src/cli/hooks/swarm/` (agent-to-agent messaging via cli/swarm MessageBus) |
| Workers | `src/cli/hooks/workers/` (cross-platform background worker manager) |
| Bin scripts | `bin/cli-hooks/{hooks-daemon,statusline}.js` |
| Tests | `src/cli/__tests__/hooks/` |

## Internal usage

The cli imports hooks via direct relative paths (no `@moflo/hooks` bare specifier, no walk-up resolver):

```ts
// From cli source:
import { HookRegistry, HookEvent, HookPriority } from '../hooks/index.js';
import type { HookContext, HookResult } from '../hooks/index.js';
```

After collapse, hooks-side cross-package walk-ups (`locateCliMemory`, `locateCliEmbeddings`, `locateSwarmArtifact`) are deleted — `cli/src/hooks/reasoningbank/` and `cli/src/hooks/swarm/` use direct relative imports into `cli/src/memory/`, `cli/src/embeddings/`, and `cli/src/swarm/message-bus/` respectively.
