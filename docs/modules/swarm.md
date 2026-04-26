# cli/swarm

> **Inlined into `@moflo/cli` by [#597](https://github.com/eric-cielo/moflo/issues/597)** (epic [#586](https://github.com/eric-cielo/moflo/issues/586) / [ADR-0001](../adr/0001-collapse-moflo-workspace-packages.md)). The `@moflo/swarm` workspace package no longer exists — its contents live at `src/cli/swarm/` and ship inside the `moflo` tarball.

The 15-agent hierarchical mesh coordination engine (ADR-003). Provides `UnifiedSwarmCoordinator` as the canonical engine, `QueenCoordinator` for hive-mind orchestration, plus topology, consensus, message-bus, attention, and federation primitives.

## Where things live

| Concern | Path |
|---------|------|
| Source | `src/cli/swarm/` |
| Public surface | `src/cli/swarm/index.ts` (re-exports coordinator, queen, message-bus, consensus, federation, workers, attention, types) |
| Coordinator | `src/cli/swarm/unified-coordinator.ts` |
| Queen | `src/cli/swarm/queen-coordinator.ts` |
| Topology | `src/cli/swarm/topology-manager.ts` |
| Message bus | `src/cli/swarm/message-bus/` (priority queue, deque, message-store, write-through-adapter) |
| Consensus | `src/cli/swarm/consensus/` (raft, byzantine, gossip) |
| Coordination | `src/cli/swarm/coordination/` (agent-registry, task-orchestrator, swarm-hub) |
| Workers | `src/cli/swarm/workers/worker-dispatch.ts` |
| Attention | `src/cli/swarm/attention-coordinator.ts` |
| Federation | `src/cli/swarm/federation-hub.ts` |
| Tests | `src/cli/__tests__/swarm/` |

## Internal usage

The cli imports swarm via direct relative paths (no `@moflo/swarm` bare specifier, no walk-up resolver inside cli):

```ts
// From cli source:
import { MessageBus, WriteThroughAdapter } from '../swarm/message-bus/index.js';
import { UnifiedSwarmCoordinator } from '../swarm/unified-coordinator.js';
```
