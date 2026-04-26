/**
 * MCP Client Connector — spawns stdio-based MCP servers and calls their tools
 * from spell steps. Thin wrapper around @modelcontextprotocol/sdk's Client +
 * StdioClientTransport: the SDK handles protocol, framing, and child-process
 * lifecycle. This connector adds server-pool management, lazy spawning, tool
 * discovery caching, and the SpellConnector interface adapter.
 *
 * The SDK is an optionalDependency and is loaded lazily on first use so
 * consumers that don't use the MCP connector don't need it installed.
 */

import type {
  SpellConnector,
  ConnectorAction,
  ConnectorOutput,
} from '../types/spell-connector.types.js';
import { loadOptional } from './shared/optional-import.js';

const MCP_INSTALL_MSG =
  "MCP connector requires '@modelcontextprotocol/sdk' to be installed. Run: npm i @modelcontextprotocol/sdk";

// Structural type — avoids a hard dependency on the SDK's types so consumers
// without @modelcontextprotocol/sdk installed can still type-check this file.
interface ClientLike {
  connect(transport: unknown): Promise<void>;
  callTool(req: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  listTools(): Promise<{ tools?: Array<{ name: string; description?: string; inputSchema: unknown }> }>;
  close(): Promise<void>;
}

type ClientCtor = new (info: { name: string; version: string }, opts: { capabilities: Record<string, unknown> }) => ClientLike;
type StdioTransportCtor = new (spec: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}) => unknown;

async function loadSdk(): Promise<{ Client: ClientCtor; StdioClientTransport: StdioTransportCtor }> {
  const [clientMod, stdioMod] = await Promise.all([
    loadOptional<{ Client: ClientCtor }>('@modelcontextprotocol/sdk/client/index.js', MCP_INSTALL_MSG),
    loadOptional<{ StdioClientTransport: StdioTransportCtor }>('@modelcontextprotocol/sdk/client/stdio.js', MCP_INSTALL_MSG),
  ]);
  return { Client: clientMod.Client, StdioClientTransport: stdioMod.StdioClientTransport };
}

// ============================================================================
// Config
// ============================================================================

export interface McpServerSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

interface McpConnectorConfig {
  servers: Record<string, McpServerSpec>;
}

interface ServerEntry {
  client: ClientLike;
  connectPromise: Promise<void>;
  toolsCache?: { tools: Array<{ name: string; description?: string; inputSchema: unknown }> };
}

// ============================================================================
// Actions
// ============================================================================

const ACTIONS: ConnectorAction[] = [
  {
    name: 'call',
    description: 'Invoke a tool on a configured MCP server',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Configured server name' },
        tool: { type: 'string', description: 'Tool name exposed by the server' },
        arguments: { type: 'object', description: 'Arguments passed to the tool' },
        timeout: { type: 'number', description: 'Per-call timeout ms (default 30000)', default: 30000 },
      },
      required: ['server', 'tool'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        content: { type: 'array' },
        isError: { type: 'boolean' },
        structuredContent: { type: 'object' },
        toolName: { type: 'string' },
        server: { type: 'string' },
      },
    },
  },
  {
    name: 'list-tools',
    description: 'List tools exposed by a configured MCP server (cached per server)',
    inputSchema: {
      type: 'object',
      properties: { server: { type: 'string' } },
      required: ['server'],
    },
    outputSchema: {
      type: 'object',
      properties: { tools: { type: 'array' }, server: { type: 'string' } },
    },
  },
  {
    name: 'list-servers',
    description: 'List configured MCP server names',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: { servers: { type: 'array' } },
    },
  },
];

// ============================================================================
// Helpers
// ============================================================================

function raceWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function extractErrorText(content: unknown): string {
  if (!Array.isArray(content)) return 'MCP tool returned error (no content)';
  for (const item of content) {
    if (item && typeof item === 'object' && 'type' in item && (item as { type: unknown }).type === 'text') {
      const text = (item as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
  }
  return 'MCP tool returned error (no text content)';
}

// ============================================================================
// Connector factory
// ============================================================================

export function createMcpClientConnector(): SpellConnector {
  let config: McpConnectorConfig = { servers: {} };
  const entries = new Map<string, ServerEntry>();

  function spec(name: string): McpServerSpec | undefined {
    return config.servers[name];
  }

  async function getOrConnect(name: string): Promise<ClientLike> {
    let entry = entries.get(name);
    if (entry) {
      await entry.connectPromise;
      return entry.client;
    }
    const s = spec(name);
    if (!s) {
      throw new Error(`MCP server "${name}" is not configured`);
    }

    const { Client, StdioClientTransport } = await loadSdk();
    const transport = new StdioClientTransport({
      command: s.command,
      args: s.args ? [...s.args] : undefined,
      env: s.env ? { ...s.env } : undefined,
      cwd: s.cwd,
    });
    const client = new Client(
      { name: 'moflo-spell-engine', version: '1.0.0' },
      { capabilities: {} },
    );
    const connectPromise = client.connect(transport);
    entry = { client, connectPromise };
    entries.set(name, entry);
    try {
      await connectPromise;
    } catch (err) {
      entries.delete(name);
      throw err;
    }
    return client;
  }

  async function doCall(
    params: { server?: string; tool?: string; arguments?: Record<string, unknown>; timeout?: number },
    start: number,
  ): Promise<ConnectorOutput> {
    if (!params.server) {
      return { success: false, data: {}, error: 'Missing required parameter: server', duration: Date.now() - start };
    }
    if (!params.tool) {
      return { success: false, data: {}, error: 'Missing required parameter: tool', duration: Date.now() - start };
    }
    const timeoutMs = params.timeout ?? 30_000;
    let client: ClientLike;
    try {
      client = await getOrConnect(params.server);
    } catch (err) {
      return {
        success: false,
        data: {},
        error: `MCP server "${params.server}" failed to start: ${(err as Error).message}`,
        duration: Date.now() - start,
      };
    }

    try {
      const result = await raceWithTimeout(
        client.callTool({ name: params.tool, arguments: params.arguments ?? {} }),
        timeoutMs,
        `MCP call ${params.server}.${params.tool}`,
      );
      const isError = Boolean((result as { isError?: unknown }).isError);
      return {
        success: !isError,
        data: {
          content: (result as { content?: unknown }).content ?? [],
          isError,
          structuredContent: (result as { structuredContent?: unknown }).structuredContent,
          toolName: params.tool,
          server: params.server,
        },
        error: isError ? extractErrorText((result as { content?: unknown }).content) : undefined,
        duration: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        data: { toolName: params.tool, server: params.server },
        error: (err as Error).message,
        duration: Date.now() - start,
      };
    }
  }

  async function doListTools(params: { server?: string }, start: number): Promise<ConnectorOutput> {
    if (!params.server) {
      return { success: false, data: {}, error: 'Missing required parameter: server', duration: Date.now() - start };
    }
    const entry = entries.get(params.server);
    if (entry?.toolsCache) {
      return {
        success: true,
        data: { tools: entry.toolsCache.tools, server: params.server, cached: true },
        duration: Date.now() - start,
      };
    }
    let client: ClientLike;
    try {
      client = await getOrConnect(params.server);
    } catch (err) {
      return {
        success: false,
        data: {},
        error: `MCP server "${params.server}" failed to start: ${(err as Error).message}`,
        duration: Date.now() - start,
      };
    }
    try {
      const result = await client.listTools();
      const tools = (result.tools ?? []).map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      const stored = entries.get(params.server);
      if (stored) stored.toolsCache = { tools };
      return { success: true, data: { tools, server: params.server, cached: false }, duration: Date.now() - start };
    } catch (err) {
      return { success: false, data: {}, error: (err as Error).message, duration: Date.now() - start };
    }
  }

  return {
    name: 'mcp',
    description:
      'Generic MCP client — spawns configured stdio MCP servers on demand and ' +
      'calls their tools. Configure servers via connector `initialize({servers:{name:{command,args,env,cwd}}})` ' +
      'or from moflo.yaml mcp.servers.',
    version: '1.0.0',
    capabilities: ['read', 'write'],

    async initialize(cfg: Record<string, unknown>): Promise<void> {
      const servers = (cfg.servers as Record<string, McpServerSpec> | undefined) ?? {};
      config = { servers: { ...servers } };
    },

    async dispose(): Promise<void> {
      const closeAll = Array.from(entries.values()).map(async e => {
        try { await e.connectPromise; } catch { /* ignore connect errors on close */ }
        try { await e.client.close(); } catch { /* ignore close errors */ }
      });
      await Promise.allSettled(closeAll);
      entries.clear();
      config = { servers: {} };
    },

    async execute(action: string, params: Record<string, unknown>): Promise<ConnectorOutput> {
      const start = Date.now();
      switch (action) {
        case 'call':
          return doCall(params as { server?: string; tool?: string; arguments?: Record<string, unknown>; timeout?: number }, start);
        case 'list-tools':
          return doListTools(params as { server?: string }, start);
        case 'list-servers':
          return {
            success: true,
            data: { servers: Object.keys(config.servers) },
            duration: Date.now() - start,
          };
        default:
          return {
            success: false,
            data: {},
            error: `Unknown action "${action}". Available: call, list-tools, list-servers`,
            duration: Date.now() - start,
          };
      }
    },

    listActions(): ConnectorAction[] {
      return ACTIONS;
    },
  };
}

export const mcpClientConnector: SpellConnector = createMcpClientConnector();
