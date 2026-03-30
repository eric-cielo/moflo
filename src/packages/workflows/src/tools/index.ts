/**
 * Built-in Workflow Tools
 *
 * Export all shipped tools and a convenience array for bulk registration.
 */

import type { WorkflowTool } from '../types/workflow-tool.types.js';
import { httpTool } from './http-tool.js';
import { githubCliTool } from './github-cli.js';
import { playwrightTool } from './playwright.js';

export { httpTool, githubCliTool, playwrightTool };

/** All built-in workflow tools, ready for bulk registration. */
export const builtinTools: WorkflowTool[] = [
  httpTool,
  githubCliTool,
  playwrightTool,
];
