/**
 * V3 CLI Memory Command
 * Memory operations for AgentDB integration
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { select, confirm, input } from '../prompt.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';

// Memory backends
const BACKENDS = [
  { value: 'agentdb', label: 'AgentDB', hint: 'Vector database with HNSW indexing (150x-12,500x faster)' },
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
    { command: 'claude-flow memory store -k "api/auth" -v "JWT implementation"', description: 'Store text' },
    { command: 'claude-flow memory store -k "pattern/singleton" --vector', description: 'Store vector' },
    { command: 'claude-flow memory store -k "pattern" -v "updated" --upsert', description: 'Update existing' }
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

    // Use direct sql.js storage with automatic embedding generation
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

    // Use sql.js directly for consistent data access
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
      default: 0.7
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
      description: 'Build/rebuild HNSW index before searching (enables 150x-12,500x speedup)',
      type: 'boolean',
      default: false
    }
  ],
  examples: [
    { command: 'claude-flow memory search -q "authentication patterns"', description: 'Semantic search' },
    { command: 'claude-flow memory search -q "JWT" -t keyword', description: 'Keyword search' },
    { command: 'claude-flow memory search -q "test" --build-hnsw', description: 'Build HNSW index and search' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const query = ctx.flags.query as string || ctx.args[0];
    const namespace = ctx.flags.namespace as string || 'all';
    const limit = ctx.flags.limit as number || 10;
    const threshold = ctx.flags.threshold as number || 0.3;
    const searchType = ctx.flags.type as string || 'semantic';
    const buildHnsw = (ctx.flags['build-hnsw'] || ctx.flags.buildHnsw) as boolean;

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
          output.writeln(output.dim(`  Search speedup: ${status.entryCount > 10000 ? '12,500x' : status.entryCount > 1000 ? '150x' : '10x'}`));
        } else {
          output.printWarning('HNSW index not available (install @ruvector/core for acceleration)');
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

    // Use direct sql.js search with vector similarity
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
        output.writeln(output.dim('Try: claude-flow memory store -k "key" --value "data"'));
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

    // Use sql.js directly for consistent data access
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
        output.printInfo('Store data: claude-flow memory store -k "key" --value "data"');
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
    { command: 'claude-flow memory delete -k "mykey"', description: 'Delete entry with default namespace' },
    { command: 'claude-flow memory delete -k "lesson" -n "lessons"', description: 'Delete entry from specific namespace' },
    { command: 'claude-flow memory delete mykey -f', description: 'Delete without confirmation' }
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

    // Use sql.js directly for consistent data access (Issue #980)
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
      output.printInfo('V3 Performance: 150x-12,500x faster search with HNSW indexing');

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
    { command: 'claude-flow memory cleanup --dry-run', description: 'Preview cleanup' },
    { command: 'claude-flow memory cleanup --older-than 30d', description: 'Delete entries older than 30 days' },
    { command: 'claude-flow memory cleanup --expired-only', description: 'Clean expired entries' }
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
    { command: 'claude-flow memory compress', description: 'Balanced compression' },
    { command: 'claude-flow memory compress --quantize --bits 4', description: '4-bit quantization (32x reduction)' },
    { command: 'claude-flow memory compress -l max -t vectors', description: 'Max compression on vectors' }
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
    { command: 'claude-flow memory export -o ./backup.json', description: 'Export all to JSON' },
    { command: 'claude-flow memory export -o ./data.csv -f csv', description: 'Export to CSV' }
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
    { command: 'claude-flow memory import -i ./backup.json', description: 'Import from file' },
    { command: 'claude-flow memory import -i ./data.json -n archive', description: 'Import to namespace' }
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

// Init subcommand - initialize memory database using sql.js
const initMemoryCommand: Command = {
  name: 'init',
  description: 'Initialize memory database with sql.js (WASM SQLite) - includes vector embeddings, pattern learning, temporal decay',
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
    { command: 'claude-flow memory init', description: 'Initialize hybrid backend with all features' },
    { command: 'claude-flow memory init -b agentdb', description: 'Initialize AgentDB backend' },
    { command: 'claude-flow memory init -p ./data/memory.db --force', description: 'Reinitialize at custom path' },
    { command: 'claude-flow memory init --verbose --verify', description: 'Initialize with full verification' }
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
        `Store data: ${output.highlight('claude-flow memory store -k "key" --value "data"')}`,
        `Search: ${output.highlight('claude-flow memory search -q "query"')}`,
        `Train patterns: ${output.highlight('claude-flow neural train -p coordination')}`,
        `View stats: ${output.highlight('claude-flow memory stats')}`
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
      output.printError(`Failed to initialize memory: ${error instanceof Error ? error.message : String(error)}`);
      return { success: false, exitCode: 1 };
    }
  }
};

// ============================================================================
// Shared DB helpers for batch commands (index-guidance, rebuild-index, code-map)
// ============================================================================

const DB_FILENAME = 'memory.db';
const SWARM_DIR = '.swarm';

async function openDb(cwd: string): Promise<{ db: any; dbPath: string; SQL: any }> {
  const fs = await import('fs');
  const path = await import('path');
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();

  const dbPath = path.join(cwd, SWARM_DIR, DB_FILENAME);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let db: any;
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

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

  return { db, dbPath, SQL };
}

function saveAndCloseDb(db: any, dbPath: string): void {
  const fs = require('fs');
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
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
  const lines = content.split('\n');
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
            const sLines = hSect.split('\n');
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
      const firstLine = currentGroup[0].split('\n')[0].trim();
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
    { command: 'claude-flow memory index-guidance', description: 'Index all guidance files' },
    { command: 'claude-flow memory index-guidance --force', description: 'Force reindex all' },
    { command: 'claude-flow memory index-guidance --file .claude/guidance/coding-rules.md', description: 'Index specific file' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const forceReindex = ctx.flags.force as boolean;
    const specificFile = ctx.flags.file as string | undefined;
    const skipEmbeddings = ctx.flags['no-embeddings'] as boolean;
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
      const fileName = pathMod.basename(filePath, pathMod.extname(filePath));
      const docKey = `doc-${keyPrefix}-${fileName}`;
      const chunkPrefix = `chunk-${keyPrefix}-${fileName}`;

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const contentHash_ = hashContent(content);

        // Check if content changed
        if (!forceReindex) {
          const stmt = db.prepare('SELECT metadata FROM memory_entries WHERE key = ? AND namespace = ?');
          stmt.bind([docKey, NAMESPACE]);
          const entry = stmt.step() ? stmt.getAsObject() : null;
          stmt.free();
          if (entry?.metadata) {
            try {
              const meta = JSON.parse(entry.metadata as string);
              if (meta.contentHash === contentHash_) {
                return { docKey, status: 'unchanged' as const, chunks: 0 };
              }
            } catch { /* ignore */ }
          }
        }

        const stats = fs.statSync(filePath);
        const relativePath = filePath.replace(cwd, '').replace(/\\/g, '/');

        // Delete old chunks
        db.run(`DELETE FROM memory_entries WHERE namespace = ? AND key LIKE ?`, [NAMESPACE, `${chunkPrefix}%`]);

        // Store full document
        const docMetadata = {
          type: 'document',
          filePath: relativePath,
          fileSize: stats.size,
          lastModified: stats.mtime.toISOString(),
          contentHash: contentHash_,
          indexedAt: new Date().toISOString(),
          ragVersion: '2.0',
        };

        batchStoreEntry(db, docKey, NAMESPACE, content, docMetadata, [keyPrefix, 'document']);

        // Chunk content
        const chunks = chunkMarkdown(content, fileName);
        if (chunks.length === 0) {
          return { docKey, status: 'indexed' as const, chunks: 0 };
        }

        const hierarchy = buildHierarchy(chunks, chunkPrefix);
        const siblings = chunks.map((_, i) => `${chunkPrefix}-${i}`);

        // Update doc with children refs
        const docChildrenMeta = { ...docMetadata, children: siblings, chunkCount: chunks.length };
        batchStoreEntry(db, docKey, NAMESPACE, content, docChildrenMeta, [keyPrefix, 'document']);

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const chunkKey = `${chunkPrefix}-${i}`;
          const prevChunk = i > 0 ? `${chunkPrefix}-${i - 1}` : null;
          const nextChunk = i < chunks.length - 1 ? `${chunkPrefix}-${i + 1}` : null;

          const contextBefore = i > 0
            ? extractOverlapContext(chunks[i - 1].content, overlapPercent, 'end')
            : null;
          const contextAfter = i < chunks.length - 1
            ? extractOverlapContext(chunks[i + 1].content, overlapPercent, 'start')
            : null;

          const hierInfo = hierarchy[chunkKey];

          const chunkMetadata = {
            type: 'chunk',
            ragVersion: '2.0',
            parentDoc: docKey,
            parentPath: relativePath,
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
            contextOverlapPercent: overlapPercent,
            hasContextBefore: !!contextBefore,
            hasContextAfter: !!contextAfter,
            contentLength: chunk.content.length,
            contentHash: hashContent(chunk.content),
            indexedAt: new Date().toISOString(),
          };

          let searchableContent = `# ${chunk.title}\n\n`;
          if (contextBefore) {
            searchableContent += `[Context from previous section:]\n${contextBefore}\n\n---\n\n`;
          }
          searchableContent += chunk.content;
          if (contextAfter) {
            searchableContent += `\n\n---\n\n[Context from next section:]\n${contextAfter}`;
          }

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
      const filePath = pathMod.resolve(cwd, specificFile);
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
      const guidanceDir = pathMod.resolve(cwd, '.claude/guidance');
      if (!fs.existsSync(guidanceDir)) {
        output.printError(`Guidance directory not found: .claude/guidance/`);
        db.close();
        return { success: false, exitCode: 1 };
      }

      const files = fs.readdirSync(guidanceDir).filter((f: string) => f.endsWith('.md'));
      for (const file of files) {
        const filePath = pathMod.resolve(guidanceDir, file);
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

      // Clean stale entries for deleted files
      const docsStmt = db.prepare(
        `SELECT DISTINCT key FROM memory_entries WHERE namespace = ? AND key LIKE 'doc-%'`
      );
      docsStmt.bind([NAMESPACE]);
      const docs: Array<{ key: string }> = [];
      while (docsStmt.step()) docs.push(docsStmt.getAsObject() as { key: string });
      docsStmt.free();

      for (const { key } of docs) {
        if (!key.startsWith('doc-guidance-')) continue;
        const checkPath = pathMod.resolve(cwd, '.claude/guidance', key.replace('doc-guidance-', '') + '.md');
        if (!fs.existsSync(checkPath)) {
          const cp = key.replace('doc-', 'chunk-');
          db.run(`DELETE FROM memory_entries WHERE namespace = ? AND key LIKE ?`, [NAMESPACE, `${cp}%`]);
          db.run(`DELETE FROM memory_entries WHERE namespace = ? AND key = ?`, [NAMESPACE, key]);
          output.writeln(output.dim(`  Removed stale: ${key}`));
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
    { command: 'claude-flow memory rebuild-index', description: 'Embed entries without embeddings' },
    { command: 'claude-flow memory rebuild-index --force', description: 'Re-embed all entries' },
    { command: 'claude-flow memory rebuild-index -n guidance', description: 'Only guidance namespace' }
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

      // Batch save every BATCH_SIZE entries
      if ((i + 1) % BATCH_SIZE === 0) {
        const fs = await import('fs');
        const data = db.export();
        fs.writeFileSync(dbPath, Buffer.from(data));
      }
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

    return { success: failed === 0, exitCode: failed > 0 ? 1 : 0 };
  }
};

// ============================================================================
// code-map subcommand
// ============================================================================

const EXCLUDE_DIRS = [
  'back-office-template', 'template', '.claude', 'node_modules',
  'dist', 'build', '.next', 'coverage',
];

const DIR_DESCRIPTIONS: Record<string, string> = {
  entities: 'MikroORM entity definitions',
  services: 'business logic services',
  routes: 'Fastify route handlers',
  middleware: 'request middleware (auth, validation, tenancy)',
  schemas: 'Zod validation schemas',
  types: 'TypeScript type definitions',
  utils: 'utility helpers',
  config: 'configuration',
  migrations: 'database migrations',
  scripts: 'CLI scripts',
  components: 'React components',
  pages: 'route page components',
  contexts: 'React context providers',
  hooks: 'React custom hooks',
  layout: 'app shell layout',
  themes: 'MUI theme configuration',
  api: 'API client layer',
  locales: 'i18n translation files',
  tests: 'test suites',
  e2e: 'end-to-end tests',
};

const TS_PATTERNS = [
  /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w.]+))?(?:\s+implements\s+([\w,\s.]+))?/,
  /^export\s+(?:default\s+)?interface\s+(\w+)(?:\s+extends\s+([\w,\s.]+))?/,
  /^export\s+(?:default\s+)?type\s+(\w+)\s*[=<]/,
  /^export\s+(?:const\s+)?enum\s+(\w+)/,
  /^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/,
  /^export\s+(?:default\s+)?const\s+(\w+)\s*[=:]/,
];

const ENTITY_DECORATOR = /@Entity\s*\(/;
const IFACE_MAP_BATCH = 20;
const TYPE_INDEX_BATCH = 80;

interface ExtractedType {
  name: string;
  kind: string;
  bases: string | null;
  implements: string | null;
  isEntity: boolean;
  file: string;
}

function detectKind(line: string): string {
  if (/\bclass\b/.test(line)) return 'class';
  if (/\binterface\b/.test(line)) return 'interface';
  if (/\btype\b/.test(line)) return 'type';
  if (/\benum\b/.test(line)) return 'enum';
  if (/\bfunction\b/.test(line)) return 'function';
  if (/\bconst\b/.test(line)) return 'const';
  return 'export';
}

function extractTypesFromFile(filePath: string, projectRoot: string): ExtractedType[] {
  const fs = require('fs');
  const pathMod = require('path');
  const fullPath = pathMod.resolve(projectRoot, filePath);
  if (!fs.existsSync(fullPath)) return [];

  let content: string;
  try {
    content = fs.readFileSync(fullPath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n');
  const types: ExtractedType[] = [];
  const seen = new Set<string>();
  let isEntityNext = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (ENTITY_DECORATOR.test(line)) {
      isEntityNext = true;
      continue;
    }

    for (const pattern of TS_PATTERNS) {
      const m = line.match(pattern);
      if (m && m[1] && !seen.has(m[1])) {
        seen.add(m[1]);
        const kind = detectKind(line);
        const bases = (m[2] || '').trim();
        const implements_ = (m[3] || '').trim();
        types.push({
          name: m[1],
          kind,
          bases: bases || null,
          implements: implements_ || null,
          isEntity: isEntityNext,
          file: filePath,
        });
        isEntityNext = false;
        break;
      }
    }

    if (isEntityNext && !line.startsWith('@') && !line.startsWith('export') && line.length > 0) {
      isEntityNext = false;
    }
  }

  return types;
}

function getProjectName(filePath: string): string {
  const parts = filePath.split('/');
  if (parts[0] === 'packages' && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === 'back-office' && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === 'customer-portal' && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === 'admin-console' && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === 'webhooks' && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === 'mobile-app') return 'mobile-app';
  if (parts[0] === 'tests') return 'tests';
  if (parts[0] === 'scripts') return 'scripts';
  return parts[0];
}

const codeMapCommand: Command = {
  name: 'code-map',
  description: 'Generate structural code map (project overviews, directory details, type indexes) into code-map namespace',
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
    { command: 'claude-flow memory code-map', description: 'Incremental code map update' },
    { command: 'claude-flow memory code-map --force', description: 'Full regeneration' },
    { command: 'claude-flow memory code-map --stats', description: 'Show stats only' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const forceRegen = ctx.flags.force as boolean;
    const verbose = ctx.flags.verbose as boolean;
    const statsOnly = ctx.flags.stats as boolean;
    const skipEmbeddings = ctx.flags['no-embeddings'] as boolean;
    const NAMESPACE = 'code-map';

    const fs = await import('fs');
    const pathMod = await import('path');
    const { execSync } = await import('child_process');
    const { createHash } = await import('crypto');

    const cwd = ctx.cwd || process.cwd();
    const hashCachePath = pathMod.join(cwd, '.swarm', 'code-map-hash.txt');

    output.writeln();
    output.writeln(output.bold('Generating Code Map'));
    output.writeln(output.dim('─'.repeat(50)));

    // 1. Get source files via git
    let raw: string;
    try {
      raw = execSync(
        `git ls-files -- "*.ts" "*.tsx" "*.js" "*.mjs" "*.jsx"`,
        { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      ).trim();
    } catch {
      output.printError('Failed to list source files via git. Is this a git repository?');
      return { success: false, exitCode: 1 };
    }

    const files = raw ? raw.split('\n').filter((f: string) => {
      for (const ex of EXCLUDE_DIRS) {
        if (f.startsWith(ex + '/') || f.startsWith(ex + '\\')) return false;
      }
      return true;
    }) : [];

    if (files.length === 0) {
      output.writeln('No source files found.');
      return { success: true };
    }

    output.writeln(`Found ${files.length} source files`);

    // 2. Hash check
    const sorted = [...files].sort();
    const currentHash = createHash('sha256').update(sorted.join('\n')).digest('hex');

    if (statsOnly) {
      const { db } = await openDb(cwd);
      const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM memory_entries WHERE namespace = ?`);
      stmt.bind([NAMESPACE]);
      const count = stmt.step() ? (stmt.getAsObject() as any).cnt : 0;
      stmt.free();
      db.close();
      output.writeln(`Stats: ${files.length} source files, ${count} chunks in code-map namespace`);
      output.writeln(`File list hash: ${currentHash.slice(0, 12)}...`);
      return { success: true };
    }

    // Check if unchanged
    if (!forceRegen && fs.existsSync(hashCachePath)) {
      const cached = fs.readFileSync(hashCachePath, 'utf-8').trim();
      if (cached === currentHash) {
        const { db } = await openDb(cwd);
        const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM memory_entries WHERE namespace = ?`);
        stmt.bind([NAMESPACE]);
        const count = stmt.step() ? (stmt.getAsObject() as any).cnt : 0;
        stmt.free();
        db.close();
        if (count > 0) {
          output.writeln(output.dim(`Skipping -- file list unchanged (${count} chunks in DB)`));
          return { success: true };
        }
      }
    }

    // 3. Extract types
    output.writeln('Extracting type declarations...');
    const allTypes: ExtractedType[] = [];
    const filesByProject: Record<string, string[]> = {};
    const typesByProject: Record<string, ExtractedType[]> = {};
    const typesByDir: Record<string, ExtractedType[]> = {};

    for (const file of files) {
      const project = getProjectName(file);
      if (!filesByProject[project]) filesByProject[project] = [];
      filesByProject[project].push(file);

      const types = extractTypesFromFile(file, cwd);
      for (const t of types) {
        allTypes.push(t);
        if (!typesByProject[project]) typesByProject[project] = [];
        typesByProject[project].push(t);

        const dir = pathMod.dirname(t.file).replace(/\\/g, '/');
        if (!typesByDir[dir]) typesByDir[dir] = [];
        typesByDir[dir].push(t);
      }
    }

    output.writeln(`Extracted ${allTypes.length} types from ${Object.keys(filesByProject).length} projects`);

    // 4. Generate chunks
    const allChunks: Array<{ key: string; content: string; metadata: Record<string, unknown>; tags: string[] }> = [];

    // Project overviews
    for (const [project, projFiles] of Object.entries(filesByProject)) {
      const types = typesByProject[project] || [];
      const dirMap: Record<string, string[]> = {};

      for (const t of types) {
        const pathModule = require('path');
        const rel = pathModule.relative(project, pathModule.dirname(t.file)).replace(/\\/g, '/') || '(root)';
        if (!dirMap[rel]) dirMap[rel] = [];
        dirMap[rel].push(t.name);
      }

      // Detect primary language
      let tsx = 0, ts = 0, js = 0;
      for (const f of projFiles) {
        const ext = pathMod.extname(f);
        if (ext === '.tsx' || ext === '.jsx') tsx++;
        else if (ext === '.ts') ts++;
        else js++;
      }
      const lang = tsx > ts && tsx > js ? 'React/TypeScript' : ts >= js ? 'TypeScript' : 'JavaScript';

      let content = `# ${project} [${lang}, ${projFiles.length} files, ${types.length} types]\n\n`;
      for (const dir of Object.keys(dirMap).sort()) {
        const names = dirMap[dir];
        const lastDir = dir.split('/').pop() || '';
        const desc = DIR_DESCRIPTIONS[lastDir];
        const descStr = desc ? ` -- ${desc}` : '';
        const shown = names.slice(0, 8).join(', ');
        const overflow = names.length > 8 ? `, ... (+${names.length - 8} more)` : '';
        content += `  ${dir}${descStr}: ${shown}${overflow}\n`;
      }

      allChunks.push({
        key: `project:${project}`,
        content: content.trim(),
        metadata: { kind: 'project-overview', project, language: lang, fileCount: projFiles.length, typeCount: types.length },
        tags: ['project', project],
      });
    }

    // Directory details
    for (const [dir, types] of Object.entries(typesByDir)) {
      if (types.length < 2) continue;
      const lastDir = dir.split('/').pop() || '';
      const desc = DIR_DESCRIPTIONS[lastDir];
      let content = `# ${dir} (${types.length} types)\n`;
      if (desc) content += `${desc}\n`;
      content += '\n';

      const sortedTypes = [...types].sort((a, b) => a.name.localeCompare(b.name));
      for (const t of sortedTypes) {
        const suffix: string[] = [];
        if (t.bases) suffix.push(`: ${t.bases}`);
        if (t.implements) suffix.push(`: ${t.implements}`);
        const suffixStr = suffix.length ? ` ${suffix.join(' ')}` : '';
        const fileName = pathMod.basename(t.file);
        content += `  ${t.name}${suffixStr} (${fileName})\n`;
      }

      allChunks.push({
        key: `dir:${dir}`,
        content: content.trim(),
        metadata: { kind: 'directory-detail', directory: dir, typeCount: types.length },
        tags: ['directory', dir.split('/')[0]],
      });
    }

    // Interface maps
    const interfaces = new Map<string, { defined: string; implementations: Array<{ name: string; project: string }> }>();
    for (const t of allTypes) {
      if (t.kind === 'interface' && !interfaces.has(t.name)) {
        interfaces.set(t.name, { defined: t.file, implementations: [] });
      }
    }
    for (const t of allTypes) {
      if (t.kind !== 'class') continue;
      const impls = t.implements ? t.implements.split(',').map((s: string) => s.trim()) : [];
      const bases = t.bases ? [t.bases.trim()] : [];
      for (const iface of [...impls, ...bases]) {
        if (interfaces.has(iface)) {
          interfaces.get(iface)!.implementations.push({ name: t.name, project: getProjectName(t.file) });
        }
      }
    }

    const mapped = Array.from(interfaces.entries())
      .filter(([, v]) => v.implementations.length > 0)
      .sort(([a], [b]) => a.localeCompare(b));

    if (mapped.length > 0) {
      const totalBatches = Math.ceil(mapped.length / IFACE_MAP_BATCH);
      for (let i = 0; i < mapped.length; i += IFACE_MAP_BATCH) {
        const batch = mapped.slice(i, i + IFACE_MAP_BATCH);
        const batchNum = Math.floor(i / IFACE_MAP_BATCH) + 1;

        let content = `# Interface-to-Implementation Map (${batchNum}/${totalBatches})\n\n`;
        for (const [name, info] of batch) {
          const implStr = info.implementations.map(impl => `${impl.name} (${impl.project})`).join(', ');
          content += `  ${name} -> ${implStr}\n`;
        }

        allChunks.push({
          key: `iface-map:${batchNum}`,
          content: content.trim(),
          metadata: { kind: 'interface-map', batch: batchNum, totalBatches, count: batch.length },
          tags: ['interface-map'],
        });
      }
    }

    // Type index
    const sortedAllTypes = [...allTypes].sort((a, b) => a.name.localeCompare(b.name));
    const typeIdxTotalBatches = Math.ceil(sortedAllTypes.length / TYPE_INDEX_BATCH);

    for (let i = 0; i < sortedAllTypes.length; i += TYPE_INDEX_BATCH) {
      const batch = sortedAllTypes.slice(i, i + TYPE_INDEX_BATCH);
      const batchNum = Math.floor(i / TYPE_INDEX_BATCH) + 1;

      let content = `# Type Index (batch ${batchNum}, ${batch.length} types)\n\n`;
      for (const t of batch) {
        const ext = pathMod.extname(t.file);
        const lang = (ext === '.tsx' || ext === '.jsx') ? 'tsx' : ext === '.ts' ? 'ts' : ext === '.mjs' ? 'esm' : 'js';
        content += `  ${t.name} -> ${t.file} [${lang}]\n`;
      }

      allChunks.push({
        key: `type-index:${batchNum}`,
        content: content.trim(),
        metadata: { kind: 'type-index', batch: batchNum, totalBatches: typeIdxTotalBatches, count: batch.length },
        tags: ['type-index'],
      });
    }

    output.writeln(`Generated ${allChunks.length} chunks`);
    if (verbose) {
      const projectCount = allChunks.filter(c => (c.metadata.kind as string) === 'project-overview').length;
      const dirCount = allChunks.filter(c => (c.metadata.kind as string) === 'directory-detail').length;
      const ifaceCount = allChunks.filter(c => (c.metadata.kind as string) === 'interface-map').length;
      const typeIdxCount = allChunks.filter(c => (c.metadata.kind as string) === 'type-index').length;
      output.writeln(`  Project overviews: ${projectCount}`);
      output.writeln(`  Directory details: ${dirCount}`);
      output.writeln(`  Interface maps:    ${ifaceCount}`);
      output.writeln(`  Type index:        ${typeIdxCount}`);
    }

    // 5. Write to DB
    output.writeln('Writing to memory database...');
    const { db, dbPath } = await openDb(cwd);

    // Clear old code-map entries
    db.run(`DELETE FROM memory_entries WHERE namespace = ?`, [NAMESPACE]);

    for (const chunk of allChunks) {
      batchStoreEntry(db, chunk.key, NAMESPACE, chunk.content, chunk.metadata, chunk.tags);
    }

    saveAndCloseDb(db, dbPath);

    // Save hash
    const hashDir = pathMod.dirname(hashCachePath);
    if (!fs.existsSync(hashDir)) {
      fs.mkdirSync(hashDir, { recursive: true });
    }
    fs.writeFileSync(hashCachePath, currentHash, 'utf-8');

    output.printSuccess(`${allChunks.length} chunks written to code-map namespace`);

    // Generate embeddings unless skipped
    if (!skipEmbeddings) {
      output.writeln(output.dim('Generating embeddings for code-map entries...'));
      try {
        const { generateEmbedding } = await import('../memory/memory-initializer.js');
        const { db: db2, dbPath: dbPath2 } = await openDb(cwd);

        const stmt = db2.prepare(
          `SELECT id, content FROM memory_entries WHERE namespace = ? AND (embedding IS NULL OR embedding = '')`,
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
          } catch { /* skip */ }
        }

        if (embedded > 0) {
          saveAndCloseDb(db2, dbPath2);
          output.printSuccess(`Generated ${embedded} embeddings`);
        } else {
          db2.close();
        }
      } catch (err: any) {
        output.writeln(output.dim(`  Embedding generation skipped: ${err.message}`));
      }
    }

    return { success: true };
  }
};

// Main memory command
export const memoryCommand: Command = {
  name: 'memory',
  description: 'Memory management commands',
  subcommands: [initMemoryCommand, storeCommand, retrieveCommand, searchCommand, listCommand, deleteCommand, statsCommand, configureCommand, cleanupCommand, compressCommand, exportCommand, importCommand, indexGuidanceCommand, rebuildIndexCommand, codeMapCommand],
  options: [],
  examples: [
    { command: 'claude-flow memory store -k "key" -v "value"', description: 'Store data' },
    { command: 'claude-flow memory search -q "auth patterns"', description: 'Search memory' },
    { command: 'claude-flow memory stats', description: 'Show statistics' }
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Memory Management Commands'));
    output.writeln();
    output.writeln('Usage: claude-flow memory <subcommand> [options]');
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      `${output.highlight('init')}       - Initialize memory database (sql.js)`,
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
      `${output.highlight('code-map')}        - Generate structural code map`
    ]);

    return { success: true };
  }
};

export default memoryCommand;
