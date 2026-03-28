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
