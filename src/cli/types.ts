/**
 * V3 CLI Type Definitions
 * Type system for the MoFlo CLI
 */

import type { MofloConfig } from './config/moflo-config.js';

// ============================================
// Core Command Types
// ============================================

export interface CommandContext {
  args: string[];
  flags: ParsedFlags;
  /**
   * Project configuration loaded from `moflo.yaml`. Optional because the
   * CLI runs from arbitrary directories — a command that needs config
   * should call `loadMofloConfig()` directly with a verified project root
   * rather than relying on this being populated. Prior versions exposed a
   * separate `V3Config` adapter object here; collapsed in #1144.
   */
  config?: MofloConfig;
  cwd: string;
  interactive: boolean;
}

export interface ParsedFlags {
  [key: string]: string | boolean | number | string[];
  _: string[];
}

export interface Command {
  name: string;
  description: string;
  aliases?: string[];
  subcommands?: Command[];
  options?: CommandOption[];
  examples?: CommandExample[];
  action?: CommandAction;
  hidden?: boolean;
}

export interface CommandOption {
  name: string;
  short?: string;
  description: string;
  type: 'string' | 'boolean' | 'number' | 'array';
  default?: unknown;
  required?: boolean;
  choices?: string[];
  validate?: (value: unknown) => boolean | string;
}

export interface CommandExample {
  command: string;
  description: string;
}

export type CommandAction = (ctx: CommandContext) => Promise<CommandResult | void>;

export interface CommandResult {
  success: boolean;
  message?: string;
  data?: unknown;
  exitCode?: number;
}

// ============================================
// Output Types
// ============================================

export interface TableColumn {
  key: string;
  header: string;
  width?: number;
  align?: 'left' | 'center' | 'right';
  format?: (value: unknown) => string;
}

export interface TableOptions {
  columns: TableColumn[];
  data: Record<string, unknown>[];
  border?: boolean;
  header?: boolean;
  padding?: number;
  maxWidth?: number;
}

export interface ProgressOptions {
  total: number;
  current?: number;
  width?: number;
  format?: string;
  showPercentage?: boolean;
  showETA?: boolean;
  showSpeed?: boolean;
}

export interface SpinnerOptions {
  text: string;
  spinner?: 'dots' | 'line' | 'arc' | 'circle' | 'arrows';
  color?: string;
}

// ============================================
// Prompt Types
// ============================================

export interface SelectOption<T = string> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** For multiselect: whether this option is selected by default */
  selected?: boolean;
}

export interface SelectPromptOptions<T = string> {
  message: string;
  options: SelectOption<T>[];
  default?: T;
  searchable?: boolean;
  pageSize?: number;
}

export interface ConfirmPromptOptions {
  message: string;
  default?: boolean;
  active?: string;
  inactive?: string;
}

export interface InputPromptOptions {
  message: string;
  default?: string;
  placeholder?: string;
  validate?: (value: string) => boolean | string;
  mask?: boolean;
}

export interface MultiSelectPromptOptions<T = string> {
  message: string;
  options: SelectOption<T>[];
  default?: T[];
  required?: boolean;
  min?: number;
  max?: number;
}

// ============================================
// Event Types
// ============================================

export type CLIEventType =
  | 'command:start'
  | 'command:end'
  | 'command:error'
  | 'prompt:start'
  | 'prompt:complete'
  | 'output:write'
  | 'progress:update'
  | 'spinner:start'
  | 'spinner:stop';

export interface CLIEvent {
  type: CLIEventType;
  timestamp: number;
  data?: unknown;
}

// ============================================
// Error Types
// ============================================

export class CLIError extends Error {
  constructor(
    message: string,
    public code: string,
    public exitCode: number = 1,
    public details?: unknown
  ) {
    super(message);
    this.name = 'CLIError';
  }
}

export class ValidationError extends CLIError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', 1, details);
    this.name = 'ValidationError';
  }
}

export class ConfigError extends CLIError {
  constructor(message: string, details?: unknown) {
    super(message, 'CONFIG_ERROR', 1, details);
    this.name = 'ConfigError';
  }
}

export class CommandNotFoundError extends CLIError {
  constructor(commandName: string) {
    super(`Unknown command: ${commandName}`, 'COMMAND_NOT_FOUND', 127);
    this.name = 'CommandNotFoundError';
  }
}
