/**
 * HTTP Workflow Tool
 *
 * Built-in tool for generic REST/GraphQL API calls.
 * Uses Node.js built-in fetch — no external dependencies.
 */

import type { WorkflowTool, ToolAction, ToolOutput } from '../types/workflow-tool.types.js';

// ============================================================================
// Types
// ============================================================================

interface HttpRequestParams {
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
  query?: Record<string, string>;
}

interface GraphqlParams {
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  query: string;
  variables?: Record<string, unknown>;
}

// ============================================================================
// Actions
// ============================================================================

const ACTIONS: ToolAction[] = [
  {
    name: 'get',
    description: 'HTTP GET request',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Request URL' },
        headers: { type: 'object', description: 'Request headers', additionalProperties: { type: 'string' } },
        query: { type: 'object', description: 'Query parameters', additionalProperties: { type: 'string' } },
        timeout: { type: 'number', description: 'Timeout in milliseconds', default: 30000 },
      },
      required: ['url'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'number' },
        headers: { type: 'object' },
        body: {},
      },
    },
  },
  {
    name: 'post',
    description: 'HTTP POST request with body',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { description: 'Request body (auto-serialized as JSON if object)' },
        timeout: { type: 'number', default: 30000 },
      },
      required: ['url'],
    },
    outputSchema: {
      type: 'object',
      properties: { status: { type: 'number' }, headers: { type: 'object' }, body: {} },
    },
  },
  {
    name: 'put',
    description: 'HTTP PUT request with body',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: {},
        timeout: { type: 'number', default: 30000 },
      },
      required: ['url'],
    },
    outputSchema: {
      type: 'object',
      properties: { status: { type: 'number' }, headers: { type: 'object' }, body: {} },
    },
  },
  {
    name: 'delete',
    description: 'HTTP DELETE request',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        timeout: { type: 'number', default: 30000 },
      },
      required: ['url'],
    },
    outputSchema: {
      type: 'object',
      properties: { status: { type: 'number' }, headers: { type: 'object' }, body: {} },
    },
  },
  {
    name: 'graphql',
    description: 'GraphQL query or mutation',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'GraphQL endpoint URL' },
        query: { type: 'string', description: 'GraphQL query or mutation string' },
        variables: { type: 'object', description: 'GraphQL variables' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        timeout: { type: 'number', default: 30000 },
      },
      required: ['url', 'query'],
    },
    outputSchema: {
      type: 'object',
      properties: { status: { type: 'number' }, headers: { type: 'object' }, body: {} },
    },
  },
];

// ============================================================================
// HTTP Tool
// ============================================================================

export const httpTool: WorkflowTool = {
  name: 'http',
  description: 'Generic HTTP/REST/GraphQL API tool using Node.js built-in fetch',
  version: '1.0.0',
  capabilities: ['read', 'write'],

  async initialize() {
    // No initialization needed — uses built-in fetch
  },

  async dispose() {
    // No cleanup needed
  },

  async execute(action: string, params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now();

    try {
      switch (action) {
        case 'get':
          return await doRequest('GET', params as unknown as HttpRequestParams, start);
        case 'post':
          return await doRequest('POST', params as unknown as HttpRequestParams, start);
        case 'put':
          return await doRequest('PUT', params as unknown as HttpRequestParams, start);
        case 'delete':
          return await doRequest('DELETE', params as unknown as HttpRequestParams, start);
        case 'graphql':
          return await doGraphql(params as unknown as GraphqlParams, start);
        default:
          return {
            success: false,
            data: {},
            error: `Unknown action "${action}". Available: get, post, put, delete, graphql`,
            duration: Date.now() - start,
          };
      }
    } catch (err) {
      return {
        success: false,
        data: {},
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - start,
      };
    }
  },

  listActions(): ToolAction[] {
    return ACTIONS;
  },
};

// ============================================================================
// Internal helpers
// ============================================================================

function buildUrl(base: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return base;
  const url = new URL(base);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

function buildHeaders(
  headers?: Record<string, string>,
  hasBody?: boolean,
): Record<string, string> {
  const result: Record<string, string> = { ...headers };
  if (hasBody) {
    const hasContentType = Object.keys(result).some(k => k.toLowerCase() === 'content-type');
    if (!hasContentType) {
      result['Content-Type'] = 'application/json';
    }
  }
  return result;
}

async function doRequest(
  method: string,
  params: HttpRequestParams,
  start: number,
): Promise<ToolOutput> {
  if (!params.url) {
    return { success: false, data: {}, error: 'Missing required parameter: url', duration: Date.now() - start };
  }

  const url = buildUrl(params.url, params.query as Record<string, string> | undefined);
  const hasBody = method !== 'GET' && method !== 'DELETE' && params.body !== undefined;
  const headers = buildHeaders(params.headers, hasBody);

  const init: RequestInit = {
    method,
    headers,
    signal: params.timeout ? AbortSignal.timeout(params.timeout) : undefined,
  };

  if (hasBody) {
    init.body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
  }

  const response = await fetch(url, init);
  const responseBody = await parseResponse(response);
  const responseHeaders = Object.fromEntries(response.headers.entries());

  return {
    success: response.ok,
    data: {
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
    },
    error: response.ok ? undefined : `HTTP ${response.status} ${response.statusText}`,
    duration: Date.now() - start,
  };
}

async function doGraphql(params: GraphqlParams, start: number): Promise<ToolOutput> {
  if (!params.url || !params.query) {
    return {
      success: false,
      data: {},
      error: 'Missing required parameters: url and query',
      duration: Date.now() - start,
    };
  }

  const graphqlBody = {
    query: params.query,
    ...(params.variables ? { variables: params.variables } : {}),
  };

  return doRequest('POST', {
    url: params.url,
    headers: params.headers,
    body: graphqlBody,
    timeout: params.timeout,
  }, start);
}

async function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return await response.text();
    }
  }
  return await response.text();
}
