/**
 * Envrc Generator
 * Creates .envrc file for PATH setup so `flo` is available directly in the terminal
 */

import * as fs from 'fs';
import * as path from 'path';
import type { InitResult } from './types.js';

/** The PATH export line added to .envrc */
export const ENVRC_PATH_LINE = 'export PATH="./node_modules/.bin:$PATH"';

/**
 * Write or update .envrc in the target directory.
 *
 * - Creates the file if it does not exist.
 * - Appends the PATH line if the file exists but does not contain it.
 * - Skips entirely when the line is already present (idempotent).
 *
 * Tracks the outcome in the InitResult (created.files or skipped).
 */
export async function writeEnvrc(
  targetDir: string,
  result: InitResult,
): Promise<void> {
  const envrcPath = path.join(targetDir, '.envrc');
  const relativePath = '.envrc';

  if (fs.existsSync(envrcPath)) {
    const existing = fs.readFileSync(envrcPath, 'utf-8');

    // Check whether the exact PATH line is already present
    const lines = existing.split(/\r?\n/);
    if (lines.some((line) => line.trim() === ENVRC_PATH_LINE)) {
      result.skipped.push(relativePath);
      return;
    }

    // Append — ensure a preceding newline so we don't corrupt the last line
    const separator = existing.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(
      envrcPath,
      existing + separator + ENVRC_PATH_LINE + '\n',
      'utf-8',
    );
    result.created.files.push(`${relativePath} (appended PATH)`);
  } else {
    // Create new .envrc
    fs.writeFileSync(
      envrcPath,
      ENVRC_PATH_LINE + '\n',
      'utf-8',
    );
    result.created.files.push(relativePath);
  }

  // Print guidance for the user
  console.log('');
  console.log('  PATH setup: created .envrc with ./node_modules/.bin on PATH');
  console.log('  If you use direnv, run:  direnv allow');
  console.log('  Otherwise, run:          source .envrc');
  console.log('  Then `flo` will be available as a direct terminal command.');
}
