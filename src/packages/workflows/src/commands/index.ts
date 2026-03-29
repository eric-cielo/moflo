/**
 * Built-in Step Commands
 */

import type { StepCommand } from '../types/step-command.types.js';
import { agentCommand } from './agent-command.js';
import { bashCommand } from './bash-command.js';
import { conditionCommand } from './condition-command.js';
import { promptCommand } from './prompt-command.js';
import { memoryCommand } from './memory-command.js';
import { waitCommand } from './wait-command.js';
import { loopCommand } from './loop-command.js';
import { browserCommand } from './browser-command.js';

export {
  agentCommand,
  bashCommand,
  conditionCommand,
  promptCommand,
  memoryCommand,
  waitCommand,
  loopCommand,
  browserCommand,
};

// Typed config interfaces (Issue #189)
export type { AgentStepConfig } from './agent-command.js';
export type { BashStepConfig } from './bash-command.js';
export type { ConditionStepConfig } from './condition-command.js';
export type { PromptStepConfig } from './prompt-command.js';
export type { MemoryStepConfig } from './memory-command.js';
export type { WaitStepConfig } from './wait-command.js';
export type { LoopStepConfig } from './loop-command.js';
export type { BrowserStepConfig, BrowserAction } from './browser-command.js';

/** All built-in step commands. */
export const builtinCommands: readonly StepCommand[] = [
  agentCommand,
  bashCommand,
  conditionCommand,
  promptCommand,
  memoryCommand,
  waitCommand,
  loopCommand,
  browserCommand,
];
