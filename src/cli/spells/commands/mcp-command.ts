/**
 * MCP Step Command — calls tools on configured MCP servers from a spell step.
 *
 * Config lives under `mcp.servers.<name>` in moflo.yaml (loaded by the spell
 * runner and passed into the connector). A step references a server by name
 * and a tool by its MCP-exported name, passing through arguments.
 */

import type {
  StepCommand,
  StepConfig,
  StepOutput,
  CastingContext,
  ValidationError,
  ValidationResult,
  OutputDescriptor,
  JSONSchema,
} from '../types/step-command.types.js';

import type { McpServerSpec } from '../connectors/mcp-client.js';

const MCP_ACTIONS = ['call', 'list-tools', 'list-servers'] as const;
export type McpAction = (typeof MCP_ACTIONS)[number];

export interface McpStepConfig extends StepConfig {
  readonly action?: McpAction;
  readonly server?: string;
  readonly tool?: string;
  readonly arguments?: Record<string, unknown>;
  readonly timeout?: number;
  /**
   * Inline server registry — overrides / supplements any servers provided by
   * a connector registry. Useful for ad-hoc spells; production spells should
   * prefer moflo.yaml.
   */
  readonly servers?: Record<string, McpServerSpec>;
}

export const mcpCommand: StepCommand<McpStepConfig> = {
  type: 'mcp',
  description: 'Call tools on configured MCP servers (stdio transport).',
  defaultMofloLevel: 'memory',

  capabilities: [
    { type: 'shell' },
    { type: 'net' },
    { type: 'fs:read' },
    { type: 'fs:write' },
  ],

  configSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...MCP_ACTIONS],
        description: 'call | list-tools | list-servers (default: call)',
        default: 'call',
      },
      server: { type: 'string', description: 'Configured MCP server name' },
      tool: { type: 'string', description: 'Tool name to invoke (required for action=call)' },
      arguments: { type: 'object', description: 'Arguments passed to the tool' },
      timeout: { type: 'number', description: 'Tool call timeout in ms', default: 30000 },
      servers: {
        type: 'object',
        description: 'Inline server registry keyed by name ({command, args?, env?, cwd?})',
      },
    },
  } satisfies JSONSchema,

  validate(config: McpStepConfig): ValidationResult {
    const errors: ValidationError[] = [];
    const action = (config.action ?? 'call') as McpAction;
    if (!MCP_ACTIONS.includes(action)) {
      errors.push({ path: 'action', message: `action must be one of: ${MCP_ACTIONS.join(', ')}` });
    }
    if (action === 'call') {
      if (!config.server) errors.push({ path: 'server', message: 'server is required for action=call' });
      if (!config.tool) errors.push({ path: 'tool', message: 'tool is required for action=call' });
    }
    if (action === 'list-tools' && !config.server) {
      errors.push({ path: 'server', message: 'server is required for action=list-tools' });
    }
    return { valid: errors.length === 0, errors };
  },

  async execute(config: McpStepConfig, context: CastingContext): Promise<StepOutput> {
    const action = config.action ?? 'call';
    const params = {
      server: config.server,
      tool: config.tool,
      arguments: config.arguments,
      timeout: config.timeout,
    };

    if (context.tools?.has('mcp') && !config.servers) {
      return context.tools.execute('mcp', action, params);
    }

    const { createMcpClientConnector } = await import('../connectors/mcp-client.js');
    const connector = createMcpClientConnector();
    await connector.initialize({ servers: config.servers ?? {} });
    try {
      return await connector.execute(action, params);
    } finally {
      await connector.dispose();
    }
  },

  describeOutputs(): OutputDescriptor[] {
    return [
      { name: 'content', type: 'array', description: 'Tool result content (MCP content items)' },
      { name: 'isError', type: 'boolean', description: 'Whether the MCP server flagged the tool call as error' },
      { name: 'structuredContent', type: 'object', description: 'Tool structured output, if provided' },
      { name: 'toolName', type: 'string' },
      { name: 'server', type: 'string' },
      { name: 'tools', type: 'array', description: 'Available tools (action=list-tools)' },
      { name: 'servers', type: 'array', description: 'Configured server names (action=list-servers)' },
    ];
  },
};
