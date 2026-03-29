/**
 * Settings.json Generator
 * Creates .claude/settings.json with V3-optimized hook configurations
 */

import type { InitOptions, HooksConfig, PlatformInfo } from './types.js';
import { detectPlatform } from './types.js';

/**
 * Generate the complete settings.json content
 */
export function generateSettings(options: InitOptions): object {
  const settings: Record<string, unknown> = {};

  // Add hooks if enabled
  if (options.components.settings) {
    settings.hooks = generateHooksConfig(options.hooks);
  }

  // Add statusLine configuration when the statusline component is enabled.
  // Previously only checked options.statusline.enabled, which could be unset
  // even when options.components.statusline was true (the guard used by
  // executor.ts to generate the statusline script). This left settings.json
  // without a statusLine entry, so the dashboard never appeared.
  if (options.components.statusline || options.statusline?.enabled) {
    settings.statusLine = generateStatusLineConfig(options);
  }

  // Add permissions
  settings.permissions = {
    allow: [
      'Bash(npx moflo*)',
      'Bash(npx flo*)',
      'Bash(node .claude/*)',
      'mcp__moflo__:*',
    ],
    deny: [
      'Read(./.env)',
      'Read(./.env.*)',
    ],
  };

  // Add claude-flow attribution for git commits and PRs
  settings.attribution = {
    commit: 'Co-Authored-By: moflo <noreply@motailz.com>',
    pr: '🤖 Generated with [moflo](https://github.com/eric-cielo/moflo)',
  };

  // Note: Claude Code expects 'model' to be a string, not an object
  // Model preferences are stored in claudeFlow settings instead
  // settings.model = 'claude-sonnet-4-5-20250929'; // Uncomment if you want to set a default model

  // Add Agent Teams configuration (experimental feature)
  settings.env = {
    // Enable Claude Code Agent Teams for multi-agent coordination
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    // Claude Flow specific environment
    CLAUDE_FLOW_V3_ENABLED: 'true',
    CLAUDE_FLOW_HOOKS_ENABLED: 'true',
  };

  // Detect platform for platform-aware configuration
  const platform = detectPlatform();

  // Add V3-specific settings
  settings.claudeFlow = {
    version: '3.0.0',
    enabled: true,
    platform: {
      os: platform.os,
      arch: platform.arch,
      shell: platform.shell,
    },
    modelPreferences: {
      default: 'claude-opus-4-6',
      routing: 'claude-haiku-4-5-20251001',
    },
    agentTeams: {
      enabled: true,
      teammateMode: 'auto', // 'auto' | 'in-process' | 'tmux'
      taskListEnabled: true,
      mailboxEnabled: true, // Uses MessageStore for persistent cross-process messaging
      coordination: {
        autoAssignOnIdle: true,       // Auto-assign pending tasks when teammate is idle
        trainPatternsOnComplete: true, // Train neural patterns when tasks complete
        notifyLeadOnComplete: true,   // Notify team lead when tasks complete
        sharedMemoryNamespace: 'agent-teams', // Memory namespace for team coordination
      },
      hooks: {
        teammateIdle: {
          enabled: true,
          autoAssign: true,
          checkTaskList: true,
        },
        taskCompleted: {
          enabled: true,
          trainPatterns: true,
          notifyLead: true,
        },
      },
    },
    swarm: {
      topology: options.runtime.topology,
      maxAgents: options.runtime.maxAgents,
    },
    memory: {
      backend: options.runtime.memoryBackend,
      enableHNSW: options.runtime.enableHNSW,
      learningBridge: { enabled: options.runtime.enableLearningBridge ?? true },
      memoryGraph: { enabled: options.runtime.enableMemoryGraph ?? true },
      agentScopes: { enabled: options.runtime.enableAgentScopes ?? true },
    },
    neural: {
      enabled: options.runtime.enableNeural,
    },
    daemon: {
      autoStart: true,
      workers: [
        'map',           // Codebase mapping
        'audit',         // Security auditing (critical priority)
        'optimize',      // Performance optimization (high priority)
        'consolidate',   // Memory consolidation
        'testgaps',      // Test coverage gaps
        'ultralearn',    // Deep knowledge acquisition
        'deepdive',      // Deep code analysis
        'document',      // Auto-documentation for ADRs
        'refactor',      // Refactoring suggestions (DDD alignment)
        'benchmark',     // Performance benchmarking
      ],
      schedules: {
        audit: { interval: '1h', priority: 'critical' },
        optimize: { interval: '30m', priority: 'high' },
        consolidate: { interval: '2h', priority: 'low' },
        document: { interval: '1h', priority: 'normal', triggers: ['adr-update', 'api-change'] },
        deepdive: { interval: '4h', priority: 'normal', triggers: ['complex-change'] },
        ultralearn: { interval: '1h', priority: 'normal' },
      },
    },
    learning: {
      enabled: true,
      autoTrain: true,
      patterns: ['coordination', 'optimization', 'prediction'],
      retention: {
        shortTerm: '24h',
        longTerm: '30d',
      },
    },
    adr: {
      autoGenerate: true,
      directory: '/docs/adr',
      template: 'madr',
    },
    ddd: {
      trackDomains: true,
      validateBoundedContexts: true,
      directory: '/docs/ddd',
    },
    security: {
      autoScan: true,
      scanOnEdit: true,
      cveCheck: true,
      threatModel: true,
    },
  };

  return settings;
}

/**
 * Build a hook command.
 * Claude Code always executes hooks in a bash shell (even on Windows),
 * so we must NOT wrap with `cmd /c` — doing so causes bash to mangle
 * the command (e.g. `node` becomes `ode`).
 */
function hookCmd(script: string, subcommand: string): string {
  return `node ${script} ${subcommand}`.trim();
}

/**
 * Build a hook command for ESM scripts (.mjs).
 */
function hookCmdEsm(script: string, subcommand: string): string {
  return `node ${script} ${subcommand}`.trim();
}

/** Shorthand for CJS hook-handler commands */
function hookHandlerCmd(subcommand: string): string {
  return hookCmd('"$CLAUDE_PROJECT_DIR/.claude/helpers/hook-handler.cjs"', subcommand);
}

/** Shorthand for ESM auto-memory-hook commands */
function autoMemoryCmd(subcommand: string): string {
  return hookCmdEsm('"$CLAUDE_PROJECT_DIR/.claude/helpers/auto-memory-hook.mjs"', subcommand);
}

/** Shorthand for gate commands (lightweight JSON state checks) */
function gateCmd(subcommand: string): string {
  return hookCmd('"$CLAUDE_PROJECT_DIR/.claude/helpers/gate.cjs"', subcommand);
}

/** Gate hook wrapper — reads stdin JSON for tool input, uses exit code 2 for blocking */
function gateHookCmd(subcommand: string): string {
  return hookCmdEsm('"$CLAUDE_PROJECT_DIR/.claude/helpers/gate-hook.mjs"', subcommand);
}

/** Prompt hook — reads stdin JSON for user prompt, classifies namespace */
function promptHookCmd(): string {
  return `node "$CLAUDE_PROJECT_DIR/.claude/helpers/prompt-hook.mjs"`;
}

/**
 * Generate statusLine configuration for Claude Code
 * Uses local helper script for cross-platform compatibility (no npx cold-start)
 */
function generateStatusLineConfig(_options: InitOptions): object {
  // Claude Code pipes JSON session data to the script via stdin.
  // Valid fields: type, command, padding (optional).
  // The script runs after each assistant message (debounced 300ms).
  // NOTE: statusline must NOT use `cmd /c` — Claude Code manages its stdin
  // directly for statusline commands, and `cmd /c` blocks stdin forwarding.
  return {
    type: 'command',
    command: `node "$CLAUDE_PROJECT_DIR/.claude/helpers/statusline.cjs"`,
  };
}

/**
 * Generate hooks configuration
 * All hooks use direct node invocation via lightweight helper scripts
 * (gate.cjs, gate-hook.mjs, hook-handler.cjs) instead of `npx flo` to avoid spawning
 * a full CLI process on every tool call.
 */
function generateHooksConfig(config: HooksConfig): object {
  const hooks: Record<string, unknown[]> = {};

  // PreToolUse — gates and validation before tool execution
  if (config.preToolUse) {
    hooks.PreToolUse = [
      {
        matcher: '^(Write|Edit|MultiEdit)$',
        hooks: [{ type: 'command', command: hookHandlerCmd('post-edit'), timeout: 5000 }],
      },
      {
        matcher: '^(Glob|Grep)$',
        hooks: [{ type: 'command', command: gateHookCmd('check-before-scan'), timeout: 3000 }],
      },
      {
        matcher: '^Read$',
        hooks: [{ type: 'command', command: gateHookCmd('check-before-read'), timeout: 3000 }],
      },
      {
        matcher: '^Agent$',
        hooks: [
          { type: 'command', command: hookHandlerCmd('pre-task'), timeout: 5000 },
        ],
      },
      {
        matcher: '^Bash$',
        hooks: [{ type: 'command', command: gateHookCmd('check-dangerous-command'), timeout: 2000 }],
      },
    ];
  }

  // PostToolUse — record outcomes for learning
  if (config.postToolUse) {
    hooks.PostToolUse = [
      {
        matcher: '^(Write|Edit|MultiEdit)$',
        hooks: [{ type: 'command', command: hookHandlerCmd('post-edit'), timeout: 5000 }],
      },
      {
        matcher: '^Agent$',
        hooks: [{ type: 'command', command: hookHandlerCmd('post-task'), timeout: 5000 }],
      },
      {
        // TaskCreate PostToolUse only fires in some Claude Code versions.
        // The prompt-reminder handles the common case.
        matcher: '^TaskCreate$',
        hooks: [{ type: 'command', command: gateCmd('record-task-created'), timeout: 2000 }],
      },
      {
        matcher: '^Bash$',
        hooks: [{ type: 'command', command: gateHookCmd('check-bash-memory'), timeout: 2000 }],
      },
      {
        // Simplified matcher — anchored regex with parens doesn't match MCP tool names reliably
        matcher: 'mcp__moflo__memory_',
        hooks: [{ type: 'command', command: gateCmd('record-memory-searched'), timeout: 3000 }],
      },
    ];
  }

  // UserPromptSubmit — gate reminders + intelligent task routing
  if (config.userPromptSubmit) {
    hooks.UserPromptSubmit = [
      {
        hooks: [
          { type: 'command', command: promptHookCmd(), timeout: 3000 },
        ],
      },
    ];
  }

  // SubagentStart — inject directive for subagents to read guidance protocol
  hooks.SubagentStart = [
    {
      hooks: [
        {
          type: 'command',
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/subagent-start.cjs"',
          timeout: 2000,
        },
      ],
    },
  ];

  // SessionStart — launch daemon, indexers, pretrain via session-start-launcher
  if (config.sessionStart) {
    hooks.SessionStart = [
      {
        hooks: [
          {
            type: 'command',
            command: 'node "$CLAUDE_PROJECT_DIR/.claude/scripts/session-start-launcher.mjs"',
            timeout: 3000,
          },
          {
            type: 'command',
            command: autoMemoryCmd('import'),
            timeout: 8000,
          },
        ],
      },
    ];
  }

  // Stop — persist session + sync auto memory
  if (config.stop) {
    hooks.Stop = [
      {
        hooks: [
          { type: 'command', command: hookHandlerCmd('session-end'), timeout: 5000 },
          { type: 'command', command: autoMemoryCmd('sync'), timeout: 10000 },
        ],
      },
    ];
  }

  // PreCompact — guidance before context window compaction
  if (config.preCompact) {
    hooks.PreCompact = [
      {
        hooks: [{ type: 'command', command: gateCmd('compact-guidance'), timeout: 3000 }],
      },
    ];
  }

  // Notification — capture notifications for logging
  if (config.notification) {
    hooks.Notification = [
      {
        hooks: [
          {
            type: 'command',
            command: hookHandlerCmd('notification'),
            timeout: 3000,
          },
        ],
      },
    ];
  }

  // NOTE: TeammateIdle and TaskCompleted are NOT valid Claude Code hook events.
  // Their configuration lives in claudeFlow.agentTeams.hooks instead (see generateSettings).

  return hooks;
}

/**
 * Generate settings.json as formatted string
 */
export function generateSettingsJson(options: InitOptions): string {
  const settings = generateSettings(options);
  return JSON.stringify(settings, null, 2);
}
