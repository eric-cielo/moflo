/**
 * Session MCP Tools for CLI
 *
 * Tool definitions for session management with file persistence.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MCPTool } from './types.js';
import { MOFLO_DIR as STORAGE_DIR } from '../services/moflo-paths.js';
import { findProjectRoot } from '../services/project-root.js';

// Storage paths
const SESSION_DIR = 'sessions';

function storeDir(...parts: string[]): string {
  return join(findProjectRoot(), STORAGE_DIR, ...parts);
}

interface SessionRecord {
  sessionId: string;
  name: string;
  description?: string;
  savedAt: string;
  stats: {
    tasks: number;
    agents: number;
    memoryEntries: number;
    totalSize: number;
  };
  data?: {
    memory?: Record<string, unknown>;
    tasks?: Record<string, unknown>;
    agents?: Record<string, unknown>;
  };
}

/** Count keys in a session data bucket (memory/tasks/agents), 0 when absent. */
function countOf(bucket: unknown): number {
  return bucket && typeof bucket === 'object' ? Object.keys(bucket as object).length : 0;
}

function getSessionDir(): string {
  return storeDir(SESSION_DIR);
}

function getSessionPath(sessionId: string): string {
  // Sanitize sessionId to prevent path traversal
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(getSessionDir(), `${safeId}.json`);
}

function ensureSessionDir(): void {
  const dir = getSessionDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadSession(sessionId: string): SessionRecord | null {
  try {
    const path = getSessionPath(sessionId);
    if (existsSync(path)) {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Return null on error
  }
  return null;
}

function saveSession(session: SessionRecord): void {
  ensureSessionDir();
  writeFileSync(getSessionPath(session.sessionId), JSON.stringify(session, null, 2), 'utf-8');
}

function listSessions(): SessionRecord[] {
  ensureSessionDir();
  const dir = getSessionDir();
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));

  const sessions: SessionRecord[] = [];
  for (const file of files) {
    try {
      const data = readFileSync(join(dir, file), 'utf-8');
      sessions.push(JSON.parse(data));
    } catch {
      // Skip invalid files
    }
  }

  return sessions;
}

// Load related stores for session data
function loadRelatedStores(options: { includeMemory?: boolean; includeTasks?: boolean; includeAgents?: boolean }) {
  const data: SessionRecord['data'] = {};

  if (options.includeMemory) {
    try {
      const memoryPath = storeDir('memory', 'store.json');
      if (existsSync(memoryPath)) {
        data.memory = JSON.parse(readFileSync(memoryPath, 'utf-8'));
      }
    } catch { /* ignore */ }
  }

  if (options.includeTasks) {
    try {
      const taskPath = storeDir('tasks', 'store.json');
      if (existsSync(taskPath)) {
        data.tasks = JSON.parse(readFileSync(taskPath, 'utf-8'));
      }
    } catch { /* ignore */ }
  }

  if (options.includeAgents) {
    try {
      const agentPath = storeDir('agents', 'store.json');
      if (existsSync(agentPath)) {
        data.agents = JSON.parse(readFileSync(agentPath, 'utf-8'));
      }
    } catch { /* ignore */ }
  }

  return data;
}

export const sessionTools: MCPTool[] = [
  {
    name: 'session_save',
    description: 'Save current session state',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Session name' },
        description: { type: 'string', description: 'Session description' },
        includeMemory: { type: 'boolean', description: 'Include memory in session' },
        includeTasks: { type: 'boolean', description: 'Include tasks in session' },
        includeAgents: { type: 'boolean', description: 'Include agents in session' },
      },
      required: ['name'],
    },
    handler: async (input) => {
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Load related data based on options
      const data = loadRelatedStores({
        includeMemory: input.includeMemory as boolean,
        includeTasks: input.includeTasks as boolean,
        includeAgents: input.includeAgents as boolean,
      });

      // Calculate stats
      const stats = {
        tasks: data.tasks ? Object.keys((data.tasks as { tasks?: object }).tasks || {}).length : 0,
        agents: data.agents ? Object.keys((data.agents as { agents?: object }).agents || {}).length : 0,
        memoryEntries: data.memory ? Object.keys((data.memory as { entries?: object }).entries || {}).length : 0,
        totalSize: 0,
      };

      const session: SessionRecord = {
        sessionId,
        name: input.name as string,
        description: input.description as string,
        savedAt: new Date().toISOString(),
        stats,
        data: Object.keys(data).length > 0 ? data : undefined,
      };

      // Calculate size
      const sessionJson = JSON.stringify(session);
      session.stats.totalSize = Buffer.byteLength(sessionJson, 'utf-8');

      saveSession(session);

      return {
        sessionId,
        name: session.name,
        savedAt: session.savedAt,
        stats: session.stats,
        path: getSessionPath(sessionId),
      };
    },
  },
  {
    name: 'session_restore',
    description: 'Restore a saved session',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to restore' },
        name: { type: 'string', description: 'Session name to restore' },
      },
    },
    handler: async (input) => {
      let session: SessionRecord | null = null;

      // Try to find by sessionId first
      if (input.sessionId) {
        session = loadSession(input.sessionId as string);
      }

      // Try to find by name if sessionId not found
      if (!session && input.name) {
        const sessions = listSessions();
        session = sessions.find(s => s.name === input.name) || null;
      }

      // Try to find latest if no params
      if (!session && !input.sessionId && !input.name) {
        const sessions = listSessions();
        if (sessions.length > 0) {
          sessions.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
          session = sessions[0];
        }
      }

      if (session) {
        // Restore data to respective stores
        if (session.data?.memory) {
          const memoryDir = storeDir('memory');
          if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
          writeFileSync(join(memoryDir, 'store.json'), JSON.stringify(session.data.memory, null, 2), 'utf-8');
        }
        if (session.data?.tasks) {
          const taskDir = storeDir('tasks');
          if (!existsSync(taskDir)) mkdirSync(taskDir, { recursive: true });
          writeFileSync(join(taskDir, 'store.json'), JSON.stringify(session.data.tasks, null, 2), 'utf-8');
        }
        if (session.data?.agents) {
          const agentDir = storeDir('agents');
          if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
          writeFileSync(join(agentDir, 'store.json'), JSON.stringify(session.data.agents, null, 2), 'utf-8');
        }

        return {
          sessionId: session.sessionId,
          name: session.name,
          restored: true,
          restoredAt: new Date().toISOString(),
          stats: session.stats,
        };
      }

      return {
        sessionId: input.sessionId || input.name || 'latest',
        restored: false,
        error: 'Session not found',
      };
    },
  },
  {
    name: 'session_list',
    description: 'List saved sessions',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum sessions to return' },
        sortBy: { type: 'string', description: 'Sort field (date, name, size)' },
      },
    },
    handler: async (input) => {
      let sessions = listSessions();

      // Sort
      const sortBy = (input.sortBy as string) || 'date';
      if (sortBy === 'date') {
        sessions.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
      } else if (sortBy === 'name') {
        sessions.sort((a, b) => a.name.localeCompare(b.name));
      } else if (sortBy === 'size') {
        sessions.sort((a, b) => b.stats.totalSize - a.stats.totalSize);
      }

      // Apply limit
      const limit = (input.limit as number) || 10;
      sessions = sessions.slice(0, limit);

      return {
        sessions: sessions.map(s => ({
          sessionId: s.sessionId,
          name: s.name,
          description: s.description,
          savedAt: s.savedAt,
          stats: s.stats,
        })),
        total: sessions.length,
        limit,
      };
    },
  },
  {
    name: 'session_delete',
    description: 'Delete a saved session',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to delete' },
      },
      required: ['sessionId'],
    },
    handler: async (input) => {
      const sessionId = input.sessionId as string;
      const path = getSessionPath(sessionId);

      if (existsSync(path)) {
        unlinkSync(path);
        return {
          sessionId,
          deleted: true,
          deletedAt: new Date().toISOString(),
        };
      }

      return {
        sessionId,
        deleted: false,
        error: 'Session not found',
      };
    },
  },
  {
    // #1349 — `flo session export` with no ID called this to resolve "the
    // current session"; it was never registered. The store has no explicit
    // active-session marker, so "current" is defined as the most recently
    // saved session. Throwing when there are none is what lets the CLI print
    // "No active session" instead of exporting something arbitrary.
    name: 'session_current',
    description: 'Resolve the current session (the most recently saved one)',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const sessions = listSessions();
      if (sessions.length === 0) {
        throw new Error('No sessions have been saved');
      }
      const [latest] = sessions.sort(
        (a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime()
      );
      return {
        sessionId: latest.sessionId,
        name: latest.name,
        savedAt: latest.savedAt,
        stats: latest.stats,
      };
    },
  },
  {
    name: 'session_export',
    description: 'Export a saved session as a portable object',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session to export' },
        includeMemory: { type: 'boolean', description: 'Include the memory snapshot (default true)' },
      },
      required: ['sessionId'],
    },
    handler: async (input) => {
      const sessionId = input.sessionId as string;
      const session = loadSession(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const includeMemory = input.includeMemory !== false;
      const data: SessionRecord = includeMemory
        ? session
        : { ...session, data: { ...session.data, memory: undefined } };

      return {
        sessionId,
        data,
        stats: {
          agentCount: session.stats?.agents ?? countOf(session.data?.agents),
          taskCount: session.stats?.tasks ?? countOf(session.data?.tasks),
          memoryEntries: includeMemory
            ? session.stats?.memoryEntries ?? countOf(session.data?.memory)
            : 0,
        },
      };
    },
  },
  {
    name: 'session_import',
    description: 'Import a session object previously produced by session_export',
    category: 'session',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'object', description: 'The exported session object' },
        name: { type: 'string', description: 'Name for the imported session' },
        activate: { type: 'boolean', description: 'Make the imported session the current one' },
      },
      required: ['data'],
    },
    handler: async (input) => {
      const incoming = (input.data ?? {}) as Partial<SessionRecord>;
      if (!incoming || typeof incoming !== 'object') {
        throw new Error('Import payload must be a session object');
      }

      const importedAt = new Date().toISOString();
      // A fresh ID keeps an import from silently overwriting a local session
      // that happens to share the source's ID.
      const sessionId = `imported-${Date.now()}`;
      const agentsImported = incoming.stats?.agents ?? countOf(incoming.data?.agents);
      const tasksImported = incoming.stats?.tasks ?? countOf(incoming.data?.tasks);
      const memoryEntriesImported =
        incoming.stats?.memoryEntries ?? countOf(incoming.data?.memory);

      const record: SessionRecord = {
        sessionId,
        name: (input.name as string) || incoming.name || sessionId,
        description: incoming.description,
        // `activate` makes this the newest session, which is what
        // session_current resolves to.
        savedAt: input.activate === true ? importedAt : incoming.savedAt || importedAt,
        stats: {
          tasks: tasksImported,
          agents: agentsImported,
          memoryEntries: memoryEntriesImported,
          totalSize: incoming.stats?.totalSize ?? 0,
        },
        data: incoming.data,
      };

      saveSession(record);

      return {
        sessionId,
        name: record.name,
        importedAt,
        stats: { agentsImported, tasksImported, memoryEntriesImported },
        activated: input.activate === true,
      };
    },
  },
];
