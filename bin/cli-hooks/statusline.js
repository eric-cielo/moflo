#!/usr/bin/env node

/**
 * Statusline CLI
 *
 * Generate statusline output for Claude Code integration.
 *
 * Usage:
 *   statusline              Output formatted statusline
 *   statusline --json       Output JSON data
 *   statusline --compact    Output compact JSON
 */

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { StatuslineGenerator, parseStatuslineData } from '../../dist/src/cli/hooks/statusline/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const compactMode = args.includes('--compact');
const helpMode = args.includes('--help') || args.includes('-h');

async function main() {
  if (helpMode) {
    console.log(`
Statusline - V3 Hooks System Status Generator

Usage:
  statusline              Output formatted statusline (default)
  statusline --json       Output JSON data
  statusline --compact    Output compact JSON (single line)
  statusline --help       Show this help

Environment Variables:
  MOFLO_STATUSLINE_REFRESH   Refresh interval in ms
  MOFLO_SHOW_HOOKS_METRICS   Show hooks metrics (true/false)
  MOFLO_SHOW_SWARM_ACTIVITY  Show swarm activity (true/false)
  MOFLO_SHOW_PERFORMANCE     Show performance targets (true/false)

Examples:
  statusline                       # Display formatted status
  statusline --json | jq           # Parse JSON output
  statusline --compact             # Single line JSON for scripting
`);
    process.exit(0);
  }

  // Create generator with environment-based config.
  // #1209 — prefer MOFLO_* toggles, fall back to the pre-rebrand CLAUDE_FLOW_*
  // names so consumers who set the old vars keep their statusline preferences.
  const showEnv = (suffix) =>
    process.env['MOFLO_' + suffix] ?? process.env['CLAUDE_' + 'FLOW_' + suffix];
  const generator = new StatuslineGenerator({
    enabled: true,
    refreshOnHook: true,
    showHooksMetrics: showEnv('SHOW_HOOKS_METRICS') !== 'false',
    showSwarmActivity: showEnv('SHOW_SWARM_ACTIVITY') !== 'false',
    showPerformance: showEnv('SHOW_PERFORMANCE') !== 'false',
  });

  // Try to read from metrics database or files
  // In real implementation, this would read from SQLite
  // For now, use default data

  if (compactMode) {
    console.log(generator.generateCompactJSON());
  } else if (jsonMode) {
    console.log(generator.generateJSON());
  } else {
    console.log(generator.generateStatusline());
  }
}

main().catch((error) => {
  console.error('Statusline error:', error.message);
  process.exit(1);
});
