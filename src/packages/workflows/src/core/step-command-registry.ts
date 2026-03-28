/**
 * Step Command Registry
 *
 * Plugin-style registry for workflow step commands.
 * Duplicate type names are rejected to prevent silent overwrites.
 */

import type {
  StepCommand,
  StepCommandEntry,
} from '../types/step-command.types.js';

// ============================================================================
// Step Command Registry
// ============================================================================

export class StepCommandRegistry {
  private readonly commands = new Map<string, StepCommandEntry>();

  /** @throws if a command with the same type is already registered. */
  register(command: StepCommand): void {
    if (!command.type || typeof command.type !== 'string') {
      throw new Error('StepCommand must have a non-empty string type');
    }

    if (this.commands.has(command.type)) {
      throw new Error(
        `Step command type "${command.type}" is already registered`
      );
    }

    this.commands.set(command.type, {
      command,
      registeredAt: new Date(),
    });
  }

  /** @returns true if removed, false if not found. */
  unregister(type: string): boolean {
    return this.commands.delete(type);
  }

  get(type: string): StepCommand | undefined {
    return this.commands.get(type)?.command;
  }

  has(type: string): boolean {
    return this.commands.has(type);
  }

  list(): StepCommandEntry[] {
    return Array.from(this.commands.values());
  }

  types(): string[] {
    return Array.from(this.commands.keys());
  }

  get size(): number {
    return this.commands.size;
  }

  clear(): void {
    this.commands.clear();
  }
}
