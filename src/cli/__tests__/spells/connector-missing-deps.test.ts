/**
 * Lazy-load error paths for optional-dependency connectors (issue #442).
 *
 * `imapflow`, `mailparser`, and `@modelcontextprotocol/sdk` are declared as
 * optionalDependencies and loaded via `await import()` on first use. When
 * they're absent, each connector must throw a single actionable message with
 * the exact install command rather than a cryptic MODULE_NOT_FOUND.
 *
 * Simulates a missing module by mocking the specifier with a getter that
 * raises ERR_MODULE_NOT_FOUND on first property access — which is what the
 * `await import()` destructure triggers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('imap connector — missing optional deps', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('imapflow');
    vi.doUnmock('mailparser');
  });

  it('throws actionable error when imapflow is not installed', async () => {
    vi.doMock('imapflow', () => new Proxy({}, {
      get() {
        const err = new Error("Cannot find package 'imapflow'") as Error & { code: string };
        err.code = 'ERR_MODULE_NOT_FOUND';
        throw err;
      },
    }));
    vi.doMock('mailparser', () => ({ simpleParser: async () => ({ attachments: [] }) }));

    const { createImapConnector } = await import('../../spells/connectors/imap.js');
    const connector = createImapConnector();
    await connector.initialize({ user: 'u', password: 'p' });
    const result = await connector.execute('read-inbox', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("'imapflow' and 'mailparser'");
    expect(result.error).toContain('npm i imapflow mailparser');
  });
});

describe('mcp connector — missing optional deps', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@modelcontextprotocol/sdk/client/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/client/stdio.js');
  });

  it('throws actionable error when SDK is not installed', async () => {
    vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => new Proxy({}, {
      get() {
        const err = new Error("Cannot find package '@modelcontextprotocol/sdk'") as Error & { code: string };
        err.code = 'ERR_MODULE_NOT_FOUND';
        throw err;
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/client/stdio.js', () => new Proxy({}, {
      get() {
        const err = new Error("Cannot find package '@modelcontextprotocol/sdk'") as Error & { code: string };
        err.code = 'ERR_MODULE_NOT_FOUND';
        throw err;
      },
    }));

    const { createMcpClientConnector } = await import('../../spells/connectors/mcp-client.js');
    const connector = createMcpClientConnector();
    await connector.initialize({
      servers: { test: { command: 'noop' } },
    });
    const result = await connector.execute('call', { server: 'test', tool: 'any' });
    expect(result.success).toBe(false);
    expect(result.error).toContain("'@modelcontextprotocol/sdk'");
    expect(result.error).toContain('npm i @modelcontextprotocol/sdk');
  });
});
