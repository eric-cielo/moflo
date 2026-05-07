/**
 * `flo retire <path>` — record a shipped file as retired (#948).
 *
 * Run this inside the moflo source repo whenever a retirement PR deletes a
 * `.claude/agents/**` or `.claude/skills/**` file. It computes content
 * hashes for the last few moflo-shipped versions of the file (from git
 * history) and appends an entry to `retired-files.json`. The launcher then
 * prunes the matching file from consumer projects on their next upgrade —
 * but only when their on-disk content matches a known-shipped hash, so
 * customized files stay put.
 *
 * Refuses to run outside moflo's own repo because the seed script and
 * `retired-files.json` live at the moflo package root and don't ship to
 * consumer projects.
 *
 * Created with motailz.com
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
// dist/src/cli/commands/retire.js → repo root is up 5 dirs.
// In dev (tsx) src/cli/commands/retire.ts → up 4 dirs. Walk to find package.json#name === 'moflo'.
function findMofloRepoRoot(start: string): string | null {
  let dir = start;
  const root = resolve(dir, '/');
  while (dir !== root) {
    const pkg = resolve(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf-8'));
        if (parsed?.name === 'moflo') return dir;
      } catch { /* keep walking */ }
    }
    dir = dirname(dir);
  }
  return null;
}

export const retireCommand: Command = {
  name: 'retire',
  description: 'Record a retired shipped file in retired-files.json (moflo dev only) — usage: flo retire <path> [--retired-by #nnn]',
  hidden: true,
  options: [
    {
      name: 'retired-by',
      description: 'GitHub PR/issue reference (e.g. #932)',
      type: 'string',
    },
    {
      name: 'retired-in',
      description: 'moflo version that ships the retirement (defaults to current package.json version)',
      type: 'string',
    },
    {
      name: 'hashes',
      description: 'Maximum number of historical content hashes to record (default 3)',
      type: 'number',
      default: 3,
    },
  ],
  examples: [
    { command: 'flo retire .claude/agents/v3/performance-engineer.md --retired-by #932', description: 'Record a retirement' },
    { command: 'flo retire .claude/skills/skill-builder/SKILL.md --retired-by #945 --retired-in 4.9.21', description: 'Pin retiredIn' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const repoRoot = findMofloRepoRoot(__filename) || findMofloRepoRoot(ctx.cwd);
    if (!repoRoot) {
      output.printError('flo retire must be run inside the moflo source repo');
      output.printInfo('retired-files.json lives at the moflo package root and does not ship to consumer projects');
      return { success: false, message: 'not in moflo repo', exitCode: 1 };
    }

    const path = ctx.args[0];
    if (!path) {
      output.printError('Missing required argument: <path>');
      return { success: false, message: 'missing path', exitCode: 2 };
    }

    const scriptPath = resolve(repoRoot, 'scripts', 'build-retired-files.mjs');
    if (!existsSync(scriptPath)) {
      output.printError(`scripts/build-retired-files.mjs not found at ${scriptPath}`);
      return { success: false, message: 'seed script missing', exitCode: 1 };
    }

    // Parser normalises kebab-case flag names to camelCase before storing
    // (#787). Read as ctx.flags.<camelCase> — bracket-with-kebab is always
    // undefined and ESLint blocks that pattern.
    const args = ['--add', path];
    if (ctx.flags.retiredBy) args.push('--retired-by', String(ctx.flags.retiredBy));
    if (ctx.flags.retiredIn) args.push('--retired-in', String(ctx.flags.retiredIn));
    if (ctx.flags.hashes) args.push('--hashes', String(ctx.flags.hashes));

    const result = spawnSync('node', [scriptPath, ...args], {
      cwd: repoRoot,
      stdio: 'inherit',
    });

    if (result.error) {
      output.printError(`failed to invoke build-retired-files.mjs: ${result.error.message}`);
      return { success: false, message: String(result.error), exitCode: 1 };
    }
    if (typeof result.status === 'number' && result.status !== 0) {
      return { success: false, message: `exit ${result.status}`, exitCode: result.status };
    }
    return { success: true };
  },
};

export default retireCommand;
