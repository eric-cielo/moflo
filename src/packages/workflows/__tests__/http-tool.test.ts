import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { httpConnector } from '../src/connectors/http-tool.js';

describe('httpConnector (workflow connector)', () => {
  describe('interface compliance', () => {
    it('has correct name and version', () => {
      expect(httpConnector.name).toBe('http');
      expect(httpConnector.version).toBe('1.0.0');
      expect(httpConnector.description).toBeTruthy();
    });

    it('declares read and write capabilities', () => {
      expect(httpConnector.capabilities).toContain('read');
      expect(httpConnector.capabilities).toContain('write');
    });

    it('listActions returns 5 actions', () => {
      const actions = httpConnector.listActions();
      expect(actions).toHaveLength(5);
      const names = actions.map(a => a.name);
      expect(names).toEqual(['get', 'post', 'put', 'delete', 'graphql']);
    });

    it('each action has input and output schemas', () => {
      for (const action of httpConnector.listActions()) {
        expect(action.inputSchema).toBeDefined();
        expect(action.inputSchema.type).toBe('object');
        expect(action.outputSchema).toBeDefined();
        expect(action.description).toBeTruthy();
      }
    });

    it('initialize and dispose are no-ops', async () => {
      await expect(httpConnector.initialize({})).resolves.toBeUndefined();
      await expect(httpConnector.dispose()).resolves.toBeUndefined();
    });
  });

  describe('execute', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    function mockFetch(status: number, body: unknown, contentType = 'application/json') {
      fetchSpy.mockResolvedValue(new Response(
        typeof body === 'string' ? body : JSON.stringify(body),
        {
          status,
          statusText: status === 200 ? 'OK' : 'Error',
          headers: { 'Content-Type': contentType },
        },
      ));
    }

    it('GET returns response body and status', async () => {
      mockFetch(200, { message: 'hello' });

      const result = await httpConnector.execute('get', { url: 'https://api.example.com/data' });

      expect(result.success).toBe(true);
      expect(result.data.status).toBe(200);
      expect(result.data.body).toEqual({ message: 'hello' });
      expect(result.duration).toBeGreaterThanOrEqual(0);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('POST with JSON body sends correct content-type', async () => {
      mockFetch(201, { id: 1 });

      const result = await httpConnector.execute('post', {
        url: 'https://api.example.com/items',
        body: { name: 'test' },
      });

      expect(result.success).toBe(true);
      expect(result.data.status).toBe(201);

      const [, init] = fetchSpy.mock.calls[0];
      expect((init as RequestInit).body).toBe('{"name":"test"}');
      expect((init as RequestInit).headers).toHaveProperty('Content-Type', 'application/json');
    });

    it('GraphQL action sends query in body', async () => {
      mockFetch(200, { data: { user: { name: 'Alice' } } });

      const result = await httpConnector.execute('graphql', {
        url: 'https://api.example.com/graphql',
        query: '{ user { name } }',
        variables: { id: '1' },
      });

      expect(result.success).toBe(true);
      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.query).toBe('{ user { name } }');
      expect(body.variables).toEqual({ id: '1' });
    });

    it('returns error output for HTTP errors (not exception)', async () => {
      mockFetch(404, { error: 'Not found' });

      const result = await httpConnector.execute('get', { url: 'https://api.example.com/missing' });

      expect(result.success).toBe(false);
      expect(result.data.status).toBe(404);
      expect(result.error).toContain('404');
    });

    it('returns error output on fetch failure', async () => {
      fetchSpy.mockRejectedValue(new Error('Network error'));

      const result = await httpConnector.execute('get', { url: 'https://unreachable.example.com' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('returns error for missing url parameter', async () => {
      const result = await httpConnector.execute('get', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('url');
    });

    it('returns error for unknown action', async () => {
      const result = await httpConnector.execute('patch', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action');
      expect(result.error).toContain('patch');
    });

    it('handles text response', async () => {
      mockFetch(200, 'plain text response', 'text/plain');

      const result = await httpConnector.execute('get', { url: 'https://example.com' });

      expect(result.success).toBe(true);
      expect(result.data.body).toBe('plain text response');
    });

    it('GET with query params appends to URL', async () => {
      mockFetch(200, {});

      await httpConnector.execute('get', {
        url: 'https://api.example.com/search',
        query: { q: 'test', page: '1' },
      });

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain('q=test');
      expect(url).toContain('page=1');
    });

    it('DELETE sends correct method', async () => {
      mockFetch(200, '');

      await httpConnector.execute('delete', { url: 'https://api.example.com/item/1' });

      const [, init] = fetchSpy.mock.calls[0];
      expect((init as RequestInit).method).toBe('DELETE');
    });

    it('PUT sends body', async () => {
      mockFetch(200, { updated: true });

      await httpConnector.execute('put', {
        url: 'https://api.example.com/item/1',
        body: { name: 'updated' },
      });

      const [, init] = fetchSpy.mock.calls[0];
      expect((init as RequestInit).method).toBe('PUT');
      expect((init as RequestInit).body).toBe('{"name":"updated"}');
    });

    it('GraphQL missing query returns error', async () => {
      const result = await httpConnector.execute('graphql', { url: 'https://api.example.com/graphql' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('query');
    });
  });
});
