/**
 * Project Root Discovery
 *
 * Walks up from cwd to find the nearest directory containing package.json or .git.
 * Extracted from workflow-tools.ts for reuse (#229).
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export function findProjectRoot(): string {
  let dir = process.cwd();
  while (true) {
    if (existsSync(resolve(dir, 'package.json')) || existsSync(resolve(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return process.cwd(); // reached filesystem root
    dir = parent;
  }
}
