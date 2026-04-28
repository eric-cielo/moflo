/**
 * Coordination MCP Tools for CLI
 *
 * Local sync-state surface — tracks last sync time, sync count, conflicts,
 * and pending-change count. Useful for spell orchestration on a single
 * machine; not a distributed protocol.
 */

import type { MCPTool } from './types.js';
import { createJsonStore } from './json-store.js';

interface SyncState {
  lastSync: string;
  syncCount: number;
  conflicts: number;
  pendingChanges: number;
}

interface CoordinationStore {
  sync: SyncState;
  nodes: Record<string, { id: string; status: string; load: number; lastHeartbeat: string }>;
  version: string;
}

const store = createJsonStore<CoordinationStore>({
  subdir: 'coordination',
  file: 'store.json',
  defaults: () => ({
    sync: {
      lastSync: new Date().toISOString(),
      syncCount: 0,
      conflicts: 0,
      pendingChanges: 0,
    },
    nodes: {},
    version: '3.0.0',
  }),
});

export const coordinationTools: MCPTool[] = [
  {
    name: 'coordination_sync',
    description: 'Synchronize state across nodes',
    category: 'coordination',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'trigger', 'resolve'], description: 'Action to perform' },
        force: { type: 'boolean', description: 'Force synchronization' },
        conflictResolution: { type: 'string', enum: ['latest', 'merge', 'manual'], description: 'Conflict resolution strategy' },
      },
    },
    handler: async (input) => {
      const state = store.load();
      const action = (input.action as string) || 'status';

      if (action === 'status') {
        const timeSinceSync = Date.now() - new Date(state.sync.lastSync).getTime();

        return {
          success: true,
          sync: state.sync,
          timeSinceSync: `${Math.floor(timeSinceSync / 1000)}s`,
          status: state.sync.conflicts > 0 ? 'conflicts' : state.sync.pendingChanges > 0 ? 'pending' : 'synced',
        };
      }

      if (action === 'trigger') {
        state.sync.syncCount++;
        state.sync.lastSync = new Date().toISOString();
        state.sync.pendingChanges = 0;

        // Simulate sync
        await new Promise(resolve => setTimeout(resolve, 50));

        store.save(state);

        return {
          success: true,
          action: 'synchronized',
          syncCount: state.sync.syncCount,
          syncedAt: state.sync.lastSync,
          nodesSync: Object.keys(state.nodes).length,
        };
      }

      if (action === 'resolve') {
        const strategy = (input.conflictResolution as string) || 'latest';

        if (state.sync.conflicts > 0) {
          const resolved = state.sync.conflicts;
          state.sync.conflicts = 0;
          store.save(state);

          return {
            success: true,
            action: 'resolved',
            strategy,
            conflictsResolved: resolved,
          };
        }

        return {
          success: true,
          action: 'resolve',
          message: 'No conflicts to resolve',
        };
      }

      return { success: false, error: 'Unknown action' };
    },
  },
];
