# cli/swarm

> **Inlined into `@moflo/cli` by [#597](https://github.com/eric-cielo/moflo/issues/597)** (epic [#586](https://github.com/eric-cielo/moflo/issues/586) / [ADR-0001](../adr/0001-collapse-moflo-workspace-packages.md)). The `@moflo/swarm` workspace package no longer exists — its contents live at `src/modules/cli/src/swarm/` and ship inside the `moflo` tarball.

The 15-agent hierarchical mesh coordination engine (ADR-003). Provides `UnifiedSwarmCoordinator` as the canonical engine, `QueenCoordinator` for hive-mind orchestration, plus topology, consensus, message-bus, attention, and federation primitives.

## Where things live

| Concern | Path |
|---------|------|
| Source | `src/modules/cli/src/swarm/` |
| Public surface | `src/modules/cli/src/swarm/index.ts` (re-exports coordinator, queen, message-bus, consensus, federation, workers, attention, types) |
| Coordinator | `src/modules/cli/src/swarm/unified-coordinator.ts` |
| Queen | `src/modules/cli/src/swarm/queen-coordinator.ts` |
| Topology | `src/modules/cli/src/swarm/topology-manager.ts` |
| Message bus | `src/modules/cli/src/swarm/message-bus/` (priority queue, deque, message-store, write-through-adapter) |
| Consensus | `src/modules/cli/src/swarm/consensus/` (raft, byzantine, gossip) |
| Coordination | `src/modules/cli/src/swarm/coordination/` (agent-registry, task-orchestrator, swarm-hub) |
| Workers | `src/modules/cli/src/swarm/workers/worker-dispatch.ts` |
| Attention | `src/modules/cli/src/swarm/attention-coordinator.ts` |
| Federation | `src/modules/cli/src/swarm/federation-hub.ts` |
| Tests | `src/modules/cli/__tests__/swarm/` |

## Internal usage

The cli imports swarm via direct relative paths (no `@moflo/swarm` bare specifier, no walk-up resolver inside cli):

```ts
// From cli source:
import { MessageBus, WriteThroughAdapter } from '../swarm/message-bus/index.js';
import { UnifiedSwarmCoordinator } from '../swarm/unified-coordinator.js';
```
