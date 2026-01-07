/**
 * V3 Progress CLI Command
 *
 * Check and manage V3 implementation progress.
 *
 * @module @claude-flow/cli/commands/progress
 */

import type { Command } from '../types.js';
import { V3ProgressService } from '@claude-flow/shared';

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function progressBar(percent: number, width: number = 20): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const bar = green('█'.repeat(filled)) + dim('░'.repeat(empty));
  return `[${bar}] ${percent}%`;
}

export const progressCommand: Command = {
  name: 'progress',
  description: 'Check V3 implementation progress',
  aliases: ['prog'],
  options: [
    {
      flags: '-d, --detailed',
      description: 'Show detailed breakdown',
    },
    {
      flags: '-j, --json',
      description: 'Output as JSON',
    },
    {
      flags: '-s, --sync',
      description: 'Sync and persist progress',
    },
    {
      flags: '-w, --watch',
      description: 'Watch for changes',
    },
  ],
  subcommands: [
    {
      name: 'check',
      description: 'Check current progress (default)',
      action: async (options) => {
        const service = new V3ProgressService();
        const metrics = await service.calculate();

        if (options.json) {
          console.log(JSON.stringify(metrics, null, 2));
          return;
        }

        console.log(`\n${bold('V3 Implementation Progress')}\n`);
        console.log(progressBar(metrics.overall, 30));
        console.log();

        if (options.detailed) {
          console.log(`${cyan('CLI Commands:')}     ${progressBar(metrics.cli.progress, 15)} ${dim(`(${metrics.cli.commands}/${metrics.cli.target})`)}`);
          console.log(`${cyan('MCP Tools:')}        ${progressBar(metrics.mcp.progress, 15)} ${dim(`(${metrics.mcp.tools}/${metrics.mcp.target})`)}`);
          console.log(`${cyan('Hooks:')}            ${progressBar(metrics.hooks.progress, 15)} ${dim(`(${metrics.hooks.subcommands}/${metrics.hooks.target})`)}`);
          console.log(`${cyan('Packages:')}         ${progressBar(metrics.packages.progress, 15)} ${dim(`(${metrics.packages.total}/${metrics.packages.target})`)}`);
          console.log(`${cyan('DDD Structure:')}    ${progressBar(metrics.ddd.progress, 15)} ${dim(`(${metrics.packages.withDDD}/${metrics.packages.total})`)}`);
          console.log();
          console.log(`${dim('Codebase:')} ${metrics.codebase.totalFiles} files, ${metrics.codebase.totalLines.toLocaleString()} lines`);
        }

        console.log(`${dim('Last updated:')} ${metrics.lastUpdated}`);
      },
    },
    {
      name: 'sync',
      description: 'Calculate and persist progress',
      action: async (options) => {
        const service = new V3ProgressService();
        const metrics = await service.sync();

        if (options.json) {
          console.log(JSON.stringify({ success: true, progress: metrics.overall }, null, 2));
          return;
        }

        console.log(green('✓') + ` Progress synced: ${bold(metrics.overall + '%')}`);
        console.log(dim(`  Persisted to .claude-flow/metrics/v3-progress.json`));
      },
    },
    {
      name: 'summary',
      description: 'Show human-readable summary',
      action: async () => {
        const service = new V3ProgressService();
        const summary = await service.getSummary();
        console.log('\n' + summary + '\n');
      },
    },
    {
      name: 'watch',
      description: 'Watch for progress changes',
      options: [
        {
          flags: '-i, --interval <ms>',
          description: 'Update interval in milliseconds',
          default: '5000',
        },
      ],
      action: async (options) => {
        const interval = parseInt(options.interval as string) || 5000;
        const service = new V3ProgressService();

        console.log(cyan(`Watching progress (interval: ${interval}ms). Press Ctrl+C to stop.\n`));

        let lastProgress = 0;

        service.on('progressChange', (event) => {
          console.log(
            `${yellow('→')} Progress changed: ${event.previous}% → ${green(event.current + '%')}`
          );
        });

        const check = async () => {
          const metrics = await service.calculate();
          if (metrics.overall !== lastProgress) {
            process.stdout.write('\r' + ' '.repeat(50) + '\r');
          }
          process.stdout.write(`\r${progressBar(metrics.overall, 20)} ${dim(new Date().toLocaleTimeString())}`);
          lastProgress = metrics.overall;
        };

        await check();
        const timer = setInterval(check, interval);

        // Handle Ctrl+C
        process.on('SIGINT', () => {
          clearInterval(timer);
          console.log('\n' + dim('Stopped watching.'));
          process.exit(0);
        });
      },
    },
  ],
  action: async (options) => {
    // Default to 'check' subcommand
    const service = new V3ProgressService();

    if (options.sync) {
      const metrics = await service.sync();
      console.log(green('✓') + ` Progress synced: ${bold(metrics.overall + '%')}`);
      return;
    }

    if (options.watch) {
      // Redirect to watch subcommand
      const watchCmd = progressCommand.subcommands?.find(s => s.name === 'watch');
      if (watchCmd?.action) {
        await watchCmd.action(options);
      }
      return;
    }

    const metrics = await service.calculate();

    if (options.json) {
      console.log(JSON.stringify(metrics, null, 2));
      return;
    }

    console.log(`\n${bold('V3 Implementation Progress')}\n`);
    console.log(progressBar(metrics.overall, 30));
    console.log();

    if (options.detailed) {
      console.log(`${cyan('CLI Commands:')}     ${progressBar(metrics.cli.progress, 15)} ${dim(`(${metrics.cli.commands}/${metrics.cli.target})`)}`);
      console.log(`${cyan('MCP Tools:')}        ${progressBar(metrics.mcp.progress, 15)} ${dim(`(${metrics.mcp.tools}/${metrics.mcp.target})`)}`);
      console.log(`${cyan('Hooks:')}            ${progressBar(metrics.hooks.progress, 15)} ${dim(`(${metrics.hooks.subcommands}/${metrics.hooks.target})`)}`);
      console.log(`${cyan('Packages:')}         ${progressBar(metrics.packages.progress, 15)} ${dim(`(${metrics.packages.total}/${metrics.packages.target})`)}`);
      console.log(`${cyan('DDD Structure:')}    ${progressBar(metrics.ddd.progress, 15)} ${dim(`(${metrics.packages.withDDD}/${metrics.packages.total})`)}`);
      console.log();
      console.log(`${dim('Codebase:')} ${metrics.codebase.totalFiles} files, ${metrics.codebase.totalLines.toLocaleString()} lines`);
    }

    console.log(`${dim('Last updated:')} ${metrics.lastUpdated}`);
  },
  examples: [
    {
      command: 'claude-flow progress',
      description: 'Check current progress',
    },
    {
      command: 'claude-flow progress --detailed',
      description: 'Show detailed breakdown',
    },
    {
      command: 'claude-flow progress sync',
      description: 'Sync and persist progress',
    },
    {
      command: 'claude-flow progress watch',
      description: 'Watch for changes',
    },
    {
      command: 'claude-flow progress --json',
      description: 'Output as JSON',
    },
  ],
};

export default progressCommand;
