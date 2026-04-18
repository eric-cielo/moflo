/**
 * Built-in Spell Connectors
 *
 * Export all shipped connectors and a convenience array for bulk registration.
 */

import type { SpellConnector } from '../types/spell-connector.types.js';
import { httpConnector } from './http-tool.js';
import { githubCliConnector } from './github-cli.js';
import { playwrightConnector } from './playwright.js';
import { localOutlookConnector } from './local-outlook.js';
import { slackConnector } from './slack.js';
import { imapConnector } from './imap.js';
import { mcpClientConnector } from './mcp-client.js';
import { graphConnector } from './graph.js';

export { httpConnector, githubCliConnector, playwrightConnector, localOutlookConnector, slackConnector, imapConnector, mcpClientConnector, graphConnector };

/** All built-in spell connectors, ready for bulk registration. */
export const builtinConnectors: SpellConnector[] = [
  httpConnector,
  githubCliConnector,
  playwrightConnector,
  localOutlookConnector,
  slackConnector,
  imapConnector,
  mcpClientConnector,
  graphConnector,
];

