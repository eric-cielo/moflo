/**
 * Prerequisite Checker
 *
 * Collects and deduplicates prerequisites from all workflow steps,
 * runs each check once, and returns structured results.
 *
 * Story #193: Workflow engine prerequisites system.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { StepCommand, Prerequisite, PrerequisiteResult } from '../types/step-command.types.js';
import type { WorkflowDefinition } from '../types/workflow-definition.types.js';
import type { StepCommandRegistry } from './step-command-registry.js';

const execFileAsync = promisify(execFile);

/** Check whether a CLI command is available on the system PATH. */
export async function commandExists(cmd: string): Promise<boolean> {
  try {
    const bin = process.platform === 'win32' ? 'where' : 'which';
    await execFileAsync(bin, [cmd]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect unique prerequisites from all steps in a workflow definition.
 * Deduplicates by prerequisite name (first occurrence wins).
 */
export function collectPrerequisites(
  definition: WorkflowDefinition,
  registry: StepCommandRegistry,
): Prerequisite[] {
  const seen = new Map<string, Prerequisite>();

  for (const step of definition.steps) {
    const command: StepCommand | undefined = registry.get(step.type);
    if (!command?.prerequisites) continue;

    for (const prereq of command.prerequisites) {
      if (!seen.has(prereq.name)) {
        seen.set(prereq.name, prereq);
      }
    }
  }

  return Array.from(seen.values());
}

/**
 * Run all prerequisite checks concurrently. Errors are treated as unsatisfied.
 */
export async function checkPrerequisites(
  prerequisites: readonly Prerequisite[],
): Promise<PrerequisiteResult[]> {
  return Promise.all(
    prerequisites.map(async (prereq) => {
      let satisfied = false;
      try {
        satisfied = await prereq.check();
      } catch {
        satisfied = false;
      }
      return {
        name: prereq.name,
        satisfied,
        installHint: prereq.installHint,
        url: prereq.url,
      };
    }),
  );
}

/**
 * Format failed prerequisites into a user-friendly error message.
 */
export function formatPrerequisiteErrors(results: readonly PrerequisiteResult[]): string {
  const failed = results.filter(r => !r.satisfied);
  if (failed.length === 0) return '';

  const lines = ['Missing prerequisites:'];
  for (const f of failed) {
    lines.push(`  - ${f.name}: ${f.installHint}`);
    if (f.url) lines.push(`    ${f.url}`);
  }
  return lines.join('\n');
}
