import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// SDK mocks
// ============================================================================

type FakeClient = {
  connect: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

// Shared state hoisted so vi.mock factories can reference it. vi.mock is
// hoisted to the top of the module; module-level `const` references would be
// TDZ-violating by the time the factory runs.
const shared = vi.hoisted(() => ({
  clientQueue: [] as Array<(c: FakeClient) => void>,
  createdClients: [] as FakeClient[],
  transportSpecs: [] as unknown[],
}));
const { clientQueue, createdClients, transportSpecs } = shared;

function nextClient(setup: (c: FakeClient) => void): void {
  clientQueue.push(setup);
}

// Use class constructors rather than vi.fn(arrow) so `new FakeClient()` works.
// Arrow-function mockImplementations cannot be called with `new`.
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class MockClient {
    connect = vi.fn().mockResolvedValue(undefined);
    callTool = vi.fn().mockResolvedValue({ content: [], isError: false });
    listTools = vi.fn().mockResolvedValue({ tools: [] });
    close = vi.fn().mockResolvedValue(undefined);
    constructor() {
      const setup = shared.clientQueue.shift();
      if (setup) setup(this as unknown as FakeClient);
      shared.createdClients.push(this as unknown as FakeClient);
    }
  }
  return { Client: MockClient };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class MockStdioClientTransport {
    spec: unknown;
    constructor(spec: unknown) {
      this.spec = spec;
      shared.transportSpecs.push(spec);
    }
  }
  return { StdioClientTransport: MockStdioClientTransport };
});

import {
  createMcpClientConnector,
  mcpClientConnector,
} from '../../spells/connectors/mcp-client.js';

beforeEach(() => {
  clientQueue.length = 0;
  createdClients.length = 0;
  transportSpecs.length = 0;
});

afterEach(async () => {
  await mcpClientConnector.dispose();
});

// ============================================================================
// Interface
// ============================================================================

describe('mcpClientConnector (interface)', () => {
  it('has correct name, version, capabilities', () => {
    expect(mcpClientConnector.name).toBe('mcp');
    expect(mcpClientConnector.version).toBe('1.0.0');
    expect(mcpClientConnector.capabilities).toContain('read');
    expect(mcpClientConnector.capabilities).toContain('write');
  });

  it('listActions returns call, list-tools, list-servers', () => {
    const names = mcpClientConnector.listActions().map(a => a.name);
    expect(names).toEqual(['call', 'list-tools', 'list-servers']);
  });
});

// ============================================================================
// action: call
// ============================================================================

describe('action: call', () => {
  const servers = {
    workiq: { command: 'npx', args: ['-y', '@microsoft/workiq', 'mcp'] },
    other: { command: 'node', args: ['other-server.js'] },
  };

  it('spawns server lazily and calls the named tool', async () => {
    nextClient(c => c.callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'OK' }],
      isError: false,
    }));

    const connector = createMcpClientConnector();
    await connector.initialize({ servers });

    const result = await connector.execute('call', {
      server: 'workiq',
      tool: 'SearchMessages',
      arguments: { query: 'invoices' },
    });

    expect(result.success).toBe(true);
    expect(result.data.toolName).toBe('SearchMessages');
    expect(result.data.server).toBe('workiq');
    expect(result.data.content).toEqual([{ type: 'text', text: 'OK' }]);

    expect(transportSpecs[0]).toEqual({
      command: 'npx',
      args: ['-y', '@microsoft/workiq', 'mcp'],
      env: undefined,
      cwd: undefined,
    });
    expect(createdClients[0].connect).toHaveBeenCalledTimes(1);
    expect(createdClients[0].callTool).toHaveBeenCalledWith({
      name: 'SearchMessages',
      arguments: { query: 'invoices' },
    });

    await connector.dispose();
  });

  it('reuses the same client for repeated calls to the same server', async () => {
    nextClient(c => c.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }));

    const connector = createMcpClientConnector();
    await connector.initialize({ servers });

    await connector.execute('call', { server: 'workiq', tool: 'A' });
    await connector.execute('call', { server: 'workiq', tool: 'B' });

    expect(createdClients.length).toBe(1);
    expect(createdClients[0].callTool).toHaveBeenCalledTimes(2);

    await connector.dispose();
  });

  it('returns success=false with extracted text when tool result isError=true', async () => {
    nextClient(c => c.callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'tool blew up' }],
      isError: true,
    }));

    const connector = createMcpClientConnector();
    await connector.initialize({ servers });
    const result = await connector.execute('call', { server: 'workiq', tool: 'Fails' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('tool blew up');

    await connector.dispose();
  });

  it('errors clearly when the server is not configured', async () => {
    const connector = createMcpClientConnector();
    await connector.initialize({ servers });

    const result = await connector.execute('call', { server: 'nope', tool: 'X' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('"nope" is not configured');
  });

  it('surfaces connect() failures as a clean error', async () => {
    nextClient(c => c.connect.mockRejectedValueOnce(new Error('exec ENOENT')));

    const connector = createMcpClientConnector();
    await connector.initialize({ servers });
    const result = await connector.execute('call', { server: 'workiq', tool: 'X' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('failed to start');
    expect(result.error).toContain('exec ENOENT');

    await connector.dispose();
  });

  it('errors when server or tool is missing', async () => {
    const connector = createMcpClientConnector();
    await connector.initialize({ servers });

    const noServer = await connector.execute('call', { tool: 'X' });
    expect(noServer.success).toBe(false);
    expect(noServer.error).toContain('server');

    const noTool = await connector.execute('call', { server: 'workiq' });
    expect(noTool.success).toBe(false);
    expect(noTool.error).toContain('tool');
  });

  it('applies per-call timeout when tool never resolves', async () => {
    nextClient(c => c.callTool.mockReturnValueOnce(new Promise(() => { /* hang */ })));

    const connector = createMcpClientConnector();
    await connector.initialize({ servers });
    const result = await connector.execute('call', { server: 'workiq', tool: 'Hang', timeout: 50 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');

    await connector.dispose();
  });

  it('passes env and cwd through to StdioClientTransport', async () => {
    const connector = createMcpClientConnector();
    await connector.initialize({
      servers: {
        custom: {
          command: 'node',
          args: ['srv.js'],
          env: { FOO: 'bar' },
          cwd: '/tmp/x',
        },
      },
    });

    await connector.execute('call', { server: 'custom', tool: 'x' });

    expect(transportSpecs[0]).toEqual({
      command: 'node',
      args: ['srv.js'],
      env: { FOO: 'bar' },
      cwd: '/tmp/x',
    });

    await connector.dispose();
  });
});

// ============================================================================
// action: list-tools
// ============================================================================

describe('action: list-tools', () => {
  it('returns tools and caches them on second call', async () => {
    nextClient(c => c.listTools.mockResolvedValue({
      tools: [
        { name: 'T1', description: 'first', inputSchema: { type: 'object' } },
        { name: 'T2', description: 'second', inputSchema: { type: 'object' } },
      ],
    }));

    const connector = createMcpClientConnector();
    await connector.initialize({ servers: { s: { command: 'x' } } });

    const first = await connector.execute('list-tools', { server: 's' });
    expect(first.success).toBe(true);
    expect((first.data.tools as Array<{ name: string }>).map(t => t.name)).toEqual(['T1', 'T2']);
    expect(first.data.cached).toBe(false);

    const second = await connector.execute('list-tools', { server: 's' });
    expect(second.success).toBe(true);
    expect(second.data.cached).toBe(true);
    expect(createdClients[0].listTools).toHaveBeenCalledTimes(1);

    await connector.dispose();
  });

  it('errors when server is not configured', async () => {
    const connector = createMcpClientConnector();
    await connector.initialize({ servers: {} });
    const result = await connector.execute('list-tools', { server: 'missing' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });
});

// ============================================================================
// action: list-servers
// ============================================================================

describe('action: list-servers', () => {
  it('enumerates configured server names', async () => {
    const connector = createMcpClientConnector();
    await connector.initialize({ servers: { a: { command: 'x' }, b: { command: 'y' } } });

    const result = await connector.execute('list-servers', {});
    expect(result.success).toBe(true);
    expect(result.data.servers).toEqual(['a', 'b']);

    await connector.dispose();
  });
});

// ============================================================================
// dispose
// ============================================================================

describe('dispose', () => {
  it('closes all opened clients and clears state', async () => {
    const connector = createMcpClientConnector();
    await connector.initialize({ servers: { a: { command: 'x' }, b: { command: 'y' } } });

    await connector.execute('call', { server: 'a', tool: 't' });
    await connector.execute('call', { server: 'b', tool: 't' });

    await connector.dispose();

    expect(createdClients[0].close).toHaveBeenCalledTimes(1);
    expect(createdClients[1].close).toHaveBeenCalledTimes(1);

    // After dispose, servers config is cleared.
    const after = await connector.execute('list-servers', {});
    expect(after.data.servers).toEqual([]);
  });
});

// ============================================================================
// unknown action
// ============================================================================

describe('unknown action', () => {
  it('returns a clear error', async () => {
    const connector = createMcpClientConnector();
    await connector.initialize({ servers: {} });
    const result = await connector.execute('nonsense', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown action');
  });
});
