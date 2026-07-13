/**
 * V3 CLI Memory Command
 * Memory operations for AgentDB integration
 */

import * as fs from 'fs';
import * as os from 'os';
import * as pathModule from 'path';
import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { select, confirm, input } from '../prompt.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';
import { openDaemonDatabase, type SqlJsLikeDatabase } from '../memory/daemon-backend.js';
import { errorDetail } from '../shared/utils/error-detail.js';
import { memoryDbPath } from '../services/moflo-paths.js';
import { resolveBridgeDbPath } from '../memory/bridge-core.js';
import { findProjectRoot } from '../services/project-root.js';

// Memory backends
const BACKENDS = [
  { value: 'agentdb', label: 'AgentDB', hint: 'Vector database with HNSW approximate-nearest-neighbor (ANN) indexing' },
  { value: 'sqlite', label: 'SQLite', hint: 'Lightweight local storage' },
  { value: 'hybrid', label: 'Hybrid', hint: 'SQLite + AgentDB (recommended)' },
  { value: 'memory', label: 'In-Memory', hint: 'Fast but non-persistent' }
];

// Store command
const storeCommand: Command = {
  name: 'store',
  description: 'Store data in memory',
  options: [
    {
      name: 'key',
      short: 'k',
      description: 'Storage key/namespace',
      type: 'string',
      required: true
    },
    {
      name: 'value',
      // Note: No short flag - global -v is reserved for verbose
      description: 'Value to store (use --value)',
      type: 'string'
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Memory namespace',
      type: 'string',
      default: 'default'
    },
    {
      name: 'ttl',
      description: 'Time to live in seconds',
      type: 'number'
    },
    {
      name: 'tags',
      description: 'Comma-separated tags',
      type: 'string'
    },
    {
      name: 'vector',
      description: 'Store as vector embedding',
      type: 'boolean',
      default: false
    },
    {
      name: 'upsert',
      short: 'u',
      description: 'Update if key exists (insert or replace)',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'flo memory store -k "api/auth" -v "JWT implementation"', description: 'Store text' },
    { command: 'flo memory store -k "pattern/singleton" --vector', description: 'Store vector' },
    { command: 'flo memory store -k "pattern" -v "updated" --upsert', description: 'Update existing' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const key = ctx.flags.key as string;
    let value = ctx.flags.value as string || ctx.args[0];
    const namespace = ctx.flags.namespace as string;
    const ttl = ctx.flags.ttl as number;
    const tags = ctx.flags.tags ? (ctx.flags.tags as string).split(',') : [];
    const asVector = ctx.flags.vector as boolean;
    const upsert = ctx.flags.upsert as boolean;

    if (!key) {
      output.printError('Key is required. Use --key or -k');
      return { success: false, exitCode: 1 };
    }

    if (!value && ctx.interactive) {
      value = await input({
        message: 'Enter value to store:',
        validate: (v) => v.length > 0 || 'Value is required'
      });
    }

    if (!value) {
      output.printError('Value is required. Use --value');
      return { success: false, exitCode: 1 };
    }

    const storeData = {
      key,
      namespace,
      value,
      ttl,
      tags,
      asVector,
      storedAt: new Date().toISOString(),
      size: Buffer.byteLength(value, 'utf8')
    };

    output.printInfo(`Storing in ${namespace}/${key}...`);

    // Use direct memory-backend storage with automatic embedding generation
    try {
      const { storeEntry } = await import('../memory/memory-initializer.js');

      if (asVector) {
        output.writeln(output.dim('  Generating embedding vector...'));
      }

      const result = await storeEntry({
        key,
        value,
        namespace,
        generateEmbeddingFlag: true, // Always generate embeddings for semantic search
        tags,
        ttl,
        upsert
      });

      if (!result.success) {
        output.printError(result.error || 'Failed to store');
        return { success: false, exitCode: 1 };
      }

      output.writeln();
      output.printTable({
        columns: [
          { key: 'property', header: 'Property', width: 15 },
          { key: 'val', header: 'Value', width: 40 }
        ],
        data: [
          { property: 'Key', val: key },
          { property: 'Namespace', val: namespace },
          { property: 'Size', val: `${storeData.size} bytes` },
          { property: 'TTL', val: ttl ? `${ttl}s` : 'None' },
          { property: 'Tags', val: tags.length > 0 ? tags.join(', ') : 'None' },
          { property: 'Vector', val: result.embedding ? `Yes (${result.embedding.dimensions}-dim)` : 'No' },
          { property: 'ID', val: result.id.substring(0, 20) }
        ]
      });

      output.writeln();
      output.printSuccess('Data stored successfully');

      return { success: true, data: { ...storeData, id: result.id, embedding: result.embedding } };
    } catch (error) {
      output.printError(`Failed to store: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Retrieve command
const retrieveCommand: Command = {
  name: 'retrieve',
  aliases: ['get'],
  description: 'Retrieve data from memory',
  options: [
    {
      name: 'key',
      short: 'k',
      description: 'Storage key',
      type: 'string'
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Memory namespace',
      type: 'string',
      default: 'default'
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const key = ctx.flags.key as string || ctx.args[0];
    const namespace = ctx.flags.namespace as string;

    if (!key) {
      output.printError('Key is required');
      return { success: false, exitCode: 1 };
    }

    // Use the memory backend directly for consistent data access
    try {
      const { getEntry } = await import('../memory/memory-initializer.js');
      const result = await getEntry({ key, namespace });

      if (!result.success) {
        output.printError(`Failed to retrieve: ${result.error}`);
        return { success: false, exitCode: 1 };
      }

      if (!result.found || !result.entry) {
        output.printWarning(`Key not found: ${key}`);
        return { success: false, exitCode: 1, data: { key, found: false } };
      }

      const entry = result.entry;

      if (ctx.flags.format === 'json') {
        output.printJson(entry);
        return { success: true, data: entry };
      }

      output.writeln();
      output.printBox(
        [
          `Namespace: ${entry.namespace}`,
          `Key: ${entry.key}`,
          `Size: ${entry.content.length} bytes`,
          `Access Count: ${entry.accessCount}`,
          `Tags: ${entry.tags.length > 0 ? entry.tags.join(', ') : 'None'}`,
          `Vector: ${entry.hasEmbedding ? 'Yes' : 'No'}`,
          '',
          output.bold('Value:'),
          entry.content
        ].join('\n'),
        'Memory Entry'
      );

      return { success: true, data: entry };
    } catch (error) {
      output.printError(`Failed to retrieve: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Search command
const searchCommand: Command = {
  name: 'search',
  description: 'Search memory with semantic/vector search',
  options: [
    {
      name: 'query',
      short: 'q',
      description: 'Search query',
      type: 'string',
      required: true
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Memory namespace',
      type: 'string'
    },
    {
      name: 'limit',
      short: 'l',
      description: 'Maximum results',
      type: 'number',
      default: 10
    },
    {
      name: 'threshold',
      description: 'Similarity threshold (0-1)',
      type: 'number',
      default: 0.5
    },
    {
      name: 'type',
      short: 't',
      description: 'Search type (semantic, keyword, hybrid)',
      type: 'string',
      default: 'semantic',
      choices: ['semantic', 'keyword', 'hybrid']
    },
    {
      name: 'build-hnsw',
      description: 'Build/rebuild HNSW index before searching (enables approximate-nearest-neighbor search)',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'flo memory search -q "authentication patterns"', description: 'Semantic search' },
    { command: 'flo memory search -q "JWT" -t keyword', description: 'Keyword search' },
    { command: 'flo memory search -q "test" --build-hnsw', description: 'Build HNSW index and search' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const query = ctx.flags.query as string || ctx.args[0];
    const namespace = ctx.flags.namespace as string || 'all';
    const limit = ctx.flags.limit as number || 10;
    // #1053 S6: align with MCP default — was 0.3 here vs 0.7 in option block.
    const threshold = ctx.flags.threshold as number || 0.5;
    const searchType = ctx.flags.type as string || 'semantic';
    const buildHnsw = ctx.flags.buildHnsw as boolean;

    if (!query) {
      output.printError('Query is required. Use --query or -q');
      return { success: false, exitCode: 1 };
    }

    // Build/rebuild HNSW index if requested
    if (buildHnsw) {
      output.printInfo('Building HNSW index...');
      try {
        const { getHNSWIndex, getHNSWStatus } = await import('../memory/memory-initializer.js');

        const startTime = Date.now();
        const index = await getHNSWIndex({ forceRebuild: true });
        const buildTime = Date.now() - startTime;

        if (index) {
          const status = getHNSWStatus();
          output.printSuccess(`HNSW index built (${status.entryCount} vectors, ${buildTime}ms)`);
          output.writeln(output.dim(`  Dimensions: ${status.dimensions}, Metric: cosine`));
        } else {
          output.printWarning('HNSW index not available (will be initialized on first use)');
        }
        output.writeln();
      } catch (error) {
        output.printWarning(`HNSW build failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        output.writeln(output.dim('  Falling back to brute-force search'));
        output.writeln();
      }
    }

    output.printInfo(`Searching: "${query}" (${searchType})`);
    output.writeln();

    // Use direct memory-backend search with vector similarity
    try {
      const { searchEntries } = await import('../memory/memory-initializer.js');

      const searchResult = await searchEntries({
        query,
        namespace,
        limit,
        threshold
      });

      if (!searchResult.success) {
        output.printError(searchResult.error || 'Search failed');
        return { success: false, exitCode: 1 };
      }

      const results = searchResult.results.map(r => ({
        key: r.key,
        score: r.score,
        namespace: r.namespace,
        preview: r.content
      }));

      if (ctx.flags.format === 'json') {
        output.printJson({ query, searchType, results, searchTime: `${searchResult.searchTime}ms` });
        return { success: true, data: results };
      }

      // Performance stats
      output.writeln(output.dim(`  Search time: ${searchResult.searchTime}ms`));
      output.writeln();

      if (results.length === 0) {
        output.printWarning('No results found');
        output.writeln(output.dim('Try: flo memory store -k "key" --value "data"'));
        return { success: true, data: [] };
      }

      output.printTable({
        columns: [
          { key: 'key', header: 'Key', width: 20 },
          { key: 'score', header: 'Score', width: 8, align: 'right', format: (v) => Number(v).toFixed(2) },
          { key: 'namespace', header: 'Namespace', width: 12 },
          { key: 'preview', header: 'Preview', width: 35 }
        ],
        data: results
      });

      output.writeln();
      output.printInfo(`Found ${results.length} results`);

      return { success: true, data: results };
    } catch (error) {
      output.printError(`Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// List command
const listCommand: Command = {
  name: 'list',
  aliases: ['ls'],
  description: 'List memory entries',
  options: [
    {
      name: 'namespace',
      short: 'n',
      description: 'Filter by namespace',
      type: 'string'
    },
    {
      name: 'tags',
      short: 't',
      description: 'Filter by tags (comma-separated)',
      type: 'string'
    },
    {
      name: 'limit',
      short: 'l',
      description: 'Maximum entries',
      type: 'number',
      default: 20
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const namespace = ctx.flags.namespace as string;
    const limit = ctx.flags.limit as number;

    // Use the memory backend directly for consistent data access
    try {
      const { listEntries } = await import('../memory/memory-initializer.js');
      const listResult = await listEntries({ namespace, limit, offset: 0 });

      if (!listResult.success) {
        output.printError(`Failed to list: ${listResult.error}`);
        return { success: false, exitCode: 1 };
      }

      // Format entries for display
      const entries = listResult.entries.map(e => ({
        key: e.key,
        namespace: e.namespace,
        size: e.size + ' B',
        vector: e.hasEmbedding ? '✓' : '-',
        accessCount: e.accessCount,
        updated: formatRelativeTime(e.updatedAt)
      }));

      if (ctx.flags.format === 'json') {
        output.printJson(listResult.entries);
        return { success: true, data: listResult.entries };
      }

      output.writeln();
      output.writeln(output.bold('Memory Entries'));
      output.writeln();

      if (entries.length === 0) {
        output.printWarning('No entries found');
        output.printInfo('Store data: flo memory store -k "key" --value "data"');
        return { success: true, data: [] };
      }

      output.printTable({
        columns: [
          { key: 'key', header: 'Key', width: 25 },
          { key: 'namespace', header: 'Namespace', width: 12 },
          { key: 'size', header: 'Size', width: 10, align: 'right' },
          { key: 'vector', header: 'Vector', width: 8, align: 'center' },
          { key: 'accessCount', header: 'Accessed', width: 10, align: 'right' },
          { key: 'updated', header: 'Updated', width: 12 }
        ],
        data: entries
      });

      output.writeln();
      output.printInfo(`Showing ${entries.length} of ${listResult.total} entries`);

      return { success: true, data: listResult.entries };
    } catch (error) {
      output.printError(`Failed to list: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Helper function to format relative time
function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const date = new Date(isoDate).getTime();
  const diff = now - date;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

// Delete command
const deleteCommand: Command = {
  name: 'delete',
  aliases: ['rm'],
  description: 'Delete memory entry',
  options: [
    {
      name: 'key',
      short: 'k',
      description: 'Storage key',
      type: 'string'
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Memory namespace',
      type: 'string',
      default: 'default'
    },
    {
      name: 'force',
      short: 'f',
      description: 'Skip confirmation',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'flo memory delete -k "mykey"', description: 'Delete entry with default namespace' },
    { command: 'flo memory delete -k "lesson" -n "lessons"', description: 'Delete entry from specific namespace' },
    { command: 'flo memory delete mykey -f', description: 'Delete without confirmation' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Support both --key flag and positional argument
    const key = ctx.flags.key as string || ctx.args[0];
    const namespace = (ctx.flags.namespace as string) || 'default';
    const force = ctx.flags.force as boolean;

    if (!key) {
      output.printError('Key is required. Use: memory delete -k "key" [-n "namespace"]');
      return { success: false, exitCode: 1 };
    }

    if (!force && ctx.interactive) {
      const confirmed = await confirm({
        message: `Delete memory entry "${key}" from namespace "${namespace}"?`,
        default: false
      });

      if (!confirmed) {
        output.printInfo('Operation cancelled');
        return { success: true };
      }
    }

    // Use the memory backend directly for consistent data access (Issue #980)
    try {
      const { deleteEntry } = await import('../memory/memory-initializer.js');
      const result = await deleteEntry({ key, namespace });

      if (!result.success) {
        output.printError(result.error || 'Failed to delete');
        return { success: false, exitCode: 1 };
      }

      if (result.deleted) {
        output.printSuccess(`Deleted "${key}" from namespace "${namespace}"`);
        output.printInfo(`Remaining entries: ${result.remainingEntries}`);
      } else {
        output.printWarning(`Key not found: "${key}" in namespace "${namespace}"`);
      }

      return { success: result.deleted, data: result };
    } catch (error) {
      output.printError(`Failed to delete: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Stats command
const statsCommand: Command = {
  name: 'stats',
  description: 'Show memory statistics',
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // Call MCP memory/stats tool for real statistics
    try {
      const statsResult = await callMCPTool('memory_stats', {}) as {
        totalEntries: number;
        totalSize: string;
        version: string;
        backend: string;
        location: string;
        oldestEntry: string | null;
        newestEntry: string | null;
      };

      const stats = {
        backend: statsResult.backend,
        entries: {
          total: statsResult.totalEntries,
          vectors: 0, // Would need vector backend support
          text: statsResult.totalEntries
        },
        storage: {
          total: statsResult.totalSize,
          location: statsResult.location
        },
        version: statsResult.version,
        oldestEntry: statsResult.oldestEntry,
        newestEntry: statsResult.newestEntry
      };

      if (ctx.flags.format === 'json') {
        output.printJson(stats);
        return { success: true, data: stats };
      }

      output.writeln();
      output.writeln(output.bold('Memory Statistics'));
      output.writeln();

      output.writeln(output.bold('Overview'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 20 },
          { key: 'value', header: 'Value', width: 30, align: 'right' }
        ],
        data: [
          { metric: 'Backend', value: stats.backend },
          { metric: 'Version', value: stats.version },
          { metric: 'Total Entries', value: stats.entries.total.toLocaleString() },
          { metric: 'Total Storage', value: stats.storage.total },
          { metric: 'Location', value: stats.storage.location }
        ]
      });

      output.writeln();
      output.writeln(output.bold('Timeline'));
      output.printTable({
        columns: [
          { key: 'metric', header: 'Metric', width: 20 },
          { key: 'value', header: 'Value', width: 30, align: 'right' }
        ],
        data: [
          { metric: 'Oldest Entry', value: stats.oldestEntry || 'N/A' },
          { metric: 'Newest Entry', value: stats.newestEntry || 'N/A' }
        ]
      });

      output.writeln();
      output.printInfo('V3 Performance: HNSW approximate-nearest-neighbor (ANN) search');

      return { success: true, data: stats };
    } catch (error) {
      output.printError(`Failed to get stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// Configure command
const configureCommand: Command = {
  name: 'configure',
  aliases: ['config'],
  description: 'Configure memory backend',
  options: [
    {
      name: 'backend',
      short: 'b',
      description: 'Memory backend',
      type: 'string',
      choices: BACKENDS.map(b => b.value)
    },
    {
      name: 'path',
      description: 'Storage path',
      type: 'string'
    },
    {
      name: 'cache-size',
      description: 'Cache size in MB',
      type: 'number'
    },
    {
      name: 'hnsw-m',
      description: 'HNSW M parameter',
      type: 'number',
      default: 16
    },
    {
      name: 'hnsw-ef',
      description: 'HNSW ef parameter',
      type: 'number',
      default: 200
    }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    let backend = ctx.flags.backend as string;

    if (!backend && ctx.interactive) {
      backend = await select({
        message: 'Select memory backend:',
        options: BACKENDS,
        default: 'hybrid'
      });
    }

    const config = {
      backend: backend || 'hybrid',
      path: ctx.flags.path || './data/memory',
      cacheSize: ctx.flags.cacheSize || 256,
      hnsw: {
        m: ctx.flags.hnswM || 16,
        ef: ctx.flags.hnswEf || 200
      }
    };

    output.writeln();
    output.printInfo('Memory Configuration');
    output.writeln();

    output.printTable({
      columns: [
        { key: 'setting', header: 'Setting', width: 20 },
        { key: 'value', header: 'Value', width: 25 }
      ],
      data: [
        { setting: 'Backend', value: config.backend },
        { setting: 'Storage Path', value: config.path },
        { setting: 'Cache Size', value: `${config.cacheSize} MB` },
        { setting: 'HNSW M', value: config.hnsw.m },
        { setting: 'HNSW ef', value: config.hnsw.ef }
      ]
    });

    output.writeln();
    output.printSuccess('Memory configuration updated');

    return { success: true, data: config };
  }
};

// Cleanup command
const cleanupCommand: Command = {
  name: 'cleanup',
  description: 'Clean up stale and expired memory entries',
  options: [
    {
      name: 'dry-run',
      short: 'd',
      description: 'Show what would be deleted',
      type: 'boolean',
      default: false
    },
    {
      name: 'older-than',
      short: 'o',
      description: 'Delete entries older than (e.g., "7d", "30d")',
      type: 'string'
    },
    {
      name: 'expired-only',
      short: 'e',
      description: 'Only delete expired TTL entries',
      type: 'boolean',
      default: false
    },
    {
      name: 'low-quality',
      short: 'l',
      description: 'Delete low quality patterns (threshold)',
      type: 'number'
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Clean specific namespace only',
      type: 'string'
    },
    {
      name: 'force',
      short: 'f',
      description: 'Skip confirmation',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'flo memory cleanup --dry-run', description: 'Preview cleanup' },
    { command: 'flo memory cleanup --older-than 30d', description: 'Delete entries older than 30 days' },
    { command: 'flo memory cleanup --expired-only', description: 'Clean expired entries' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const dryRun = ctx.flags.dryRun as boolean;
    const force = ctx.flags.force as boolean;

    if (dryRun) {
      output.writeln(output.warning('DRY RUN - No changes will be made'));
    }

    output.printInfo('Analyzing memory for cleanup...');

    try {
      const result = await callMCPTool<{
        dryRun: boolean;
        candidates: {
          expired: number;
          stale: number;
          lowQuality: number;
          total: number;
        };
        deleted: {
          entries: number;
          vectors: number;
          patterns: number;
        };
        freed: {
          bytes: number;
          formatted: string;
        };
        duration: number;
      }>('memory_cleanup', {
        dryRun,
        olderThan: ctx.flags.olderThan,
        expiredOnly: ctx.flags.expiredOnly,
        lowQualityThreshold: ctx.flags.lowQuality,
        namespace: ctx.flags.namespace,
      });

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Cleanup Analysis'));
      output.printTable({
        columns: [
          { key: 'category', header: 'Category', width: 20 },
          { key: 'count', header: 'Count', width: 15, align: 'right' }
        ],
        data: [
          { category: 'Expired (TTL)', count: result.candidates.expired },
          { category: 'Stale (unused)', count: result.candidates.stale },
          { category: 'Low Quality', count: result.candidates.lowQuality },
          { category: output.bold('Total'), count: output.bold(String(result.candidates.total)) }
        ]
      });

      if (!dryRun && result.candidates.total > 0 && !force) {
        const confirmed = await confirm({
          message: `Delete ${result.candidates.total} entries (${result.freed.formatted})?`,
          default: false
        });

        if (!confirmed) {
          output.printInfo('Cleanup cancelled');
          return { success: true, data: result };
        }
      }

      if (!dryRun) {
        output.writeln();
        output.printSuccess(`Cleaned ${result.deleted.entries} entries`);
        output.printList([
          `Vectors removed: ${result.deleted.vectors}`,
          `Patterns removed: ${result.deleted.patterns}`,
          `Space freed: ${result.freed.formatted}`,
          `Duration: ${result.duration}ms`
        ]);
      }

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Cleanup error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Compress command
const compressCommand: Command = {
  name: 'compress',
  description: 'Compress and optimize memory storage',
  options: [
    {
      name: 'level',
      short: 'l',
      description: 'Compression level (fast, balanced, max)',
      type: 'string',
      choices: ['fast', 'balanced', 'max'],
      default: 'balanced'
    },
    {
      name: 'target',
      short: 't',
      description: 'Target (vectors, text, patterns, all)',
      type: 'string',
      choices: ['vectors', 'text', 'patterns', 'all'],
      default: 'all'
    },
    {
      name: 'quantize',
      short: 'z',
      description: 'Enable vector quantization (reduces memory 4-32x)',
      type: 'boolean',
      default: false
    },
    {
      name: 'bits',
      description: 'Quantization bits (4, 8, 16)',
      type: 'number',
      default: 8
    },
    {
      name: 'rebuild-index',
      short: 'r',
      description: 'Rebuild HNSW index after compression',
      type: 'boolean',
      default: true
    }
  ],
  examples: [
    { command: 'flo memory compress', description: 'Balanced compression' },
    { command: 'flo memory compress --quantize --bits 4', description: '4-bit quantization (32x reduction)' },
    { command: 'flo memory compress -l max -t vectors', description: 'Max compression on vectors' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const level = ctx.flags.level as string || 'balanced';
    const target = ctx.flags.target as string || 'all';
    const quantize = ctx.flags.quantize as boolean;
    const bits = ctx.flags.bits as number || 8;
    const rebuildIndex = ctx.flags.rebuildIndex as boolean ?? true;

    output.writeln();
    output.writeln(output.bold('Memory Compression'));
    output.writeln(output.dim(`Level: ${level}, Target: ${target}, Quantize: ${quantize ? `${bits}-bit` : 'no'}`));
    output.writeln();

    const spinner = output.createSpinner({ text: 'Analyzing current storage...', spinner: 'dots' });
    spinner.start();

    try {
      const result = await callMCPTool<{
        before: {
          totalSize: string;
          vectorsSize: string;
          textSize: string;
          patternsSize: string;
          indexSize: string;
        };
        after: {
          totalSize: string;
          vectorsSize: string;
          textSize: string;
          patternsSize: string;
          indexSize: string;
        };
        compression: {
          ratio: number;
          bytesSaved: number;
          formattedSaved: string;
          quantizationApplied: boolean;
          indexRebuilt: boolean;
        };
        performance: {
          searchLatencyBefore: number;
          searchLatencyAfter: number;
          searchSpeedup: string;
        };
        duration: number;
      }>('memory_compress', {
        level,
        target,
        quantize,
        bits,
        rebuildIndex,
      });

      spinner.succeed('Compression complete');

      if (ctx.flags.format === 'json') {
        output.printJson(result);
        return { success: true, data: result };
      }

      output.writeln();
      output.writeln(output.bold('Storage Comparison'));
      output.printTable({
        columns: [
          { key: 'category', header: 'Category', width: 15 },
          { key: 'before', header: 'Before', width: 12, align: 'right' },
          { key: 'after', header: 'After', width: 12, align: 'right' },
          { key: 'saved', header: 'Saved', width: 12, align: 'right' }
        ],
        data: [
          { category: 'Vectors', before: result.before.vectorsSize, after: result.after.vectorsSize, saved: '-' },
          { category: 'Text', before: result.before.textSize, after: result.after.textSize, saved: '-' },
          { category: 'Patterns', before: result.before.patternsSize, after: result.after.patternsSize, saved: '-' },
          { category: 'Index', before: result.before.indexSize, after: result.after.indexSize, saved: '-' },
          { category: output.bold('Total'), before: result.before.totalSize, after: result.after.totalSize, saved: output.success(result.compression.formattedSaved) }
        ]
      });

      output.writeln();
      output.printBox(
        [
          `Compression Ratio: ${result.compression.ratio.toFixed(2)}x`,
          `Space Saved: ${result.compression.formattedSaved}`,
          `Quantization: ${result.compression.quantizationApplied ? `Yes (${bits}-bit)` : 'No'}`,
          `Index Rebuilt: ${result.compression.indexRebuilt ? 'Yes' : 'No'}`,
          `Duration: ${(result.duration / 1000).toFixed(1)}s`
        ].join('\n'),
        'Results'
      );

      if (result.performance) {
        output.writeln();
        output.writeln(output.bold('Performance Impact'));
        output.printList([
          `Search latency: ${result.performance.searchLatencyBefore.toFixed(2)}ms → ${result.performance.searchLatencyAfter.toFixed(2)}ms`,
          `Speedup: ${output.success(result.performance.searchSpeedup)}`
        ]);
      }

      return { success: true, data: result };
    } catch (error) {
      spinner.fail('Compression failed');
      if (error instanceof MCPClientError) {
        output.printError(`Compression error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Export command
const exportCommand: Command = {
  name: 'export',
  description: 'Export memory to file',
  options: [
    {
      name: 'output',
      short: 'o',
      description: 'Output file path',
      type: 'string',
      required: true
    },
    {
      name: 'format',
      short: 'f',
      description: 'Export format (json, csv, binary)',
      type: 'string',
      choices: ['json', 'csv', 'binary'],
      default: 'json'
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Export specific namespace',
      type: 'string'
    },
    {
      name: 'include-vectors',
      description: 'Include vector embeddings',
      type: 'boolean',
      default: true
    }
  ],
  examples: [
    { command: 'flo memory export -o ./backup.json', description: 'Export all to JSON' },
    { command: 'flo memory export -o ./data.csv -f csv', description: 'Export to CSV' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const outputPath = ctx.flags.output as string;
    const format = ctx.flags.format as string || 'json';

    if (!outputPath) {
      output.printError('Output path is required. Use --output or -o');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Exporting memory to ${outputPath}...`);

    try {
      const result = await callMCPTool<{
        outputPath: string;
        format: string;
        exported: {
          entries: number;
          vectors: number;
          patterns: number;
        };
        fileSize: string;
      }>('memory_export', {
        outputPath,
        format,
        namespace: ctx.flags.namespace,
        includeVectors: ctx.flags.includeVectors ?? true,
      });

      output.printSuccess(`Exported to ${result.outputPath}`);
      output.printList([
        `Entries: ${result.exported.entries}`,
        `Vectors: ${result.exported.vectors}`,
        `Patterns: ${result.exported.patterns}`,
        `File size: ${result.fileSize}`
      ]);

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Export error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Import command
const importCommand: Command = {
  name: 'import',
  description: 'Import memory from file',
  options: [
    {
      name: 'input',
      short: 'i',
      description: 'Input file path',
      type: 'string',
      required: true
    },
    {
      name: 'merge',
      short: 'm',
      description: 'Merge with existing (skip duplicates)',
      type: 'boolean',
      default: true
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Import into specific namespace',
      type: 'string'
    }
  ],
  examples: [
    { command: 'flo memory import -i ./backup.json', description: 'Import from file' },
    { command: 'flo memory import -i ./data.json -n archive', description: 'Import to namespace' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const inputPath = ctx.flags.input as string || ctx.args[0];

    if (!inputPath) {
      output.printError('Input path is required. Use --input or -i');
      return { success: false, exitCode: 1 };
    }

    output.printInfo(`Importing memory from ${inputPath}...`);

    try {
      const result = await callMCPTool<{
        inputPath: string;
        imported: {
          entries: number;
          vectors: number;
          patterns: number;
        };
        skipped: number;
        duration: number;
      }>('memory_import', {
        inputPath,
        merge: ctx.flags.merge ?? true,
        namespace: ctx.flags.namespace,
      });

      output.printSuccess(`Imported from ${result.inputPath}`);
      output.printList([
        `Entries: ${result.imported.entries}`,
        `Vectors: ${result.imported.vectors}`,
        `Patterns: ${result.imported.patterns}`,
        `Skipped (duplicates): ${result.skipped}`,
        `Duration: ${result.duration}ms`
      ]);

      return { success: true, data: result };
    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(`Import error: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};

// Init subcommand - initialize memory database using node:sqlite
const initMemoryCommand: Command = {
  name: 'init',
  description: 'Initialize memory database with node:sqlite (Node 22+ built-in) - includes vector embeddings, pattern learning, temporal decay',
  options: [
    {
      name: 'backend',
      short: 'b',
      description: 'Backend type: hybrid (default), sqlite, or agentdb',
      type: 'string',
      default: 'hybrid'
    },
    {
      name: 'path',
      short: 'p',
      description: 'Database path',
      type: 'string'
    },
    {
      name: 'force',
      short: 'f',
      description: 'Overwrite existing database',
      type: 'boolean',
      default: false
    },
    {
      name: 'verbose',
      description: 'Show detailed initialization output',
      type: 'boolean',
      default: false
    },
    {
      name: 'verify',
      description: 'Run verification tests after initialization',
      type: 'boolean',
      default: true
    },
    {
      name: 'load-embeddings',
      description: 'Pre-load ONNX embedding model (lazy by default)',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'flo memory init', description: 'Initialize hybrid backend with all features' },
    { command: 'flo memory init -b agentdb', description: 'Initialize AgentDB backend' },
    { command: 'flo memory init -p ./data/memory.db --force', description: 'Reinitialize at custom path' },
    { command: 'flo memory init --verbose --verify', description: 'Initialize with full verification' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const backend = (ctx.flags.backend as string) || 'hybrid';
    const customPath = ctx.flags.path as string;
    const force = ctx.flags.force as boolean;
    const verbose = ctx.flags.verbose as boolean;
    const verify = ctx.flags.verify !== false; // Default true
    const loadEmbeddings = ctx.flags.loadEmbeddings as boolean;

    output.writeln();
    output.writeln(output.bold('Initializing Memory Database'));
    output.writeln(output.dim('─'.repeat(50)));

    const spinner = output.createSpinner({ text: 'Initializing schema...', spinner: 'dots' });
    spinner.start();

    try {
      // Import the memory initializer
      const { initializeMemoryDatabase, loadEmbeddingModel, verifyMemoryInit } = await import('../memory/memory-initializer.js');

      const result = await initializeMemoryDatabase({
        backend,
        dbPath: customPath,
        force,
        verbose
      });

      if (!result.success) {
        spinner.fail('Initialization failed');
        output.printError(result.error || 'Unknown error');
        return { success: false, exitCode: 1 };
      }

      spinner.succeed('Schema initialized');

      // Lazy load or pre-load embedding model
      if (loadEmbeddings) {
        const embeddingSpinner = output.createSpinner({ text: 'Loading embedding model...', spinner: 'dots' });
        embeddingSpinner.start();

        const embeddingResult = await loadEmbeddingModel({ verbose });

        if (embeddingResult.success) {
          embeddingSpinner.succeed(`Embedding model loaded: ${embeddingResult.modelName} (${embeddingResult.dimensions}-dim, ${embeddingResult.loadTime}ms)`);
        } else {
          embeddingSpinner.stop(output.warning(`Embedding model: ${embeddingResult.error || 'Using fallback'}`));
        }
      }

      output.writeln();

      // Show features enabled with detailed capabilities
      const featureLines = [
        `Backend:           ${result.backend}`,
        `Schema Version:    ${result.schemaVersion}`,
        `Database Path:     ${result.dbPath}`,
        '',
        output.bold('Features:'),
        `  Vector Embeddings: ${result.features.vectorEmbeddings ? output.success('✓ Enabled') : output.dim('✗ Disabled')}`,
        `  Pattern Learning:  ${result.features.patternLearning ? output.success('✓ Enabled') : output.dim('✗ Disabled')}`,
        `  Temporal Decay:    ${result.features.temporalDecay ? output.success('✓ Enabled') : output.dim('✗ Disabled')}`,
        `  HNSW Indexing:     ${result.features.hnswIndexing ? output.success('✓ Enabled') : output.dim('✗ Disabled')}`,
        `  Migration Tracking: ${result.features.migrationTracking ? output.success('✓ Enabled') : output.dim('✗ Disabled')}`
      ];

      if (verbose) {
        featureLines.push(
          '',
          output.bold('HNSW Configuration:'),
          `  M (connections):     16`,
          `  ef (construction):   200`,
          `  ef (search):         100`,
          `  Metric:              cosine`,
          '',
          output.bold('Pattern Learning:'),
          `  Confidence scoring:  0.0 - 1.0`,
          `  Temporal decay:      Half-life 30 days`,
          `  Pattern versioning:  Enabled`,
          `  Types: task-routing, error-recovery, optimization, coordination, prediction`
        );
      }

      output.printBox(featureLines.join('\n'), 'Configuration');
      output.writeln();

      // ADR-053: Show ControllerRegistry activation results
      if (result.controllers) {
        const { activated, failed, initTimeMs } = result.controllers;
        if (activated.length > 0 || failed.length > 0) {
          const controllerLines = [
            output.bold('AgentDB Controllers:'),
            `  Activated: ${activated.length}  Failed: ${failed.length}  Init: ${Math.round(initTimeMs)}ms`,
          ];
          if (verbose && activated.length > 0) {
            controllerLines.push('');
            for (const name of activated) {
              controllerLines.push(`  ${output.success('✓')} ${name}`);
            }
          }
          if (failed.length > 0 && verbose) {
            controllerLines.push('');
            for (const name of failed) {
              controllerLines.push(`  ${output.dim('✗')} ${name}`);
            }
          }
          output.printBox(controllerLines.join('\n'), 'Controller Registry (ADR-053)');
          output.writeln();
        }
      }

      // Show tables created
      if (verbose && result.tablesCreated.length > 0) {
        output.writeln(output.bold('Tables Created:'));
        output.printTable({
          columns: [
            { key: 'table', header: 'Table', width: 22 },
            { key: 'purpose', header: 'Purpose', width: 38 }
          ],
          data: [
            { table: 'memory_entries', purpose: 'Core memory storage with embeddings' },
            { table: 'patterns', purpose: 'Learned patterns with confidence scores' },
            { table: 'pattern_history', purpose: 'Pattern versioning and evolution' },
            { table: 'trajectories', purpose: 'SONA learning trajectories' },
            { table: 'trajectory_steps', purpose: 'Individual trajectory steps' },
            { table: 'migration_state', purpose: 'Migration progress tracking' },
            { table: 'sessions', purpose: 'Context persistence' },
            { table: 'vector_indexes', purpose: 'HNSW index configuration' },
            { table: 'metadata', purpose: 'System metadata' }
          ]
        });
        output.writeln();

        output.writeln(output.bold('Indexes Created:'));
        output.printList(result.indexesCreated.slice(0, 8).map(idx => output.dim(idx)));
        if (result.indexesCreated.length > 8) {
          output.writeln(output.dim(`  ... and ${result.indexesCreated.length - 8} more`));
        }
        output.writeln();
      }

      // Run verification if enabled
      if (verify) {
        const verifySpinner = output.createSpinner({ text: 'Verifying initialization...', spinner: 'dots' });
        verifySpinner.start();

        const verification = await verifyMemoryInit(result.dbPath, { verbose });

        if (verification.success) {
          verifySpinner.succeed(`Verification passed (${verification.summary.passed}/${verification.summary.total} tests)`);
        } else {
          verifySpinner.fail(`Verification failed (${verification.summary.failed}/${verification.summary.total} tests failed)`);
        }

        if (verbose || !verification.success) {
          output.writeln();
          output.writeln(output.bold('Verification Results:'));
          output.printTable({
            columns: [
              { key: 'status', header: '', width: 3 },
              { key: 'name', header: 'Test', width: 22 },
              { key: 'details', header: 'Details', width: 30 },
              { key: 'duration', header: 'Time', width: 8, align: 'right' }
            ],
            data: verification.tests.map(t => ({
              status: t.passed ? output.success('✓') : output.error('✗'),
              name: t.name,
              details: t.details || '',
              duration: t.duration ? `${t.duration}ms` : '-'
            }))
          });
        }

        output.writeln();
      }

      // Show next steps
      output.writeln(output.bold('Next Steps:'));
      output.printList([
        `Store data: ${output.highlight('flo memory store -k "key" --value "data"')}`,
        `Search: ${output.highlight('flo memory search -q "query"')}`,
        `Train patterns: ${output.highlight('flo neural train -p coordination')}`,
        `View stats: ${output.highlight('flo memory stats')}`
      ]);

      // Also sync to .claude directory
      const fs = await import('fs');
      const path = await import('path');
      const claudeDir = path.join(process.cwd(), '.claude');
      const claudeDbPath = path.join(claudeDir, 'memory.db');

      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }

      if (fs.existsSync(result.dbPath) && (!fs.existsSync(claudeDbPath) || force)) {
        fs.copyFileSync(result.dbPath, claudeDbPath);
        output.writeln();
        output.writeln(output.dim(`Synced to: ${claudeDbPath}`));
      }

      return {
        success: true,
        data: result
      };
    } catch (error) {
      spinner.fail('Initialization failed');
      output.printError(`Failed to initialize memory: ${errorDetail(error)}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// ============================================================================
// Shared DB helpers for batch commands (index-guidance, rebuild-index, code-map)
// ============================================================================

// Exported for test access (swarm-path-relocation.test.ts pins the canonical
// resolution); production callers use it via the `flo memory` command actions.
export async function openDb(cwd: string): Promise<{ db: SqlJsLikeDatabase; dbPath: string }> {
  // Canonical store is `.moflo/moflo.db`. Route through the shared bridge
  // resolver so these `flo memory` CLI writers land on the exact path the
  // daemon, MCP server, and bridge read — and so the post-#727 migration
  // window is honoured (legacy `.swarm/memory.db` is preferred only when it
  // is the sole existing file). Pre-fix this joined `.swarm/` under cwd
  // unconditionally, recreating the legacy dir on every call and stranding
  // user data in a store nothing else reads (#1168 follow-up — `openDb` was
  // the explicit-command writer the original relocation sweep missed).
  const dbPath = resolveBridgeDbPath(findProjectRoot({ cwd }));
  // openDaemonDatabase ensures the parent directory exists and applies WAL.
  const db = openDaemonDatabase(dbPath);

  // Ensure table exists
  db.run(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      namespace TEXT DEFAULT 'default',
      content TEXT NOT NULL,
      type TEXT DEFAULT 'semantic',
      embedding TEXT,
      embedding_model TEXT DEFAULT 'local',
      embedding_dimensions INTEGER,
      tags TEXT,
      metadata TEXT,
      owner_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      expires_at INTEGER,
      last_accessed_at INTEGER,
      access_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      UNIQUE(namespace, key)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memory_key_ns ON memory_entries(key, namespace)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_entries(namespace)`);

  return { db, dbPath };
}

/**
 * Close the DB handle. node:sqlite + WAL has already persisted every prior
 * `db.run` incrementally — the explicit atomicWriteFileSync sql.js used to
 * need is gone (Phase 5 / #1084).
 */
function saveAndCloseDb(db: SqlJsLikeDatabase, _dbPath: string): void {
  db.close();
}

function batchGenerateId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function batchStoreEntry(
  db: any,
  key: string,
  namespace: string,
  content: string,
  metadata: Record<string, unknown> = {},
  tags: string[] = [],
  embedding?: number[],
  embeddingModel?: string,
  embeddingDimensions?: number
): void {
  const now = Date.now();
  const id = batchGenerateId();
  if (embedding) {
    db.run(`
      INSERT OR REPLACE INTO memory_entries
      (id, key, namespace, content, metadata, tags, embedding, embedding_model, embedding_dimensions, created_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `, [id, key, namespace, content, JSON.stringify(metadata), JSON.stringify(tags),
        JSON.stringify(embedding), embeddingModel || 'local', embeddingDimensions || 384, now, now]);
  } else {
    db.run(`
      INSERT OR REPLACE INTO memory_entries
      (id, key, namespace, content, metadata, tags, created_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `, [id, key, namespace, content, JSON.stringify(metadata), JSON.stringify(tags), now, now]);
  }
}

function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

// ============================================================================
// index-guidance subcommand
// ============================================================================

const MIN_CHUNK_SIZE = 50;
const MAX_CHUNK_SIZE = 4000;
const FORCE_CHUNK_THRESHOLD = 6000;
const DEFAULT_OVERLAP_PERCENT = 20;

interface MarkdownChunk {
  title: string;
  content: string;
  level: number;
  headerLine: number;
  isPart?: boolean;
  partNum?: number;
  isForced?: boolean;
  forceNum?: number;
}

function chunkMarkdown(content: string, fileName: string): MarkdownChunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: MarkdownChunk[] = [];
  let currentChunk: { title: string; content: string[]; level: number; headerLine: number } = {
    title: fileName, content: [], level: 0, headerLine: 0
  };

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum].replace(/\r$/, '');
    const h2Match = line.match(/^## (.+)$/);
    const h3Match = line.match(/^### (.+)$/);

    if (h2Match || h3Match) {
      if (currentChunk.content.length > 0) {
        const chunkContent = currentChunk.content.join('\n').trim();
        if (chunkContent.length >= MIN_CHUNK_SIZE) {
          chunks.push({
            title: currentChunk.title,
            content: chunkContent,
            level: currentChunk.level,
            headerLine: currentChunk.headerLine
          });
        }
      }
      currentChunk = {
        title: h2Match ? h2Match[1] : h3Match![1],
        content: [line],
        level: h2Match ? 2 : 3,
        headerLine: lineNum
      };
    } else {
      currentChunk.content.push(line);
    }
  }

  if (currentChunk.content.length > 0) {
    const chunkContent = currentChunk.content.join('\n').trim();
    if (chunkContent.length >= MIN_CHUNK_SIZE) {
      chunks.push({
        title: currentChunk.title,
        content: chunkContent,
        level: currentChunk.level,
        headerLine: currentChunk.headerLine
      });
    }
  }

  // Split oversized chunks by paragraphs
  const finalChunks: MarkdownChunk[] = [];
  for (const chunk of chunks) {
    if (chunk.content.length > MAX_CHUNK_SIZE) {
      const paragraphs = chunk.content.split(/\n\n+/);
      let currentPart: string[] = [];
      let currentLength = 0;
      let partNum = 1;

      for (const para of paragraphs) {
        if (currentLength + para.length > MAX_CHUNK_SIZE && currentPart.length > 0) {
          finalChunks.push({
            title: `${chunk.title} (part ${partNum})`,
            content: currentPart.join('\n\n'),
            level: chunk.level,
            headerLine: chunk.headerLine,
            isPart: true,
            partNum
          });
          currentPart = [para];
          currentLength = para.length;
          partNum++;
        } else {
          currentPart.push(para);
          currentLength += para.length;
        }
      }

      if (currentPart.length > 0) {
        finalChunks.push({
          title: partNum > 1 ? `${chunk.title} (part ${partNum})` : chunk.title,
          content: currentPart.join('\n\n'),
          level: chunk.level,
          headerLine: chunk.headerLine,
          isPart: partNum > 1,
          partNum: partNum > 1 ? partNum : undefined
        });
      }
    } else {
      finalChunks.push(chunk);
    }
  }

  // Force chunking for large files with few chunks
  const totalContent = finalChunks.reduce((acc, c) => acc + c.content.length, 0);
  if (totalContent > FORCE_CHUNK_THRESHOLD && finalChunks.length < 3) {
    const allContent = finalChunks.map(c => c.content).join('\n\n');
    const TARGET_CHUNK_SIZE = 2500;
    const rawSections = allContent.split(/\n---+\n/);
    const sections: string[] = [];

    for (const raw of rawSections) {
      if (raw.length > TARGET_CHUNK_SIZE) {
        const headerSplit = raw.split(/\n(?=## )/);
        for (const hSect of headerSplit) {
          if (hSect.length > TARGET_CHUNK_SIZE) {
            const sLines = hSect.split(/\r?\n/);
            let chunk = '';
            for (const line of sLines) {
              if (chunk.length + line.length > TARGET_CHUNK_SIZE && chunk.length > 100) {
                sections.push(chunk.trim());
                chunk = line;
              } else {
                chunk += (chunk ? '\n' : '') + line;
              }
            }
            if (chunk.trim().length > 30) sections.push(chunk.trim());
          } else if (hSect.trim().length > 30) {
            sections.push(hSect.trim());
          }
        }
      } else if (raw.trim().length > 30) {
        sections.push(raw.trim());
      }
    }

    const forcedChunks: MarkdownChunk[] = [];
    let currentGroup: string[] = [];
    let currentLength = 0;
    let groupNum = 1;

    const flushGroup = () => {
      if (currentGroup.length === 0) return;
      const firstLine = currentGroup[0].split(/\r?\n/)[0].trim();
      const title = firstLine.startsWith('#')
        ? firstLine.replace(/^#+\s*/, '').slice(0, 60)
        : `${fileName} Section ${groupNum}`;
      forcedChunks.push({
        title,
        content: currentGroup.join('\n\n'),
        level: 2,
        headerLine: 0,
        isForced: true,
        forceNum: groupNum
      });
      groupNum++;
      currentGroup = [];
      currentLength = 0;
    };

    for (const section of sections) {
      if (currentLength + section.length > TARGET_CHUNK_SIZE && currentGroup.length > 0) {
        flushGroup();
      }
      currentGroup.push(section);
      currentLength += section.length;
    }
    flushGroup();

    if (forcedChunks.length >= 2) {
      return forcedChunks;
    }
  }

  return finalChunks;
}

function extractOverlapContext(text: string, percent: number, position: 'start' | 'end'): string {
  if (!text || percent <= 0) return '';
  const targetLength = Math.floor(text.length * (percent / 100));
  if (targetLength < 20) return '';

  if (position === 'start') {
    let end = targetLength;
    const nextPara = text.indexOf('\n\n', targetLength - 50);
    const nextSentence = text.indexOf('. ', targetLength - 30);
    if (nextPara > 0 && nextPara < targetLength + 100) end = nextPara;
    else if (nextSentence > 0 && nextSentence < targetLength + 50) end = nextSentence + 1;
    return text.substring(0, end).trim();
  } else {
    let start = text.length - targetLength;
    const prevPara = text.lastIndexOf('\n\n', start + 50);
    const prevSentence = text.lastIndexOf('. ', start + 30);
    if (prevPara > 0 && prevPara > start - 100) start = prevPara + 2;
    else if (prevSentence > 0 && prevSentence > start - 50) start = prevSentence + 2;
    return text.substring(start).trim();
  }
}

function buildHierarchy(chunks: MarkdownChunk[], chunkPrefix: string): Record<string, { parent: string | null; children: string[] }> {
  const hierarchy: Record<string, { parent: string | null; children: string[] }> = {};
  let currentH2Index: number | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkKey = `${chunkPrefix}-${i}`;
    hierarchy[chunkKey] = { parent: null, children: [] };

    if (chunk.level === 2) {
      currentH2Index = i;
    } else if (chunk.level === 3 && currentH2Index !== null) {
      const parentKey = `${chunkPrefix}-${currentH2Index}`;
      hierarchy[chunkKey].parent = parentKey;
      hierarchy[parentKey].children.push(chunkKey);
    }
  }

  return hierarchy;
}

const indexGuidanceCommand: Command = {
  name: 'index-guidance',
  description: 'Index .claude/guidance/ markdown files into the guidance namespace with RAG linked segments',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force reindex all files (even unchanged)',
      type: 'boolean',
      default: false
    },
    {
      name: 'file',
      description: 'Index a specific file only',
      type: 'string'
    },
    {
      name: 'no-embeddings',
      description: 'Skip embedding generation after indexing',
      type: 'boolean',
      default: false
    },
    {
      name: 'overlap',
      description: 'Context overlap percentage (default: 20)',
      type: 'number',
      default: 20
    }
  ],
  examples: [
    { command: 'flo memory index-guidance', description: 'Index all guidance files' },
    { command: 'flo memory index-guidance --force', description: 'Force reindex all' },
    { command: 'flo memory index-guidance --file .claude/guidance/coding-rules.md', description: 'Index specific file' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const forceReindex = ctx.flags.force as boolean;
    const specificFile = ctx.flags.file as string | undefined;
    const skipEmbeddings = ctx.flags.noEmbeddings as boolean;
    const overlapPercent = (ctx.flags.overlap as number) || DEFAULT_OVERLAP_PERCENT;
    const NAMESPACE = 'guidance';

    const fs = await import('fs');
    const pathMod = await import('path');
    const cwd = ctx.cwd || process.cwd();

    output.writeln();
    output.writeln(output.bold('Indexing Guidance Files'));
    output.writeln(output.dim(`Context overlap: ${overlapPercent}%`));
    output.writeln();

    const { db, dbPath } = await openDb(cwd);

    let docsIndexed = 0;
    let chunksIndexed = 0;
    let unchanged = 0;
    let errors = 0;

    const indexFile = (filePath: string, keyPrefix: string) => {
      const fileName = pathModule.basename(filePath, pathModule.extname(filePath));
      const docKey = `doc-${keyPrefix}-${fileName}`;
      const chunkPrefix = `chunk-${keyPrefix}-${fileName}`;

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const contentHash_ = hashContent(content);

        // #1053 S4: doc-* retired — read docContentHash off chunk-0 instead.
        if (!forceReindex) {
          const stmt = db.prepare('SELECT metadata FROM memory_entries WHERE key = ? AND namespace = ?');
          stmt.bind([`${chunkPrefix}-0`, NAMESPACE]);
          const entry = stmt.step() ? stmt.getAsObject() : null;
          stmt.free();
          if (entry?.metadata) {
            try {
              const meta = JSON.parse(entry.metadata as string);
              if (meta.docContentHash === contentHash_) {
                return { docKey, status: 'unchanged' as const, chunks: 0 };
              }
            } catch { /* ignore */ }
          }
        }

        const stats = fs.statSync(filePath);
        const relativePath = filePath.replace(cwd, '').replace(/\\/g, '/');

        // Delete old chunks. Also delete any legacy doc-* row (#1053 S4).
        db.run(`DELETE FROM memory_entries WHERE namespace = ? AND key LIKE ?`, [NAMESPACE, `${chunkPrefix}%`]);
        db.run(`DELETE FROM memory_entries WHERE namespace = ? AND key = ?`, [NAMESPACE, docKey]);

        // #1053 S4: doc-* entries no longer written. parentDoc on chunks
        // remains as an identifier label; callers Read parentPath when
        // they need the source file (see shipped/moflo-memory-protocol.md).

        // Chunk content
        const chunks = chunkMarkdown(content, fileName);
        if (chunks.length === 0) {
          return { docKey, status: 'indexed' as const, chunks: 0 };
        }

        const hierarchy = buildHierarchy(chunks, chunkPrefix);
        const siblings = chunks.map((_, i) => `${chunkPrefix}-${i}`);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const chunkKey = `${chunkPrefix}-${i}`;
          const prevChunk = i > 0 ? `${chunkPrefix}-${i - 1}` : null;
          const nextChunk = i < chunks.length - 1 ? `${chunkPrefix}-${i + 1}` : null;

          // #1053 S5: dropped prev/next preamble wrapping. Traversal happens
          // via memory_get_neighbors now (S2).

          const hierInfo = hierarchy[chunkKey];

          const chunkMetadata = {
            type: 'chunk',
            ragVersion: '2.0',
            // #1053 S4: parentDoc is an identifier label (target row no
            // longer exists); use parentPath for the actual source file.
            // docContentHash on every chunk lets the skip-if-unchanged
            // check read it off chunk-0.
            parentDoc: docKey,
            parentPath: relativePath,
            docContentHash: contentHash_,
            chunkIndex: i,
            totalChunks: chunks.length,
            prevChunk,
            nextChunk,
            siblings,
            hierarchicalParent: hierInfo.parent,
            hierarchicalChildren: hierInfo.children.length > 0 ? hierInfo.children : null,
            chunkTitle: chunk.title,
            headerLevel: chunk.level,
            headerLine: chunk.headerLine,
            isPart: chunk.isPart || false,
            partNum: chunk.partNum || null,
            contentLength: chunk.content.length,
            contentHash: hashContent(chunk.content),
            indexedAt: new Date().toISOString(),
          };

          // #1053 S5: title heading + chunk body. No prev/next preamble.
          const searchableContent = `# ${chunk.title}\n\n${chunk.content}`;

          batchStoreEntry(
            db,
            chunkKey,
            NAMESPACE,
            searchableContent,
            chunkMetadata,
            [keyPrefix, 'chunk', `level-${chunk.level}`, chunk.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')]
          );
        }

        return { docKey, status: 'indexed' as const, chunks: chunks.length };
      } catch (err: any) {
        return { docKey, status: 'error' as const, error: err.message, chunks: 0 };
      }
    };

    if (specificFile) {
      const filePath = pathModule.resolve(cwd, specificFile);
      if (!fs.existsSync(filePath)) {
        output.printError(`File not found: ${specificFile}`);
        db.close();
        return { success: false, exitCode: 1 };
      }

      let prefix = 'docs';
      if (specificFile.includes('.claude/guidance/') || specificFile.includes('.claude\\guidance\\')) {
        prefix = 'guidance';
      }

      const result = indexFile(filePath, prefix);
      if (result.status === 'indexed') { docsIndexed++; chunksIndexed += result.chunks; }
      else if (result.status === 'unchanged') { unchanged++; }
      else { errors++; output.printError(`${result.docKey}: ${(result as any).error}`); }
    } else {
      const guidanceDir = pathModule.resolve(cwd, '.claude/guidance');
      if (!fs.existsSync(guidanceDir)) {
        output.printError(`Guidance directory not found: .claude/guidance/`);
        db.close();
        return { success: false, exitCode: 1 };
      }

      const files = fs.readdirSync(guidanceDir).filter((f: string) => f.endsWith('.md'));
      for (const file of files) {
        const filePath = pathModule.resolve(guidanceDir, file);
        const result = indexFile(filePath, 'guidance');
        if (result.status === 'indexed') {
          output.printSuccess(`${result.docKey} (${result.chunks} chunks)`);
          docsIndexed++;
          chunksIndexed += result.chunks;
        } else if (result.status === 'unchanged') {
          unchanged++;
        } else {
          output.printError(`${result.docKey}: ${(result as any).error}`);
          errors++;
        }
      }

      // #1053 S4: Clean stale chunks for deleted files.
      // doc-* markers are gone — derive prefixes from chunk keys directly.
      // Chunk key shape: chunk-guidance-<filename>-<index>; group by stripping
      // the trailing -<index>.
      const chunksStmt = db.prepare(
        `SELECT DISTINCT key FROM memory_entries WHERE namespace = ? AND key LIKE 'chunk-guidance-%'`
      );
      chunksStmt.bind([NAMESPACE]);
      const seenPrefixes = new Set<string>();
      while (chunksStmt.step()) {
        const { key } = chunksStmt.getAsObject() as { key: string };
        const prefix = key.replace(/-\d+$/, '');
        seenPrefixes.add(prefix);
      }
      chunksStmt.free();

      for (const prefix of seenPrefixes) {
        const filename = prefix.replace('chunk-guidance-', '') + '.md';
        const checkPath = pathModule.resolve(cwd, '.claude/guidance', filename);
        if (!fs.existsSync(checkPath)) {
          db.run(`DELETE FROM memory_entries WHERE namespace = ? AND key LIKE ?`, [NAMESPACE, `${prefix}-%`]);
          // Also sweep any legacy doc-* row for this prefix (one-time tidy).
          const legacyDocKey = prefix.replace('chunk-', 'doc-');
          db.run(`DELETE FROM memory_entries WHERE namespace = ? AND key = ?`, [NAMESPACE, legacyDocKey]);
          output.writeln(output.dim(`  Removed stale: ${prefix}-* (file ${filename} not found)`));
        }
      }
    }

    // Save DB
    if (docsIndexed > 0 || chunksIndexed > 0) {
      saveAndCloseDb(db, dbPath);
    } else {
      db.close();
    }

    output.writeln();
    output.writeln(output.bold('Indexing Complete'));
    output.writeln(`  Documents indexed: ${docsIndexed}`);
    output.writeln(`  Chunks created:    ${chunksIndexed}`);
    output.writeln(`  Unchanged:         ${unchanged}`);
    output.writeln(`  Errors:            ${errors}`);

    // Generate embeddings unless skipped
    if (!skipEmbeddings && (docsIndexed > 0 || chunksIndexed > 0)) {
      output.writeln();
      output.writeln(output.dim('Generating embeddings for new entries...'));

      try {
        const { generateEmbedding } = await import('../memory/memory-initializer.js');
        const { db: db2, dbPath: dbPath2 } = await openDb(cwd);

        const stmt = db2.prepare(
          `SELECT id, content FROM memory_entries WHERE namespace = ? AND (embedding IS NULL OR embedding = '')`
        );
        stmt.bind([NAMESPACE]);
        const entries: Array<{ id: string; content: string }> = [];
        while (stmt.step()) entries.push(stmt.getAsObject() as { id: string; content: string });
        stmt.free();

        let embedded = 0;
        for (const entry of entries) {
          try {
            const text = entry.content.substring(0, 1500);
            const { embedding, dimensions, model } = await generateEmbedding(text);
            db2.run(
              `UPDATE memory_entries SET embedding = ?, embedding_model = ?, embedding_dimensions = ?, updated_at = ? WHERE id = ?`,
              [JSON.stringify(embedding), model, dimensions, Date.now(), entry.id]
            );
            embedded++;
          } catch { /* skip individual failures */ }
        }

        if (embedded > 0) {
          saveAndCloseDb(db2, dbPath2);
          output.printSuccess(`Generated ${embedded} embeddings`);
        } else {
          db2.close();
          output.writeln(output.dim('  No new embeddings needed'));
        }
      } catch (err: any) {
        output.writeln(output.dim(`  Embedding generation skipped: ${err.message}`));
      }
    }

    return { success: errors === 0, exitCode: errors > 0 ? 1 : 0 };
  }
};

// ============================================================================
// rebuild-index subcommand
// ============================================================================

const rebuildIndexCommand: Command = {
  name: 'rebuild-index',
  description: 'Regenerate embeddings for memory entries missing them (or all with --force)',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Re-embed all entries, not just those missing embeddings',
      type: 'boolean',
      default: false
    },
    {
      name: 'namespace',
      short: 'n',
      description: 'Only process entries in this namespace',
      type: 'string'
    },
    {
      name: 'verbose',
      description: 'Show detailed progress',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'flo memory rebuild-index', description: 'Embed entries without embeddings' },
    { command: 'flo memory rebuild-index --force', description: 'Re-embed all entries' },
    { command: 'flo memory rebuild-index -n guidance', description: 'Only guidance namespace' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const forceAll = ctx.flags.force as boolean;
    const namespaceFilter = ctx.flags.namespace as string | undefined;
    const verbose = ctx.flags.verbose as boolean;
    const BATCH_SIZE = 100;

    const cwd = ctx.cwd || process.cwd();

    output.writeln();
    output.writeln(output.bold('Rebuilding Embedding Index'));
    output.writeln(output.dim('─'.repeat(50)));

    const { db, dbPath } = await openDb(cwd);

    // Build query
    let sql = `SELECT id, key, namespace, content FROM memory_entries WHERE status = 'active'`;
    const params: string[] = [];

    if (!forceAll) {
      sql += ` AND (embedding IS NULL OR embedding = '')`;
    }
    if (namespaceFilter) {
      sql += ` AND namespace = ?`;
      params.push(namespaceFilter);
    }
    sql += ` ORDER BY created_at DESC`;

    const stmt = db.prepare(sql);
    stmt.bind(params);
    const entries: Array<{ id: string; key: string; namespace: string; content: string }> = [];
    while (stmt.step()) entries.push(stmt.getAsObject() as any);
    stmt.free();

    // Atomic write + post-condition check shared by both code paths below
    // (no-work-needed early return and post-embedding completion). Throws
    // are caught here to surface a clean CommandResult; the index-all.mjs
    // hnsw-rebuild step relies on the non-zero exit when this fails.
    const writeSidecarOrFail = async (showBytes: boolean): Promise<CommandResult | null> => {
      const { buildAndWriteHnswSidecar } = await import('../memory/hnsw-persistence.js');
      try {
        const result = await buildAndWriteHnswSidecar(dbPath, cwd);
        const tail = showBytes ? ` (${(result.bytes / 1024).toFixed(1)} KB)` : '';
        output.writeln(`  HNSW sidecar:    ${result.vectorCount} vectors → ${result.sidecarPath}${tail}`);
        if (!fs.existsSync(result.sidecarPath)) {
          output.printError(`HNSW sidecar missing after write: ${result.sidecarPath}`);
          return { success: false, exitCode: 1 };
        }
        return null;
      } catch (err) {
        const msg = errorDetail(err);
        output.printError(`HNSW sidecar write failed: ${msg}`);
        return { success: false, exitCode: 1 };
      }
    };

    if (entries.length === 0) {
      // Show stats
      const totalStmt = db.prepare(`SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active'`);
      const total = totalStmt.step() ? (totalStmt.getAsObject() as any).cnt : 0;
      totalStmt.free();

      const embedStmt = db.prepare(`SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active' AND embedding IS NOT NULL AND embedding != ''`);
      const withEmbed = embedStmt.step() ? (embedStmt.getAsObject() as any).cnt : 0;
      embedStmt.free();

      output.printSuccess(`All entries already have embeddings (${withEmbed}/${total})`);
      db.close();

      // Refresh the HNSW sidecar even on the no-work path so a consumer
      // that upgrades to this release with embeddings already current
      // still gets the cold-start speedup.
      if (withEmbed > 0) {
        const fail = await writeSidecarOrFail(false);
        if (fail) return fail;
      }

      return { success: true };
    }

    output.writeln(`Found ${entries.length} entries to embed`);
    output.writeln();

    const { generateEmbedding } = await import('../memory/memory-initializer.js');

    let embedded = 0;
    let failed = 0;
    const startTime = Date.now();

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      try {
        const text = entry.content.substring(0, 1500);
        const { embedding, dimensions, model } = await generateEmbedding(text);

        db.run(
          `UPDATE memory_entries SET embedding = ?, embedding_model = ?, embedding_dimensions = ?, updated_at = ? WHERE id = ?`,
          [JSON.stringify(embedding), model, dimensions, Date.now(), entry.id]
        );
        embedded++;

        if (verbose && (i + 1) % 10 === 0) {
          output.writeln(output.dim(`  Progress: ${i + 1}/${entries.length}`));
        }
      } catch (err: any) {
        if (verbose) {
          output.writeln(output.dim(`  Failed: ${entry.key}: ${err.message}`));
        }
        failed++;
      }

      // node:sqlite + WAL persists each db.run incrementally — the
      // periodic batch flush sql.js needed here was the export-+-rewrite
      // pattern Phase 5 (#1084) killed. No flush needed.
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

    // Final stats
    const totalStmt2 = db.prepare(`SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active'`);
    const total2 = totalStmt2.step() ? (totalStmt2.getAsObject() as any).cnt : 0;
    totalStmt2.free();

    const embedStmt2 = db.prepare(`SELECT COUNT(*) as cnt FROM memory_entries WHERE status = 'active' AND embedding IS NOT NULL AND embedding != ''`);
    const withEmbed2 = embedStmt2.step() ? (embedStmt2.getAsObject() as any).cnt : 0;
    embedStmt2.free();

    if (embedded > 0) {
      saveAndCloseDb(db, dbPath);
    } else {
      db.close();
    }

    output.writeln();
    output.writeln(output.bold('Embedding Generation Complete'));
    output.writeln(`  Embedded:        ${embedded} entries`);
    output.writeln(`  Failed:          ${failed} entries`);
    output.writeln(`  Time:            ${totalTime}s`);
    output.writeln(`  Total coverage:  ${withEmbed2}/${total2} entries`);

    // Build + persist the HNSW sidecar so cold-start memory searches
    // skip the full SQL→graph rebuild. Failure is fatal — bin/index-all.mjs
    // and any caller of this command depend on the sidecar landing on disk.
    if (withEmbed2 > 0) {
      const fail = await writeSidecarOrFail(true);
      if (fail) return fail;
    }

    return { success: failed === 0, exitCode: failed > 0 ? 1 : 0 };
  }
};

// ============================================================================
// code-map subcommand — delegates to the single shipped generator (#1260)
// ============================================================================

/**
 * Resolve the file-level code-map generator (`bin/generate-code-map.mjs`) for
 * `cwd`, reusing moflo's canonical bin resolver so this dist CLI command and
 * the batch indexer (`.claude/scripts/index-all.mjs`) spawn the exact same
 * script — one generator, one key scheme (#1260).
 *
 * Cross-platform: the resolver is located via a cwd-relative path (never a
 * file-relative `../../../../` depth — that broke #1126) and imported as a
 * `file://` URL so Windows accepts the absolute path (Rule #1). Returns null
 * when no copy is found (broken install / not-yet-synced worktree).
 */
async function resolveCodeMapGenerator(cwd: string): Promise<string | null> {
  const { pathToFileURL } = await import('url');
  const resolverCandidates = [
    pathModule.join(cwd, 'node_modules', 'moflo', 'bin', 'lib', 'resolve-bin.mjs'),
    pathModule.join(cwd, 'bin', 'lib', 'resolve-bin.mjs'), // dev / source tree
  ];
  for (const resolverPath of resolverCandidates) {
    if (!fs.existsSync(resolverPath)) continue;
    try {
      const { resolveMofloBin } = await import(pathToFileURL(resolverPath).href);
      return (
        resolveMofloBin(cwd, 'flo-codemap', 'generate-code-map.mjs', {
          includeDevFallback: true,
        }) ?? null
      );
    } catch {
      // Fall through to the next resolver candidate.
    }
  }
  return null;
}

const codeMapCommand: Command = {
  name: 'code-map',
  description: 'Generate the structural code map (project overviews, directory details, type + file indexes) into the code-map namespace',
  options: [
    {
      name: 'force',
      short: 'f',
      description: 'Force full regeneration even if file list unchanged',
      type: 'boolean',
      default: false
    },
    {
      name: 'verbose',
      description: 'Show detailed logging',
      type: 'boolean',
      default: false
    },
    {
      name: 'stats',
      description: 'Print stats and exit without regenerating',
      type: 'boolean',
      default: false
    },
    {
      name: 'no-embeddings',
      description: 'Skip embedding generation after mapping',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'flo memory code-map', description: 'Incremental code map update' },
    { command: 'flo memory code-map --force', description: 'Full regeneration' },
    { command: 'flo memory code-map --stats', description: 'Show stats only' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const forceRegen = ctx.flags.force as boolean;
    const verbose = ctx.flags.verbose as boolean;
    const statsOnly = ctx.flags.stats as boolean;
    const skipEmbeddings = ctx.flags.noEmbeddings as boolean;
    const cwd = ctx.cwd || process.cwd();

    output.writeln();
    output.writeln(output.bold('Generating Code Map'));
    output.writeln(output.dim('─'.repeat(50)));

    // Single source of truth (#1260): delegate to the one shipped generator —
    // the same `bin/generate-code-map.mjs` that `index-all.mjs` runs. This
    // command previously carried a SECOND, divergent generator (directory-level
    // scheme with no `file:` entries, a path-list-only skip hash at a different
    // cache path, and a DELETE+reinsert write that nulled embeddings). The two
    // fought over the `code-map` namespace and accumulated orphaned rows that
    // neither skip-cache could reconcile. Delegating here makes divergence
    // structurally impossible.
    const script = await resolveCodeMapGenerator(cwd);
    if (!script) {
      output.printError(
        'Could not locate the code-map generator (bin/generate-code-map.mjs). Is the moflo package installed?',
      );
      return { success: false, exitCode: 1 };
    }

    const scriptArgs: string[] = [];
    if (forceRegen) scriptArgs.push('--force');
    if (verbose) scriptArgs.push('--verbose');
    if (statsOnly) scriptArgs.push('--stats');
    if (skipEmbeddings) scriptArgs.push('--no-embeddings');

    const { execFileSync } = await import('child_process');
    try {
      // process.execPath (not bare 'node') so the child uses the exact same
      // interpreter with no PATH dependency — robust on Windows where the
      // launching node need not be on PATH (Rule #1). execFileSync passes argv
      // as an array, so spaces in the path (e.g. "Program Files") are safe.
      execFileSync(process.execPath, [script, ...scriptArgs], {
        cwd,
        stdio: 'inherit',
        windowsHide: true,
        timeout: 5 * 60_000,
      });
    } catch (err) {
      const code = (err as { status?: number }).status;
      output.printError(
        `Code map generation failed${typeof code === 'number' ? ` (exit ${code})` : ''}: ${errorDetail(err)}`,
      );
      return { success: false, exitCode: typeof code === 'number' ? code : 1 };
    }

    return { success: true };
  }
};

// refresh subcommand — reindex everything + vacuum
const refreshCommand: Command = {
  name: 'refresh',
  description: 'Reindex all guidance and code, rebuild embeddings, clean up expired entries, and vacuum the database',
  options: [
    {
      name: 'skip-guidance',
      description: 'Skip guidance reindexing',
      type: 'boolean',
      default: false,
    },
    {
      name: 'skip-code-map',
      description: 'Skip code map regeneration',
      type: 'boolean',
      default: false,
    },
    {
      name: 'skip-cleanup',
      description: 'Skip expired entry cleanup',
      type: 'boolean',
      default: false,
    },
    {
      name: 'verbose',
      short: 'v',
      description: 'Verbose output',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    { command: 'flo memory refresh', description: 'Full reindex + vacuum' },
    { command: 'flo memory refresh --skip-code-map', description: 'Reindex guidance only + vacuum' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const skipGuidance = ctx.flags.skipGuidance as boolean;
    const skipCodeMap = ctx.flags.skipCodeMap as boolean;
    const skipCleanup = ctx.flags.skipCleanup as boolean;

    output.writeln();
    output.writeln(output.bold('MoFlo Memory Refresh'));
    output.writeln(output.dim('Reindex all content, rebuild embeddings, clean up, and vacuum'));
    output.writeln(output.dim('─'.repeat(60)));
    output.writeln();

    const t0 = performance.now();
    const steps: { name: string; status: 'pass' | 'fail' | 'skip'; message: string; duration: number }[] = [];

    // Helper to run a subcommand action
    const runStep = async (name: string, skip: boolean, action: () => Promise<CommandResult | void>): Promise<void> => {
      if (skip) {
        steps.push({ name, status: 'skip', message: 'Skipped', duration: 0 });
        output.writeln(`${output.dim('○')} ${name}: ${output.dim('Skipped')}`);
        return;
      }
      const stepStart = performance.now();
      try {
        const result = await action();
        const dur = performance.now() - stepStart;
        const success = result === undefined || result.success;
        steps.push({ name, status: success ? 'pass' : 'fail', message: success ? 'Done' : (result?.message || 'Failed'), duration: dur });
        const icon = success ? output.success('✓') : output.error('✗');
        const durStr = dur < 1000 ? `${dur.toFixed(0)}ms` : `${(dur / 1000).toFixed(1)}s`;
        output.writeln(`${icon} ${name} ${output.dim(`(${durStr})`)}`);
      } catch (err) {
        const dur = performance.now() - stepStart;
        const msg = errorDetail(err);
        steps.push({ name, status: 'fail', message: msg, duration: dur });
        output.writeln(`${output.error('✗')} ${name}: ${msg}`);
      }
    };

    // Build a fake context with force flag for subcommand calls
    const forceCtx: CommandContext = {
      args: [],
      flags: { force: true, _: [], 'no-embeddings': false, overlap: 20 },
      cwd: ctx.cwd,
      interactive: false,
    };

    // Step 1: Index guidance
    await runStep('Index Guidance', skipGuidance, async () => {
      return indexGuidanceCommand.action!(forceCtx) as Promise<CommandResult>;
    });

    // Step 2: Code map
    await runStep('Code Map', skipCodeMap, async () => {
      const codeMapCtx: CommandContext = {
        args: [],
        flags: { force: true, _: [], stats: false },
        cwd: ctx.cwd,
        interactive: false,
      };
      return codeMapCommand.action!(codeMapCtx) as Promise<CommandResult>;
    });

    // Step 3: Rebuild embeddings
    await runStep('Rebuild Embeddings', false, async () => {
      const rebuildCtx: CommandContext = {
        args: [],
        flags: { force: true, _: [] },
        cwd: ctx.cwd,
        interactive: false,
      };
      return rebuildIndexCommand.action!(rebuildCtx) as Promise<CommandResult>;
    });

    // Step 4: Cleanup expired entries (direct SQL — avoids MCP dependency)
    await runStep('Cleanup Expired', skipCleanup, async () => {
      const { db, dbPath } = await openDb(ctx.cwd);
      try {
        const now = Date.now();
        const result = db.run(
          `DELETE FROM memory_entries WHERE expires_at IS NOT NULL AND expires_at > 0 AND expires_at < ?`,
          [now]
        );
        const deleted = db.getRowsModified();
        if (deleted > 0) {
          saveAndCloseDb(db, dbPath);
          output.writeln(output.dim(`  Removed ${deleted} expired entries`));
        } else {
          db.close();
          output.writeln(output.dim('  No expired entries found'));
        }
        return { success: true };
      } catch (err) {
        try { db.close(); } catch { /* ignore */ }
        throw err;
      }
    });

    // Step 5: VACUUM the database
    await runStep('Vacuum Database', false, async () => {
      const { db, dbPath } = await openDb(ctx.cwd);
      try {
        db.run('VACUUM');
        saveAndCloseDb(db, dbPath);
        return { success: true };
      } catch (err) {
        try { db.close(); } catch { /* ignore */ }
        throw err;
      }
    });

    // Summary
    const totalTime = performance.now() - t0;
    const passed = steps.filter(s => s.status === 'pass').length;
    const failed = steps.filter(s => s.status === 'fail').length;
    const skipped = steps.filter(s => s.status === 'skip').length;

    output.writeln();
    output.writeln(output.dim('─'.repeat(60)));

    const parts = [
      output.success(`${passed} done`),
      failed > 0 ? output.error(`${failed} failed`) : null,
      skipped > 0 ? output.dim(`${skipped} skipped`) : null,
    ].filter(Boolean);

    const durStr = totalTime < 1000 ? `${totalTime.toFixed(0)}ms` : `${(totalTime / 1000).toFixed(1)}s`;
    output.writeln(`${output.bold('Refresh complete:')} ${parts.join(', ')} ${output.dim(`(${durStr})`)}`);

    if (failed > 0) {
      return { success: false, exitCode: 1 };
    }
    return { success: true };
  },
};

// Manual recovery for legacy DBs the launcher's auto cherry-pick can't reach
// — schema mismatches that made the auto-run skip, an even older legacy DB
// the candidate list doesn't include, or a friend's exported DB.
const restoreLearningsCommand: Command = {
  name: 'restore-learnings',
  description: 'Cherry-pick learnings/knowledge entries from a legacy DB into .moflo/moflo.db',
  options: [
    {
      name: 'from',
      description: 'Path to the legacy DB to read from (e.g. .swarm/memory.db)',
      type: 'string',
      required: true,
    },
  ],
  examples: [
    { command: 'flo memory restore-learnings --from .swarm/memory.db', description: 'Recover from a legacy memory DB' },
    { command: 'flo memory restore-learnings --from .swarm/memory.db.bak', description: 'Recover from a post-upgrade .bak' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const from = ctx.flags.from as string;
    if (!from) {
      output.printError('Source DB path is required. Use --from <path>');
      return { success: false, exitCode: 1 };
    }
    const sourcePath = pathModule.resolve(from);
    if (!fs.existsSync(sourcePath)) {
      output.printError(`Source DB not found: ${sourcePath}`);
      return { success: false, exitCode: 1 };
    }

    try {
      const { cherryPickLearningsFromLegacy, CHERRY_PICK_SKIP_REASONS } = await import(
        '../services/cherry-pick-learnings.js'
      );
      const result = await cherryPickLearningsFromLegacy({
        projectRoot: process.cwd(),
        legacyPaths: [sourcePath],
      });
      const report = result.sources[0];
      if (report?.reason === CHERRY_PICK_SKIP_REASONS.SCHEMA_MISMATCH) {
        output.printWarning(`Source DB has no memory_entries table — nothing to copy: ${sourcePath}`);
        return { success: true, data: result };
      }
      if (report?.reason === CHERRY_PICK_SKIP_REASONS.OPEN_FAILED) {
        output.printError(`Could not open source DB: ${sourcePath}`);
        return { success: false, exitCode: 1, data: result };
      }
      output.printSuccess(
        `Cherry-picked ${result.copied} of ${result.considered} learning/knowledge entries from ${sourcePath}`,
      );
      if (result.copied < result.considered) {
        output.printInfo(
          `${result.considered - result.copied} duplicate row${result.considered - result.copied === 1 ? '' : 's'} skipped (INSERT OR IGNORE)`,
        );
      }
      output.printInfo(`Target: ${result.target}`);
      return { success: true, data: result };
    } catch (error) {
      output.printError(
        `restore-learnings failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return { success: false, exitCode: 1 };
    }
  },
};

/**
 * Expand a leading `~` to the user's home directory before path resolution.
 * `path.resolve` does NOT do this — `~/x` would resolve to `<cwd>/~/x`. Handles
 * both POSIX (`~/`) and Windows (`~\`) separators and bare `~` (Rule #1); a
 * `~user` form is left untouched (we only resolve the current user's home).
 */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return pathModule.join(os.homedir(), p.slice(2));
  }
  return p;
}

// Sync command (#1233, epic #1231) — portable durable artifact for same-user
// multi-machine sharing. One durable-aware verb over the existing cherry-pick
// primitive: it carries the durable slice (learnings, knowledge) to/from a
// portable SQLite artifact you keep in a synced folder (Dropbox/iCloud) or copy
// by hand. Embeddings ride along verbatim (no lossy re-embed) and the merge is
// INSERT OR IGNORE on UNIQUE(namespace, key), so re-running --from is a no-op.
//   --to <path>    flush local durable namespaces → artifact (created if absent)
//   --from <path>  merge an artifact → local durable namespaces
const syncCommand: Command = {
  name: 'sync',
  description: 'Export/import durable learnings to a portable artifact for multi-machine sharing',
  options: [
    {
      name: 'to',
      description: 'Write the durable slice (learnings, knowledge) to this artifact path',
      type: 'string',
    },
    {
      name: 'from',
      description: 'Merge a durable artifact at this path into the local DB',
      type: 'string',
    },
  ],
  examples: [
    {
      command: 'flo memory sync --to ~/Dropbox/moflo/durable.db',
      description: 'Export durable learnings to a synced folder',
    },
    {
      command: 'flo memory sync --from ~/Dropbox/moflo/durable.db',
      description: 'Merge durable learnings carried from another machine',
    },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const to = ctx.flags.to as string | undefined;
    const from = ctx.flags.from as string | undefined;
    if ((!to && !from) || (to && from)) {
      output.printError('Specify exactly one direction: --to <path> (export) or --from <path> (import).');
      return { success: false, exitCode: 1 };
    }

    const projectRoot = findProjectRoot();
    const localDb = memoryDbPath(projectRoot);
    const { cherryPickLearningsFromLegacy, DURABLE_NAMESPACES, CHERRY_PICK_SKIP_REASONS } = await import(
      '../services/cherry-pick-learnings.js'
    );
    const plural = (n: number): string => (n === 1 ? 'y' : 'ies');

    const SELF = CHERRY_PICK_SKIP_REASONS.SELF_REFERENCE;

    try {
      if (to) {
        const artifact = pathModule.resolve(expandHome(to));
        if (!fs.existsSync(localDb)) {
          output.printWarning(`No local memory DB at ${localDb} — nothing to export yet.`);
          return { success: true, data: { copied: 0 } };
        }
        const result = await cherryPickLearningsFromLegacy({
          projectRoot,
          legacyPaths: [localDb],
          toPath: artifact,
          namespaces: DURABLE_NAMESPACES,
        });
        // The only no-op cherry-pick can hit here (source is our own valid DB)
        // is the artifact aliasing the local DB — surface it, don't claim a copy.
        if (result.sources[0]?.reason === SELF) {
          output.printWarning(`--to path is the local memory DB itself (${artifact}) — nothing to export.`);
          return { success: true, data: result };
        }
        output.printSuccess(`Exported ${result.copied} durable entr${plural(result.copied)} to ${artifact}`);
        if (result.considered > result.copied) {
          output.printInfo(`${result.considered - result.copied} already present in the artifact (skipped).`);
        }
        return { success: true, data: result };
      }

      // --from: merge the artifact into the local durable namespaces.
      const artifact = pathModule.resolve(expandHome(from!));
      if (!fs.existsSync(artifact)) {
        output.printError(`Artifact not found: ${artifact}`);
        return { success: false, exitCode: 1 };
      }
      const result = await cherryPickLearningsFromLegacy({
        projectRoot,
        legacyPaths: [artifact],
        toPath: localDb,
        namespaces: DURABLE_NAMESPACES,
      });
      const report = result.sources[0];
      if (report?.reason === CHERRY_PICK_SKIP_REASONS.SCHEMA_MISMATCH) {
        output.printWarning(`Artifact has no memory_entries table — not a moflo durable artifact: ${artifact}`);
        return { success: true, data: result };
      }
      if (report?.reason === CHERRY_PICK_SKIP_REASONS.OPEN_FAILED) {
        output.printError(`Could not open artifact: ${artifact}`);
        return { success: false, exitCode: 1, data: result };
      }
      if (report?.reason === SELF) {
        output.printWarning(`--from path is the local memory DB itself (${artifact}) — nothing to merge.`);
        return { success: true, data: result };
      }
      // No recognised source report at all (e.g. the artifact vanished between
      // the existsSync check above and the open — TOCTOU): a 0/0 result is not
      // a real merge, so don't report success as if rows moved.
      if (!report && result.considered === 0) {
        output.printWarning(`No durable entries read from ${artifact} — it may have been moved or emptied.`);
        return { success: true, data: result };
      }
      output.printSuccess(`Merged ${result.copied} durable entr${plural(result.copied)} from ${artifact}`);
      if (result.considered > result.copied) {
        const dupes = result.considered - result.copied;
        output.printInfo(`${dupes} duplicate${dupes === 1 ? '' : 's'} skipped (conflict-free merge).`);
      }
      if (result.copied > 0) {
        output.printInfo(
          'Restart your Claude Code session (or run `flo memory rebuild-index`) so the merged learnings are searchable.',
        );
      }
      return { success: true, data: result };
    } catch (error) {
      output.printError(`memory sync failed: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

// Team-share commands (#1234, epic #1231) — a git-tracked JSONL artifact the
// team commits. `team-export` writes the local durable slice into it (merge,
// first-write-wins, provenance-stamped) and makes it git-trackable; session-
// start (and `team-import`) merge it back into the local DB. Diffable JSONL is
// what makes this reviewable + merge-friendly, unlike the SQLite artifacts of
// stories #1232/#1233.
function resolveTeamArtifact(projectRoot: string, explicit: unknown): Promise<string> {
  return import('../services/team-artifact-sync.js').then(({ resolveTeamArtifactPath, DEFAULT_TEAM_ARTIFACT_REL }) => {
    if (typeof explicit === 'string' && explicit.trim().length > 0) {
      return pathModule.resolve(explicit.trim());
    }
    return resolveTeamArtifactPath(projectRoot) ?? pathModule.resolve(projectRoot, DEFAULT_TEAM_ARTIFACT_REL);
  });
}

const teamExportCommand: Command = {
  name: 'team-export',
  description: 'Write durable learnings into the git-tracked team artifact (JSONL) for sharing',
  options: [
    {
      name: 'to',
      description: 'Artifact path (default: memory.team_artifact or .moflo/shared/learnings.jsonl)',
      type: 'string',
    },
  ],
  examples: [
    { command: 'flo memory team-export', description: 'Merge local learnings into the team artifact, then git add + commit it' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const projectRoot = findProjectRoot();
    const artifactPath = await resolveTeamArtifact(projectRoot, ctx.flags.to);
    try {
      const { exportTeamArtifact, ensureSharedArtifactTracked } = await import('../services/team-artifact-sync.js');
      const report = exportTeamArtifact({ projectRoot, artifactPath, sharedAt: new Date().toISOString() });
      const gitignore = ensureSharedArtifactTracked(projectRoot, artifactPath);

      const rel = pathModule.relative(projectRoot, artifactPath) || artifactPath;
      output.printSuccess(`Shared ${report.added} new durable entr${report.added === 1 ? 'y' : 'ies'} → ${rel}`);
      output.printInfo(`Artifact now holds ${report.total} entr${report.total === 1 ? 'y' : 'ies'}.`);
      if (gitignore !== 'unchanged') {
        output.printInfo(`.gitignore ${gitignore} so the shared artifact is tracked while the rest of .moflo/ stays ignored.`);
      }
      output.printInfo(`Commit it to share: git add ${rel} && git commit -m "share learnings"`);
      return { success: true, data: report };
    } catch (error) {
      output.printError(`team-export failed: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

const teamImportCommand: Command = {
  name: 'team-import',
  description: 'Merge the git-tracked team artifact (JSONL) into the local learnings',
  options: [
    {
      name: 'from',
      description: 'Artifact path (default: memory.team_artifact or .moflo/shared/learnings.jsonl)',
      type: 'string',
    },
  ],
  examples: [
    { command: 'flo memory team-import', description: 'Merge teammates shared learnings after a git pull' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const projectRoot = findProjectRoot();
    const artifactPath = await resolveTeamArtifact(projectRoot, ctx.flags.from);
    if (!fs.existsSync(artifactPath)) {
      output.printError(`Team artifact not found: ${artifactPath}`);
      output.printInfo('A teammate runs `flo memory team-export` + commits it first.');
      return { success: false, exitCode: 1 };
    }
    try {
      const { importTeamArtifact } = await import('../services/team-artifact-sync.js');
      const report = importTeamArtifact({ projectRoot, artifactPath });
      output.printSuccess(`Merged ${report.imported} durable entr${report.imported === 1 ? 'y' : 'ies'} from the team artifact`);
      if (report.considered > report.imported) {
        output.printInfo(`${report.considered - report.imported} already present (skipped, conflict-free).`);
      }
      if (report.skippedMalformed > 0) {
        output.printWarning(`${report.skippedMalformed} malformed line${report.skippedMalformed === 1 ? '' : 's'} skipped.`);
      }
      if (report.skippedNonDurable > 0) {
        output.printWarning(`${report.skippedNonDurable} non-durable entr${report.skippedNonDurable === 1 ? 'y' : 'ies'} skipped (only learnings/knowledge are shared).`);
      }
      if (report.imported > 0) {
        output.printInfo(
          'Restart your Claude Code session (or run `flo memory rebuild-index`) so the merged learnings are embedded + searchable.',
        );
      }
      return { success: true, data: report };
    } catch (error) {
      output.printError(`team-import failed: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

// Snapshot backup/restore (#1244, epic #1231) — whole-DB hydration for fast
// cold-start. Unlike `sync`/`team-*` (which move only the durable slice), these
// move the ENTIRE DB (structural + durable + embeddings) so a fresh workspace
// is searchable on its first session without a full reindex. Safe because each
// restored workspace owns its own copy — this is snapshot-restore, NOT the
// forbidden live whole-DB sharing (see `flo doctor -c shared-db`).
const backupCommand: Command = {
  name: 'backup',
  description: 'Write a whole-DB snapshot (structural + durable + embeddings) for fast workspace hydration',
  options: [
    { name: 'to', description: 'Snapshot destination path', type: 'string' },
  ],
  examples: [
    { command: 'flo memory backup --to ~/moflo-snapshots/myproject.db', description: 'Snapshot the local memory DB for seeding fresh workspaces' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const to = ctx.flags.to as string | undefined;
    if (!to) {
      output.printError('Specify a destination: --to <snapshot path>.');
      return { success: false, exitCode: 1 };
    }
    const projectRoot = findProjectRoot();
    try {
      const { backupSnapshot } = await import('../services/snapshot-restore.js');
      const result = backupSnapshot({ projectRoot, toPath: pathModule.resolve(expandHome(to)) });
      const mb = (result.bytes / (1024 * 1024)).toFixed(1);
      output.printSuccess(`Snapshot written → ${result.target} (${mb} MB)`);
      output.printInfo('Hydrate a fresh workspace with `flo memory restore --from <path>` or `memory.hydrate_from` in moflo.yaml.');
      return { success: true, data: result };
    } catch (error) {
      output.printError(`memory backup failed: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

const restoreCommand: Command = {
  name: 'restore',
  description: 'Hydrate the local memory DB from a whole-DB snapshot (no-op unless the local DB is empty)',
  options: [
    { name: 'from', description: 'Snapshot source path', type: 'string' },
    { name: 'force', description: 'Overwrite even when the local DB already has content', type: 'boolean' },
  ],
  examples: [
    { command: 'flo memory restore --from ~/moflo-snapshots/myproject.db', description: 'Seed an empty workspace from a snapshot' },
    { command: 'flo memory restore --from snap.db --force', description: 'Replace the local DB even if it has content' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const from = ctx.flags.from as string | undefined;
    if (!from) {
      output.printError('Specify a source: --from <snapshot path>.');
      return { success: false, exitCode: 1 };
    }
    const projectRoot = findProjectRoot();
    try {
      const { restoreSnapshot, RESTORE_SKIP_REASONS } = await import('../services/snapshot-restore.js');
      const result = await restoreSnapshot({
        projectRoot,
        fromPath: pathModule.resolve(expandHome(from)),
        force: Boolean(ctx.flags.force),
      });
      if (result.restored) {
        const mb = ((result.bytes ?? 0) / (1024 * 1024)).toFixed(1);
        output.printSuccess(`Restored local memory DB from snapshot (${mb} MB) → ${result.target}`);
        if ((result.purged ?? 0) > 0) {
          output.printInfo(`${result.purged} ephemeral row${result.purged === 1 ? '' : 's'} purged from the restored copy.`);
        }
        output.printInfo('Restart your Claude Code session so the daemon indexes the restored DB.');
        return { success: true, data: result };
      }
      switch (result.reason) {
        case RESTORE_SKIP_REASONS.LOCAL_NOT_EMPTY:
          output.printWarning('Local memory DB already has content — not clobbering it. Use --force to override.');
          break;
        case RESTORE_SKIP_REASONS.SNAPSHOT_MISSING:
          output.printError(`Snapshot not found: ${pathModule.resolve(expandHome(from))}`);
          return { success: false, exitCode: 1, data: result };
        case RESTORE_SKIP_REASONS.INVALID_SNAPSHOT:
          output.printError('Source is not a moflo snapshot (no memory_entries table).');
          return { success: false, exitCode: 1, data: result };
        case RESTORE_SKIP_REASONS.SELF_REFERENCE:
          output.printWarning('--from path is the local memory DB itself — nothing to restore.');
          break;
        default:
          output.printWarning('Restore was a no-op.');
      }
      return { success: true, data: result };
    } catch (error) {
      output.printError(`memory restore failed: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  },
};

// Main memory command
export const memoryCommand: Command = {
  name: 'memory',
  description: 'Memory management commands',
  subcommands: [initMemoryCommand, storeCommand, retrieveCommand, searchCommand, listCommand, deleteCommand, statsCommand, configureCommand, cleanupCommand, compressCommand, exportCommand, importCommand, indexGuidanceCommand, rebuildIndexCommand, codeMapCommand, refreshCommand, restoreLearningsCommand, syncCommand, teamExportCommand, teamImportCommand, backupCommand, restoreCommand],
  options: [],
  examples: [
    { command: 'flo memory store -k "key" -v "value"', description: 'Store data' },
    { command: 'flo memory search -q "auth patterns"', description: 'Search memory' },
    { command: 'flo memory stats', description: 'Show statistics' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Memory Management Commands'));
    output.writeln();
    output.writeln('Usage: flo memory <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('init')}       - Initialize memory database (node:sqlite)`,
      `${output.highlight('store')}      - Store data in memory`,
      `${output.highlight('retrieve')}   - Retrieve data from memory`,
      `${output.highlight('search')}     - Semantic/vector search`,
      `${output.highlight('list')}       - List memory entries`,
      `${output.highlight('delete')}     - Delete memory entry`,
      `${output.highlight('stats')}      - Show statistics`,
      `${output.highlight('configure')}  - Configure backend`,
      `${output.highlight('cleanup')}    - Clean expired entries`,
      `${output.highlight('compress')}   - Compress database`,
      `${output.highlight('export')}     - Export memory to file`,
      `${output.highlight('import')}          - Import from file`,
      `${output.highlight('index-guidance')}  - Index .claude/guidance/ files with RAG segments`,
      `${output.highlight('rebuild-index')}   - Regenerate embeddings for memory entries`,
      `${output.highlight('code-map')}        - Generate structural code map`,
      `${output.highlight('refresh')}         - Reindex all content, rebuild embeddings, cleanup, and vacuum`,
      `${output.highlight('restore-learnings')} - Cherry-pick learnings/knowledge from a legacy DB`,
      `${output.highlight('sync')}             - Export/import durable learnings to a portable artifact (multi-machine)`,
      `${output.highlight('team-export')}      - Write durable learnings to the git-tracked team artifact (JSONL)`,
      `${output.highlight('team-import')}      - Merge the team artifact into local learnings`
    ]);

    return { success: true };
  }
};

export default memoryCommand;
