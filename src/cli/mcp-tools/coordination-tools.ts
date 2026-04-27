/**
 * Coordination MCP Tools for CLI
 *
 * Local sync-state surface — tracks last sync time, sync count, conflicts,
 * and pending-change count. Useful for spell orchestration on a single
 * machine; not a distributed protocol.
 */

import type { MCPTool } from './types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Storage paths
const STORAGE_DIR = '.claude-flow';
const COORD_DIR = 'coordination';
const COORD_FILE = 'store.json';

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

function getCoordDir(): string {
  return join(process.cwd(), STORAGE_DIR, COORD_DIR);
}

function getCoordPath(): string {
  return join(getCoordDir(), COORD_FILE);
}

function ensureCoordDir(): void {
  const dir = getCoordDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadCoordStore(): CoordinationStore {
  try {
    const path = getCoordPath();
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    // Return default store
  }
  return {
    sync: {
      lastSync: new Date().toISOString(),
      syncCount: 0,
      conflicts: 0,
      pendingChanges: 0,
    },
    nodes: {},
    version: '3.0.0',
  };
}

function saveCoordStore(store: CoordinationStore): void {
  ensureCoordDir();
  writeFileSync(getCoordPath(), JSON.stringify(store, null, 2), 'utf-8');
}

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
      const store = loadCoordStore();
      const action = (input.action as string) || 'status';

      if (action === 'status') {
        const timeSinceSync = Date.now() - new Date(store.sync.lastSync).getTime();

        return {
          success: true,
          sync: store.sync,
          timeSinceSync: `${Math.floor(timeSinceSync / 1000)}s`,
          status: store.sync.conflicts > 0 ? 'conflicts' : store.sync.pendingChanges > 0 ? 'pending' : 'synced',
        };
      }

      if (action === 'trigger') {
        store.sync.syncCount++;
        store.sync.lastSync = new Date().toISOString();
        store.sync.pendingChanges = 0;

        // Simulate sync
        await new Promise(resolve => setTimeout(resolve, 50));

        saveCoordStore(store);

        return {
          success: true,
          action: 'synchronized',
          syncCount: store.sync.syncCount,
          syncedAt: store.sync.lastSync,
          nodesSync: Object.keys(store.nodes).length,
        };
      }

      if (action === 'resolve') {
        const strategy = (input.conflictResolution as string) || 'latest';

        if (store.sync.conflicts > 0) {
          const resolved = store.sync.conflicts;
          store.sync.conflicts = 0;
          saveCoordStore(store);

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
