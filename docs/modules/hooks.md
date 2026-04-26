# cli/hooks

> **Inlined into `@moflo/cli` by [#599](https://github.com/eric-cielo/moflo/issues/599)** (epic [#586](https://github.com/eric-cielo/moflo/issues/586) / [ADR-0001](../adr/0001-collapse-moflo-workspace-packages.md)). The `@moflo/hooks` workspace package no longer exists — its contents live at `src/modules/cli/src/hooks/` and ship inside the `moflo` tarball.

The V3 hooks system: lifecycle event registry + executor, ReasoningBank pattern learning, background daemons, statusline integration, and the cross-platform worker manager.

## Where things live

| Concern | Path |
|---------|------|
| Source | `src/modules/cli/src/hooks/` |
| Public surface | `src/modules/cli/src/hooks/index.ts` (re-exports registry, executor, daemons, statusline, workers, ReasoningBank, MCP tools, official-hooks bridge, swarm communication) |
| Types | `src/modules/cli/src/hooks/types.ts` (HookEvent, HookPriority, HookContext, HookResult, …) |
| Registry | `src/modules/cli/src/hooks/registry/` |
| Executor | `src/modules/cli/src/hooks/executor/` |
| Daemons | `src/modules/cli/src/hooks/daemons/` (DaemonManager, MetricsDaemon, SwarmMonitorDaemon, HooksLearningDaemon) |
| ReasoningBank | `src/modules/cli/src/hooks/reasoningbank/` (vector-indexed pattern learning, GuidanceProvider) |
| Statusline | `src/modules/cli/src/hooks/statusline/` |
| MCP tools | `src/modules/cli/src/hooks/mcp/` |
| Bridge | `src/modules/cli/src/hooks/bridge/official-hooks-bridge.ts` (V3 ↔ Claude Code official hook API) |
| Swarm comm | `src/modules/cli/src/hooks/swarm/` (agent-to-agent messaging via cli/swarm MessageBus) |
| Workers | `src/modules/cli/src/hooks/workers/` (cross-platform background worker manager) |
| Bin scripts | `src/modules/cli/bin/hooks/{hooks-daemon,statusline}.js` |
| Tests | `src/modules/cli/__tests__/hooks/` |

## Internal usage

The cli imports hooks via direct relative paths (no `@moflo/hooks` bare specifier, no walk-up resolver):

```ts
// From cli source:
import { HookRegistry, HookEvent, HookPriority } from '../hooks/index.js';
import type { HookContext, HookResult } from '../hooks/index.js';
```

After collapse, hooks-side cross-package walk-ups (`locateCliMemory`, `locateCliEmbeddings`, `locateSwarmArtifact`) are deleted — `cli/src/hooks/reasoningbank/` and `cli/src/hooks/swarm/` use direct relative imports into `cli/src/memory/`, `cli/src/embeddings/`, and `cli/src/swarm/message-bus/` respectively.
