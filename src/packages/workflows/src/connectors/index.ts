/**
 * Built-in Workflow Connectors
 *
 * Export all shipped connectors and a convenience array for bulk registration.
 */

import type { WorkflowConnector } from '../types/workflow-connector.types.js';
import { httpConnector } from './http-tool.js';
import { githubCliConnector } from './github-cli.js';
import { playwrightConnector } from './playwright.js';

export { httpConnector, githubCliConnector, playwrightConnector };

/** All built-in workflow connectors, ready for bulk registration. */
export const builtinConnectors: WorkflowConnector[] = [
  httpConnector,
  githubCliConnector,
  playwrightConnector,
];

// Backwards-compatibility aliases (one release cycle)
/** @deprecated Use `httpConnector` instead. */
export const httpTool = httpConnector;
/** @deprecated Use `githubCliConnector` instead. */
export const githubCliTool = githubCliConnector;
/** @deprecated Use `playwrightConnector` instead. */
export const playwrightTool = playwrightConnector;
/** @deprecated Use `builtinConnectors` instead. */
export const builtinTools = builtinConnectors;
